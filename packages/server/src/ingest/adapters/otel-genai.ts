/**
 * OpenTelemetry GenAI adapter (FR-2.5).
 *
 * The `gen_ai.*` conventions moved to a dedicated repository at v1.42.0 (June
 * 2026) and remain pre-stable — names can still change between versions. The
 * entire mapping is therefore one table constant: a rename is a one-line fix, and
 * unmapped attributes survive verbatim in `attributes` rather than being dropped
 * (ADR-0002, IF-2.2).
 */

import {
  ERROR_CODES,
  ValidationError,
  err,
  newSpanId,
  newTraceId,
  ok,
  type AttributeMap,
  type AttributeValue,
  type ChatMessage,
  type LlmPayload,
  type Result,
  type SpanKind,
  type SpanRecord,
  type SpanStatus,
  type ToolPayload,
} from '@anvaya/core';
import type { AdaptContext, SpanAdapter } from './types.js';

/** gen_ai.operation.name -> internal span kind. */
const OPERATION_TO_KIND: Readonly<Record<string, SpanKind>> = {
  chat: 'llm',
  generate_content: 'llm',
  text_completion: 'llm',
  embeddings: 'embedding',
  retrieval: 'retriever',
  execute_tool: 'tool',
  invoke_agent: 'agent',
  create_agent: 'agent',
  invoke_workflow: 'chain',
};

/** Attribute keys consumed by the mapping; everything else is passed through. */
const MAPPED_KEYS = new Set([
  'gen_ai.provider.name',
  'gen_ai.system',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
  'gen_ai.usage.reasoning.output_tokens',
  'gen_ai.response.finish_reasons',
  'gen_ai.request.temperature',
  'gen_ai.request.max_tokens',
  'gen_ai.operation.name',
  'gen_ai.tool.name',
  'gen_ai.tool.type',
  'gen_ai.tool.call.id',
  'gen_ai.conversation.id',
  'gen_ai.agent.name',
  'gen_ai.agent.id',
]);

interface OtelSpanLike {
  readonly traceId?: string;
  readonly trace_id?: string;
  readonly spanId?: string;
  readonly span_id?: string;
  readonly parentSpanId?: string;
  readonly parent_span_id?: string;
  readonly name?: string;
  readonly startTimeUnixNano?: number | string;
  readonly endTimeUnixNano?: number | string;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly status?: { code?: number | string; message?: string };
  readonly attributes?: Record<string, unknown>;
  readonly events?: readonly { name?: string; timestamp?: number; attributes?: Record<string, unknown> }[];
}

export class OtelGenAiAdapter implements SpanAdapter {
  readonly format = 'otel-genai' as const;

  adapt(raw: unknown, _ctx: AdaptContext): Result<SpanRecord, ValidationError> {
    if (typeof raw !== 'object' || raw === null) {
      return err(
        new ValidationError('otel span must be an object', { code: ERROR_CODES.INVALID_SPAN }),
      );
    }
    const span = raw as OtelSpanLike;
    const attrs = span.attributes ?? {};

    const startTime = toMillis(span.startTime ?? span.startTimeUnixNano);
    const endTime = toMillis(span.endTime ?? span.endTimeUnixNano);
    if (startTime === undefined || endTime === undefined) {
      return err(
        new ValidationError('otel span is missing usable start/end timestamps', {
          code: ERROR_CODES.INVALID_SPAN,
        }),
      );
    }

    const operation = str(attrs['gen_ai.operation.name']);
    const kind: SpanKind = operation ? (OPERATION_TO_KIND[operation] ?? 'unknown') : 'unknown';

    const llm = this.buildLlm(attrs, span.events ?? []);
    const tool = this.buildTool(attrs);

    // SpanRecord has no sessionId; the trace does. Carry it as an attribute so
    // the assembler can promote it.
    const conversationId = str(attrs['gen_ai.conversation.id']);
    const extraAttributes: Record<string, AttributeValue> = conversationId
      ? { 'anvaya.session_id': conversationId }
      : {};

    return ok({
      spanId: span.spanId ?? span.span_id ?? newSpanId(),
      traceId: span.traceId ?? span.trace_id ?? newTraceId(),
      ...(span.parentSpanId ?? span.parent_span_id
        ? { parentSpanId: (span.parentSpanId ?? span.parent_span_id) as string }
        : {}),
      name: span.name ?? operation ?? 'otel-span',
      kind,
      startTime,
      endTime,
      durationMs: Math.max(0, endTime - startTime),
      status: mapStatus(span.status?.code),
      ...(span.status?.message ? { statusMessage: span.status.message } : {}),
      attributes: { ...passthroughAttributes(attrs), ...extraAttributes },
      events: (span.events ?? []).map((e) => ({
        name: e.name ?? 'event',
        timestamp: toMillis(e.timestamp) ?? startTime,
        ...(e.attributes ? { attributes: passthroughAttributes(e.attributes) } : {}),
      })),
      ...(llm ? { llm } : {}),
      ...(tool ? { tool } : {}),
    });
  }

