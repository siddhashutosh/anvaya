/**
 * L0 infrastructure detectors — INF-001..INF-004, GEN-006, CTX-001, ECO-001.
 *
 * Pure span-status/timing/count analysis. No content is read, so these work
 * fully with captureContent disabled (ADR-0007).
 */

import type { Finding, NormalizedTrace, SpanRecord } from '@anvaya/core';
import { evidence, finding, type DetectionContext, type Detector } from '../types.js';

/** Reads an HTTP-ish status from wherever the instrumentation happened to put it. */
function statusCodeOf(span: SpanRecord): number | undefined {
  const candidates = [
    span.attributes['http.status_code'],
    span.attributes['http.response.status_code'],
    span.attributes['error.status'],
    span.attributes['status_code'],
  ];
  for (const c of candidates) {
    const n = typeof c === 'number' ? c : typeof c === 'string' ? Number(c) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function errorText(span: SpanRecord): string {
  const fromEvent = span.events.find((e) => e.name === 'exception');
  const message =
    span.statusMessage ??
    (typeof fromEvent?.attributes?.['exception.message'] === 'string'
      ? (fromEvent.attributes['exception.message'] as string)
      : '') ??
    '';
  return message.toLowerCase();
}

export const providerErrorDetector: Detector = {
  id: 'inf.provider-error',
  tier: 'L0',
  emits: ['INF-001'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Model-provider call returned a failure status or raised an exception.',
  supports: (t) => t.byKind.llm.length > 0 || t.byKind.embedding.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of [...ctx.trace.byKind.llm, ...ctx.trace.byKind.embedding]) {
      if (span.status !== 'error') continue;
      const status = statusCodeOf(span);
      const text = errorText(span);
      // The more specific INF-002/003/004 detectors own these; avoid double-reporting.
      if (status === 429 || status === 401 || status === 403) continue;
      if (text.includes('timeout') || text.includes('timed out')) continue;

      out.push(
        finding({
          ctx,
          detector: this,
          code: 'INF-001',
          spanId: span.spanId,
          confidence: 0.95,
          detail: `Provider call "${span.name}" failed${status ? ` with status ${status}` : ''}.`,
          evidence: [
            evidence('span', span.name),
            evidence('provider', span.llm?.provider ?? 'unknown'),
            ...(status !== undefined ? [evidence('httpStatus', status)] : []),
            ...(span.statusMessage ? [evidence('message', span.statusMessage.slice(0, 200))] : []),
          ],
        }),
      );
    }
    return out;
  },
};

export const timeoutDetector: Detector = {
  id: 'inf.timeout',
  tier: 'L0',
  emits: ['INF-002'],
  cost: 'free',
  requiresBaseline: false,
  description: 'A model or tool call exceeded its deadline.',
  supports: () => true,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.spans) {
      if (span.status !== 'error') continue;
      const text = errorText(span);
      if (!text.includes('timeout') && !text.includes('timed out') && !text.includes('etimedout')) {
        continue;
      }
      out.push(
        finding({
          ctx,
          detector: this,
          code: 'INF-002',
          spanId: span.spanId,
          confidence: 0.9,
          detail: `"${span.name}" timed out after ${Math.round(span.durationMs)}ms.`,
          evidence: [
            evidence('span', span.name),
            evidence('durationMs', Math.round(span.durationMs)),
            evidence('kind', span.kind),
          ],
        }),
      );
    }
    return out;
  },
};

export const rateLimitDetector: Detector = {
  id: 'inf.rate-limit',
  tier: 'L0',
  emits: ['INF-003'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Provider returned 429 or a quota-exceeded status.',
  supports: () => true,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.spans) {
      const status = statusCodeOf(span);
      const text = errorText(span);
      const limited =
        status === 429 || text.includes('rate limit') || text.includes('quota exceeded');
      if (!limited) continue;

      out.push(
        finding({
          ctx,
          detector: this,
          code: 'INF-003',
          spanId: span.spanId,
          confidence: 0.95,
          detail: `"${span.name}" was rate limited. Retrying without backoff makes this worse — see TOL-004.`,
          evidence: [
            evidence('span', span.name),
            ...(status !== undefined ? [evidence('httpStatus', status)] : []),
            evidence('provider', span.llm?.provider ?? 'unknown'),
          ],
        }),
      );
    }
    return out;
  },
};

