/**
 * The Storage port (FR-5.1). No SQL exists outside storage/sqlite/.
 *
 * Keeping every consumer behind this interface is what makes the SQLite-first
 * decision reversible (ADR-0001): Postgres becomes an additional adapter
 * directory, not a rewrite.
 */

import type {
  Attribution,
  BaselineRow,
  DetectorTier,
  Finding,
  Incident,
  Page,
  SessionSummary,
  SessionTurn,
  Severity,
  SpanRecord,
  TaxonomyCode,
  TimeRange,
  TraceRecord,
  TraceSummary,
} from '@anvaya/core';

export interface TraceBundle {
  readonly trace: TraceRecord;
  readonly spans: readonly SpanRecord[];
  readonly findings: readonly Finding[];
  readonly attribution?: Attribution;
  readonly detectorRuns: readonly DetectorRun[];
  /**
   * Session projection for this trace, persisted alongside it so the next turn
   * can be compared without re-reading this trace's spans.
   */
  readonly sessionTurn?: SessionTurn;
}

export interface DetectorRun {
  readonly traceId: string;
  readonly detectorId: string;
  readonly tier: DetectorTier;
  readonly outcome: DetectorOutcome;
  readonly durationMs: number;
  readonly findingCount: number;
  readonly createdAt: number;
}

export type DetectorOutcome =
  | 'ok'
  | 'skipped:unsupported'
  | 'skipped:disabled'
  | 'skipped:insufficient-baseline'
  | 'skipped:covered'
  | 'skipped:unconfigured'
  | 'skipped:budget'
  | 'failed'
  | 'timeout';

export interface TraceDetail {
  readonly trace: TraceRecord;
  readonly spans: readonly SpanRecord[];
  readonly findings: readonly Finding[];
  readonly attribution?: Attribution;
}

export interface TraceQuery {
  readonly range?: TimeRange;
  readonly service?: string;
  readonly environment?: string;
  readonly sessionId?: string;
  readonly status?: 'ok' | 'error';
  readonly hasFindings?: boolean;
  readonly code?: TaxonomyCode;
  readonly minSeverity?: Severity;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface FindingQuery {
  readonly range?: TimeRange;
  readonly code?: TaxonomyCode;
  readonly family?: string;
  readonly severity?: Severity;
  readonly tier?: DetectorTier;
  readonly role?: 'origin' | 'symptom' | 'standalone';
  readonly traceId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface IncidentQuery {
  readonly status?: 'open' | 'resolved';
  readonly code?: TaxonomyCode;
  readonly minSeverity?: Severity;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface IncidentDetail {
  readonly incident: Incident;
  readonly findings: readonly Finding[];
}

export interface CodeCount {
  readonly code: TaxonomyCode;
  readonly count: number;
  readonly severity: Severity;
}

export interface CohortCount {
  readonly value: string;
  readonly withCode: number;
  readonly total: number;
}

export interface OverviewStats {
  readonly traceCount: number;
  readonly errorTraceCount: number;
  readonly failureRate: number;
  readonly findingCount: number;
  readonly incidentCount: number;
  readonly openIncidentCount: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly p50DurationMs: number;
  readonly p95DurationMs: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly topCodes: readonly CodeCount[];
}

export interface TimeseriesQuery {
  readonly range: TimeRange;
  readonly bucketMs: number;
  readonly code?: TaxonomyCode;
}

export interface TimeBucket {
  readonly start: number;
  readonly traces: number;
  readonly errors: number;
  readonly findings: number;
  readonly costUsd: number;
  readonly p95DurationMs: number;
}

export interface SessionQuery {
  readonly range?: TimeRange;
  readonly service?: string;
  readonly minTraces?: number;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CostBucket {
  readonly value: string;
  readonly traces: number;
  readonly costUsd: number;
  readonly tokens: number;
}

export interface StorageHealth {
  readonly ok: boolean;
  readonly driver: string;
  readonly traceCount: number;
  readonly sizeBytes?: number;
  readonly message?: string;
}

export interface PurgeResult {
  readonly traces: number;
  readonly spans: number;
  readonly findings: number;
}

export interface Storage {
  init(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<StorageHealth>;

  /** One transaction for the whole bundle (FR-5.7). */
  saveTraceBundle(bundle: TraceBundle): Promise<void>;
  getTrace(traceId: string): Promise<TraceDetail | undefined>;
  listTraces(query: TraceQuery): Promise<Page<TraceSummary>>;

  // ── incremental path (serverless inline ingest, ADR-0009) ────────────────
  //
  // Spans are durable the moment they arrive and analysis happens separately,
  // because a stateless host cannot hold a partial trace in memory between
  // requests.

  /** Persist spans without analysing. Widens the trace envelope; never shrinks it. */
  saveSpans(trace: TraceRecord, spans: readonly SpanRecord[]): Promise<void>;
  /** Traces whose spans landed but which were never analysed — the cron sweep. */
  listUnanalysedTraces(olderThan: number, limit?: number): Promise<readonly string[]>;
  getTraceSpans(traceId: string): Promise<readonly SpanRecord[]>;
  getTraceRecord(traceId: string): Promise<TraceRecord | undefined>;

  listFindings(query: FindingQuery): Promise<Page<Finding>>;

  upsertIncident(incident: Incident): Promise<void>;
  listIncidents(query: IncidentQuery): Promise<Page<Incident>>;
  getIncident(incidentId: string): Promise<IncidentDetail | undefined>;
  findOpenIncident(
    code: TaxonomyCode,
    originOperation: string,
    since: number,
  ): Promise<Incident | undefined>;
  resolveStaleIncidents(before: number): Promise<number>;

  /** The most recent turn of a session strictly before `beforeTime`, if any. */
  getPreviousSessionTurn(
    sessionId: string,
    beforeTime: number,
  ): Promise<{ turn: SessionTurn; turnIndex: number } | undefined>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  getSessionTraces(sessionId: string, limit?: number): Promise<readonly TraceSummary[]>;

  /** Cost and token totals grouped by a cohort key, for showback/chargeback. */
  costByCohort(key: string, range: TimeRange, limit?: number): Promise<readonly CostBucket[]>;

  getBaseline(metric: string, scope: string): Promise<BaselineRow | undefined>;
  listBaselines(): Promise<readonly BaselineRow[]>;
  putBaselines(rows: readonly BaselineRow[]): Promise<void>;

  overview(range: TimeRange): Promise<OverviewStats>;
  timeseries(query: TimeseriesQuery): Promise<readonly TimeBucket[]>;
  codeFrequency(range: TimeRange, limit?: number): Promise<readonly CodeCount[]>;
  cohortCounts(code: TaxonomyCode, key: string, range: TimeRange): Promise<readonly CohortCount[]>;
  codeRate(code: TaxonomyCode, range: TimeRange): Promise<{ withCode: number; total: number }>;

  purgeOlderThan(cutoff: number): Promise<PurgeResult>;
}
