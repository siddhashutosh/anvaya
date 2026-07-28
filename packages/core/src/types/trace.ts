import type { AttributeMap, Severity } from './common.js';
import type { SpanKind, SpanRecord, SpanStatus } from './span.js';

export interface TraceRecord {
  readonly traceId: string;
  readonly sessionId?: string;
  readonly service: string;
  readonly environment: string;
  readonly rootSpanId?: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly spanCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
  readonly findingCount: number;
  readonly worstSeverity?: Severity;
  readonly attributes: AttributeMap;
}

/** A node in the span tree. `span` is undefined only for the synthetic root. */
export interface SpanNode {
  readonly span: SpanRecord | undefined;
  readonly children: readonly SpanNode[];
  readonly depth: number;
}

/**
 * Derived structure computed once by the enrich stage so no detector has to
 * re-walk the tree.
 */
export interface TraceMetrics {
  readonly totalTokens: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
  readonly errorSpanCount: number;
  readonly maxDepth: number;
  readonly llmCallCount: number;
  readonly toolCallCount: number;
  readonly retrievalCount: number;
  readonly agentIterations: number;
  readonly distinctToolNames: readonly string[];
  /** Highest observed inputTokens/contextLimit across LLM spans, 0..1. Drives CTX-001. */
  readonly maxContextUtilisation: number;
}

/**
 * The unit every detector consumes. Produced by TraceEnricher.
 */
export interface NormalizedTrace {
  readonly trace: TraceRecord;
  readonly spans: readonly SpanRecord[];
  readonly tree: SpanNode;
  readonly byKind: Readonly<Record<SpanKind, readonly SpanRecord[]>>;
  readonly index: ReadonlyMap<string, SpanRecord>;
  /** spanId -> ordered ancestor spanIds (nearest first). Used by causal attribution. */
  readonly ancestors: ReadonlyMap<string, readonly string[]>;
  readonly metrics: TraceMetrics;
}

export interface TraceSummary {
  readonly traceId: string;
  readonly sessionId?: string;
  readonly service: string;
  readonly environment: string;
  readonly name: string;
  readonly startTime: number;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly spanCount: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly findingCount: number;
  readonly worstSeverity?: Severity;
}
