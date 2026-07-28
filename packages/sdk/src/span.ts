/**
 * Mutable span builder. Becomes an immutable SpanRecord on end().
 *
 * Content is only retained when captureContent is enabled, and everything that
 * is retained passes through the Redactor before it leaves the process
 * (ADR-0007, FR-1.9).
 */

import {
  newSpanId,
  type AgentPayload,
  type AttributeMap,
  type AttributeValue,
  type LlmPayload,
  type Redactor,
  type RetrievalPayload,
  type SpanEvent,
  type SpanKind,
  type SpanRecord,
  type SpanStatus,
  type ToolPayload,
} from '@anvaya/core';

export interface SpanBuilderOptions {
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly captureContent: boolean;
  readonly redactor: Redactor;
}

export class SpanBuilder {
  readonly spanId: string;
  readonly traceId: string;

  private readonly parentSpanId: string | undefined;
  private readonly name: string;
  private readonly kind: SpanKind;
  private readonly startTime: number;
  private readonly captureContent: boolean;
  private readonly redactor: Redactor;

  private status: SpanStatus = 'unset';
  private statusMessage: string | undefined;
  private attributes: Record<string, AttributeValue> = {};
  private events: SpanEvent[] = [];
  private llm: LlmPayload | undefined;
  private retrieval: RetrievalPayload | undefined;
  private tool: ToolPayload | undefined;
  private agent: AgentPayload | undefined;
  private ended = false;

