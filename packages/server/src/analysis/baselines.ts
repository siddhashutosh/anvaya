/**
 * BaselineManager — incremental rolling statistics (FR-5.8).
 *
 * Welford's algorithm so an update is O(1) rather than a recomputation over
 * history, and a bounded sample reservoir so PSI/JS have raw values to bin
 * without unbounded memory.
 */

import {
  WelfordAccumulator,
  type BaselineRow,
  type BaselineStats,
  type Logger,
  type NormalizedTrace,
} from '@anvaya/core';
import type { Storage } from '../storage/types.js';
import type { BaselineReader } from '../detectors/types.js';

interface Entry {
  readonly metric: string;
  readonly scope: string;
  readonly accumulator: WelfordAccumulator;
  dirty: boolean;
}

function key(metric: string, scope: string): string {
  return `${metric}::${scope}`;
}

export class BaselineManager implements BaselineReader {
  private readonly entries = new Map<string, Entry>();
  private readonly logger: Logger;

  constructor(
    private readonly storage: Storage,
    logger: Logger,
  ) {
    this.logger = logger.child('baselines');
  }

  /** Load persisted baselines into memory once at startup. */
  async load(): Promise<void> {
    const rows = await this.storage.listBaselines();
    for (const row of rows) {
      this.entries.set(key(row.metric, row.scope), {
        metric: row.metric,
        scope: row.scope,
        accumulator: WelfordAccumulator.fromJSON(row.stats),
        dirty: false,
      });
    }
    this.logger.info('baselines loaded', { count: rows.length });
  }

  get(metric: string, scope = 'global'): BaselineStats | undefined {
    return this.entries.get(key(metric, scope))?.accumulator.toJSON();
  }

  samples(metric: string, scope = 'global'): readonly number[] {
    return this.entries.get(key(metric, scope))?.accumulator.samples ?? [];
  }

  /**
   * Fold a trace into every baseline it contributes to.
   *
   * Called AFTER detection so a trace is never compared against a baseline that
   * already includes it — otherwise an outlier partially masks itself.
   */
  update(trace: NormalizedTrace): void {
    this.push('trace.duration_ms', 'global', trace.trace.durationMs);
    this.push('trace.cost_usd', 'global', trace.metrics.totalCostUsd);
    this.push('trace.output_tokens', 'global', trace.metrics.totalOutputTokens);
    this.push('trace.span_count', 'global', trace.spans.length);

    for (const span of trace.byKind.llm) {
      const model = span.llm?.requestModel ?? 'unknown';
      this.push('llm.duration_ms', model, span.durationMs);
      if (span.llm?.outputTokens !== undefined) {
        this.push('llm.output_tokens', model, span.llm.outputTokens);
      }
    }

    for (const span of trace.byKind.retriever) {
      const index = span.retrieval?.indexName ?? 'default';
      this.push('retrieval.duration_ms', index, span.durationMs);

      const scores = (span.retrieval?.documents ?? [])
        .map((d) => d.score)
        .filter((s): s is number => typeof s === 'number');
      if (scores.length > 0) {
        this.push('retrieval.top1_score', index, Math.max(...scores));
        // Also keep a 'default'-scoped copy so drift has a single global series.
        if (index !== 'default') this.push('retrieval.top1_score', 'default', Math.max(...scores));
      }
    }

    for (const span of trace.byKind.tool) {
      this.push('tool.duration_ms', span.tool?.toolName ?? span.name, span.durationMs);
    }
  }

  /** Persist dirty baselines. Called on a timer and at shutdown. */
  async flush(): Promise<void> {
    const dirty = [...this.entries.values()].filter((e) => e.dirty);
    if (dirty.length === 0) return;

    const rows: BaselineRow[] = dirty.map((e) => ({
      metric: e.metric,
      scope: e.scope,
      stats: e.accumulator.toJSON(),
      updatedAt: Date.now(),
    }));

    await this.storage.putBaselines(rows);
    for (const entry of dirty) entry.dirty = false;
    this.logger.debug('baselines flushed', { count: rows.length });
  }

  get size(): number {
    return this.entries.size;
  }

  private push(metric: string, scope: string, value: number): void {
    if (!Number.isFinite(value)) return;
    const k = key(metric, scope);
    let entry = this.entries.get(k);
    if (!entry) {
      entry = { metric, scope, accumulator: new WelfordAccumulator(), dirty: true };
      this.entries.set(k, entry);
    }
    entry.accumulator.push(value);
    entry.dirty = true;
  }
}
