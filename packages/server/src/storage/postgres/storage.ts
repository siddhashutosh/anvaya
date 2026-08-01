/**
 * PostgresStorage — the serverless-capable Storage adapter.
 *
 * Same port as SqliteStorage (FR-5.1); the SQLite-first decision in ADR-0001 was
 * made reversible precisely so this could be added without touching detection,
 * analysis, the API or the UI.
 *
 * Two behaviours differ from SQLite and are load-bearing:
 *
 *   1. `saveTraceBundle` is idempotent per statement rather than transactional.
 *      Neon's pooled endpoint gives no session affinity, so a wrapping
 *      BEGIN/COMMIT can land on a different connection than its statements. Every
 *      write is therefore an upsert, and a retry repairs a partial write.
 *   2. `analyzed_at` marks traces the pipeline has processed, so a cron sweep can
 *      find traces whose root span never arrived (ADR-0009).
 */

import {
  SEVERITY_RANK,
  familyOf,
  maxSeverity,
  percentile,
  type Attribution,
  type BaselineRow,
  type Finding,
  type Incident,
  type Logger,
  type Page,
  type SessionSummary,
  type SessionTurn,
  type Severity,
  type SpanRecord,
  type TaxonomyCode,
  type TimeRange,
  type TraceRecord,
  type TraceSummary,
} from '@anvaya/core';
import type {
  CodeCount,
  CohortCount,
  CostBucket,
  FindingQuery,
  IncidentDetail,
  IncidentQuery,
  OverviewStats,
  PurgeResult,
  SessionQuery,
  Storage,
  StorageHealth,
  TimeBucket,
  TimeseriesQuery,
  TraceBundle,
  TraceDetail,
  TraceQuery,
} from '../types.js';
import { PostgresClient, json, num, type PgDriver, type SqlValue } from './client.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export interface PostgresStorageOptions {
  readonly connectionString: string;
  readonly logger: Logger;
  readonly driver?: PgDriver;
}

