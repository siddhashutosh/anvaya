/**
 * Bounded span queue (FR-2.8, NFR-2.5).
 *
 * Decouples the fast ingest acknowledgement (NFR-1.3) from slow analysis
 * (NFR-1.5). Overflow drops the oldest and increments a counter surfaced in
 * /health — a silent drop would make the tool lie about its own coverage.
 */

import type { Logger, SpanRecord } from '@anvaya/core';

export interface QueuedSpan {
  readonly span: SpanRecord;
  readonly service: string;
  readonly environment: string;
  readonly sessionId?: string;
  readonly receivedAt: number;
}

export interface SpanQueueOptions {
  readonly maxSize: number;
  readonly logger: Logger;
}

export class SpanQueue {
  private readonly items: QueuedSpan[] = [];
  private droppedCount = 0;
  private readonly logger: Logger;

  constructor(private readonly options: SpanQueueOptions) {
    this.logger = options.logger.child('queue');
  }

  push(item: QueuedSpan): boolean {
    if (this.items.length >= this.options.maxSize) {
      this.items.shift();
      this.droppedCount++;
      if (this.droppedCount % 500 === 1) {
        this.logger.warn('span queue full, dropping oldest', {
          dropped: this.droppedCount,
          maxSize: this.options.maxSize,
        });
      }
      this.items.push(item);
      return false;
    }
    this.items.push(item);
    return true;
  }

  drain(max: number): readonly QueuedSpan[] {
    return this.items.splice(0, max);
  }

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }
}
