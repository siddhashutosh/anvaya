/**
 * PostgresStorage and the serverless inline ingest path (ADR-0009).
 *
 * Run against pglite — real Postgres compiled to WASM — so the Postgres dialect,
 * the migrations, the upsert semantics and the inline pipeline are all verified
 * on a laptop with no server and no Docker. The same adapter runs against Neon in
 * production; only the driver differs.
 */

import { PGlite } from '@electric-sql/pglite';
import { createNoopLogger } from '@anvaya/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertDispatcher } from '../src/alerts/dispatcher.js';
import { CausalAttributor } from '../src/analysis/attributor.js';
import { BaselineManager } from '../src/analysis/baselines.js';
import { IncidentClusterer } from '../src/analysis/clusterer.js';
import { CohortCorrelator } from '../src/analysis/correlator.js';
import { TraceEnricher } from '../src/analysis/enricher.js';
import { SessionAnalyzer } from '../src/analysis/session.js';
import { configSchema } from '../src/config/schema.js';
import { createRegistry } from '../src/detectors/index.js';
import { InlineIngestor } from '../src/pipeline/inline.js';
import { AnalysisPipeline } from '../src/pipeline/pipeline.js';
import { PostgresStorage } from '../src/storage/postgres/storage.js';
import type { PgDriver, SqlValue } from '../src/storage/postgres/client.js';
import { Metrics } from '../src/telemetry/metrics.js';
import { TEST_CONFIG, trace } from './fixtures.js';

const logger = createNoopLogger();
const config = configSchema.parse({ ingest: { mode: 'inline' } });

/** pglite behind the driver interface the client expects. */
function pgliteDriver(db: PGlite): PgDriver {
  return {
    async query<T>(sql: string, params?: readonly SqlValue[]) {
      const result = await db.query<T>(sql, params ? [...params] : undefined);
      return { rows: result.rows };
    },
    async end() {
      await db.close();
    },
  };
}

let db: PGlite;
let storage: PostgresStorage;

beforeEach(async () => {
  db = new PGlite();
  storage = new PostgresStorage({
    connectionString: 'memory://test',
    logger,
    driver: pgliteDriver(db),
  });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
});

function makePipeline(baselines: BaselineManager) {
  return new AnalysisPipeline({
    registry: createRegistry(),
    enricher: new TraceEnricher(),
    attributor: new CausalAttributor(),
    clusterer: new IncidentClusterer({
      windowMs: config.analysis.incidentWindowMs,
      autoResolveMs: config.analysis.autoResolveMs,
      storage,
      logger,
    }),
    correlator: new CohortCorrelator({
      storage,
      cohortKeys: ['service'],
      minLift: 2,
      minSamples: 20,
      logger,
    }),
    baselines,
    sessionAnalyzer: new SessionAnalyzer({ thresholds: TEST_CONFIG.detection.thresholds, logger }),
    storage,
    alerts: new AlertDispatcher(config, logger),
    config,
    metrics: new Metrics(),
    logger,
  });
}

// ── schema ──────────────────────────────────────────────────────────────────

describe('migrations', () => {
  it('creates every table and is idempotent', async () => {
    await storage.init();
    await storage.init();

    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.rows.map((r) => r.table_name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'baselines',
        'detector_runs',
        'findings',
        'incidents',
        'schema_migrations',
        'spans',
        'traces',
      ]),
    );
  });

  it('reports healthy', async () => {
    const health = await storage.health();
    expect(health.ok).toBe(true);
    expect(health.driver).toBe('postgres');
  });
});

// ── storage parity with the SQLite adapter ──────────────────────────────────

