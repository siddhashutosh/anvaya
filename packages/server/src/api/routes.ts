/**
 * REST routes (FR-6.*).
 *
 * Handlers contain no business logic: they parse, delegate, and shape. Anything
 * they throw is converted by the error boundary.
 */

import {
  CATALOG,
  DAY,
  ERROR_CODES,
  HOUR,
  NotFoundError,
  TAXONOMY_VERSION,
  ValidationError,
  familyOf,
  getMode,
  ingestPayloadSchema,
  type DetectorTier,
  type IngestAck,
  type Severity,
  type TimeRange,
} from '@anvaya/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config/schema.js';
import type { DetectorRegistry } from '../detectors/registry.js';
import { getAdapter } from '../ingest/adapters/index.js';
import type { IngestWorker } from '../pipeline/worker.js';
import type { InlineIngestor, IngestItem } from '../pipeline/inline.js';
import type { Storage } from '../storage/types.js';
import type { Metrics } from '../telemetry/metrics.js';
import type { Redactor } from '@anvaya/core';

export interface RouteDeps {
  readonly storage: Storage;
  readonly worker: IngestWorker;
  readonly registry: DetectorRegistry;
  readonly metrics: Metrics;
  readonly config: Config;
  readonly redactor: Redactor;
  readonly judgeConfigured: boolean;
  /** Present only in serverless (`inline`) mode — see ADR-0009. */
  readonly inline?: InlineIngestor;
}

