/**
 * TraceAssembler — groups spans into traces and decides when a trace is complete
 * (FR-2.9).
 *
 * Completion rule: the root span closing, or `idleMs` with no new spans,
 * whichever comes first. On overflow the oldest pending trace is force-completed
 * rather than dropped, so a partial trace is still analysed — a trace that never
 * closed is often exactly the failing one.
 */

import { maxOf, minOf, type Logger, type SpanRecord, type TraceRecord } from '@anvaya/core';
import type { QueuedSpan } from './queue.js';

export interface PendingTrace {
  readonly traceId: string;
  readonly service: string;
  readonly environment: string;
  sessionId?: string;
  readonly spans: SpanRecord[];
  firstSeen: number;
  lastSeen: number;
  rootClosed: boolean;
  droppedSpans: number;
}

export interface TraceAssemblerOptions {
  readonly idleMs: number;
  readonly maxPending: number;
  /**
   * Ceiling on spans retained for a single trace. `maxPending` bounds how many
   * traces are in flight but nothing bounded the size of any one of them, so a
   * runaway agent loop could grow memory without limit. Excess spans are dropped
   * and counted rather than silently accepted.
   */
  readonly maxSpansPerTrace: number;
  readonly onComplete: (trace: TraceRecord, spans: readonly SpanRecord[]) => void;
  readonly logger: Logger;
}

export class TraceAssembler {
  private readonly pending = new Map<string, PendingTrace>();
  private readonly logger: Logger;
  private forcedCount = 0;
  private droppedSpanCount = 0;

  constructor(private readonly options: TraceAssemblerOptions) {
    this.logger = options.logger.child('assembler');
  }

  add(item: QueuedSpan): void {
    const { span } = item;
    const now = Date.now();

    let entry = this.pending.get(span.traceId);
    if (!entry) {
      if (this.pending.size >= this.options.maxPending) this.evictOldest();
      entry = {
        traceId: span.traceId,
        service: item.service,
        environment: item.environment,
        spans: [],
        firstSeen: now,
        lastSeen: now,
        rootClosed: false,
        droppedSpans: 0,
        ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
      };
      this.pending.set(span.traceId, entry);
    }

    if (entry.spans.length >= this.options.maxSpansPerTrace) {
      entry.droppedSpans++;
      this.droppedSpanCount++;
      if (entry.droppedSpans === 1) {
        this.logger.warn('trace exceeded span ceiling; further spans dropped', {
          traceId: span.traceId,
          maxSpansPerTrace: this.options.maxSpansPerTrace,
        });
      }
      entry.lastSeen = now;
      return;
    }

    entry.spans.push(span);
    entry.lastSeen = now;

    // Adapters carry a conversation id through as an attribute; promote it.
    if (!entry.sessionId) {
      const fromAttr = span.attributes['anvaya.session_id'];
      if (typeof fromAttr === 'string') entry.sessionId = fromAttr;
    }

    if (!span.parentSpanId) entry.rootClosed = true;
    if (entry.rootClosed) this.complete(span.traceId);
  }

  /** Completes traces that have gone quiet. Called on a timer by the pipeline. */
  sweep(now = Date.now()): number {
    let completed = 0;
    for (const [traceId, entry] of [...this.pending.entries()]) {
      if (now - entry.lastSeen >= this.options.idleMs) {
        this.complete(traceId);
        completed++;
      }
    }
    return completed;
  }

  /** Completes everything pending. Used at graceful shutdown (FR-8.6). */
  flushAll(): number {
    const count = this.pending.size;
    for (const traceId of [...this.pending.keys()]) this.complete(traceId);
    return count;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get forcedCompletions(): number {
    return this.forcedCount;
  }

  /** Spans discarded because their trace hit the per-trace ceiling. */
  get droppedSpans(): number {
    return this.droppedSpanCount;
  }

  private evictOldest(): void {
    let oldestId: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, entry] of this.pending) {
      if (entry.firstSeen < oldestAt) {
        oldestAt = entry.firstSeen;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.forcedCount++;
      this.logger.warn('pending trace limit reached, force-completing oldest', {
        traceId: oldestId,
        pending: this.pending.size,
      });
      this.complete(oldestId);
    }
  }

  private complete(traceId: string): void {
    const entry = this.pending.get(traceId);
    if (!entry || entry.spans.length === 0) {
      this.pending.delete(traceId);
      return;
    }
    this.pending.delete(traceId);

    try {
      this.options.onComplete(buildTraceRecord(entry), entry.spans);
    } catch (e) {
      // The pipeline has its own error boundary; this guard stops one bad trace
      // from stopping the sweep for every other trace.
      this.logger.error('trace completion handler failed', { err: e, traceId });
    }
  }
}

function buildTraceRecord(entry: PendingTrace): TraceRecord {
  const spans = entry.spans;
  // Fold, not spread: a runaway agent can produce a span count large enough to
  // blow the argument limit, and that is precisely the trace worth keeping.
  const startTime = minOf(spans.map((s) => s.startTime));
  const endTime = maxOf(spans.map((s) => s.endTime));

  const root =
    spans.find((s) => !s.parentSpanId) ??
    [...spans].sort((a, b) => a.startTime - b.startTime)[0];

  const hasError = spans.some((s) => s.status === 'error');

  return {
    traceId: entry.traceId,
    ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
    service: entry.service,
    environment: entry.environment,
    ...(root ? { rootSpanId: root.spanId } : {}),
    name: root?.name ?? 'trace',
    startTime,
    endTime,
    durationMs: Math.max(0, endTime - startTime),
    status: hasError ? 'error' : 'ok',
    spanCount: spans.length,
    // Token/cost totals are filled in by the enricher.
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    findingCount: 0,
    attributes: root?.attributes ?? {},
  };
}
