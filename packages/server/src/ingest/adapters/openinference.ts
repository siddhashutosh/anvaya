/**
 * OpenInference adapter (FR-2.6).
 *
 * The span-kind vocabulary maps 1:1 onto the internal model — the internal kinds
 * were chosen to align with it precisely so this adapter stays trivial.
 */

import {
  ERROR_CODES,
  SPAN_KINDS,
  ValidationError,
  err,
  newSpanId,
  newTraceId,
  ok,
  type AttributeMap,
  type AttributeValue,
  type LlmPayload,
  type RetrievalPayload,
  type Result,
  type RetrievedDocument,
  type SpanKind,
  type SpanRecord,
  type SpanStatus,
  type ToolPayload,
} from '@anvaya/core';
import type { AdaptContext, SpanAdapter } from './types.js';

const MAPPED_PREFIXES = ['llm.', 'retrieval.', 'tool.', 'embedding.', 'input.', 'output.'];
const MAPPED_KEYS = new Set(['openinference.span.kind', 'session.id']);

interface OiSpanLike {
  readonly spanId?: string;
  readonly traceId?: string;
  readonly parentSpanId?: string;
  readonly name?: string;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly statusCode?: string;
  readonly statusMessage?: string;
  readonly attributes?: Record<string, unknown>;
}

export class OpenInferenceAdapter implements SpanAdapter {
  readonly format = 'openinference' as const;

  adapt(raw: unknown, _ctx: AdaptContext): Result<SpanRecord, ValidationError> {
    if (typeof raw !== 'object' || raw === null) {
      return err(
        new ValidationError('openinference span must be an object', {
          code: ERROR_CODES.INVALID_SPAN,
        }),
      );
    }
    const span = raw as OiSpanLike;
    const attrs = span.attributes ?? {};

    const startTime = num(span.startTime);
    const endTime = num(span.endTime);
    if (startTime === undefined || endTime === undefined) {
      return err(
        new ValidationError('openinference span is missing start/end timestamps', {
          code: ERROR_CODES.INVALID_SPAN,
        }),
      );
    }

    const kind = mapKind(str(attrs['openinference.span.kind']));
    const sessionId = str(attrs['session.id']);

    return ok({
      spanId: span.spanId ?? newSpanId(),
      traceId: span.traceId ?? newTraceId(),
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      name: span.name && span.name.length > 0 ? span.name : kind,
      kind,
      startTime,
      endTime,
      durationMs: Math.max(0, endTime - startTime),
      status: mapStatus(span.statusCode),
      ...(span.statusMessage ? { statusMessage: span.statusMessage } : {}),
      attributes: {
        ...passthrough(attrs),
        ...(sessionId ? { 'anvaya.session_id': sessionId } : {}),
      },
      events: [],
      ...(kind === 'llm' ? { llm: buildLlm(attrs) } : {}),
      ...(kind === 'retriever' || kind === 'reranker'
        ? { retrieval: buildRetrieval(attrs) }
        : {}),
      ...(kind === 'tool' ? { tool: buildTool(attrs) } : {}),
    });
  }
}

function mapKind(value: string | undefined): SpanKind {
  if (!value) return 'unknown';
  const lower = value.toLowerCase();
  return (SPAN_KINDS as readonly string[]).includes(lower) ? (lower as SpanKind) : 'unknown';
}

function mapStatus(code: string | undefined): SpanStatus {
  if (code === 'ERROR') return 'error';
  if (code === 'OK') return 'ok';
  return 'unset';
}

function buildLlm(attrs: Record<string, unknown>): LlmPayload {
  return {
    ...(str(attrs['llm.provider']) ? { provider: str(attrs['llm.provider']) as string } : {}),
    ...(str(attrs['llm.model_name'])
      ? { requestModel: str(attrs['llm.model_name']) as string }
      : {}),
    ...(num(attrs['llm.token_count.prompt']) !== undefined
      ? { inputTokens: num(attrs['llm.token_count.prompt']) as number }
      : {}),
    ...(num(attrs['llm.token_count.completion']) !== undefined
      ? { outputTokens: num(attrs['llm.token_count.completion']) as number }
      : {}),
    ...(str(attrs['output.value'])
      ? { outputMessages: [{ role: 'assistant' as const, content: str(attrs['output.value']) as string }] }
      : {}),
    ...(str(attrs['input.value'])
      ? { inputMessages: [{ role: 'user' as const, content: str(attrs['input.value']) as string }] }
      : {}),
  };
}

function buildRetrieval(attrs: Record<string, unknown>): RetrievalPayload {
  const documents: RetrievedDocument[] = [];
  // OpenInference indexes documents as retrieval.documents.N.document.*
  for (let i = 0; i < 100; i++) {
    const prefix = `retrieval.documents.${i}.document`;
    const id = str(attrs[`${prefix}.id`]);
    const score = num(attrs[`${prefix}.score`]);
    const content = str(attrs[`${prefix}.content`]);
    if (id === undefined && score === undefined && content === undefined) break;
    documents.push({
      id: id ?? `doc-${i}`,
      ...(score !== undefined ? { score } : {}),
      ...(content !== undefined ? { content } : {}),
    });
  }

  return {
    ...(str(attrs['input.value']) ? { query: str(attrs['input.value']) as string } : {}),
    ...(documents.length > 0 ? { documents } : {}),
  };
}

function buildTool(attrs: Record<string, unknown>): ToolPayload {
  return {
    toolName: str(attrs['tool.name']) ?? 'unknown',
    ...(str(attrs['tool.parameters'])
      ? { arguments: str(attrs['tool.parameters']) as string }
      : {}),
    ...(str(attrs['output.value']) ? { result: str(attrs['output.value']) as string } : {}),
  };
}

function passthrough(attrs: Record<string, unknown>): AttributeMap {
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (MAPPED_KEYS.has(key)) continue;
    if (MAPPED_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
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
