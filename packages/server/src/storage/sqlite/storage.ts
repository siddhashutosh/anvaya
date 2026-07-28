/**
 * SqliteStorage — the default Storage adapter.
 *
 * All SQL in the system lives in this file and in migrations.ts (FR-5.1).
 */

import { statSync } from 'node:fs';
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
  SessionQuery,
  IncidentDetail,
  IncidentQuery,
  OverviewStats,
  PurgeResult,
  Storage,
  StorageHealth,
  TimeBucket,
  TimeseriesQuery,
  TraceBundle,
  TraceDetail,
  TraceQuery,
} from '../types.js';
import { SqliteClient, type SqlValue } from './client.js';
import {
  rowToFinding,
  rowToIncident,
  rowToSpan,
  rowToTrace,
  rowToTraceSummary,
  type FindingRow,
  type IncidentRow,
  type SpanRow,
  type TraceRow,
} from './mappers.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export interface SqliteStorageOptions {
  readonly path: string;
  readonly busyTimeoutMs: number;
  readonly logger: Logger;
}

export class SqliteStorage implements Storage {
  private readonly client: SqliteClient;
  private readonly logger: Logger;

  constructor(private readonly options: SqliteStorageOptions) {
    this.logger = options.logger.child('storage');
    this.client = new SqliteClient({
      path: options.path,
      busyTimeoutMs: options.busyTimeoutMs,
      logger: this.logger,
    });
  }