function parseRange(query: Record<string, unknown>): TimeRange {
  const to = numberOr(query.to, Date.now());
  const from = numberOr(query.from, to - DAY);
  if (from > to) {
    throw new ValidationError('`from` must not be after `to`', {
      code: ERROR_CODES.INVALID_QUERY,
    });
  }
  return { from, to };
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // ── health & meta (public) ────────────────────────────────────────────────

  app.get('/health', async () => {
    const storage = await deps.storage.health();
    const worker = deps.worker.stats();
    return {
      status: storage.ok ? 'ok' : 'degraded',
      version: '1.0.0',
      taxonomyVersion: TAXONOMY_VERSION,
      components: {
        storage,
        ingest: worker,
        detection: {
          enabled: deps.config.detection.enabled,
          detectors: deps.registry.size,
          judgeConfigured: deps.judgeConfigured,
        },
      },
      metrics: deps.metrics.snapshot(),
    };
  });

  app.get('/v1/meta', async () => ({
    name: 'anvaya',
    version: '1.0.0',
    taxonomyVersion: TAXONOMY_VERSION,
    taxonomySize: CATALOG.length,
    capabilities: {
      formats: ['anvaya', 'otel-genai', 'openinference'],
      tiers: deps.config.detection.tiers,
      judgeConfigured: deps.judgeConfigured,
      contentCaptureExpected: true,
    },
    deployment: {
      ingestMode: deps.config.ingest.mode,
      storageDriver: deps.config.storage.driver,
      // True when running on a stateless host with no external database: data
      // survives only as long as the instance. Surfaced so the dashboard can say
      // so rather than quietly implying persistence.
      ephemeralStorage:
        deps.config.storage.driver === 'sqlite' && deps.config.storage.path.startsWith('/tmp'),
    },
  }));

  // ── ingest ────────────────────────────────────────────────────────────────

  app.post('/v1/ingest', async (request, reply) => {
    const parsed = ingestPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('invalid ingest payload', {
        code: ERROR_CODES.VALIDATION_FAILED,
        context: {
          details: parsed.error.issues.slice(0, 10).map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      });
    }

    const payload = parsed.data;
    const adapter = getAdapter(payload.format);
    const errors: IngestAck['errors'][number][] = [];
    const inlineItems: IngestItem[] = [];
    let accepted = 0;

    const ctx = {
      service: payload.service,
      environment: payload.environment,
      ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
    };

    for (const [index, raw] of payload.spans.entries()) {
      const result = adapter.adapt(raw, ctx);
      if (!result.ok) {
        // Partial-batch acceptance (FR-2.3): one bad span never rejects the batch.
        errors.push({ index, message: result.error.message });
        continue;
      }

      // Server-side redaction as defence in depth (NFR-4.2): an older SDK or a
      // direct OTel producer cannot bypass the policy.
      const span = deps.config.ingest.redactServerSide
        ? deps.redactor.redactObject(result.value).value
        : result.value;

      if (deps.inline) {
        inlineItems.push({
          span,
          service: payload.service,
          environment: payload.environment,
          ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
        });
      } else {
        deps.worker.enqueue({
          span,
          service: payload.service,
          environment: payload.environment,
          ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
          receivedAt: Date.now(),
        });
      }
      accepted++;
    }

    // Serverless: persist and analyse before responding. There is no event loop
    // after the response, so deferring the work would simply lose it.
    let analysed = 0;
    if (deps.inline && inlineItems.length > 0) {
      ({ analysed } = await deps.inline.ingest(inlineItems));
    }

    deps.metrics.counter('ingest.spans_accepted', accepted);
    deps.metrics.counter('ingest.spans_rejected', errors.length);

    const ack: IngestAck & { analysed?: number } = {
      accepted,
      rejected: errors.length,
      errors: errors.slice(0, 20),
      ...(deps.inline ? { analysed } : {}),
    };
    return reply.code(202).send(ack);
  });

  /**
   * Cron target: analyse traces whose root span never arrived, so a client that
   * crashed mid-trace cannot leave one permanently undiagnosed.
   */
  // GET as well as POST: Vercel Cron issues GET.
  const sweep = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!deps.inline) {
      return reply.code(200).send({ mode: 'worker', analysed: 0, resolved: 0 });
    }
    const { analysed } = await deps.inline.sweep();
    const resolved = await deps.storage.resolveStaleIncidents(
      Date.now() - deps.config.analysis.autoResolveMs,
    );

    let purged = 0;
    if (deps.config.retention.enabled) {
      const cutoff = Date.now() - deps.config.retention.maxAgeDays * DAY;
      purged = (await deps.storage.purgeOlderThan(cutoff)).traces;
    }

    return reply.send({ mode: 'inline', analysed, resolved, purged });
  };

  app.get('/v1/maintenance/sweep', sweep);
  app.post('/v1/maintenance/sweep', sweep);

  // ── traces ────────────────────────────────────────────────────────────────

  app.get('/v1/traces', async (request: FastifyRequest) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    return deps.storage.listTraces({
      range: parseRange(q),
      ...(stringOr(q.service) ? { service: stringOr(q.service) as string } : {}),
      ...(stringOr(q.environment) ? { environment: stringOr(q.environment) as string } : {}),
      ...(stringOr(q.sessionId) ? { sessionId: stringOr(q.sessionId) as string } : {}),
      ...(q.status === 'ok' || q.status === 'error' ? { status: q.status } : {}),
      ...(q.hasFindings === 'true' ? { hasFindings: true } : {}),
      ...(stringOr(q.code) ? { code: stringOr(q.code) as string } : {}),
      ...(stringOr(q.minSeverity) ? { minSeverity: stringOr(q.minSeverity) as Severity } : {}),
      limit: numberOr(q.limit, 50),
      ...(stringOr(q.cursor) ? { cursor: stringOr(q.cursor) as string } : {}),
    });
  });

  app.get('/v1/traces/:traceId', async (request) => {
    const { traceId } = request.params as { traceId: string };
    const detail = await deps.storage.getTrace(traceId);
    if (!detail) throw new NotFoundError(`trace ${traceId} not found`, { context: { traceId } });

    // Attach the taxonomy card for each finding so the UI never hardcodes it.
    return {
      ...detail,
      taxonomy: Object.fromEntries(
        [...new Set(detail.findings.map((f) => f.code))]
          .map((code) => [code, getMode(code)] as const)
          .filter(([, mode]) => mode !== undefined),
      ),
    };
  });

  // ── findings ──────────────────────────────────────────────────────────────

  app.get('/v1/findings', async (request) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    return deps.storage.listFindings({
      range: parseRange(q),
      ...(stringOr(q.code) ? { code: stringOr(q.code) as string } : {}),
      ...(stringOr(q.family) ? { family: stringOr(q.family) as string } : {}),
      ...(stringOr(q.severity) ? { severity: stringOr(q.severity) as Severity } : {}),
      ...(stringOr(q.tier) ? { tier: stringOr(q.tier) as DetectorTier } : {}),
      ...(q.role === 'origin' || q.role === 'symptom' || q.role === 'standalone'
        ? { role: q.role }
        : {}),
      ...(stringOr(q.traceId) ? { traceId: stringOr(q.traceId) as string } : {}),
      limit: numberOr(q.limit, 50),
      ...(stringOr(q.cursor) ? { cursor: stringOr(q.cursor) as string } : {}),
    });
  });

  // ── sessions ──────────────────────────────────────────────────────────────
  //
  // A session spans many traces, and two MAST modes (FM-1.4, FM-2.1) are only
  // observable across that boundary — so sessions are a first-class view, not a
  // filter over traces.

  app.get('/v1/sessions', async (request) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    return deps.storage.listSessions({
      range: parseRange(q),
      ...(stringOr(q.service) ? { service: stringOr(q.service) as string } : {}),
      ...(q.minTraces !== undefined ? { minTraces: numberOr(q.minTraces, 1) } : {}),
      limit: numberOr(q.limit, 50),
      ...(stringOr(q.cursor) ? { cursor: stringOr(q.cursor) as string } : {}),
    });
  });

  app.get('/v1/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const traces = await deps.storage.getSessionTraces(sessionId);
    if (traces.length === 0) {
      throw new NotFoundError(`session ${sessionId} not found`, { context: { sessionId } });
    }

    const findings = await deps.storage.listFindings({
      range: { from: 0, to: Date.now() },
      limit: 200,
    });

    const traceIds = new Set(traces.map((t) => t.traceId));
    return {
      sessionId,
      traces,
      // Session-scoped findings attach to the turn where the loss became visible.
      findings: findings.items.filter((f) => traceIds.has(f.traceId)),
      taxonomy: Object.fromEntries(
        [...new Set(findings.items.filter((f) => traceIds.has(f.traceId)).map((f) => f.code))]
          .map((code) => [code, getMode(code)] as const)
          .filter(([, mode]) => mode !== undefined),
      ),
    };
  });

  // ── incidents ─────────────────────────────────────────────────────────────

  app.get('/v1/incidents', async (request) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    return deps.storage.listIncidents({
      ...(q.status === 'open' || q.status === 'resolved' ? { status: q.status } : {}),
      ...(stringOr(q.code) ? { code: stringOr(q.code) as string } : {}),
      ...(stringOr(q.minSeverity) ? { minSeverity: stringOr(q.minSeverity) as Severity } : {}),
      limit: numberOr(q.limit, 50),
      ...(stringOr(q.cursor) ? { cursor: stringOr(q.cursor) as string } : {}),
    });
  });

  app.get('/v1/incidents/:incidentId', async (request) => {
    const { incidentId } = request.params as { incidentId: string };
    const detail = await deps.storage.getIncident(incidentId);
    if (!detail) {
      throw new NotFoundError(`incident ${incidentId} not found`, { context: { incidentId } });
    }
    // Remediation travels with the incident (FR-4.8, NFR-6.3).
    return { ...detail, mode: getMode(detail.incident.code) };
  });

  // ── taxonomy ──────────────────────────────────────────────────────────────

  app.get('/v1/taxonomy', async () => ({
    version: TAXONOMY_VERSION,
    modes: CATALOG,
  }));

  app.get('/v1/taxonomy/:code', async (request) => {
    const { code } = request.params as { code: string };
    const mode = getMode(code);
    if (!mode) throw new NotFoundError(`taxonomy code ${code} not found`, { context: { code } });
    return mode;
  });

  // ── stats ─────────────────────────────────────────────────────────────────

  app.get('/v1/stats/overview', async (request) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const range = parseRange(q);
    const overview = await deps.storage.overview(range);
    return {
      range,
      ...overview,
      topCodes: overview.topCodes.map((c) => ({
        ...c,
        name: getMode(c.code)?.name ?? c.code,
        family: familyOf(c.code) ?? 'INF',
      })),
    };
  });

  app.get('/v1/stats/timeseries', async (request) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const range = parseRange(q);
    const bucketMs = numberOr(q.bucketMs, HOUR);
    // Cap the bucket count so a wide range with a tiny bucket cannot exhaust memory.
    const maxBuckets = 500;
    const safeBucket = Math.max(bucketMs, Math.ceil((range.to - range.from) / maxBuckets));

    return {
      range,
      bucketMs: safeBucket,
      buckets: await deps.storage.timeseries({ range, bucketMs: safeBucket }),
    };
  });

  app.get('/v1/stats/codes', async (request) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const counts = await deps.storage.codeFrequency(parseRange(q), numberOr(q.limit, 20));
    return {
      codes: counts.map((c) => ({
        ...c,
        name: getMode(c.code)?.name ?? c.code,
        family: familyOf(c.code) ?? 'INF',
      })),
    };
  });

  /**
   * Cost attribution by cohort — the showback/chargeback view. Without a
   * per-cohort breakdown, AI spend is opaque at the organisational level even
   * when the aggregate bill is visible.
   */
  app.get('/v1/stats/cost', async (request) => {
    const q = (request.query ?? {}) as Record<string, unknown>;
    const range = parseRange(q);
    const key = stringOr(q.key) ?? 'service';
    const buckets = await deps.storage.costByCohort(key, range, numberOr(q.limit, 20));
    const total = buckets.reduce((sum, b) => sum + b.costUsd, 0);

    return {
      range,
      key,
      totalCostUsd: total,
      buckets: buckets.map((b) => ({
        ...b,
        share: total === 0 ? 0 : b.costUsd / total,
      })),
    };
  });

  // ── detectors ─────────────────────────────────────────────────────────────

  app.get('/v1/detectors', async () => {
    const disabled = new Set(deps.config.detection.disabledDetectors);
    return {
      detectors: deps.registry.all().map((d) => ({
        id: d.id,
        tier: d.tier,
        emits: d.emits,
        cost: d.cost,
        requiresBaseline: d.requiresBaseline,
        description: d.description,
        enabled:
          deps.config.detection.enabled && deps.config.detection.tiers[d.tier] && !disabled.has(d.id),
      })),
    };
  });
}