/** Builds `$1, $2, …` and accumulates bound values. */
class Params {
  readonly values: SqlValue[] = [];
  next(value: SqlValue): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export class PostgresStorage implements Storage {
  private readonly client: PostgresClient;
  private readonly logger: Logger;

  constructor(options: PostgresStorageOptions) {
    this.logger = options.logger.child('storage.pg');
    this.client = new PostgresClient({
      connectionString: options.connectionString,
      logger: this.logger,
      ...(options.driver ? { driver: options.driver } : {}),
    });
  }

  async init(): Promise<void> {
    await this.client.migrate();
    this.logger.info('storage ready', { driver: 'postgres' });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async health(): Promise<StorageHealth> {
    try {
      const row = await this.client.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM traces');
      return { ok: true, driver: 'postgres', traceCount: num(row?.n) };
    } catch (e) {
      return {
        ok: false,
        driver: 'postgres',
        traceCount: 0,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ── writes ────────────────────────────────────────────────────────────────

  async saveTraceBundle(bundle: TraceBundle): Promise<void> {
    await this.upsertTrace(bundle.trace, bundle.attribution, bundle.sessionTurn, true);
    for (const span of bundle.spans) await this.upsertSpan(span);

    // Analysis is at-least-once (inline on root arrival, plus the cron sweep) and
    // finding ids are freshly generated each run, so an upsert would never match
    // and every re-analysis would double the findings. The stored set is defined
    // as "whatever the latest analysis produced", so replace it wholesale.
    await this.client.run('DELETE FROM findings WHERE trace_id = $1', [bundle.trace.traceId]);
    for (const finding of bundle.findings) await this.upsertFinding(finding);
    for (const run of bundle.detectorRuns) {
      await this.client.run(
        `INSERT INTO detector_runs
           (trace_id, detector_id, tier, outcome, duration_ms, finding_count, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (trace_id, detector_id) DO UPDATE SET
           outcome = EXCLUDED.outcome,
           duration_ms = EXCLUDED.duration_ms,
           finding_count = EXCLUDED.finding_count`,
        [run.traceId, run.detectorId, run.tier, run.outcome, run.durationMs, run.findingCount, run.createdAt],
      );
    }
  }

  /** Persist spans without analysing — the serverless ingest path (ADR-0009). */
  async saveSpans(
    trace: TraceRecord,
    spans: readonly SpanRecord[],
  ): Promise<void> {
    await this.upsertTrace(trace, undefined, undefined, false);
    for (const span of spans) await this.upsertSpan(span);
  }

  private async upsertTrace(
    trace: TraceRecord,
    attribution: Attribution | undefined,
    sessionTurn: SessionTurn | undefined,
    analysed: boolean,
  ): Promise<void> {
    await this.client.run(
      `INSERT INTO traces (
         trace_id, session_id, service, environment, root_span_id, name,
         start_time, end_time, duration_ms, status, span_count,
         total_input_tokens, total_output_tokens, total_cost_usd,
         finding_count, worst_severity, attributes, attribution, session_turn, analyzed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (trace_id) DO UPDATE SET
         session_id = COALESCE(EXCLUDED.session_id, traces.session_id),
         root_span_id = COALESCE(EXCLUDED.root_span_id, traces.root_span_id),
         -- A trace grows as spans arrive, so the envelope only ever widens.
         start_time = LEAST(traces.start_time, EXCLUDED.start_time),
         end_time = GREATEST(traces.end_time, EXCLUDED.end_time),
         duration_ms = GREATEST(traces.end_time, EXCLUDED.end_time)
                     - LEAST(traces.start_time, EXCLUDED.start_time),
         status = CASE WHEN EXCLUDED.status = 'error' THEN 'error' ELSE traces.status END,
         span_count = GREATEST(traces.span_count, EXCLUDED.span_count),
         total_input_tokens = GREATEST(traces.total_input_tokens, EXCLUDED.total_input_tokens),
         total_output_tokens = GREATEST(traces.total_output_tokens, EXCLUDED.total_output_tokens),
         total_cost_usd = GREATEST(traces.total_cost_usd, EXCLUDED.total_cost_usd),
         finding_count = GREATEST(traces.finding_count, EXCLUDED.finding_count),
         worst_severity = COALESCE(EXCLUDED.worst_severity, traces.worst_severity),
         attributes = CASE WHEN EXCLUDED.attributes = '{}'::jsonb
                           THEN traces.attributes ELSE EXCLUDED.attributes END,
         attribution = COALESCE(EXCLUDED.attribution, traces.attribution),
         session_turn = COALESCE(EXCLUDED.session_turn, traces.session_turn),
         analyzed_at = COALESCE(EXCLUDED.analyzed_at, traces.analyzed_at)`,
      [
        trace.traceId,
        trace.sessionId ?? null,
        trace.service,
        trace.environment,
        trace.rootSpanId ?? null,
        trace.name,
        trace.startTime,
        trace.endTime,
        trace.durationMs,
        trace.status,
        trace.spanCount,
        trace.totalInputTokens,
        trace.totalOutputTokens,
        trace.totalCostUsd,
        trace.findingCount,
        trace.worstSeverity ?? null,
        JSON.stringify(trace.attributes),
        attribution ? JSON.stringify(attribution) : null,
        sessionTurn ? JSON.stringify(sessionTurn) : null,
        analysed ? Date.now() : null,
      ],
    );
  }

  private async upsertSpan(span: SpanRecord): Promise<void> {
    await this.client.run(
      `INSERT INTO spans (
         span_id, trace_id, parent_span_id, name, kind, start_time, end_time,
         duration_ms, status, status_message, attributes, events, llm, retrieval, tool, agent
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (span_id) DO NOTHING`,
      [
        span.spanId,
        span.traceId,
        span.parentSpanId ?? null,
        span.name,
        span.kind,
        span.startTime,
        span.endTime,
        span.durationMs,
        span.status,
        span.statusMessage ?? null,
        JSON.stringify(span.attributes),
        JSON.stringify(span.events),
        span.llm ? JSON.stringify(span.llm) : null,
        span.retrieval ? JSON.stringify(span.retrieval) : null,
        span.tool ? JSON.stringify(span.tool) : null,
        span.agent ? JSON.stringify(span.agent) : null,
      ],
    );
  }

  private async upsertFinding(finding: Finding): Promise<void> {
    await this.client.run(
      `INSERT INTO findings (
         finding_id, trace_id, span_id, code, family, severity, confidence,
         detector_id, tier, title, detail, evidence, role, caused_by,
         taxonomy_version, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (finding_id) DO UPDATE SET
         role = EXCLUDED.role, caused_by = EXCLUDED.caused_by`,
      [
        finding.findingId,
        finding.traceId,
        finding.spanId ?? null,
        finding.code,
        familyOf(finding.code) ?? 'INF',
        finding.severity,
        finding.confidence,
        finding.detectorId,
        finding.tier,
        finding.title,
        finding.detail,
        JSON.stringify(finding.evidence),
        finding.role,
        finding.causedBy ?? null,
        finding.taxonomyVersion,
        finding.createdAt,
      ],
    );
  }

  /** Traces whose spans landed but which were never analysed (ADR-0009 sweep). */
  async listUnanalysedTraces(olderThan: number, limit = 50): Promise<readonly string[]> {
    const rows = await this.client.query<{ trace_id: string }>(
      `SELECT trace_id FROM traces
       WHERE analyzed_at IS NULL AND start_time < $1
       ORDER BY start_time ASC LIMIT $2`,
      [olderThan, limit],
    );
    return rows.map((r) => r.trace_id);
  }

  async getTraceSpans(traceId: string): Promise<readonly SpanRecord[]> {
    const rows = await this.client.query<SpanRow>(
      'SELECT * FROM spans WHERE trace_id = $1 ORDER BY start_time ASC',
      [traceId],
    );
    return rows.map(rowToSpan);
  }

  async getTraceRecord(traceId: string): Promise<TraceRecord | undefined> {
    const row = await this.client.queryOne<TraceRow>(
      'SELECT * FROM traces WHERE trace_id = $1',
      [traceId],
    );
    return row ? rowToTrace(row) : undefined;
  }

  // ── trace reads ───────────────────────────────────────────────────────────

  async getTrace(traceId: string): Promise<TraceDetail | undefined> {
    const row = await this.client.queryOne<TraceRow>(
      'SELECT * FROM traces WHERE trace_id = $1',
      [traceId],
    );
    if (!row) return undefined;

    const spans = (
      await this.client.query<SpanRow>(
        'SELECT * FROM spans WHERE trace_id = $1 ORDER BY start_time ASC',
        [traceId],
      )
    ).map(rowToSpan);

    const findings = (
      await this.client.query<FindingRow>(
        'SELECT * FROM findings WHERE trace_id = $1 ORDER BY created_at ASC',
        [traceId],
      )
    ).map(rowToFinding);

    const attribution = row.attribution ? json<Attribution | undefined>(row.attribution, undefined) : undefined;

    return {
      trace: rowToTrace(row),
      spans,
      findings,
      ...(attribution ? { attribution } : {}),
    };
  }

  async listTraces(query: TraceQuery): Promise<Page<TraceSummary>> {
    const p = new Params();
    const where: string[] = [];

    if (query.range) {
      where.push(`t.start_time >= ${p.next(query.range.from)} AND t.start_time <= ${p.next(query.range.to)}`);
    }
    if (query.service) where.push(`t.service = ${p.next(query.service)}`);
    if (query.environment) where.push(`t.environment = ${p.next(query.environment)}`);
    if (query.sessionId) where.push(`t.session_id = ${p.next(query.sessionId)}`);
    if (query.status) where.push(`t.status = ${p.next(query.status)}`);
    if (query.hasFindings) where.push('t.finding_count > 0');
    if (query.minSeverity) {
      const allowed = severitiesAtLeast(query.minSeverity);
      where.push(`t.worst_severity IN (${allowed.map((s) => p.next(s)).join(',')})`);
    }
    if (query.code) {
      where.push(
        `EXISTS (SELECT 1 FROM findings f WHERE f.trace_id = t.trace_id AND f.code = ${p.next(query.code)})`,
      );
    }
    if (query.cursor) where.push(`t.start_time < ${p.next(Number(query.cursor))}`);

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = clampLimit(query.limit);

    const totalRow = await this.client.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM traces t ${clause}`,
      p.values,
    );

    const rows = await this.client.query<TraceRow>(
      `SELECT * FROM traces t ${clause} ORDER BY t.start_time DESC LIMIT ${p.next(limit + 1)}`,
      p.values,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(rowToTraceSummary),
      total: num(totalRow?.n),
      ...(hasMore && last ? { nextCursor: String(num(last.start_time)) } : {}),
    };
  }

  // ── findings ──────────────────────────────────────────────────────────────

  async listFindings(query: FindingQuery): Promise<Page<Finding>> {
    const p = new Params();
    const where: string[] = [];

    if (query.range) {
      where.push(`created_at >= ${p.next(query.range.from)} AND created_at <= ${p.next(query.range.to)}`);
    }
    if (query.code) where.push(`code = ${p.next(query.code)}`);
    if (query.family) where.push(`family = ${p.next(query.family)}`);
    if (query.severity) where.push(`severity = ${p.next(query.severity)}`);
    if (query.tier) where.push(`tier = ${p.next(query.tier)}`);
    if (query.role) where.push(`role = ${p.next(query.role)}`);
    if (query.traceId) where.push(`trace_id = ${p.next(query.traceId)}`);
    if (query.cursor) where.push(`created_at < ${p.next(Number(query.cursor))}`);

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = clampLimit(query.limit);

    const totalRow = await this.client.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM findings ${clause}`,
      p.values,
    );

    const rows = await this.client.query<FindingRow>(
      `SELECT * FROM findings ${clause} ORDER BY created_at DESC LIMIT ${p.next(limit + 1)}`,
      p.values,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(rowToFinding),
      total: num(totalRow?.n),
      ...(hasMore && last ? { nextCursor: String(num(last.created_at)) } : {}),
    };
  }

  // ── incidents ─────────────────────────────────────────────────────────────

  async upsertIncident(incident: Incident): Promise<void> {
    await this.client.run(
      `INSERT INTO incidents (
         incident_id, code, origin_operation, severity, status,
         first_seen, last_seen, occurrences, trace_ids, title, hypothesis, cohorts
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (incident_id) DO UPDATE SET
         severity = EXCLUDED.severity,
         status = EXCLUDED.status,
         last_seen = EXCLUDED.last_seen,
         occurrences = EXCLUDED.occurrences,
         trace_ids = EXCLUDED.trace_ids,
         hypothesis = EXCLUDED.hypothesis,
         cohorts = EXCLUDED.cohorts`,
      [
        incident.incidentId,
        incident.code,
        incident.originOperation,
        incident.severity,
        incident.status,
        incident.firstSeen,
        incident.lastSeen,
        incident.occurrences,
        JSON.stringify(incident.traceIds.slice(-200)),
        incident.title,
        incident.hypothesis ?? null,
        JSON.stringify(incident.cohorts),
      ],
    );
  }

  async listIncidents(query: IncidentQuery): Promise<Page<Incident>> {
    const p = new Params();
    const where: string[] = [];

    if (query.status) where.push(`status = ${p.next(query.status)}`);
    if (query.code) where.push(`code = ${p.next(query.code)}`);
    if (query.minSeverity) {
      const allowed = severitiesAtLeast(query.minSeverity);
      where.push(`severity IN (${allowed.map((s) => p.next(s)).join(',')})`);
    }
    if (query.cursor) where.push(`last_seen < ${p.next(Number(query.cursor))}`);

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = clampLimit(query.limit);

    const totalRow = await this.client.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM incidents ${clause}`,
      p.values,
    );

    const rows = await this.client.query<IncidentRow>(
      `SELECT * FROM incidents ${clause} ORDER BY last_seen DESC LIMIT ${p.next(limit + 1)}`,
      p.values,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(rowToIncident),
      total: num(totalRow?.n),
      ...(hasMore && last ? { nextCursor: String(num(last.last_seen)) } : {}),
    };
  }

  async getIncident(incidentId: string): Promise<IncidentDetail | undefined> {
    const row = await this.client.queryOne<IncidentRow>(
      'SELECT * FROM incidents WHERE incident_id = $1',
      [incidentId],
    );
    if (!row) return undefined;

    const incident = rowToIncident(row);
    const traceIds = incident.traceIds.slice(-50);
    if (traceIds.length === 0) return { incident, findings: [] };

    const findings = (
      await this.client.query<FindingRow>(
        `SELECT * FROM findings WHERE code = $1 AND trace_id = ANY($2::text[])
         ORDER BY created_at DESC LIMIT 200`,
        [incident.code, traceIds as unknown as SqlValue],
      )
    ).map(rowToFinding);

    return { incident, findings };
  }

  async findOpenIncident(
    code: TaxonomyCode,
    originOperation: string,
    since: number,
  ): Promise<Incident | undefined> {
    const row = await this.client.queryOne<IncidentRow>(
      `SELECT * FROM incidents
       WHERE code = $1 AND origin_operation = $2 AND status = 'open' AND last_seen >= $3
       ORDER BY last_seen DESC LIMIT 1`,
      [code, originOperation, since],
    );
    return row ? rowToIncident(row) : undefined;
  }

  async resolveStaleIncidents(before: number): Promise<number> {
    const rows = await this.client.query<{ incident_id: string }>(
      `UPDATE incidents SET status = 'resolved'
       WHERE status = 'open' AND last_seen < $1
       RETURNING incident_id`,
      [before],
    );
    return rows.length;
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  async getPreviousSessionTurn(
    sessionId: string,
    beforeTime: number,
  ): Promise<{ turn: SessionTurn; turnIndex: number } | undefined> {
    const row = await this.client.queryOne<{ session_turn: unknown }>(
      `SELECT session_turn FROM traces
       WHERE session_id = $1 AND start_time < $2 AND session_turn IS NOT NULL
       ORDER BY start_time DESC LIMIT 1`,
      [sessionId, beforeTime],
    );
    if (!row?.session_turn) return undefined;

    const countRow = await this.client.queryOne<{ n: string }>(
      'SELECT COUNT(*) AS n FROM traces WHERE session_id = $1 AND start_time < $2',
      [sessionId, beforeTime],
    );

    const turn = json<SessionTurn | undefined>(row.session_turn, undefined);
    return turn ? { turn, turnIndex: num(countRow?.n) } : undefined;
  }

  async listSessions(query: SessionQuery): Promise<Page<SessionSummary>> {
    const p = new Params();
    const where: string[] = ['session_id IS NOT NULL'];

    if (query.range) {
      where.push(`start_time >= ${p.next(query.range.from)} AND start_time <= ${p.next(query.range.to)}`);
    }
    if (query.service) where.push(`service = ${p.next(query.service)}`);
    if (query.cursor) where.push(`start_time < ${p.next(Number(query.cursor))}`);

    const clause = `WHERE ${where.join(' AND ')}`;
    const having = query.minTraces ? `HAVING COUNT(*) >= ${Math.floor(query.minTraces)}` : '';
    const limit = clampLimit(query.limit);

    const totalRow = await this.client.queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT session_id FROM traces ${clause} GROUP BY session_id ${having}
       ) s`,
      p.values,
    );

    const rows = await this.client.query<SessionRow>(
      `SELECT session_id,
              MIN(service) AS service,
              MIN(environment) AS environment,
              COUNT(*) AS trace_count,
              MIN(start_time) AS start_time,
              MAX(end_time) AS last_seen,
              COALESCE(SUM(total_cost_usd), 0) AS cost,
              COALESCE(SUM(total_input_tokens + total_output_tokens), 0) AS tokens,
              COALESCE(SUM(finding_count), 0) AS findings,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
       FROM traces ${clause}
       GROUP BY session_id ${having}
       ORDER BY last_seen DESC LIMIT ${p.next(limit + 1)}`,
      p.values,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    const severities = new Map<string, Severity>();
    if (page.length > 0) {
      const ids = page.map((r) => r.session_id);
      for (const row of await this.client.query<{ session_id: string; severity: Severity }>(
        `SELECT t.session_id, f.severity FROM findings f
         JOIN traces t ON t.trace_id = f.trace_id
         WHERE t.session_id = ANY($1::text[])`,
        [ids as unknown as SqlValue],
      )) {
        const worst = maxSeverity(severities.get(row.session_id), row.severity);
        if (worst) severities.set(row.session_id, worst);
      }
    }

    return {
      items: page.map((r) => ({
        sessionId: r.session_id,
        service: r.service,
        environment: r.environment,
        traceCount: num(r.trace_count),
        startTime: num(r.start_time),
        lastSeen: num(r.last_seen),
        totalCostUsd: Number(r.cost),
        totalTokens: num(r.tokens),
        findingCount: num(r.findings),
        errorCount: num(r.errors),
        ...(severities.get(r.session_id) ? { worstSeverity: severities.get(r.session_id) } : {}),
      })),
      total: num(totalRow?.n),
      ...(hasMore && last ? { nextCursor: String(num(last.start_time)) } : {}),
    };
  }

  async getSessionTraces(sessionId: string, limit = 200): Promise<readonly TraceSummary[]> {
    const rows = await this.client.query<TraceRow>(
      'SELECT * FROM traces WHERE session_id = $1 ORDER BY start_time ASC LIMIT $2',
      [sessionId, clampLimit(limit)],
    );
    return rows.map(rowToTraceSummary);
  }

  async costByCohort(key: string, range: TimeRange, limit = 20): Promise<readonly CostBucket[]> {
    const safeKey = key.replace(/[^A-Za-z0-9_.]/g, '');
    const expr =
      key === 'service' || key === 'environment' ? `t.${key}` : `t.attributes ->> '${safeKey}'`;

    const rows = await this.client.query<{
      value: string | null;
      traces: string;
      cost: string;
      tokens: string;
    }>(
      `SELECT ${expr} AS value,
              COUNT(*) AS traces,
              COALESCE(SUM(t.total_cost_usd), 0) AS cost,
              COALESCE(SUM(t.total_input_tokens + t.total_output_tokens), 0) AS tokens
       FROM traces t
       WHERE t.start_time >= $1 AND t.start_time <= $2
       GROUP BY value
       ORDER BY cost DESC
       LIMIT $3`,
      [range.from, range.to, limit],
    );

    return rows
      .filter((r) => r.value !== null && r.value !== undefined)
      .map((r) => ({
        value: String(r.value),
        traces: num(r.traces),
        costUsd: Number(r.cost),
        tokens: num(r.tokens),
      }));
  }

  // ── baselines ─────────────────────────────────────────────────────────────

  async getBaseline(metric: string, scope: string): Promise<BaselineRow | undefined> {
    const row = await this.client.queryOne<{
      metric: string;
      scope: string;
      stats: unknown;
      updated_at: string;
    }>('SELECT * FROM baselines WHERE metric = $1 AND scope = $2', [metric, scope]);
    if (!row) return undefined;
    return {
      metric: row.metric,
      scope: row.scope,
      stats: json(row.stats, { count: 0, mean: 0, m2: 0, min: 0, max: 0, samples: [] }),
      updatedAt: num(row.updated_at),
    };
  }

  async listBaselines(): Promise<readonly BaselineRow[]> {
    const rows = await this.client.query<{
      metric: string;
      scope: string;
      stats: unknown;
      updated_at: string;
    }>('SELECT * FROM baselines');
    return rows.map((row) => ({
      metric: row.metric,
      scope: row.scope,
      stats: json(row.stats, { count: 0, mean: 0, m2: 0, min: 0, max: 0, samples: [] }),
      updatedAt: num(row.updated_at),
    }));
  }

  async putBaselines(rows: readonly BaselineRow[]): Promise<void> {
    for (const row of rows) {
      await this.client.run(
        `INSERT INTO baselines (metric, scope, stats, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (metric, scope) DO UPDATE SET
           stats = EXCLUDED.stats, updated_at = EXCLUDED.updated_at`,
        [row.metric, row.scope, JSON.stringify(row.stats), row.updatedAt],
      );
    }
  }

  // ── stats ─────────────────────────────────────────────────────────────────

  async overview(range: TimeRange): Promise<OverviewStats> {
    const totals = await this.client.queryOne<{
      n: string;
      errors: string;
      cost: string;
      intok: string;
      outtok: string;
    }>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(SUM(total_cost_usd), 0) AS cost,
              COALESCE(SUM(total_input_tokens), 0) AS intok,
              COALESCE(SUM(total_output_tokens), 0) AS outtok
       FROM traces WHERE start_time >= $1 AND start_time <= $2`,
      [range.from, range.to],
    );

    const durations = (
      await this.client.query<{ duration_ms: string }>(
        'SELECT duration_ms FROM traces WHERE start_time >= $1 AND start_time <= $2',
        [range.from, range.to],
      )
    ).map((r) => num(r.duration_ms));

    const findingRow = await this.client.queryOne<{ n: string }>(
      'SELECT COUNT(*) AS n FROM findings WHERE created_at >= $1 AND created_at <= $2',
      [range.from, range.to],
    );

    const bySeverity: Record<Severity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    for (const row of await this.client.query<{ severity: Severity; n: string }>(
      `SELECT severity, COUNT(*) AS n FROM findings
       WHERE created_at >= $1 AND created_at <= $2 GROUP BY severity`,
      [range.from, range.to],
    )) {
      bySeverity[row.severity] = num(row.n);
    }

    const incidents = await this.client.queryOne<{ n: string; open: string }>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open
       FROM incidents WHERE last_seen >= $1 AND last_seen <= $2`,
      [range.from, range.to],
    );

    const traceCount = num(totals?.n);
    const errorTraceCount = num(totals?.errors);

    return {
      traceCount,
      errorTraceCount,
      failureRate: traceCount === 0 ? 0 : errorTraceCount / traceCount,
      findingCount: num(findingRow?.n),
      incidentCount: num(incidents?.n),
      openIncidentCount: num(incidents?.open),
      totalCostUsd: Number(totals?.cost ?? 0),
      totalTokens: num(totals?.intok) + num(totals?.outtok),
      p50DurationMs: percentile(durations, 50),
      p95DurationMs: percentile(durations, 95),
      bySeverity,
      topCodes: await this.codeFrequency(range, 8),
    };
  }

  async timeseries(query: TimeseriesQuery): Promise<readonly TimeBucket[]> {
    const { range, bucketMs } = query;
    const traces = await this.client.query<{
      start_time: string;
      status: string;
      duration_ms: string;
      total_cost_usd: string;
      finding_count: number;
    }>(
      `SELECT start_time, status, duration_ms, total_cost_usd, finding_count
       FROM traces WHERE start_time >= $1 AND start_time <= $2 ORDER BY start_time ASC`,
      [range.from, range.to],
    );

    const buckets = new Map<
      number,
      { traces: number; errors: number; findings: number; cost: number; durations: number[] }
    >();
    for (let t = Math.floor(range.from / bucketMs) * bucketMs; t <= range.to; t += bucketMs) {
      buckets.set(t, { traces: 0, errors: 0, findings: 0, cost: 0, durations: [] });
    }

    for (const row of traces) {
      const key = Math.floor(num(row.start_time) / bucketMs) * bucketMs;
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.traces++;
      if (row.status === 'error') bucket.errors++;
      bucket.findings += num(row.finding_count);
      bucket.cost += Number(row.total_cost_usd);
      bucket.durations.push(num(row.duration_ms));
    }

    return [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([start, b]) => ({
        start,
        traces: b.traces,
        errors: b.errors,
        findings: b.findings,
        costUsd: b.cost,
        p95DurationMs: percentile(b.durations, 95),
      }));
  }

  async codeFrequency(range: TimeRange, limit = 20): Promise<readonly CodeCount[]> {
    const rows = await this.client.query<{ code: string; severity: Severity; n: string }>(
      `SELECT code, severity, COUNT(*) AS n FROM findings
       WHERE created_at >= $1 AND created_at <= $2
       GROUP BY code, severity ORDER BY n DESC LIMIT $3`,
      [range.from, range.to, limit],
    );
    return rows.map((r) => ({ code: r.code, count: num(r.n), severity: r.severity }));
  }

  async cohortCounts(
    code: TaxonomyCode,
    key: string,
    range: TimeRange,
  ): Promise<readonly CohortCount[]> {
    const safeKey = key.replace(/[^A-Za-z0-9_.]/g, '');
    const expr =
      key === 'service' || key === 'environment' ? `t.${key}` : `t.attributes ->> '${safeKey}'`;

    const rows = await this.client.query<{ value: string | null; withcode: string; total: string }>(
      `SELECT ${expr} AS value,
              COALESCE(SUM(CASE WHEN EXISTS (
                SELECT 1 FROM findings f WHERE f.trace_id = t.trace_id AND f.code = $1
              ) THEN 1 ELSE 0 END), 0) AS withcode,
              COUNT(*) AS total
       FROM traces t
       WHERE t.start_time >= $2 AND t.start_time <= $3
       GROUP BY value`,
      [code, range.from, range.to],
    );

    return rows
      .filter((r) => r.value !== null && r.value !== undefined)
      .map((r) => ({ value: String(r.value), withCode: num(r.withcode), total: num(r.total) }));
  }

  async codeRate(code: TaxonomyCode, range: TimeRange): Promise<{ withCode: number; total: number }> {
    const row = await this.client.queryOne<{ withcode: string; total: string }>(
      `SELECT COALESCE(SUM(CASE WHEN EXISTS (
                SELECT 1 FROM findings f WHERE f.trace_id = t.trace_id AND f.code = $1
              ) THEN 1 ELSE 0 END), 0) AS withcode,
              COUNT(*) AS total
       FROM traces t WHERE t.start_time >= $2 AND t.start_time <= $3`,
      [code, range.from, range.to],
    );
    return { withCode: num(row?.withcode), total: num(row?.total) };
  }

  // ── retention ─────────────────────────────────────────────────────────────

  async purgeOlderThan(cutoff: number): Promise<PurgeResult> {
    const spanRow = await this.client.queryOne<{ n: string }>(
      'SELECT COUNT(*) AS n FROM spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE start_time < $1)',
      [cutoff],
    );
    const findingRow = await this.client.queryOne<{ n: string }>(
      'SELECT COUNT(*) AS n FROM findings WHERE created_at < $1',
      [cutoff],
    );

    await this.client.run('DELETE FROM findings WHERE created_at < $1', [cutoff]);
    await this.client.run(
      'DELETE FROM detector_runs WHERE trace_id IN (SELECT trace_id FROM traces WHERE start_time < $1)',
      [cutoff],
    );
    // Spans cascade from traces, so the parent delete is last and authoritative.
    const traceRows = await this.client.query<{ trace_id: string }>(
      'DELETE FROM traces WHERE start_time < $1 RETURNING trace_id',
      [cutoff],
    );

    return {
      traces: traceRows.length,
      spans: num(spanRow?.n),
      findings: num(findingRow?.n),
    };
  }
}

// ── row mapping ─────────────────────────────────────────────────────────────

interface TraceRow {
  trace_id: string;
  session_id: string | null;
  service: string;
  environment: string;
  root_span_id: string | null;
  name: string;
  start_time: string;
  end_time: string;
  duration_ms: string;
  status: string;
  span_count: number;
  total_input_tokens: string;
  total_output_tokens: string;
  total_cost_usd: string;
  finding_count: number;
  worst_severity: string | null;
  attributes: unknown;
  attribution: unknown;
  session_turn: unknown;
  analyzed_at: string | null;
}

interface SpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_time: string;
  end_time: string;
  duration_ms: string;
  status: string;
  status_message: string | null;
  attributes: unknown;
  events: unknown;
  llm: unknown;
  retrieval: unknown;
  tool: unknown;
  agent: unknown;
}

interface FindingRow {
  finding_id: string;
  trace_id: string;
  span_id: string | null;
  code: string;
  family: string;
  severity: string;
  confidence: string;
  detector_id: string;
  tier: string;
  title: string;
  detail: string;
  evidence: unknown;
  role: string;
  caused_by: string | null;
  taxonomy_version: string;
  created_at: string;
}

interface IncidentRow {
  incident_id: string;
  code: string;
  origin_operation: string;
  severity: string;
  status: string;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  trace_ids: unknown;
  title: string;
  hypothesis: string | null;
  cohorts: unknown;
}

interface SessionRow {
  session_id: string;
  service: string;
  environment: string;
  trace_count: string;
  start_time: string;
  last_seen: string;
  cost: string;
  tokens: string;
  findings: string;
  errors: string;
}

function rowToTrace(row: TraceRow): TraceRecord {
  return {
    traceId: row.trace_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    service: row.service,
    environment: row.environment,
    ...(row.root_span_id ? { rootSpanId: row.root_span_id } : {}),
    name: row.name,
    startTime: num(row.start_time),
    endTime: num(row.end_time),
    durationMs: num(row.duration_ms),
    status: row.status as TraceRecord['status'],
    spanCount: num(row.span_count),
    totalInputTokens: num(row.total_input_tokens),
    totalOutputTokens: num(row.total_output_tokens),
    totalCostUsd: Number(row.total_cost_usd),
    findingCount: num(row.finding_count),
    ...(row.worst_severity ? { worstSeverity: row.worst_severity as Severity } : {}),
    attributes: json(row.attributes, {}),
  };
}

function rowToTraceSummary(row: TraceRow): TraceSummary {
  return {
    traceId: row.trace_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    service: row.service,
    environment: row.environment,
    name: row.name,
    startTime: num(row.start_time),
    durationMs: num(row.duration_ms),
    status: row.status as TraceSummary['status'],
    spanCount: num(row.span_count),
    totalCostUsd: Number(row.total_cost_usd),
    totalTokens: num(row.total_input_tokens) + num(row.total_output_tokens),
    findingCount: num(row.finding_count),
    ...(row.worst_severity ? { worstSeverity: row.worst_severity as Severity } : {}),
  };
}

function rowToSpan(row: SpanRow): SpanRecord {
  const llm = row.llm ? json<SpanRecord['llm']>(row.llm, undefined) : undefined;
  const retrieval = row.retrieval ? json<SpanRecord['retrieval']>(row.retrieval, undefined) : undefined;
  const tool = row.tool ? json<SpanRecord['tool']>(row.tool, undefined) : undefined;
  const agent = row.agent ? json<SpanRecord['agent']>(row.agent, undefined) : undefined;

  return {
    spanId: row.span_id,
    traceId: row.trace_id,
    ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
    name: row.name,
    kind: row.kind as SpanRecord['kind'],
    startTime: num(row.start_time),
    endTime: num(row.end_time),
    durationMs: num(row.duration_ms),
    status: row.status as SpanRecord['status'],
    ...(row.status_message ? { statusMessage: row.status_message } : {}),
    attributes: json(row.attributes, {}),
    events: json(row.events, []),
    ...(llm ? { llm } : {}),
    ...(retrieval ? { retrieval } : {}),
    ...(tool ? { tool } : {}),
    ...(agent ? { agent } : {}),
  };
}

function rowToFinding(row: FindingRow): Finding {
  return {
    findingId: row.finding_id,
    traceId: row.trace_id,
    ...(row.span_id ? { spanId: row.span_id } : {}),
    code: row.code,
    severity: row.severity as Severity,
    confidence: Number(row.confidence),
    detectorId: row.detector_id,
    tier: row.tier as Finding['tier'],
    title: row.title,
    detail: row.detail,
    evidence: json(row.evidence, []),
    role: row.role as Finding['role'],
    ...(row.caused_by ? { causedBy: row.caused_by } : {}),
    taxonomyVersion: row.taxonomy_version,
    createdAt: num(row.created_at),
  };
}

function rowToIncident(row: IncidentRow): Incident {
  return {
    incidentId: row.incident_id,
    code: row.code,
    originOperation: row.origin_operation,
    severity: row.severity as Severity,
    status: row.status as Incident['status'],
    firstSeen: num(row.first_seen),
    lastSeen: num(row.last_seen),
    occurrences: num(row.occurrences),
    traceIds: json(row.trace_ids, []),
    title: row.title,
    ...(row.hypothesis ? { hypothesis: row.hypothesis } : {}),
    cohorts: json(row.cohorts, []),
  };
}

function clampLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

function severitiesAtLeast(min: Severity): Severity[] {
  const floor = SEVERITY_RANK[min];
  return (Object.keys(SEVERITY_RANK) as Severity[]).filter((s) => SEVERITY_RANK[s] >= floor);
}