  async init(): Promise<void> {
    this.client.open();
    this.client.migrate();
    this.logger.info('storage ready', { path: this.options.path, driver: 'sqlite' });
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async health(): Promise<StorageHealth> {
    try {
      const row = this.client.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM traces');
      let sizeBytes: number | undefined;
      if (this.options.path !== ':memory:') {
        try {
          sizeBytes = statSync(this.options.path).size;
        } catch {
          // File may not exist yet; not a health failure.
        }
      }
      return {
        ok: true,
        driver: 'sqlite',
        traceCount: row?.n ?? 0,
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      };
    } catch (e) {
      return {
        ok: false,
        driver: 'sqlite',
        traceCount: 0,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ── writes ────────────────────────────────────────────────────────────────

  async saveTraceBundle(bundle: TraceBundle): Promise<void> {
    this.client.transaction(() => {
      this.insertTrace(bundle.trace, bundle.attribution, bundle.sessionTurn);
      for (const span of bundle.spans) this.insertSpan(span);
      for (const finding of bundle.findings) this.insertFinding(finding);
      for (const run of bundle.detectorRuns) {
        this.client.run(
          `INSERT OR REPLACE INTO detector_runs
             (trace_id, detector_id, tier, outcome, duration_ms, finding_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [run.traceId, run.detectorId, run.tier, run.outcome, run.durationMs, run.findingCount, run.createdAt],
        );
      }
    });
  }

  private insertTrace(
    trace: TraceRecord,
    attribution?: Attribution,
    sessionTurn?: SessionTurn,
  ): void {
    this.client.run(
      `INSERT INTO traces (
         trace_id, session_id, service, environment, root_span_id, name,
         start_time, end_time, duration_ms, status, span_count,
         total_input_tokens, total_output_tokens, total_cost_usd,
         finding_count, worst_severity, attributes, attribution, session_turn
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(trace_id) DO UPDATE SET
         end_time = excluded.end_time,
         duration_ms = excluded.duration_ms,
         status = excluded.status,
         span_count = excluded.span_count,
         total_input_tokens = excluded.total_input_tokens,
         total_output_tokens = excluded.total_output_tokens,
         total_cost_usd = excluded.total_cost_usd,
         finding_count = excluded.finding_count,
         worst_severity = excluded.worst_severity,
         attribution = excluded.attribution,
         session_turn = COALESCE(excluded.session_turn, traces.session_turn)`,
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
      ],
    );
  }

  /** INSERT OR IGNORE gives ingest idempotency on spanId (FR-2.7). */
  private insertSpan(span: SpanRecord): void {
    this.client.run(
      `INSERT OR IGNORE INTO spans (
         span_id, trace_id, parent_span_id, name, kind, start_time, end_time,
         duration_ms, status, status_message, attributes, events, llm, retrieval, tool, agent
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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

  private insertFinding(finding: Finding): void {
    this.client.run(
      `INSERT OR REPLACE INTO findings (
         finding_id, trace_id, span_id, code, family, severity, confidence,
         detector_id, tier, title, detail, evidence, role, caused_by,
         taxonomy_version, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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

  // ── trace reads ───────────────────────────────────────────────────────────

  async getTrace(traceId: string): Promise<TraceDetail | undefined> {
    const row = this.client.queryOne<TraceRow>('SELECT * FROM traces WHERE trace_id = ?', [traceId]);
    if (!row) return undefined;

    const spans = this.client
      .query<SpanRow>('SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time ASC', [traceId])
      .map(rowToSpan);
    const findings = this.client
      .query<FindingRow>('SELECT * FROM findings WHERE trace_id = ? ORDER BY created_at ASC', [traceId])
      .map(rowToFinding);

    const attribution = row.attribution
      ? (JSON.parse(row.attribution) as Attribution)
      : undefined;

    return {
      trace: rowToTrace(row),
      spans,
      findings,
      ...(attribution ? { attribution } : {}),
    };
  }

  async listTraces(query: TraceQuery): Promise<Page<TraceSummary>> {
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (query.range) {
      where.push('t.start_time >= ? AND t.start_time <= ?');
      params.push(query.range.from, query.range.to);
    }
    if (query.service) {
      where.push('t.service = ?');
      params.push(query.service);
    }
    if (query.environment) {
      where.push('t.environment = ?');
      params.push(query.environment);
    }
    if (query.sessionId) {
      where.push('t.session_id = ?');
      params.push(query.sessionId);
    }
    if (query.status) {
      where.push('t.status = ?');
      params.push(query.status);
    }
    if (query.hasFindings) where.push('t.finding_count > 0');
    if (query.minSeverity) {
      const allowed = severitiesAtLeast(query.minSeverity);
      where.push(`t.worst_severity IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    }
    if (query.code) {
      where.push('EXISTS (SELECT 1 FROM findings f WHERE f.trace_id = t.trace_id AND f.code = ?)');
      params.push(query.code);
    }
    // Cursor is the start_time of the last row seen — traces are ordered by it.
    if (query.cursor) {
      where.push('t.start_time < ?');
      params.push(Number(query.cursor));
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = clampLimit(query.limit);

    const total =
      this.client.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM traces t ${clause}`,
        params,
      )?.n ?? 0;

    const rows = this.client.query<TraceRow>(
      `SELECT * FROM traces t ${clause} ORDER BY t.start_time DESC LIMIT ?`,
      [...params, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(rowToTraceSummary),
      total,
      ...(hasMore && last ? { nextCursor: String(last.start_time) } : {}),
    };
  }

  // ── findings ──────────────────────────────────────────────────────────────

  async listFindings(query: FindingQuery): Promise<Page<Finding>> {
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (query.range) {
      where.push('created_at >= ? AND created_at <= ?');
      params.push(query.range.from, query.range.to);
    }
    if (query.code) {
      where.push('code = ?');
      params.push(query.code);
    }
    if (query.family) {
      where.push('family = ?');
      params.push(query.family);
    }
    if (query.severity) {
      where.push('severity = ?');
      params.push(query.severity);
    }
    if (query.tier) {
      where.push('tier = ?');
      params.push(query.tier);
    }
    if (query.role) {
      where.push('role = ?');
      params.push(query.role);
    }
    if (query.traceId) {
      where.push('trace_id = ?');
      params.push(query.traceId);
    }
    if (query.cursor) {
      where.push('created_at < ?');
      params.push(Number(query.cursor));
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = clampLimit(query.limit);

    const total =
      this.client.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM findings ${clause}`, params)
        ?.n ?? 0;

    const rows = this.client.query<FindingRow>(
      `SELECT * FROM findings ${clause} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(rowToFinding),
      total,
      ...(hasMore && last ? { nextCursor: String(last.created_at) } : {}),
    };
  }

  // ── incidents ─────────────────────────────────────────────────────────────

  async upsertIncident(incident: Incident): Promise<void> {
    this.client.run(
      `INSERT INTO incidents (
         incident_id, code, origin_operation, severity, status,
         first_seen, last_seen, occurrences, trace_ids, title, hypothesis, cohorts
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(incident_id) DO UPDATE SET
         severity = excluded.severity,
         status = excluded.status,
         last_seen = excluded.last_seen,
         occurrences = excluded.occurrences,
         trace_ids = excluded.trace_ids,
         hypothesis = excluded.hypothesis,
         cohorts = excluded.cohorts`,
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
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.code) {
      where.push('code = ?');
      params.push(query.code);
    }
    if (query.minSeverity) {
      const allowed = severitiesAtLeast(query.minSeverity);
      where.push(`severity IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    }
    if (query.cursor) {
      where.push('last_seen < ?');
      params.push(Number(query.cursor));
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = clampLimit(query.limit);

    const total =
      this.client.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM incidents ${clause}`, params)
        ?.n ?? 0;

    const rows = this.client.query<IncidentRow>(
      `SELECT * FROM incidents ${clause} ORDER BY last_seen DESC LIMIT ?`,
      [...params, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(rowToIncident),
      total,
      ...(hasMore && last ? { nextCursor: String(last.last_seen) } : {}),
    };
  }

  async getIncident(incidentId: string): Promise<IncidentDetail | undefined> {
    const row = this.client.queryOne<IncidentRow>(
      'SELECT * FROM incidents WHERE incident_id = ?',
      [incidentId],
    );
    if (!row) return undefined;

    const incident = rowToIncident(row);
    const traceIds = incident.traceIds.slice(-50);
    if (traceIds.length === 0) return { incident, findings: [] };

    const placeholders = traceIds.map(() => '?').join(',');
    const findings = this.client
      .query<FindingRow>(
        `SELECT * FROM findings WHERE code = ? AND trace_id IN (${placeholders})
         ORDER BY created_at DESC LIMIT 200`,
        [incident.code, ...traceIds],
      )
      .map(rowToFinding);

    return { incident, findings };
  }

  async findOpenIncident(
    code: TaxonomyCode,
    originOperation: string,
    since: number,
  ): Promise<Incident | undefined> {
    const row = this.client.queryOne<IncidentRow>(
      `SELECT * FROM incidents
       WHERE code = ? AND origin_operation = ? AND status = 'open' AND last_seen >= ?
       ORDER BY last_seen DESC LIMIT 1`,
      [code, originOperation, since],
    );
    return row ? rowToIncident(row) : undefined;
  }

  async resolveStaleIncidents(before: number): Promise<number> {
    const stale = this.client.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM incidents WHERE status = 'open' AND last_seen < ?`,
      [before],
    );
    this.client.run(`UPDATE incidents SET status = 'resolved' WHERE status = 'open' AND last_seen < ?`, [
      before,
    ]);
    return stale?.n ?? 0;
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  async getPreviousSessionTurn(
    sessionId: string,
    beforeTime: number,
  ): Promise<{ turn: SessionTurn; turnIndex: number } | undefined> {
    const row = this.client.queryOne<{ session_turn: string | null }>(
      `SELECT session_turn FROM traces
       WHERE session_id = ? AND start_time < ? AND session_turn IS NOT NULL
       ORDER BY start_time DESC LIMIT 1`,
      [sessionId, beforeTime],
    );
    if (!row?.session_turn) return undefined;

    const turnIndex =
      this.client.queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM traces WHERE session_id = ? AND start_time < ?',
        [sessionId, beforeTime],
      )?.n ?? 0;

    try {
      return { turn: JSON.parse(row.session_turn) as SessionTurn, turnIndex };
    } catch {
      // A corrupt projection must not break analysis of the current trace.
      return undefined;
    }
  }

  async listSessions(query: SessionQuery): Promise<Page<SessionSummary>> {
    const where: string[] = ['session_id IS NOT NULL'];
    const params: SqlValue[] = [];

    if (query.range) {
      where.push('start_time >= ? AND start_time <= ?');
      params.push(query.range.from, query.range.to);
    }
    if (query.service) {
      where.push('service = ?');
      params.push(query.service);
    }
    if (query.cursor) {
      where.push('start_time < ?');
      params.push(Number(query.cursor));
    }

    const clause = `WHERE ${where.join(' AND ')}`;
    const limit = clampLimit(query.limit);
    const having = query.minTraces ? `HAVING COUNT(*) >= ${Math.floor(query.minTraces)}` : '';

    const total =
      this.client.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT session_id FROM traces ${clause} GROUP BY session_id ${having}
         )`,
        params,
      )?.n ?? 0;

    const rows = this.client.query<{
      session_id: string;
      service: string;
      environment: string;
      traceCount: number;
      startTime: number;
      lastSeen: number;
      cost: number;
      tokens: number;
      findings: number;
      errors: number;
    }>(
      `SELECT session_id,
              MIN(service) AS service,
              MIN(environment) AS environment,
              COUNT(*) AS traceCount,
              MIN(start_time) AS startTime,
              MAX(end_time) AS lastSeen,
              COALESCE(SUM(total_cost_usd), 0) AS cost,
              COALESCE(SUM(total_input_tokens + total_output_tokens), 0) AS tokens,
              COALESCE(SUM(finding_count), 0) AS findings,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
       FROM traces ${clause}
       GROUP BY session_id ${having}
       ORDER BY lastSeen DESC LIMIT ?`,
      [...params, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    // Worst severity per session, resolved in one pass rather than per row.
    const severities = new Map<string, Severity>();
    if (page.length > 0) {
      const placeholders = page.map(() => '?').join(',');
      for (const row of this.client.query<{ session_id: string; severity: Severity }>(
        `SELECT t.session_id, f.severity FROM findings f
         JOIN traces t ON t.trace_id = f.trace_id
         WHERE t.session_id IN (${placeholders})`,
        page.map((r) => r.session_id),
      )) {
        const current = severities.get(row.session_id);
        const worst = maxSeverity(current, row.severity);
        if (worst) severities.set(row.session_id, worst);
      }
    }

    return {
      items: page.map((r) => ({
        sessionId: r.session_id,
        service: r.service,
        environment: r.environment,
        traceCount: r.traceCount,
        startTime: r.startTime,
        lastSeen: r.lastSeen,
        totalCostUsd: r.cost,
        totalTokens: r.tokens,
        findingCount: r.findings,
        errorCount: r.errors,
        ...(severities.get(r.session_id) ? { worstSeverity: severities.get(r.session_id) } : {}),
      })),
      total,
      ...(hasMore && last ? { nextCursor: String(last.startTime) } : {}),
    };
  }

  async getSessionTraces(sessionId: string, limit = 200): Promise<readonly TraceSummary[]> {
    return this.client
      .query<TraceRow>(
        'SELECT * FROM traces WHERE session_id = ? ORDER BY start_time ASC LIMIT ?',
        [sessionId, clampLimit(limit)],
      )
      .map(rowToTraceSummary);
  }

  async costByCohort(
    key: string,
    range: TimeRange,
    limit = 20,
  ): Promise<readonly CostBucket[]> {
    // Column keys are addressed directly; anything else lives in the JSON blob.
    const expr =
      key === 'service' || key === 'environment'
        ? `t.${key}`
        : `json_extract(t.attributes, '$.${key.replace(/[^A-Za-z0-9_.]/g, '')}')`;

    return this.client
      .query<{ value: string | null; traces: number; cost: number; tokens: number }>(
        `SELECT ${expr} AS value,
                COUNT(*) AS traces,
                COALESCE(SUM(t.total_cost_usd), 0) AS cost,
                COALESCE(SUM(t.total_input_tokens + t.total_output_tokens), 0) AS tokens
         FROM traces t
         WHERE t.start_time >= ? AND t.start_time <= ?
         GROUP BY value
         ORDER BY cost DESC
         LIMIT ?`,
        [range.from, range.to, limit],
      )
      .filter((r) => r.value !== null && r.value !== undefined)
      .map((r) => ({
        value: String(r.value),
        traces: r.traces,
        costUsd: r.cost,
        tokens: r.tokens,
      }));
  }

  // ── baselines ─────────────────────────────────────────────────────────────

  async getBaseline(metric: string, scope: string): Promise<BaselineRow | undefined> {
    const row = this.client.queryOne<{
      metric: string;
      scope: string;
      stats: string;
      updated_at: number;
    }>('SELECT * FROM baselines WHERE metric = ? AND scope = ?', [metric, scope]);
    if (!row) return undefined;
    return {
      metric: row.metric,
      scope: row.scope,
      stats: JSON.parse(row.stats),
      updatedAt: row.updated_at,
    };
  }

  async listBaselines(): Promise<readonly BaselineRow[]> {
    return this.client
      .query<{ metric: string; scope: string; stats: string; updated_at: number }>(
        'SELECT * FROM baselines',
      )
      .map((row) => ({
        metric: row.metric,
        scope: row.scope,
        stats: JSON.parse(row.stats),
        updatedAt: row.updated_at,
      }));
  }

  async putBaselines(rows: readonly BaselineRow[]): Promise<void> {
    if (rows.length === 0) return;
    this.client.transaction(() => {
      for (const row of rows) {
        this.client.run(
          `INSERT INTO baselines (metric, scope, stats, updated_at) VALUES (?,?,?,?)
           ON CONFLICT(metric, scope) DO UPDATE SET stats = excluded.stats, updated_at = excluded.updated_at`,
          [row.metric, row.scope, JSON.stringify(row.stats), row.updatedAt],
        );
      }
    });
  }

  // ── stats ─────────────────────────────────────────────────────────────────

  async overview(range: TimeRange): Promise<OverviewStats> {
    const totals = this.client.queryOne<{
      n: number;
      errors: number;
      cost: number;
      inTok: number;
      outTok: number;
    }>(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(total_cost_usd), 0) AS cost,
              COALESCE(SUM(total_input_tokens), 0) AS inTok,
              COALESCE(SUM(total_output_tokens), 0) AS outTok
       FROM traces WHERE start_time >= ? AND start_time <= ?`,
      [range.from, range.to],
    );

    const durations = this.client
      .query<{ duration_ms: number }>(
        'SELECT duration_ms FROM traces WHERE start_time >= ? AND start_time <= ?',
        [range.from, range.to],
      )
      .map((r) => r.duration_ms);

    const findingCount =
      this.client.queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM findings WHERE created_at >= ? AND created_at <= ?',
        [range.from, range.to],
      )?.n ?? 0;

    const severityRows = this.client.query<{ severity: Severity; n: number }>(
      `SELECT severity, COUNT(*) AS n FROM findings
       WHERE created_at >= ? AND created_at <= ? GROUP BY severity`,
      [range.from, range.to],
    );
    const bySeverity: Record<Severity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    for (const row of severityRows) bySeverity[row.severity] = row.n;

    const incidents = this.client.queryOne<{ n: number; open: number }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open
       FROM incidents WHERE last_seen >= ? AND last_seen <= ?`,
      [range.from, range.to],
    );

    const traceCount = totals?.n ?? 0;
    const errorTraceCount = totals?.errors ?? 0;

    return {
      traceCount,
      errorTraceCount,
      failureRate: traceCount === 0 ? 0 : errorTraceCount / traceCount,
      findingCount,
      incidentCount: incidents?.n ?? 0,
      openIncidentCount: incidents?.open ?? 0,
      totalCostUsd: totals?.cost ?? 0,
      totalTokens: (totals?.inTok ?? 0) + (totals?.outTok ?? 0),
      p50DurationMs: percentile(durations, 50),
      p95DurationMs: percentile(durations, 95),
      bySeverity,
      topCodes: await this.codeFrequency(range, 8),
    };
  }

  async timeseries(query: TimeseriesQuery): Promise<readonly TimeBucket[]> {
    const { range, bucketMs } = query;
    const traces = this.client.query<{
      start_time: number;
      status: string;
      duration_ms: number;
      total_cost_usd: number;
      finding_count: number;
    }>(
      `SELECT start_time, status, duration_ms, total_cost_usd, finding_count
       FROM traces WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC`,
      [range.from, range.to],
    );

    const buckets = new Map<
      number,
      { traces: number; errors: number; findings: number; cost: number; durations: number[] }
    >();

    // Pre-create empty buckets so the chart has a continuous x-axis rather than
    // implying activity where there was none.
    for (let t = Math.floor(range.from / bucketMs) * bucketMs; t <= range.to; t += bucketMs) {
      buckets.set(t, { traces: 0, errors: 0, findings: 0, cost: 0, durations: [] });
    }

    for (const row of traces) {
      const key = Math.floor(row.start_time / bucketMs) * bucketMs;
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.traces++;
      if (row.status === 'error') bucket.errors++;
      bucket.findings += row.finding_count;
      bucket.cost += row.total_cost_usd;
      bucket.durations.push(row.duration_ms);
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
    return this.client
      .query<{ code: string; severity: Severity; n: number }>(
        `SELECT code, severity, COUNT(*) AS n FROM findings
         WHERE created_at >= ? AND created_at <= ?
         GROUP BY code, severity ORDER BY n DESC LIMIT ?`,
        [range.from, range.to, limit],
      )
      .map((row) => ({ code: row.code, count: row.n, severity: row.severity }));
  }

  async cohortCounts(
    code: TaxonomyCode,
    key: string,
    range: TimeRange,
  ): Promise<readonly CohortCount[]> {
    // `service` and `environment` are columns; anything else lives in the JSON
    // attributes blob, so it is extracted with json_extract.
    const expr =
      key === 'service' || key === 'environment'
        ? `t.${key}`
        : `json_extract(t.attributes, '$.${key.replace(/[^A-Za-z0-9_.]/g, '')}')`;

    return this.client
      .query<{ value: string | null; withCode: number; total: number }>(
        `SELECT ${expr} AS value,
                SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM findings f WHERE f.trace_id = t.trace_id AND f.code = ?
                ) THEN 1 ELSE 0 END) AS withCode,
                COUNT(*) AS total
         FROM traces t
         WHERE t.start_time >= ? AND t.start_time <= ?
         GROUP BY value`,
        [code, range.from, range.to],
      )
      .filter((row) => row.value !== null && row.value !== undefined)
      .map((row) => ({ value: String(row.value), withCode: row.withCode, total: row.total }));
  }

  async codeRate(
    code: TaxonomyCode,
    range: TimeRange,
  ): Promise<{ withCode: number; total: number }> {
    const row = this.client.queryOne<{ withCode: number; total: number }>(
      `SELECT SUM(CASE WHEN EXISTS (
                 SELECT 1 FROM findings f WHERE f.trace_id = t.trace_id AND f.code = ?
               ) THEN 1 ELSE 0 END) AS withCode,
              COUNT(*) AS total
       FROM traces t WHERE t.start_time >= ? AND t.start_time <= ?`,
      [code, range.from, range.to],
    );
    return { withCode: row?.withCode ?? 0, total: row?.total ?? 0 };
  }

  // ── retention ─────────────────────────────────────────────────────────────

  async purgeOlderThan(cutoff: number): Promise<PurgeResult> {
    return this.client.transaction(() => {
      const traces =
        this.client.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM traces WHERE start_time < ?', [
          cutoff,
        ])?.n ?? 0;
      const spans =
        this.client.queryOne<{ n: number }>(
          'SELECT COUNT(*) AS n FROM spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE start_time < ?)',
          [cutoff],
        )?.n ?? 0;
      const findings =
        this.client.queryOne<{ n: number }>(
          'SELECT COUNT(*) AS n FROM findings WHERE created_at < ?',
          [cutoff],
        )?.n ?? 0;

      // Children go first: ON DELETE CASCADE covers it, but being explicit keeps
      // the counts honest and works if foreign_keys is ever off.
      this.client.run(
        'DELETE FROM spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE start_time < ?)',
        [cutoff],
      );
      this.client.run('DELETE FROM findings WHERE created_at < ?', [cutoff]);
      this.client.run(
        'DELETE FROM detector_runs WHERE trace_id IN (SELECT trace_id FROM traces WHERE start_time < ?)',
        [cutoff],
      );
      this.client.run('DELETE FROM traces WHERE start_time < ?', [cutoff]);

      return { traces, spans, findings };
    });
  }
}

function clampLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

function severitiesAtLeast(min: Severity): Severity[] {
  const floor = SEVERITY_RANK[min];
  return (Object.keys(SEVERITY_RANK) as Severity[]).filter((s) => SEVERITY_RANK[s] >= floor);
}
