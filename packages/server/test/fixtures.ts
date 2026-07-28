/**
 * Trace fixtures.
 *
 * Detector tests read as scenarios rather than as JSON blobs, which is what
 * makes "does this detector fire on the thing it claims to detect?" reviewable.
 */

import {
  createNoopLogger,
  newSpanId,
  newTraceId,
  type Finding,
  type NormalizedTrace,
  type SpanKind,
  type SpanRecord,
  type TraceRecord,
} from '@anvaya/core';
import { TraceEnricher } from '../src/analysis/enricher.js';
import { configSchema, type Config } from '../src/config/schema.js';
import type { BaselineReader, DetectionContext, Detector } from '../src/detectors/types.js';

export const TEST_CONFIG: Config = configSchema.parse({});
const enricher = new TraceEnricher();

export interface SpanInput extends Partial<Omit<SpanRecord, 'spanId' | 'traceId' | 'kind'>> {
  name: string;
  kind: SpanKind;
  /** Index into the span list; resolved to a real spanId by the builder. */
  parent?: number;
  offsetMs?: number;
}

export class TraceBuilder {
  private readonly traceId = newTraceId();
  private readonly inputs: SpanInput[] = [];
  /**
   * An hour ago, not a fixed historical instant: API queries default to the last
   * 24 hours, so a fixture pinned to a past date is invisible to every endpoint
   * under test. The hour of headroom keeps span offsets in the past too.
   */
  private baseTime = Date.now() - 3_600_000;
  private attributes: Record<string, string | number | boolean> = {};
  private sessionId: string | undefined;

  span(input: SpanInput): this {
    this.inputs.push(input);
    return this;
  }

  attrs(attributes: Record<string, string | number | boolean>): this {
    this.attributes = { ...this.attributes, ...attributes };
    return this;
  }

  session(id: string): this {
    this.sessionId = id;
    return this;
  }

  /** Pin the trace to an absolute start time, for time-sensitive assertions. */
  at(epochMs: number): this {
    this.baseTime = epochMs;
    return this;
  }

  build(): { trace: TraceRecord; spans: SpanRecord[] } {
    const ids = this.inputs.map(() => newSpanId());

    const spans: SpanRecord[] = this.inputs.map((input, i) => {
      const startTime = this.baseTime + (input.offsetMs ?? i * 100);
      const durationMs = input.durationMs ?? 50;
      const parentIndex = input.parent;
      return {
        spanId: ids[i] as string,
        traceId: this.traceId,
        ...(parentIndex !== undefined ? { parentSpanId: ids[parentIndex] as string } : {}),
        name: input.name,
        kind: input.kind,
        startTime,
        endTime: startTime + durationMs,
        durationMs,
        status: input.status ?? 'ok',
        ...(input.statusMessage ? { statusMessage: input.statusMessage } : {}),
        attributes: input.attributes ?? {},
        events: input.events ?? [],
        ...(input.llm ? { llm: input.llm } : {}),
        ...(input.retrieval ? { retrieval: input.retrieval } : {}),
        ...(input.tool ? { tool: input.tool } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      };
    });

    const startTime = Math.min(...spans.map((s) => s.startTime));
    const endTime = Math.max(...spans.map((s) => s.endTime));

    return {
      trace: {
        traceId: this.traceId,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        service: 'test-service',
        environment: 'test',
        rootSpanId: spans[0]?.spanId,
        name: spans[0]?.name ?? 'trace',
        startTime,
        endTime,
        durationMs: endTime - startTime,
        status: spans.some((s) => s.status === 'error') ? 'error' : 'ok',
        spanCount: spans.length,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        findingCount: 0,
        attributes: this.attributes,
      },
      spans,
    };
  }

  normalized(): NormalizedTrace {
    const { trace, spans } = this.build();
    return enricher.enrich(trace, spans);
  }
}

export function trace(): TraceBuilder {
  return new TraceBuilder();
}

/** A baseline reader backed by literal values, so L2 tests are deterministic. */
export function baselines(
  entries: Record<string, { mean: number; stddev: number; count: number; samples?: number[] }>,
): BaselineReader {
  return {
    get(metric, scope = 'global') {
      const entry = entries[`${metric}::${scope}`] ?? entries[metric];
      if (!entry) return undefined;
      return {
        count: entry.count,
        mean: entry.mean,
        // Welford stores M2; variance = M2 / (n-1).
        m2: entry.stddev ** 2 * Math.max(1, entry.count - 1),
        min: entry.mean - entry.stddev * 3,
        max: entry.mean + entry.stddev * 3,
        samples: entry.samples ?? [],
      };
    },
    samples(metric, scope = 'global') {
      return (entries[`${metric}::${scope}`] ?? entries[metric])?.samples ?? [];
    },
  };
}

export const NO_BASELINES: BaselineReader = {
  get: () => undefined,
  samples: () => [],
};

export function context(
  normalized: NormalizedTrace,
  overrides: Partial<DetectionContext> = {},
): DetectionContext {
  return {
    trace: normalized,
    baselines: NO_BASELINES,
    config: TEST_CONFIG.detection,
    thresholds: TEST_CONFIG.detection.thresholds,
    logger: createNoopLogger(),
    existing: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Run a detector against a trace, honouring its own supports() gate. */
export async function run(
  detector: Detector,
  normalized: NormalizedTrace,
  overrides: Partial<DetectionContext> = {},
): Promise<readonly Finding[]> {
  if (!detector.supports(normalized)) return [];
  return detector.run(context(normalized, overrides));
}

export const LONG_ANSWER =
  'Refunds are processed within five business days of approval. Customers must submit a request within thirty days of the original purchase date. Approved refunds return to the original payment method.';
