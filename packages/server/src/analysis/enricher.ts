/**
 * TraceEnricher — builds the span tree, ancestor index, and derived metrics once,
 * so no detector has to re-walk the trace.
 *
 * Tolerates a forest: spans whose declared parent is absent are attached to a
 * synthetic root rather than dropped. Partial traces are still worth analysing.
 */

import {
  SPAN_KINDS,
  maxSeverity,
  type NormalizedTrace,
  type Severity,
  type SpanKind,
  type SpanNode,
  type SpanRecord,
  type TraceMetrics,
  type TraceRecord,
} from '@anvaya/core';
import { estimateCostUsd } from '../ingest/pricing.js';

export class TraceEnricher {
  enrich(
    trace: TraceRecord,
    spans: readonly SpanRecord[],
    worstSeverity?: Severity,
  ): NormalizedTrace {
    const ordered = [...spans].sort((a, b) => a.startTime - b.startTime);
    const index = new Map(ordered.map((s) => [s.spanId, s] as const));

    const byKind = buildKindIndex(ordered);
    const { tree, ancestors } = buildTree(ordered, index);
    const metrics = computeMetrics(ordered, byKind);

    const enrichedTrace: TraceRecord = {
      ...trace,
      spanCount: ordered.length,
      totalInputTokens: metrics.totalInputTokens,
      totalOutputTokens: metrics.totalOutputTokens,
      totalCostUsd: metrics.totalCostUsd,
      status: metrics.errorSpanCount > 0 ? 'error' : trace.status,
      ...(worstSeverity
        ? { worstSeverity: maxSeverity(trace.worstSeverity, worstSeverity) as Severity }
        : {}),
    };

    return { trace: enrichedTrace, spans: ordered, tree, byKind, index, ancestors, metrics };
  }
}

function buildKindIndex(spans: readonly SpanRecord[]): Record<SpanKind, readonly SpanRecord[]> {
  const out = {} as Record<SpanKind, SpanRecord[]>;
  for (const kind of SPAN_KINDS) out[kind] = [];
  for (const span of spans) out[span.kind].push(span);
  return out;
}

function buildTree(
  spans: readonly SpanRecord[],
  index: ReadonlyMap<string, SpanRecord>,
): { tree: SpanNode; ancestors: ReadonlyMap<string, readonly string[]> } {
  const childrenOf = new Map<string, SpanRecord[]>();
  const roots: SpanRecord[] = [];

  for (const span of spans) {
    // A span whose parent was never ingested is treated as a root, not lost.
    if (span.parentSpanId && index.has(span.parentSpanId)) {
      const siblings = childrenOf.get(span.parentSpanId) ?? [];
      siblings.push(span);
      childrenOf.set(span.parentSpanId, siblings);
    } else {
      roots.push(span);
    }
  }

  const ancestors = new Map<string, readonly string[]>();

  const build = (span: SpanRecord, depth: number, chain: readonly string[]): SpanNode => {
    ancestors.set(span.spanId, chain);
    const nextChain = [span.spanId, ...chain];
    // Depth is bounded to guard against a cyclic parent chain in malformed input.
    const children =
      depth < 64
        ? (childrenOf.get(span.spanId) ?? []).map((child) => build(child, depth + 1, nextChain))
        : [];
    return { span, children, depth };
  };

  const tree: SpanNode = {
    span: undefined,
    depth: -1,
    children: roots.map((root) => build(root, 0, [])),
  };

  return { tree, ancestors };
}

function computeMetrics(
  spans: readonly SpanRecord[],
  byKind: Record<SpanKind, readonly SpanRecord[]>,
): TraceMetrics {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let errorSpanCount = 0;
  let maxDepth = 0;
  let maxContextUtilisation = 0;
  let agentIterations = 0;

  for (const span of spans) {
    if (span.status === 'error') errorSpanCount++;

    if (span.llm) {
      const input = span.llm.inputTokens ?? 0;
      const output = span.llm.outputTokens ?? 0;
      totalInputTokens += input;
      totalOutputTokens += output;

      // Prefer a provider-reported cost; fall back to the pricing table.
      totalCostUsd +=
        span.llm.costUsd ??
        estimateCostUsd(
          span.llm.responseModel ?? span.llm.requestModel,
          input,
          output,
          span.llm.cacheReadTokens ?? 0,
        );

      if (span.llm.contextLimit && span.llm.contextLimit > 0) {
        maxContextUtilisation = Math.max(maxContextUtilisation, input / span.llm.contextLimit);
      }
    }

    if (span.agent?.iteration !== undefined) {
      agentIterations = Math.max(agentIterations, span.agent.iteration);
    }
  }

  maxDepth = computeMaxDepth(spans);

  const toolNames = new Set<string>();
  for (const span of byKind.tool) {
    if (span.tool?.toolName) toolNames.add(span.tool.toolName);
  }

  return {
    totalTokens: totalInputTokens + totalOutputTokens,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    errorSpanCount,
    maxDepth,
    llmCallCount: byKind.llm.length,
    toolCallCount: byKind.tool.length,
    retrievalCount: byKind.retriever.length + byKind.reranker.length,
    agentIterations: agentIterations || byKind.agent.length,
    distinctToolNames: [...toolNames],
    maxContextUtilisation,
  };
}

function computeMaxDepth(spans: readonly SpanRecord[]): number {
  const parents = new Map(spans.map((s) => [s.spanId, s.parentSpanId] as const));
  let max = 0;
  for (const span of spans) {
    let depth = 0;
    let current = span.parentSpanId;
    while (current && depth < 64) {
      depth++;
      current = parents.get(current);
    }
    if (depth > max) max = depth;
  }
  return max;
}
