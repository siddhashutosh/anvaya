/**
 * Implicit trace-context propagation via AsyncLocalStorage (FR-1.7).
 *
 * Nested observe* calls read the ambient context to find their parent, so users
 * never thread a trace object through their call stack. Instrumentation outside
 * a trace degrades to a root span rather than failing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sessionId?: string;
  readonly sampled: boolean;
}

const storage = new AsyncLocalStorage<SpanContext>();

export function getContext(): SpanContext | undefined {
  return storage.getStore();
}

export function runInContext<T>(ctx: SpanContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Derive a child context that keeps the trace but re-parents to a new span. */
export function childContext(parent: SpanContext, spanId: string): SpanContext {
  return {
    traceId: parent.traceId,
    spanId,
    sampled: parent.sampled,
    ...(parent.sessionId !== undefined ? { sessionId: parent.sessionId } : {}),
  };
}
