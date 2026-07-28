/**
 * The internal span model.
 *
 * Deliberately NOT the OpenTelemetry `gen_ai.*` shape — those conventions are
 * explicitly pre-stable and attribute names can still change between versions,
 * so binding the internal model to them would propagate every rename through
 * detectors, storage, API and UI. Wire formats are translated at the ingest
 * boundary instead. See ADR-0002.
 *
 * Span *kinds* do mirror the OpenInference vocabulary, because that mapping is
 * 1:1 and costs nothing.
 */

import type { AttributeMap } from './common.js';

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

export const SPAN_KINDS: readonly SpanKind[] = Object.freeze([
  'llm',
  'embedding',
  'chain',
  'retriever',
  'reranker',
  'tool',
  'agent',
  'guardrail',
  'evaluator',
  'prompt',
  'unknown',
] as const);

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes?: AttributeMap;
}

export interface ToolCallRef {
  readonly id?: string;
  readonly name: string;
  readonly arguments?: string;
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCalls?: readonly ToolCallRef[];
}

/**
 * LLM call payload. Every content field is optional: capture is off by default
 * (NFR-4.1), and L0/L2 detection works on metadata alone.
 */
export interface LlmPayload {
  readonly provider?: string;
  readonly requestModel?: string;
  readonly responseModel?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
  readonly finishReason?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly contextLimit?: number;
  readonly systemInstructions?: string;
  /**
   * Message-list length. Metadata, not content, so it survives with
   * `captureContent: false` — which is what lets session-scoped detection of
   * MAST FM-2.1 (conversation reset) work in the default privacy posture.
   */
  readonly inputMessageCount?: number;
  readonly inputMessages?: readonly ChatMessage[];
  readonly outputMessages?: readonly ChatMessage[];
  /** Separated from the answer so AGT-006 (MAST FM-2.6) can compare plan against action. */
  readonly reasoningText?: string;
  readonly costUsd?: number;
}

export interface RetrievedDocument {
  readonly id: string;
  /** First-class because RET-002 (Barnett FP2) compares this against a baseline. */
  readonly score?: number;
  readonly content?: string;
  readonly metadata?: AttributeMap;
  /** Drives RET-006 index staleness. */
  readonly timestamp?: number;
}

export interface RetrievalPayload {
  readonly query?: string;
  readonly indexName?: string;
  readonly topK?: number;
  readonly scoreThreshold?: number;
  readonly documents?: readonly RetrievedDocument[];
}

export interface ToolPayload {
  readonly toolName: string;
  readonly toolType?: 'function' | 'extension' | 'datastore';
  readonly arguments?: string;
  readonly result?: string;
  readonly error?: string;
  /** Attempt ordinal — drives TOL-004 retry-storm detection. */
  readonly attempt?: number;
  /** State-changing call — drives AGT-008 (missing verification) and TOL-005. */
  readonly mutating?: boolean;
  /** Privileged tools are weighted more heavily by TOL-005 excessive agency. */
  readonly privileged?: boolean;
  readonly parameterSchema?: unknown;
  readonly availableTools?: readonly string[];
}

export interface AgentPayload {
  readonly agentName?: string;
  readonly agentRole?: string;
  readonly objective?: string;
  readonly iteration?: number;
  readonly maxIterations?: number;
  /** The subtask ledger — AGT-007 premature termination compares these two. */
  readonly declaredSubtasks?: readonly string[];
  readonly completedSubtasks?: readonly string[];
  readonly terminated?: boolean;
  readonly reasoningText?: string;
}

export interface SpanRecord {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly statusMessage?: string;
  readonly attributes: AttributeMap;
  readonly events: readonly SpanEvent[];
  readonly llm?: LlmPayload;
  readonly retrieval?: RetrievalPayload;
  readonly tool?: ToolPayload;
  readonly agent?: AgentPayload;
}