describe('PostgresStorage', () => {
  it('round-trips a trace bundle', async () => {
    const { trace: rec, spans } = trace()
      .span({ name: 'root', kind: 'chain' })
      .span({
        name: 'llm.answer',
        kind: 'llm',
        parent: 0,
        llm: { requestModel: 'claude-sonnet-5', inputTokens: 100, outputTokens: 20 },
      })
      .build();

    await storage.saveTraceBundle({ trace: rec, spans, findings: [], detectorRuns: [] });

    const detail = await storage.getTrace(rec.traceId);
    expect(detail?.spans).toHaveLength(2);
    // jsonb must round-trip as a structured payload, not as a string.
    expect(detail?.spans.find((s) => s.kind === 'llm')?.llm?.inputTokens).toBe(100);
    // BIGINT comes back as a string from Postgres and must be coerced.
    expect(typeof detail?.trace.startTime).toBe('number');
  });

  it('is idempotent on span id', async () => {
    const { trace: rec, spans } = trace().span({ name: 'root', kind: 'chain' }).build();
    const bundle = { trace: rec, spans, findings: [], detectorRuns: [] };

    await storage.saveTraceBundle(bundle);
    await storage.saveTraceBundle(bundle);

    expect((await storage.getTrace(rec.traceId))?.spans).toHaveLength(1);
  });

  it('only ever widens a trace envelope on upsert', async () => {
    const { trace: rec, spans } = trace()
      .span({ name: 'a', kind: 'tool', offsetMs: 1000, durationMs: 100 })
      .build();
    await storage.saveSpans(rec, spans);

    // A later batch carrying an EARLIER span must extend the window backwards.
    const early = { ...spans[0]!, spanId: 'earlier', startTime: rec.startTime - 5000, endTime: rec.startTime - 4000 };
    await storage.saveSpans({ ...rec, startTime: early.startTime, endTime: early.endTime }, [early]);

    const stored = await storage.getTraceRecord(rec.traceId);
    expect(stored?.startTime).toBe(early.startTime);
    expect(stored?.endTime).toBe(rec.endTime);
  });

  it('filters, paginates and purges', async () => {
    for (let i = 0; i < 5; i++) {
      const { trace: rec, spans } = trace().span({ name: `t-${i}`, kind: 'chain' }).build();
      await storage.saveTraceBundle({ trace: rec, spans, findings: [], detectorRuns: [] });
    }

    const page = await storage.listTraces({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.nextCursor).toBeDefined();

    const purged = await storage.purgeOlderThan(Date.now() + 1000);
    expect(purged.traces).toBe(5);
    expect((await storage.listTraces({})).total).toBe(0);
  });

  it('aggregates cost by a cohort key inside jsonb attributes', async () => {
    for (const route of ['refunds', 'refunds', 'billing']) {
      const { trace: rec, spans } = trace()
        .attrs({ route })
        .span({
          name: 'llm',
          kind: 'llm',
          llm: { requestModel: 'claude-sonnet-5', inputTokens: 100_000, outputTokens: 10_000 },
        })
        .build();
      await storage.saveTraceBundle({
        trace: { ...rec, totalCostUsd: 0.45 },
        spans,
        findings: [],
        detectorRuns: [],
      });
    }

    const buckets = await storage.costByCohort('route', { from: 0, to: Date.now() + 1000 });
    const refunds = buckets.find((b) => b.value === 'refunds');
    expect(refunds?.traces).toBe(2);
    expect(refunds?.costUsd).toBeCloseTo(0.9, 5);
  });

  it('persists and reloads baselines', async () => {
    await storage.putBaselines([
      {
        metric: 'llm.duration_ms',
        scope: 'claude-sonnet-5',
        stats: { count: 40, mean: 800, m2: 1000, min: 500, max: 1200, samples: [800, 810] },
        updatedAt: Date.now(),
      },
    ]);

    const row = await storage.getBaseline('llm.duration_ms', 'claude-sonnet-5');
    expect(row?.stats.count).toBe(40);
    expect(row?.stats.samples).toEqual([800, 810]);
    expect(await storage.listBaselines()).toHaveLength(1);
  });

  it('resolves stale incidents and reports how many', async () => {
    await storage.upsertIncident({
      incidentId: 'inc_1',
      code: 'RET-002',
      originOperation: 'kb.search',
      severity: 'high',
      status: 'open',
      firstSeen: 1000,
      lastSeen: 2000,
      occurrences: 3,
      traceIds: ['a'],
      title: 'Retrieval quality collapse at kb.search',
      cohorts: [],
    });

    expect(await storage.resolveStaleIncidents(5000)).toBe(1);
    const after = await storage.listIncidents({ status: 'resolved' });
    expect(after.items[0]?.incidentId).toBe('inc_1');
  });
});

// ── the serverless ingest path ──────────────────────────────────────────────

describe('InlineIngestor (ADR-0009)', () => {
  function ingestor(pipeline: AnalysisPipeline) {
    return new InlineIngestor({
      storage,
      pipeline,
      metrics: new Metrics(),
      logger,
      sweepAfterMs: 0,
    });
  }

  function items(spans: readonly { traceId: string }[], sessionId?: string) {
    return spans.map((span) => ({
      span: span as never,
      service: 'svc',
      environment: 'test',
      ...(sessionId ? { sessionId } : {}),
    }));
  }

  it('persists spans without analysing until the root arrives', async () => {
    const baselines = new BaselineManager(storage, logger, { reloadEveryTrace: true });
    const inline = ingestor(makePipeline(baselines));

    const { spans } = trace()
      .span({ name: 'root', kind: 'chain', durationMs: 900 })
      .span({
        name: 'llm.answer',
        kind: 'llm',
        parent: 0,
        llm: { finishReason: 'length', outputTokens: 512, maxTokens: 512 },
      })
      .build();

    const root = spans.find((s) => !s.parentSpanId)!;
    const child = spans.find((s) => s.parentSpanId)!;

    // Children first: nothing should be analysed yet.
    const first = await inline.ingest(items([child]));
    expect(first.analysed).toBe(0);
    expect(await storage.getTraceSpans(child.traceId)).toHaveLength(1);
    expect((await storage.getTrace(child.traceId))?.findings).toHaveLength(0);

    // Root arrives: the trace is complete and gets analysed in-request.
    const second = await inline.ingest(items([root]));
    expect(second.analysed).toBe(1);

    const detail = await storage.getTrace(root.traceId);
    expect(detail?.spans).toHaveLength(2);
    // GEN-006 is deterministic on finishReason=length.
    expect(detail?.findings.map((f) => f.code)).toContain('GEN-006');
    expect(detail?.trace.findingCount).toBeGreaterThan(0);
  });

  it('sweeps a trace whose root never arrived', async () => {
    const baselines = new BaselineManager(storage, logger, { reloadEveryTrace: true });
    const inline = ingestor(makePipeline(baselines));

    const { spans } = trace()
      .span({ name: 'root', kind: 'chain' })
      .span({
        name: 'llm.answer',
        kind: 'llm',
        parent: 0,
        llm: { finishReason: 'length', outputTokens: 512 },
      })
      .build();

    // Only the orphan child is ever sent — the client crashed before the root.
    const child = spans.find((s) => s.parentSpanId)!;
    await inline.ingest(items([child]));
    expect((await storage.getTrace(child.traceId))?.findings).toHaveLength(0);

    const swept = await inline.sweep();
    expect(swept.analysed).toBe(1);
    expect((await storage.getTrace(child.traceId))?.findings.length).toBeGreaterThan(0);

    // Already analysed: a second sweep must not redo the work.
    expect((await inline.sweep()).analysed).toBe(0);
  });

  it('re-analysing a trace replaces findings rather than duplicating them', async () => {
    const baselines = new BaselineManager(storage, logger, { reloadEveryTrace: true });
    const pipeline = makePipeline(baselines);
    const inline = ingestor(pipeline);

    const { spans } = trace()
      .span({ name: 'root', kind: 'chain' })
      .span({ name: 'llm.answer', kind: 'llm', parent: 0, llm: { finishReason: 'length', outputTokens: 512 } })
      .build();

    await inline.ingest(items(spans));
    const first = (await storage.getTrace(spans[0]!.traceId))?.findings.length ?? 0;

    // Analysis is at-least-once, so it must be idempotent.
    const record = await storage.getTraceRecord(spans[0]!.traceId);
    await pipeline.analyze(record!, await storage.getTraceSpans(spans[0]!.traceId));

    const second = (await storage.getTrace(spans[0]!.traceId))?.findings.length ?? 0;
    expect(second).toBe(first);
  });

  it('carries baselines across invocations through storage', async () => {
    // The point of request-scoped baselines: state survives in the database, not
    // in the process, because the process does not survive.
    for (let i = 0; i < 3; i++) {
      const fresh = new BaselineManager(storage, logger, { reloadEveryTrace: true });
      const inline = ingestor(makePipeline(fresh));
      const { spans } = trace()
        .span({ name: 'root', kind: 'chain', durationMs: 500 })
        .span({ name: 'llm', kind: 'llm', parent: 0, llm: { requestModel: 'm', inputTokens: 10, outputTokens: 5 } })
        .build();
      await inline.ingest(items(spans));
    }

    const baseline = await storage.getBaseline('trace.duration_ms', 'global');
    expect(baseline?.stats.count).toBe(3);
  });

  it('isolates a failing trace from the rest of the batch', async () => {
    const baselines = new BaselineManager(storage, logger, { reloadEveryTrace: true });
    const inline = ingestor(makePipeline(baselines));

    const good = trace().span({ name: 'root', kind: 'chain' }).build();
    // A span referencing a trace id far longer than the column allows nothing —
    // the point is that one broken trace must not fail its neighbours.
    const broken = { ...good.spans[0]!, spanId: 'x'.repeat(10), traceId: 'y'.repeat(10), startTime: NaN };

    const result = await inline.ingest([
      ...items(good.spans),
      { span: broken as never, service: 'svc', environment: 'test' },
    ]);

    expect(result.analysed).toBeGreaterThanOrEqual(1);
    expect(await storage.getTraceRecord(good.trace.traceId)).toBeDefined();
  });
});
