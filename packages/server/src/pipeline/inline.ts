/**
 * InlineIngestor — the serverless ingest path (ADR-0009).
 *
 * The worker path buffers spans in memory and analyses them on a timer. A
 * serverless runtime provides neither: there is no event loop between
 * invocations and no shared memory across them, so a queued span would simply
 * never be drained.
 *
 * Instead:
 *
 *   1. Spans are written to storage the moment they arrive.
 *   2. When a batch contains the ROOT span — the last span to close, so the
 *      natural end-of-trace signal — the trace is loaded back and analysed
 *      within the same request.
 *   3. Anything the root never arrived for is caught by `sweep()`, driven by a
 *      cron, so a crashed client cannot leave a trace permanently unanalysed.
 *
 * Analysis is therefore at-least-once and idempotent: re-analysing a trace
 * overwrites its findings by id rather than duplicating them.
 */

import type { Logger, SpanRecord, TraceRecord } from '@anvaya/core';
import type { Storage } from '../storage/types.js';
import type { Metrics } from '../telemetry/metrics.js';
import type { AnalysisPipeline } from './pipeline.js';

export interface InlineIngestorOptions {
  readonly storage: Storage;
  readonly pipeline: AnalysisPipeline;
  readonly metrics: Metrics;
  readonly logger: Logger;
  /** A trace with no root is swept once it has been quiet this long. */
  readonly sweepAfterMs: number;
  /**
   * Chance that an ingest request also sweeps a few stale traces.
   *
   * Cron is the floor, not the mechanism — a Hobby-plan deployment gets one
   * cron per day, which is far too slow to recover a trace whose client died.
   * Piggybacking on traffic means recovery normally happens within seconds, and
   * costs nothing on an idle system.
   */
  readonly opportunisticSweepRate?: number;
}

export interface IngestItem {
  readonly span: SpanRecord;
  readonly service: string;
  readonly environment: string;
  readonly sessionId?: string;
}

// Both adapters implement the incremental methods, so inline mode is not
// Postgres-only: SQLite in /tmp is a valid (ephemeral) serverless target.

export class InlineIngestor {
  private readonly logger: Logger;

  constructor(private readonly options: InlineIngestorOptions) {
    this.logger = options.logger.child('inline');
  }

  /**
   * Persist a batch and analyse any trace it completed.
   * Returns the number of traces analysed, for the ingest acknowledgement.
   */
  async ingest(items: readonly IngestItem[]): Promise<{ analysed: number }> {
    if (items.length === 0) return { analysed: 0 };

    const storage = this.options.storage;

    // Group by trace so one batch spanning several traces still writes once each.
    const byTrace = new Map<string, IngestItem[]>();
    for (const item of items) {
      const list = byTrace.get(item.span.traceId) ?? [];
      list.push(item);
      byTrace.set(item.span.traceId, list);
    }

    let analysed = 0;

    for (const [traceId, group] of byTrace) {
      try {
        const spans = group.map((g) => g.span);
        const first = group[0];
        if (!first) continue;

        await storage.saveSpans(buildPartialTrace(first, spans), spans);
        this.options.metrics.counter('inline.spans_written', spans.length);

        // The root span closes last, so its arrival means the trace is complete.
        const hasRoot = spans.some((s) => !s.parentSpanId);
        if (hasRoot) {
          await this.analyseTrace(storage, traceId);
          analysed++;
        }
      } catch (e) {
        // One bad trace must not fail the whole batch.
        this.logger.error('inline ingest failed for trace', { err: e, traceId });
        this.options.metrics.counter('inline.trace_failed');
      }
    }

    await this.maybeSweep();
    return { analysed };
  }

  /**
   * Occasionally recover stale traces on the back of ordinary traffic.
   *
   * Bounded to a couple of traces so an ingest request never turns into a long
   * maintenance job, and failures are swallowed: a sweep must never affect the
   * ingest it rode in on.
   */
  private async maybeSweep(): Promise<void> {
    const rate = this.options.opportunisticSweepRate ?? 0;
    if (rate <= 0 || Math.random() > rate) return;

    try {
      await this.sweep(2);
    } catch (e) {
      this.logger.debug('opportunistic sweep failed', { err: e });
    }
  }

  /**
   * Analyse traces whose root span never arrived, so a client that crashed
   * mid-trace still gets its partial trace diagnosed.
   */
  async sweep(limit = 25): Promise<{ analysed: number }> {
    const storage = this.options.storage;
    const cutoff = Date.now() - this.options.sweepAfterMs;
    const traceIds = await storage.listUnanalysedTraces(cutoff, limit);

    let analysed = 0;
    for (const traceId of traceIds) {
      try {
        await this.analyseTrace(storage, traceId);
        analysed++;
      } catch (e) {
        this.logger.error('sweep analysis failed', { err: e, traceId });
        this.options.metrics.counter('inline.sweep_failed');
      }
    }

    if (analysed > 0) this.logger.info('swept unanalysed traces', { analysed });
    return { analysed };
  }

  private async analyseTrace(storage: Storage, traceId: string): Promise<void> {
    const [record, spans] = await Promise.all([
      storage.getTraceRecord(traceId),
      storage.getTraceSpans(traceId),
    ]);
    if (!record || spans.length === 0) return;

    await this.options.pipeline.analyze(record, spans);
    this.options.metrics.counter('inline.traces_analysed');
  }
}

/**
 * A provisional trace row for spans that have arrived so far.
 *
 * Totals are recomputed properly by the enricher at analysis time; the upsert
 * only ever widens the time envelope, so an early partial row cannot shrink the
 * final one.
 */
function buildPartialTrace(item: IngestItem, spans: readonly SpanRecord[]): TraceRecord {
  let startTime = Number.POSITIVE_INFINITY;
  let endTime = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    if (span.startTime < startTime) startTime = span.startTime;
    if (span.endTime > endTime) endTime = span.endTime;
  }

  const root = spans.find((s) => !s.parentSpanId);
  const sessionFromAttr = spans
    .map((s) => s.attributes['anvaya.session_id'])
    .find((v): v is string => typeof v === 'string');

  const hasError = spans.some((s) => s.status === 'error');

  return {
    traceId: item.span.traceId,
    ...(item.sessionId ?? sessionFromAttr
      ? { sessionId: (item.sessionId ?? sessionFromAttr) as string }
      : {}),
    service: item.service,
    environment: item.environment,
    ...(root ? { rootSpanId: root.spanId } : {}),
    name: root?.name ?? spans[0]?.name ?? 'trace',
    startTime,
    endTime,
    durationMs: Math.max(0, endTime - startTime),
    status: hasError ? 'error' : 'ok',
    spanCount: spans.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    findingCount: 0,
    attributes: root?.attributes ?? spans[0]?.attributes ?? {},
  };
}
