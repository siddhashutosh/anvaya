/**
 * API response shapes.
 *
 * Declared structurally rather than imported from @anvaya/core so the UI builds
 * without a compiled server, and so an additive server field cannot break the
 * UI build (IF-3.3).
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type DetectorTier = 'L0' | 'L1' | 'L2' | 'L3';
export type FindingRole = 'origin' | 'symptom' | 'standalone';
export type SpanKind =
  | 'llm'
  | 'embedding'
  | 'chain'
  | 'retriever'
  | 'reranker'
  | 'tool'
  | 'agent'
  | 'guardrail'
  | 'evaluator'
  | 'prompt'
  | 'unknown';

export interface Evidence {
  label: string;
  value: string | number | boolean;
  comparison?: { baseline: number; delta: number; samples: number };
}

export interface Finding {
  findingId: string;
  traceId: string;
  spanId?: string;
  code: string;
  severity: Severity;
  confidence: number;
  detectorId: string;
  tier: DetectorTier;
  title: string;
  detail: string;
  evidence: Evidence[];
  role: FindingRole;
  causedBy?: string;
  taxonomyVersion: string;
  createdAt: number;
}

export interface Attribution {
  traceId: string;
  originFindingId?: string;
  chain: { findingId: string; code: string; title: string }[];
  summary: string;
}

export interface SpanRecord {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: 'ok' | 'error' | 'unset';
  statusMessage?: string;
  attributes: Record<string, unknown>;
  events: { name: string; timestamp: number }[];
  llm?: {
    provider?: string;
    requestModel?: string;
    inputTokens?: number;
    outputTokens?: number;
    finishReason?: string;
    costUsd?: number;
  };
  retrieval?: {
    query?: string;
    indexName?: string;
    documents?: { id: string; score?: number }[];
  };
  tool?: { toolName: string; attempt?: number; error?: string };
  agent?: { agentName?: string; iteration?: number; maxIterations?: number };
}

export interface TraceRecord {
  traceId: string;
  sessionId?: string;
  service: string;
  environment: string;
  name: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: 'ok' | 'error' | 'unset';
  spanCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  findingCount: number;
  worstSeverity?: Severity;
  attributes: Record<string, unknown>;
}

export interface TraceSummary {
  traceId: string;
  sessionId?: string;
  service: string;
  environment: string;
  name: string;
  startTime: number;
  durationMs: number;
  status: 'ok' | 'error' | 'unset';
  spanCount: number;
  totalCostUsd: number;
  totalTokens: number;
  findingCount: number;
  worstSeverity?: Severity;
}

export interface SessionSummary {
  sessionId: string;
  service: string;
  environment: string;
  traceCount: number;
  startTime: number;
  lastSeen: number;
  totalCostUsd: number;
  totalTokens: number;
  findingCount: number;
  errorCount: number;
  worstSeverity?: Severity;
}

export interface FailureMode {
  code: string;
  family: string;
  name: string;
  definition: string;
  defaultSeverity: Severity;
  tier: DetectorTier;
  evidenceRequired: string[];
  remediation: string;
  source: { kind: string; ref: string; note?: string };
  causes: string[];
  observedFrequency?: number;
}

export interface TraceDetail {
  trace: TraceRecord;
  spans: SpanRecord[];
  findings: Finding[];
  attribution?: Attribution;
  taxonomy: Record<string, FailureMode>;
}

export interface CohortHypothesis {
  key: string;
  value: string;
  lift: number;
  inCohortRate: number;
  baseRate: number;
  samples: number;
  statement: string;
}

export interface Incident {
  incidentId: string;
  code: string;
  originOperation: string;
  severity: Severity;
  status: 'open' | 'resolved';
  firstSeen: number;
  lastSeen: number;
  occurrences: number;
  traceIds: string[];
  title: string;
  hypothesis?: string;
  cohorts: CohortHypothesis[];
}

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor?: string;
}

export interface CodeCount {
  code: string;
  count: number;
  severity: Severity;
  name?: string;
  family?: string;
}

export interface OverviewStats {
  range: { from: number; to: number };
  traceCount: number;
  errorTraceCount: number;
  failureRate: number;
  findingCount: number;
  incidentCount: number;
  openIncidentCount: number;
  totalCostUsd: number;
  totalTokens: number;
  p50DurationMs: number;
  p95DurationMs: number;
  bySeverity: Record<Severity, number>;
  topCodes: CodeCount[];
}

export interface TimeBucket {
  start: number;
  traces: number;
  errors: number;
  findings: number;
  costUsd: number;
  p95DurationMs: number;
}

export interface DetectorInfo {
  id: string;
  tier: DetectorTier;
  emits: string[];
  cost: 'free' | 'cheap' | 'billed';
  requiresBaseline: boolean;
  description: string;
  enabled: boolean;
}