  constructor(options: SpanBuilderOptions) {
    this.spanId = newSpanId();
    this.traceId = options.traceId;
    this.parentSpanId = options.parentSpanId;
    this.name = options.name;
    this.kind = options.kind;
    this.startTime = Date.now();
    this.captureContent = options.captureContent;
    this.redactor = options.redactor;
  }

  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = typeof value === 'string' ? this.scrub(value) : value;
    return this;
  }

  setAttributes(attrs: AttributeMap): this {
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
    return this;
  }

  setStatus(status: SpanStatus, message?: string): this {
    this.status = status;
    if (message !== undefined) this.statusMessage = this.scrub(message).slice(0, 2000);
    return this;
  }

  addEvent(name: string, attributes?: AttributeMap): this {
    this.events.push({
      name,
      timestamp: Date.now(),
      ...(attributes ? { attributes: this.scrubAttributes(attributes) } : {}),
    });
    return this;
  }

  /** Records an exception as a span event and sets error status (FR-1.8). */
  recordException(error: unknown): this {
    const e = error instanceof Error ? error : new Error(String(error));
    this.addEvent('exception', {
      'exception.type': e.name,
      'exception.message': this.scrub(e.message).slice(0, 1000),
      ...(e.stack ? { 'exception.stacktrace': this.scrub(e.stack).slice(0, 4000) } : {}),
    });
    return this.setStatus('error', e.message);
  }

  setLlm(payload: LlmPayload): this {
    this.llm = { ...this.llm, ...this.filterLlm(payload) };
    return this;
  }

  setRetrieval(payload: RetrievalPayload): this {
    this.retrieval = { ...this.retrieval, ...this.filterRetrieval(payload) };
    return this;
  }

  /** Partial so a later `extract` can attach the result without restating toolName. */
  setTool(payload: Partial<ToolPayload>): this {
    const toolName = payload.toolName ?? this.tool?.toolName;
    if (toolName === undefined) return this;
    this.tool = { ...this.tool, ...this.filterTool({ ...payload, toolName }) };
    return this;
  }

  setAgent(payload: AgentPayload): this {
    this.agent = { ...this.agent, ...this.filterAgent(payload) };
    return this;
  }

  end(): SpanRecord {
    this.ended = true;
    const endTime = Date.now();
    return {
      spanId: this.spanId,
      traceId: this.traceId,
      ...(this.parentSpanId !== undefined ? { parentSpanId: this.parentSpanId } : {}),
      name: this.name,
      kind: this.kind,
      startTime: this.startTime,
      endTime,
      durationMs: endTime - this.startTime,
      status: this.status === 'unset' ? 'ok' : this.status,
      ...(this.statusMessage !== undefined ? { statusMessage: this.statusMessage } : {}),
      attributes: this.attributes,
      events: this.events,
      ...(this.llm ? { llm: this.llm } : {}),
      ...(this.retrieval ? { retrieval: this.retrieval } : {}),
      ...(this.tool ? { tool: this.tool } : {}),
      ...(this.agent ? { agent: this.agent } : {}),
    };
  }

  get isEnded(): boolean {
    return this.ended;
  }

  // ── content policy ────────────────────────────────────────────────────────

  private scrub(value: string): string {
    return this.redactor.redact(value).value;
  }

  private scrubAttributes(attrs: AttributeMap): AttributeMap {
    const out: Record<string, AttributeValue> = {};
    for (const [k, v] of Object.entries(attrs)) {
      out[k] = typeof v === 'string' ? this.scrub(v) : v;
    }
    return out;
  }

  /**
   * Metadata always survives; free text only survives with captureContent on.
   * L0 and L2 detection is fully functional on metadata alone, which is why the
   * default is safe rather than crippling.
   */
  private filterLlm(p: LlmPayload): LlmPayload {
    const metadata: LlmPayload = {
      ...(p.provider !== undefined ? { provider: p.provider } : {}),
      ...(p.requestModel !== undefined ? { requestModel: p.requestModel } : {}),
      ...(p.responseModel !== undefined ? { responseModel: p.responseModel } : {}),
      ...(p.inputTokens !== undefined ? { inputTokens: p.inputTokens } : {}),
      ...(p.outputTokens !== undefined ? { outputTokens: p.outputTokens } : {}),
      ...(p.cacheReadTokens !== undefined ? { cacheReadTokens: p.cacheReadTokens } : {}),
      ...(p.cacheCreationTokens !== undefined ? { cacheCreationTokens: p.cacheCreationTokens } : {}),
      ...(p.reasoningTokens !== undefined ? { reasoningTokens: p.reasoningTokens } : {}),
      ...(p.finishReason !== undefined ? { finishReason: p.finishReason } : {}),
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
      ...(p.contextLimit !== undefined ? { contextLimit: p.contextLimit } : {}),
      ...(p.costUsd !== undefined ? { costUsd: p.costUsd } : {}),
      // A count is metadata, not content, so it is captured either way — session
      // detection of conversation resets depends on it.
      ...(p.inputMessageCount !== undefined
        ? { inputMessageCount: p.inputMessageCount }
        : p.inputMessages
          ? { inputMessageCount: p.inputMessages.length }
          : {}),
    };
    if (!this.captureContent) return metadata;

    return {
      ...metadata,
      ...(p.systemInstructions !== undefined
        ? { systemInstructions: this.scrub(p.systemInstructions) }
        : {}),
      ...(p.inputMessages
        ? { inputMessages: p.inputMessages.map((m) => ({ ...m, content: this.scrub(m.content) })) }
        : {}),
      ...(p.outputMessages
        ? { outputMessages: p.outputMessages.map((m) => ({ ...m, content: this.scrub(m.content) })) }
        : {}),
      ...(p.reasoningText !== undefined ? { reasoningText: this.scrub(p.reasoningText) } : {}),
    };
  }

  private filterRetrieval(p: RetrievalPayload): RetrievalPayload {
    const documents = p.documents?.map((d) => ({
      id: d.id,
      ...(d.score !== undefined ? { score: d.score } : {}),
      ...(d.timestamp !== undefined ? { timestamp: d.timestamp } : {}),
      ...(d.metadata ? { metadata: this.scrubAttributes(d.metadata) } : {}),
      ...(this.captureContent && d.content !== undefined ? { content: this.scrub(d.content) } : {}),
    }));

    return {
      ...(p.indexName !== undefined ? { indexName: p.indexName } : {}),
      ...(p.topK !== undefined ? { topK: p.topK } : {}),
      ...(p.scoreThreshold !== undefined ? { scoreThreshold: p.scoreThreshold } : {}),
      ...(this.captureContent && p.query !== undefined ? { query: this.scrub(p.query) } : {}),
      ...(documents ? { documents } : {}),
    };
  }

  private filterTool(p: ToolPayload): ToolPayload {
    return {
      toolName: p.toolName,
      ...(p.toolType !== undefined ? { toolType: p.toolType } : {}),
      ...(p.attempt !== undefined ? { attempt: p.attempt } : {}),
      ...(p.mutating !== undefined ? { mutating: p.mutating } : {}),
      ...(p.privileged !== undefined ? { privileged: p.privileged } : {}),
      ...(p.availableTools ? { availableTools: p.availableTools } : {}),
      ...(p.parameterSchema !== undefined ? { parameterSchema: p.parameterSchema } : {}),
      // Errors are retained regardless of captureContent: an error message is
      // diagnostic, and it is redacted like everything else.
      ...(p.error !== undefined ? { error: this.scrub(p.error).slice(0, 2000) } : {}),
      ...(this.captureContent && p.arguments !== undefined
        ? { arguments: this.scrub(p.arguments) }
        : {}),
      ...(this.captureContent && p.result !== undefined ? { result: this.scrub(p.result) } : {}),
    };
  }

  private filterAgent(p: AgentPayload): AgentPayload {
    return {
      ...(p.agentName !== undefined ? { agentName: p.agentName } : {}),
      ...(p.agentRole !== undefined ? { agentRole: p.agentRole } : {}),
      ...(p.iteration !== undefined ? { iteration: p.iteration } : {}),
      ...(p.maxIterations !== undefined ? { maxIterations: p.maxIterations } : {}),
      ...(p.declaredSubtasks ? { declaredSubtasks: p.declaredSubtasks } : {}),
      ...(p.completedSubtasks ? { completedSubtasks: p.completedSubtasks } : {}),
      ...(p.terminated !== undefined ? { terminated: p.terminated } : {}),
      ...(this.captureContent && p.objective !== undefined
        ? { objective: this.scrub(p.objective) }
        : {}),
      ...(this.captureContent && p.reasoningText !== undefined
        ? { reasoningText: this.scrub(p.reasoningText) }
        : {}),
    };
  }
}
