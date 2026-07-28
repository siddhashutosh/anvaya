/**
 * The observe* helpers (FR-1.6).
 *
 * Each wraps a host function in a correctly-parented span, captures the payload
 * detection needs, and — critically — RE-THROWS the host's own error after
 * recording it. See ADR-0005 for why that asymmetry is deliberate.
 *
 * All of them are safe to call with no initialised client: they simply run the
 * wrapped function (IF-1.1).
 */

import type {
  AgentPayload,
  LlmPayload,
  RetrievalPayload,
  SpanKind,
  ToolPayload,
} from '@anvaya/core';
import { getClient } from './registry.js';
import type { SpanBuilder } from './span.js';

export type LlmMeta = Omit<LlmPayload, 'outputTokens' | 'finishReason' | 'outputMessages'>;
export type RetrievalMeta = Omit<RetrievalPayload, 'documents'>;
export type ToolMeta = Omit<ToolPayload, 'result' | 'error'>;
export type AgentMeta = AgentPayload;

async function run<T>(
  name: string,
  kind: SpanKind,
  fn: () => Promise<T>,
  configure: (span: SpanBuilder) => void,
  onSuccess?: (span: SpanBuilder, result: T) => void,
): Promise<T> {
  const client = getClient();
  const span = client?.startSpan(name, kind);

  // No client, or span creation failed: run the host function untouched.
  if (!client || !span) return fn();

  try {
    configure(span);
  } catch {
    // Payload capture must never break the call it is observing.
  }

  try {
    const result = await client.withSpan(span, fn);
    try {
      span.setStatus('ok');
      onSuccess?.(span, result);
    } catch {
      /* capture failure is not a call failure */
    }
    return result;
  } catch (e) {
    try {
      span.recordException(e);
    } catch {
      /* ignore */
    }
    // Host's error, re-thrown unchanged.
    throw e;
  } finally {
    try {
      client.record(span.end());
    } catch {
      /* ignore */
    }
  }
}

export function observeLLM<T>(
  name: string,
  meta: LlmMeta,
  fn: () => Promise<T>,
  extract?: (result: T) => Partial<LlmPayload>,
): Promise<T> {
  return run(
    name,
    'llm',
    fn,
    (span) => span.setLlm(meta),
    (span, result) => {
      if (extract) span.setLlm(extract(result));
    },
  );
}

export function observeRetrieval<T>(
  name: string,
  meta: RetrievalMeta,
  fn: () => Promise<T>,
  extract?: (result: T) => Partial<RetrievalPayload>,
): Promise<T> {
  return run(
    name,
    'retriever',
    fn,
    (span) => span.setRetrieval(meta),
    (span, result) => {
      if (extract) span.setRetrieval(extract(result));
    },
  );
}

export function observeTool<T>(
  name: string,
  meta: ToolMeta,
  fn: () => Promise<T>,
  extract?: (result: T) => Partial<ToolPayload>,
): Promise<T> {
  return run(
    name,
    'tool',
    fn,
    (span) => span.setTool(meta),
    (span, result) => {
      span.setTool(extract ? extract(result) : { toolName: meta.toolName });
    },
  );
}

export function observeAgent<T>(name: string, meta: AgentMeta, fn: () => Promise<T>): Promise<T> {
  return run(name, 'agent', fn, (span) => span.setAgent(meta));
}

export function observeGuardrail<T>(
  name: string,
  fn: () => Promise<T>,
  extract?: (result: T) => Record<string, string | number | boolean>,
): Promise<T> {
  return run(
    name,
    'guardrail',
    fn,
    () => {},
    (span, result) => {
      if (extract) span.setAttributes(extract(result));
    },
  );
}

export function observeChain<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return run(name, 'chain', fn, () => {});
}

export function observeEmbedding<T>(name: string, model: string, fn: () => Promise<T>): Promise<T> {
  return run(name, 'embedding', fn, (span) => span.setAttribute('embedding.model', model));
}

export function observeReranker<T>(
  name: string,
  meta: RetrievalMeta,
  fn: () => Promise<T>,
  extract?: (result: T) => Partial<RetrievalPayload>,
): Promise<T> {
  return run(
    name,
    'reranker',
    fn,
    (span) => span.setRetrieval(meta),
    (span, result) => {
      if (extract) span.setRetrieval(extract(result));
    },
  );
}
