/**
 * IngestWorker — drains the span queue into the assembler, sweeps idle traces,
 * and feeds completed traces to the analysis pipeline.
 *
 * This is where backpressure lives: the HTTP layer only ever pushes to a bounded
 * queue and returns, so ingest acknowledgement latency is decoupled from analysis
 * time (NFR-1.3 vs NFR-1.5).
 */

import type { Logger, SpanRecord, TraceRecord } from '@anvaya/core';
import { TraceAssembler } from '../ingest/assembler.js';
import { SpanQueue, type QueuedSpan } from '../ingest/queue.js';
import type { Metrics } from '../telemetry/metrics.js';
import type { AnalysisPipeline } from './pipeline.js';

export interface IngestWorkerOptions {
  readonly queue: SpanQueue;
  readonly pipeline: AnalysisPipeline;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly traceIdleMs: number;
  readonly maxPendingTraces: number;
  readonly maxSpansPerTrace: number;
  readonly sweepIntervalMs: number;
  readonly concurrency: number;
}

export class IngestWorker {
  private readonly assembler: TraceAssembler;
  private readonly logger: Logger;
  private readonly ready: { trace: TraceRecord; spans: readonly SpanRecord[] }[] = [];

  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private draining = false;
  private inFlight = 0;

  constructor(private readonly options: IngestWorkerOptions) {
    this.logger = options.logger.child('worker');
    this.assembler = new TraceAssembler({
      idleMs: options.traceIdleMs,
      maxPending: options.maxPendingTraces,
      maxSpansPerTrace: options.maxSpansPerTrace,
      logger: this.logger,
      onComplete: (trace, spans) => {
        this.ready.push({ trace, spans });
      },
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.sweepIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.info('ingest worker started', {
      sweepIntervalMs: this.options.sweepIntervalMs,
      concurrency: this.options.concurrency,
    });
  }

  /** One cycle: drain the queue, assemble, sweep idle traces, analyse what is ready. */
  async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const batch = this.options.queue.drain(500);
      for (const item of batch) this.assembler.add(item);

      this.assembler.sweep();
      this.options.metrics.gauge('queue.depth', this.options.queue.size);
      this.options.metrics.gauge('queue.dropped', this.options.queue.dropped);
      this.options.metrics.gauge('assembler.pending', this.assembler.pendingCount);

      await this.analyseReady();
    } catch (e) {
      // The worker loop must survive anything; a dead worker means silent blindness.
      this.logger.error('worker tick failed', { err: e });
      this.options.metrics.counter('worker.tick_failed');
    } finally {
      this.draining = false;
    }
  }

  /** Flush everything and stop. Used by graceful shutdown (FR-8.6). */
  async drain(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    // Pull whatever is left out of the queue and force every pending trace closed.
    const remaining = this.options.queue.drain(Number.MAX_SAFE_INTEGER);
    for (const item of remaining) this.assembler.add(item);
    const forced = this.assembler.flushAll();
    if (forced > 0) this.logger.info('force-completed pending traces on shutdown', { count: forced });

    await this.analyseReady();
    this.logger.info('ingest worker drained');
  }

  enqueue(item: QueuedSpan): boolean {
    return this.options.queue.push(item);
  }

  stats(): {
    queued: number;
    dropped: number;
    pending: number;
    inFlight: number;
    droppedOversizeSpans: number;
  } {
    return {
      queued: this.options.queue.size,
      dropped: this.options.queue.dropped,
      pending: this.assembler.pendingCount,
      inFlight: this.inFlight,
      droppedOversizeSpans: this.assembler.droppedSpans,
    };
  }

  private async analyseReady(): Promise<void> {
    while (this.ready.length > 0) {
      const batch = this.ready.splice(0, this.options.concurrency);
      this.inFlight += batch.length;
      try {
        await Promise.all(
          batch.map(async ({ trace, spans }) => {
            try {
              await this.options.pipeline.analyze(trace, spans);
            } catch (e) {
              // The pipeline has its own boundaries; this is the last line.
              this.logger.error('pipeline threw for trace', { err: e, traceId: trace.traceId });
              this.options.metrics.counter('pipeline.unhandled_error');
            }
          }),
        );
      } finally {
        this.inFlight -= batch.length;
      }
    }
  }
}