  private buildLlm(
    attrs: Record<string, unknown>,
    events: readonly { name?: string; attributes?: Record<string, unknown> }[],
  ): LlmPayload | undefined {
    const provider = str(attrs['gen_ai.provider.name']) ?? str(attrs['gen_ai.system']);
    const requestModel = str(attrs['gen_ai.request.model']);
    const inputTokens = num(attrs['gen_ai.usage.input_tokens']);
    const outputTokens = num(attrs['gen_ai.usage.output_tokens']);
    const messages = this.buildMessages(attrs, events);
    const systemInstructions = str(attrs['gen_ai.system_instructions']);

    // Any one of these makes it an LLM span. System instructions count: a span
    // carrying a system prompt is unambiguously a model call, and dropping the
    // payload would disable SEC-004 prompt-leak detection for OTel producers.
    if (
      !provider &&
      !requestModel &&
      inputTokens === undefined &&
      outputTokens === undefined &&
      !messages &&
      !systemInstructions
    ) {
      return undefined;
    }

    const finishReasons = attrs['gen_ai.response.finish_reasons'];
    const finishReason = Array.isArray(finishReasons)
      ? str(finishReasons[0])
      : str(finishReasons);

    return {
      ...(provider ? { provider } : {}),
      ...(requestModel ? { requestModel } : {}),
      ...(str(attrs['gen_ai.response.model'])
        ? { responseModel: str(attrs['gen_ai.response.model']) as string }
        : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(num(attrs['gen_ai.usage.cache_read.input_tokens']) !== undefined
        ? { cacheReadTokens: num(attrs['gen_ai.usage.cache_read.input_tokens']) as number }
        : {}),
      ...(num(attrs['gen_ai.usage.cache_creation.input_tokens']) !== undefined
        ? { cacheCreationTokens: num(attrs['gen_ai.usage.cache_creation.input_tokens']) as number }
        : {}),
      ...(num(attrs['gen_ai.usage.reasoning.output_tokens']) !== undefined
        ? { reasoningTokens: num(attrs['gen_ai.usage.reasoning.output_tokens']) as number }
        : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(num(attrs['gen_ai.request.temperature']) !== undefined
        ? { temperature: num(attrs['gen_ai.request.temperature']) as number }
        : {}),
      ...(num(attrs['gen_ai.request.max_tokens']) !== undefined
        ? { maxTokens: num(attrs['gen_ai.request.max_tokens']) as number }
        : {}),
      ...(systemInstructions ? { systemInstructions } : {}),
      ...(messages ?? {}),
    };
  }

  /**
   * Message content arrives one of two ways, and both are live in the wild:
   *
   *   - as span attributes (`gen_ai.input.messages` / `gen_ai.output.messages`)
   *   - as LOG EVENTS on the span (`gen_ai.user.message`, `gen_ai.choice`, …),
   *     which is what the current conventions prescribe
   *
   * Reading only the first silently discarded every prompt and completion from a
   * spec-compliant emitter, which in turn disabled every L1 content detector.
   */
  private buildMessages(
    attrs: Record<string, unknown>,
    events: readonly { name?: string; attributes?: Record<string, unknown> }[],
  ): Pick<LlmPayload, 'inputMessages' | 'outputMessages' | 'inputMessageCount'> | undefined {
    const input: ChatMessage[] = [];
    const output: ChatMessage[] = [];

    // 1. attribute form
    for (const message of parseMessages(attrs['gen_ai.input.messages'])) input.push(message);
    for (const message of parseMessages(attrs['gen_ai.output.messages'])) output.push(message);

    // 2. event form
    for (const event of events) {
      const name = event.name ?? '';
      if (!name.startsWith('gen_ai.')) continue;

      const body = event.attributes ?? {};
      const content = str(body.content) ?? str(body.message) ?? str(body.body);
      if (!content) continue;

      if (name === 'gen_ai.choice' || name === 'gen_ai.assistant.message') {
        output.push({ role: 'assistant', content });
      } else if (name === 'gen_ai.user.message') {
        input.push({ role: 'user', content });
      } else if (name === 'gen_ai.system.message') {
        input.push({ role: 'system', content });
      } else if (name === 'gen_ai.tool.message') {
        input.push({ role: 'tool', content });
      }
    }

    if (input.length === 0 && output.length === 0) return undefined;
    return {
      ...(input.length > 0 ? { inputMessages: input, inputMessageCount: input.length } : {}),
      ...(output.length > 0 ? { outputMessages: output } : {}),
    };
  }

  private buildTool(attrs: Record<string, unknown>): ToolPayload | undefined {
    const toolName = str(attrs['gen_ai.tool.name']);
    if (!toolName) return undefined;
    const toolType = str(attrs['gen_ai.tool.type']);
    return {
      toolName,
      ...(toolType === 'function' || toolType === 'extension' || toolType === 'datastore'
        ? { toolType }
        : {}),
    };
  }
}

/** Everything not consumed by the mapping survives verbatim (IF-2.2). */
function passthroughAttributes(attrs: Record<string, unknown>): AttributeMap {
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (MAPPED_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[key] = value as string[];
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
      out[key] = value as number[];
    } else if (value !== null && value !== undefined) {
      out[key] = JSON.stringify(value).slice(0, 2000);
    }
  }
  return out;
}

function mapStatus(code: number | string | undefined): SpanStatus {
  if (code === 2 || code === 'ERROR' || code === 'STATUS_CODE_ERROR') return 'error';
  if (code === 1 || code === 'OK' || code === 'STATUS_CODE_OK') return 'ok';
  return 'unset';
}

/** OTel emits nanoseconds; the internal model is milliseconds (DR-2). */
function toMillis(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return undefined;
  // Values above ~1e14 are nanoseconds; below that they are already ms.
  return n > 1e14 ? Math.floor(n / 1e6) : Math.floor(n);
}

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** Accepts the array form and the JSON-string form; tolerates neither being present. */
function parseMessages(value: unknown): ChatMessage[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  const out: ChatMessage[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role : 'user';
    const content =
      typeof record.content === 'string'
        ? record.content
        : // Parts form: [{type:'text', content:'…'}]
          Array.isArray(record.parts)
          ? record.parts
              .map((p) =>
                typeof p === 'object' && p !== null
                  ? String((p as Record<string, unknown>).content ?? '')
                  : '',
              )
              .filter(Boolean)
              .join('\n')
          : undefined;
    if (!content) continue;
    out.push({ role: (VALID_ROLES.has(role) ? role : 'user') as ChatMessage['role'], content });
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