export const authFailureDetector: Detector = {
  id: 'inf.auth-failure',
  tier: 'L0',
  emits: ['INF-004'],
  cost: 'free',
  requiresBaseline: false,
  description: 'A call failed authentication or authorization.',
  supports: () => true,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.spans) {
      const status = statusCodeOf(span);
      const text = errorText(span);
      const authFailed =
        status === 401 ||
        status === 403 ||
        text.includes('unauthorized') ||
        text.includes('invalid api key') ||
        text.includes('authentication');
      if (!authFailed) continue;

      out.push(
        finding({
          ctx,
          detector: this,
          code: 'INF-004',
          spanId: span.spanId,
          confidence: 0.95,
          detail: `"${span.name}" failed authentication. Check credential expiry and environment first.`,
          evidence: [
            evidence('span', span.name),
            ...(status !== undefined ? [evidence('httpStatus', status)] : []),
          ],
        }),
      );
    }
    return out;
  },
};

export const truncationDetector: Detector = {
  id: 'gen.output-truncated',
  tier: 'L0',
  emits: ['GEN-006'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Generation stopped at the token limit rather than at a natural stop.',
  supports: (t) => t.byKind.llm.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.llm) {
      const reason = span.llm?.finishReason?.toLowerCase();
      if (reason !== 'length' && reason !== 'max_tokens' && reason !== 'max_output_tokens') continue;

      out.push(
        finding({
          ctx,
          detector: this,
          code: 'GEN-006',
          spanId: span.spanId,
          confidence: 1,
          detail:
            'The model stopped because it hit the output token limit. If the output was meant to be structured, expect GEN-005 as well.',
          evidence: [
            evidence('finishReason', span.llm?.finishReason ?? 'length'),
            evidence('outputTokens', span.llm?.outputTokens ?? 0),
            ...(span.llm?.maxTokens ? [evidence('maxTokens', span.llm.maxTokens)] : []),
          ],
        }),
      );
    }
    return out;
  },
};

export const contextOverflowDetector: Detector = {
  id: 'ctx.window-overflow',
  tier: 'L0',
  emits: ['CTX-001'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Prompt tokens approached or exceeded the model context limit.',
  supports: (t: NormalizedTrace) => t.byKind.llm.some((s) => (s.llm?.contextLimit ?? 0) > 0),
  async run(ctx: DetectionContext) {
    const out: Finding[] = [];
    const threshold = ctx.thresholds.contextUtilisationWarn;

    for (const span of ctx.trace.byKind.llm) {
      const limit = span.llm?.contextLimit ?? 0;
      const input = span.llm?.inputTokens ?? 0;
      if (limit <= 0 || input <= 0) continue;

      const utilisation = input / limit;
      if (utilisation < threshold) continue;

      out.push(
        finding({
          ctx,
          detector: contextOverflowDetector,
          code: 'CTX-001',
          spanId: span.spanId,
          confidence: utilisation >= 1 ? 0.98 : 0.75,
          severity: utilisation >= 1 ? 'critical' : 'high',
          detail: `Prompt used ${(utilisation * 100).toFixed(1)}% of the ${limit}-token context window. Drop lowest-scoring chunks rather than truncating the tail.`,
          evidence: [
            evidence('inputTokens', input),
            evidence('contextLimit', limit),
            evidence('utilisation', Number(utilisation.toFixed(3))),
          ],
        }),
      );
    }
    return out;
  },
};

export const tokenBudgetDetector: Detector = {
  id: 'eco.token-budget',
  tier: 'L0',
  emits: ['ECO-001'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Total trace tokens exceeded the configured budget.',
  supports: (t) => t.metrics.totalTokens > 0,
  async run(ctx) {
    const budget = ctx.thresholds.tokenBudgetPerTrace;
    const total = ctx.trace.metrics.totalTokens;
    if (total <= budget) return [];

    // Name the biggest consumer: the budget breach is usually a symptom of a loop.
    const top = [...ctx.trace.byKind.llm]
      .sort(
        (a, b) =>
          (b.llm?.inputTokens ?? 0) + (b.llm?.outputTokens ?? 0) -
          ((a.llm?.inputTokens ?? 0) + (a.llm?.outputTokens ?? 0)),
      )
      .slice(0, 3);

    return [
      finding({
        ctx,
        detector: tokenBudgetDetector,
        code: 'ECO-001',
        confidence: 1,
        detail: `Trace consumed ${total.toLocaleString()} tokens against a budget of ${budget.toLocaleString()}. Check AGT-003 and AGT-005 first — loops are the usual cause.`,
        evidence: [
          evidence('totalTokens', total),
          evidence('budget', budget),
          evidence('llmCalls', ctx.trace.metrics.llmCallCount),
          evidence('topConsumers', top.map((s) => s.name).join(', ') || 'n/a'),
        ],
      }),
    ];
  },
};

export const L0_INFRASTRUCTURE_DETECTORS: readonly Detector[] = [
  providerErrorDetector,
  timeoutDetector,
  rateLimitDetector,
  authFailureDetector,
  truncationDetector,
  contextOverflowDetector,
  tokenBudgetDetector,
];
