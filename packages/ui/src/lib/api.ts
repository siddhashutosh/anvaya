/**
 * Typed API client.
 *
 * Normalises the server's error envelope into ApiError so every view can render
 * an error state carrying the requestId — which is the whole point of the
 * request-id contract (FR-6.12, FR-7.11).
 */

import type {
  DetectorInfo,
  FailureMode,
  Finding,
  Incident,
  OverviewStats,
  Page,
  SessionSummary,
  TimeBucket,
  TraceDetail,
  TraceSummary,
} from './types';

const BASE: string =
  (import.meta.env.VITE_ANVAYA_API as string | undefined) ?? 'http://localhost:4319';

/**
 * Read key for a collector started with `ANVAYA_API_KEY`.
 *
 * Without this the dashboard 401s against any authenticated collector, which
 * made enabling auth an all-or-nothing choice between a secured ingest endpoint
 * and a working UI.
 */
const API_KEY: string | undefined = import.meta.env.VITE_ANVAYA_API_KEY as string | undefined;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; requestId?: string };
}

async function request<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch {
    // A network failure has no envelope; synthesise one so callers have a
    // uniform shape to render.
    throw new ApiError(
      `Cannot reach the Anvaya server at ${BASE}. Is it running?`,
      'NETWORK_UNREACHABLE',
      0,
    );
  }

  if (!response.ok) {
    let envelope: ErrorEnvelope = {};
    try {
      envelope = (await response.json()) as ErrorEnvelope;
    } catch {
      // Non-JSON error body; fall through to the status-based message.
    }
    throw new ApiError(
      envelope.error?.message ?? `Request failed with status ${response.status}`,
      envelope.error?.code ?? 'UNKNOWN',
      response.status,
      envelope.error?.requestId,
    );
  }

  return (await response.json()) as T;
}

/** Index signature so range objects compose with the generic query-param bag. */
export interface RangeParams {
  from?: number;
  to?: number;
  [key: string]: unknown;
}

export const api = {
  baseUrl: BASE,

  health: () => request<{ status: string; components: Record<string, unknown> }>('/health'),

  overview: (range: RangeParams) => request<OverviewStats>('/v1/stats/overview', range),

  timeseries: (range: RangeParams & { bucketMs?: number }) =>
    request<{ range: RangeParams; bucketMs: number; buckets: TimeBucket[] }>(
      '/v1/stats/timeseries',
      range,
    ),

  codes: (range: RangeParams & { limit?: number }) =>
    request<{ codes: (import('./types').CodeCount)[] }>('/v1/stats/codes', range),

  traces: (params: RangeParams & Record<string, unknown>) =>
    request<Page<TraceSummary>>('/v1/traces', params),

  trace: (traceId: string) => request<TraceDetail>(`/v1/traces/${encodeURIComponent(traceId)}`),

  findings: (params: RangeParams & Record<string, unknown>) =>
    request<Page<Finding>>('/v1/findings', params),

  sessions: (params: RangeParams & Record<string, unknown>) =>
    request<Page<SessionSummary>>('/v1/sessions', params),

  session: (sessionId: string) =>
    request<{
      sessionId: string;
      traces: TraceSummary[];
      findings: Finding[];
      taxonomy: Record<string, FailureMode>;
    }>(`/v1/sessions/${encodeURIComponent(sessionId)}`),

  costByCohort: (params: RangeParams & { key?: string }) =>
    request<{
      key: string;
      totalCostUsd: number;
      buckets: { value: string; traces: number; costUsd: number; tokens: number; share: number }[];
    }>('/v1/stats/cost', params),

  incidents: (params: Record<string, unknown>) => request<Page<Incident>>('/v1/incidents', params),

  incident: (id: string) =>
    request<{ incident: Incident; findings: Finding[]; mode?: FailureMode }>(
      `/v1/incidents/${encodeURIComponent(id)}`,
    ),

  taxonomy: () => request<{ version: string; modes: FailureMode[] }>('/v1/taxonomy'),

  detectors: () => request<{ detectors: DetectorInfo[] }>('/v1/detectors'),
};
