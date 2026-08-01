/**
 * Bounded queue + batched async delivery (FR-1.11, FR-1.13).
 *
 * The queue is bounded and drops the OLDEST span on overflow. Dropping the newest
 * would bias retention toward the start of a spike, which is exactly the period
 * least likely to contain the failure being investigated. Drops are counted, never
 * silent (NFR-2.5).
 */

import type { Logger, SpanRecord } from '@anvaya/core';
import type { Transport } from './http-transport.js';

export interface BatchProcessorOptions {
  readonly maxQueueSize: number;
  readonly batchSize: number;
  readonly flushIntervalMs: number;
  readonly service: string;
  readonly environment: string;
  readonly transport: Transport;
  readonly logger: Logger;
}

export interface BatchStats {
  readonly queued: number;
  readonly sent: number;
  readonly dropped: number;
  readonly failed: number;
  /** Delivered but refused by the collector — usually a malformed span. */
  readonly rejected: number;
  readonly circuitState: string;
}

export class BatchProcessor {
  private readonly queue: SpanRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** The in-flight flush, if any. Callers await this rather than returning early. */
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  private sent = 0;
  private dropped = 0;
  private failed = 0;
  private rejected = 0;

  constructor(private readonly options: BatchProcessorOptions) {
    this.scheduleFlush();
  }

  enqueue(span: SpanRecord): void {
    if (this.stopped) return;

    if (this.queue.length >= this.options.maxQueueSize) {
      this.queue.shift();
      this.dropped++;
      // One warning per 100 drops: a full queue would otherwise flood the host's logs.
      if (this.dropped % 100 === 1) {
        this.options.logger.warn('anvaya sdk: span queue full, dropping oldest', {
          dropped: this.dropped,
          maxQueueSize: this.options.maxQueueSize,
        });
      }
    }
    this.queue.push(span);

    if (this.queue.length >= this.options.batchSize) {
      void this.flush();
    }
  }

  /**
   * Deliver everything currently queued.
   *
   * When a flush is already in flight this AWAITS it rather than returning
   * early — `await flush()` is a delivery guarantee (FR-1.15), and returning
   * while a send is still in flight silently loses spans at shutdown. After the
   * in-flight flush settles, it loops so anything enqueued meanwhile also goes.
   */
  async flush(): Promise<void> {
    for (;;) {
      if (this.inFlight) {
        await this.inFlight;
        // Another caller drained the queue while we waited.
        if (this.queue.length === 0) return;
        continue;
      }
      if (this.queue.length === 0) return;

      const run = this.drain();
      this.inFlight = run;
      try {
        await run;
      } finally {
        if (this.inFlight === run) this.inFlight = undefined;
      }
      // A transport failure stops the drain; do not spin retrying it here.
      if (this.lastDrainFailed) return;
    }
  }

  private lastDrainFailed = false;

  private async drain(): Promise<void> {
    this.lastDrainFailed = false;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.options.batchSize);
      const result = await this.options.transport.send({
        format: 'anvaya',
        service: this.options.service,
        environment: this.options.environment,
        spans: batch,
      });

      if (result.ok) {
        // A 202 does not mean every span was kept: the collector validates each
        // one and reports per-span rejections in the ack. Counting the batch as
        // wholly sent would hide malformed spans behind a green transport —
        // precisely the silent failure this project exists to surface.
        const rejected = result.value.rejected ?? 0;
        this.sent += batch.length - rejected;
        if (rejected > 0) {
          this.rejected += rejected;
          this.options.logger.warn('anvaya sdk: collector rejected spans', {
            rejected,
            batchSize: batch.length,
            reason: result.value.errors?.[0]?.message,
          });
        }
        continue;
      }

      this.failed += batch.length;
      this.lastDrainFailed = true;
      // The batch is not requeued: doing so under a sustained outage would grow
      // memory without bound, and the transport has already retried.
      if (this.failed % 100 < batch.length) {
        this.options.logger.warn('anvaya sdk: batch send failed', {
          err: result.error,
          batchSize: batch.length,
          totalFailed: this.failed,
        });
      }
      return;
    }
  }

  stats(): BatchStats {
    return {
      queued: this.queue.length,
      sent: this.sent,
      dropped: this.dropped,
      failed: this.failed,
      rejected: this.rejected,
      circuitState: this.options.transport.circuitState,
    };
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  private scheduleFlush(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
    // Never hold the host process open just to flush telemetry.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
}
