/**
 * Row <-> record mapping. Isolated here so the shape of the physical schema never
 * leaks into the rest of the server.
 */

import type {
  AgentPayload,
  AttributeMap,
  CohortHypothesis,
  DetectorTier,
  Evidence,
  Finding,
  FindingRole,
  Incident,
  IncidentStatus,
  LlmPayload,
  RetrievalPayload,
  Severity,
  SpanEvent,
  SpanKind,
  SpanRecord,
  SpanStatus,
  ToolPayload,
  TraceRecord,
  TraceSummary,
} from '@anvaya/core';

export interface TraceRow {
  trace_id: string;
  session_id: string | null;
  service: string;
  environment: string;
  root_span_id: string | null;
  name: string;
  start_time: number;
  end_time: number;
  duration_ms: number;
  status: string;
  span_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  finding_count: number;
  worst_severity: string | null;
  attributes: string;
  attribution: string | null;
}

export interface SpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_time: number;
  end_time: number;
  duration_ms: number;
  status: string;
  status_message: string | null;
  attributes: string;
  events: string;
  llm: string | null;
  retrieval: string | null;
  tool: string | null;
  agent: string | null;
}

export interface FindingRow {
  finding_id: string;
  trace_id: string;
  span_id: string | null;
  code: string;
  family: string;
  severity: string;
  confidence: number;
  detector_id: string;
  tier: string;
  title: string;
  detail: string;
  evidence: string;
  role: string;
  caused_by: string | null;
  taxonomy_version: string;
  created_at: number;
}

export interface IncidentRow {
  incident_id: string;
  code: string;
  origin_operation: string;
  severity: string;
  status: string;
  first_seen: number;
  last_seen: number;
  occurrences: number;
  trace_ids: string;
  title: string;
  hypothesis: string | null;
  cohorts: string;
}

/** Never let a corrupt JSON column take down a query. */
function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function rowToTrace(row: TraceRow): TraceRecord {
  return {
    traceId: row.trace_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    service: row.service,
    environment: row.environment,
    ...(row.root_span_id ? { rootSpanId: row.root_span_id } : {}),
    name: row.name,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMs: row.duration_ms,
    status: row.status as SpanStatus,
    spanCount: row.span_count,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    totalCostUsd: row.total_cost_usd,
    findingCount: row.finding_count,
    ...(row.worst_severity ? { worstSeverity: row.worst_severity as Severity } : {}),
    attributes: parseJson<AttributeMap>(row.attributes, {}),
  };
}

export function rowToTraceSummary(row: TraceRow): TraceSummary {
  return {
    traceId: row.trace_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    service: row.service,
    environment: row.environment,
    name: row.name,
    startTime: row.start_time,
    durationMs: row.duration_ms,
    status: row.status as SpanStatus,
    spanCount: row.span_count,
    totalCostUsd: row.total_cost_usd,
    totalTokens: row.total_input_tokens + row.total_output_tokens,
    findingCount: row.finding_count,
    ...(row.worst_severity ? { worstSeverity: row.worst_severity as Severity } : {}),
  };
}

export function rowToSpan(row: SpanRow): SpanRecord {
  const llm = row.llm ? parseJson<LlmPayload>(row.llm, {}) : undefined;
  const retrieval = row.retrieval ? parseJson<RetrievalPayload>(row.retrieval, {}) : undefined;
  const tool = row.tool ? parseJson<ToolPayload | undefined>(row.tool, undefined) : undefined;
  const agent = row.agent ? parseJson<AgentPayload>(row.agent, {}) : undefined;

  return {
    spanId: row.span_id,
    traceId: row.trace_id,
    ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
    name: row.name,
    kind: row.kind as SpanKind,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMs: row.duration_ms,
    status: row.status as SpanStatus,
    ...(row.status_message ? { statusMessage: row.status_message } : {}),
    attributes: parseJson<AttributeMap>(row.attributes, {}),
    events: parseJson<SpanEvent[]>(row.events, []),
    ...(llm ? { llm } : {}),
    ...(retrieval ? { retrieval } : {}),
    ...(tool ? { tool } : {}),
    ...(agent ? { agent } : {}),
  };
}

export function rowToFinding(row: FindingRow): Finding {
  return {
    findingId: row.finding_id,
    traceId: row.trace_id,
    ...(row.span_id ? { spanId: row.span_id } : {}),
    code: row.code,
    severity: row.severity as Severity,
    confidence: row.confidence,
    detectorId: row.detector_id,
    tier: row.tier as DetectorTier,
    title: row.title,
    detail: row.detail,
    evidence: parseJson<Evidence[]>(row.evidence, []),
    role: row.role as FindingRole,
    ...(row.caused_by ? { causedBy: row.caused_by } : {}),
    taxonomyVersion: row.taxonomy_version,
    createdAt: row.created_at,
  };
}

export function rowToIncident(row: IncidentRow): Incident {
  return {
    incidentId: row.incident_id,
    code: row.code,
    originOperation: row.origin_operation,
    severity: row.severity as Severity,
    status: row.status as IncidentStatus,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    occurrences: row.occurrences,
    traceIds: parseJson<string[]>(row.trace_ids, []),
    title: row.title,
    ...(row.hypothesis ? { hypothesis: row.hypothesis } : {}),
    cohorts: parseJson<CohortHypothesis[]>(row.cohorts, []),
  };
}
