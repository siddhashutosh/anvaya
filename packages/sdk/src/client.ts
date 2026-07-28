/**
 * AnvayaClient — the SDK's public surface.
 *
 * Every method is wrapped by `safely` so no SDK error reaches host code
 * (ADR-0005). The single exception is `trace()`, which must propagate the host
 * function's own error; that is documented and tested.
 */

import {
  Redactor,
  createLogger,
  createNoopLogger,
  newTraceId,
  type Logger,
  type LogLevel,
  type RedactionPattern,
  type SpanKind,
  type SpanRecord,
} from '@anvaya/core';
import { childContext, getContext, runInContext, type SpanContext } from './context.js';
import { safely, safelyAsync, type ErrorHook } from './safely.js';
import { SpanBuilder } from './span.js';
import { BatchProcessor, type BatchStats } from './transport/batch-processor.js';
import { HttpTransport, type Transport } from './transport/http-transport.js';

export interface SdkConfig {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly service: string;
  readonly environment?: string;
  readonly enabled?: boolean;
  readonly sampleRate?: number;
  /** Off by default (NFR-4.1). L0/L2 detection works fully on metadata alone. */
  readonly captureContent?: boolean;
  readonly maxQueueSize?: number;
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly redaction?: {
    readonly enabled?: boolean;
    readonly customPatterns?: readonly RedactionPattern[];
  };
  readonly logLevel?: LogLevel;
  readonly onError?: ErrorHook;
  /** Injectable for tests. */
  readonly transport?: Transport;
  readonly logger?: Logger;
}

export interface TraceOptions {
  readonly sessionId?: string;
  readonly attributes?: Record<string, string | number | boolean>;
}

export interface SpanOptions {
  readonly parentSpanId?: string;
}

export interface TraceHandle {
  readonly traceId: string;
  readonly sessionId?: string;
  setAttribute(key: string, value: string | number | boolean): void;
}

export interface SdkStats extends BatchStats {
  readonly enabled: boolean;
  readonly tracesStarted: number;
  readonly spansRecorded: number;
  readonly spansSampledOut: number;
}

const DEFAULTS = {
  environment: 'development',
  enabled: true,
  sampleRate: 1,
  captureContent: false,
  maxQueueSize: 2048,
  batchSize: 64,
  flushIntervalMs: 2000,
  maxRetries: 3,
  timeoutMs: 5000,
  logLevel: 'warn' as LogLevel,
};

export class AnvayaClient {
  private readonly logger: Logger;
  private readonly redactor: Redactor;
  private readonly processor: BatchProcessor | undefined;
  private readonly enabled: boolean;
  private readonly sampleRate: number;
  private readonly captureContent: boolean;
  private readonly onError: ErrorHook | undefined;

  private tracesStarted = 0;
  private spansRecorded = 0;
  private spansSampledOut = 0;
  private shutdownRegistered = false;
  private exitHook: (() => void) | undefined;

  constructor(private readonly config: SdkConfig) {
    this.enabled = config.enabled ?? DEFAULTS.enabled;
    this.sampleRate = clamp(config.sampleRate ?? DEFAULTS.sampleRate, 0, 1);
    this.captureContent = config.captureContent ?? DEFAULTS.captureContent;
    this.onError = config.onError;

    this.logger =
      config.logger ??
      (this.enabled
        ? createLogger({
            name: 'anvaya.sdk',
            level: config.logLevel ?? DEFAULTS.logLevel,
            format: 'pretty',
            baseContext: { service: config.service },
          })
        : createNoopLogger('anvaya.sdk'));

    this.redactor = new Redactor({
      enabled: config.redaction?.enabled ?? true,
      ...(config.redaction?.customPatterns
        ? { customPatterns: config.redaction.customPatterns }
        : {}),
    });

    if (this.enabled) {
      const transport =
        config.transport ??
        new HttpTransport({
          endpoint: config.endpoint,
          ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
          timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
          maxRetries: config.maxRetries ?? DEFAULTS.maxRetries,
          logger: this.logger,
        });

      this.processor = new BatchProcessor({
        maxQueueSize: config.maxQueueSize ?? DEFAULTS.maxQueueSize,
        batchSize: config.batchSize ?? DEFAULTS.batchSize,
        flushIntervalMs: config.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
        service: config.service,
        environment: config.environment ?? DEFAULTS.environment,
        transport,
        logger: this.logger,
      });

      this.registerShutdownHooks();
    }
  }

  /**
   * Run `fn` inside a new trace.
   *
   * Note the asymmetry required by ADR-0005: the SDK's own bookkeeping is wrapped
   * and can never throw, but `fn`'s error is re-thrown unchanged, because
   * swallowing it would alter host control flow.
   */
  async trace<T>(name: string, fn: (t: TraceHandle) => Promise<T>, options: TraceOptions = {}): Promise<T> {
    if (!this.enabled) {
      return fn(inertHandle(newTraceId()));
    }

    const traceId = newTraceId();
    const sampled = this.shouldSample();
    this.tracesStarted++;

    const span = safely(
      'trace.start',
      () =>
        new SpanBuilder({
          traceId,
          name,
          kind: 'chain',
          captureContent: this.captureContent,
          redactor: this.redactor,
        }),
      undefined,
      this.logger,
      this.onError,
    );

    if (span && options.attributes) {
      safely('trace.attributes', () => span.setAttributes(options.attributes ?? {}), undefined, this.logger, this.onError);
    }

    const ctx: SpanContext = {
      traceId,
      spanId: span?.spanId ?? 'root',
      sampled,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    };

    try {
      const result = await runInContext(ctx, () => fn(this.makeHandle(traceId, span, options.sessionId)));
      if (span) span.setStatus('ok');
      return result;
    } catch (e) {
      // Host error: record it, then re-throw unchanged.
      if (span) safely('trace.recordException', () => span.recordException(e), undefined, this.logger, this.onError);
      throw e;
    } finally {
      if (span) {
        safely(
          'trace.end',
          () => {
            const record = span.end();
            this.record(record, sampled, span.isEnded ? undefined : undefined);
          },
          undefined,
          this.logger,
          this.onError,
        );
      }
    }
  }

  /** Start a span manually. Returns undefined when disabled or on internal failure. */
  startSpan(name: string, kind: SpanKind, options: SpanOptions = {}): SpanBuilder | undefined {
    if (!this.enabled) return undefined;
    const ctx = getContext();
    const traceId = ctx?.traceId ?? newTraceId();
    const parentSpanId = options.parentSpanId ?? ctx?.spanId;

    return safely(
      'startSpan',
      () =>
        new SpanBuilder({
          traceId,
          ...(parentSpanId !== undefined ? { parentSpanId } : {}),
          name,
          kind,
          captureContent: this.captureContent,
          redactor: this.redactor,
        }),
      undefined,
      this.logger,
      this.onError,
    );
  }

  /** Enqueue a finished span. Honours the trace's sampling decision. */
  record(span: SpanRecord, sampled = true, _unused?: undefined): void {
    if (!this.enabled || !this.processor) return;
    safely(
      'record',
      () => {
        // Error spans are always kept regardless of sampling (FR-1.10) — a
        // sampled-out failure is the one trace you actually needed.
        if (!sampled && span.status !== 'error') {
          this.spansSampledOut++;
          return;
        }
        this.processor?.enqueue(span);
        this.spansRecorded++;
      },
      undefined,
      this.logger,
      this.onError,
    );
  }

  /** Run a child span inside the ambient context. Used by the observe* helpers. */
  async withSpan<T>(span: SpanBuilder, fn: () => Promise<T>): Promise<T> {
    const parent = getContext();
    const ctx: SpanContext = parent
      ? childContext(parent, span.spanId)
      : { traceId: span.traceId, spanId: span.spanId, sampled: true };
    return runInContext(ctx, fn);
  }

  async flush(): Promise<void> {
    await safelyAsync('flush', async () => this.processor?.flush(), undefined, this.logger, this.onError);
  }

  async shutdown(): Promise<void> {
    await safelyAsync(
      'shutdown',
      async () => {
        this.removeShutdownHooks();
        await this.processor?.shutdown();
      },
      undefined,
      this.logger,
      this.onError,
    );
  }

  get stats(): SdkStats {
    const batch = this.processor?.stats() ?? {
      queued: 0,
      sent: 0,
      dropped: 0,
      failed: 0,
      circuitState: 'closed',
    };
    return {
      ...batch,
      enabled: this.enabled,
      tracesStarted: this.tracesStarted,
      spansRecorded: this.spansRecorded,
      spansSampledOut: this.spansSampledOut,
    };
  }

  get isCaptureContentEnabled(): boolean {
    return this.captureContent;
  }

  get log(): Logger {
    return this.logger;
  }

  private makeHandle(traceId: string, span: SpanBuilder | undefined, sessionId?: string): TraceHandle {
    return {
      traceId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      setAttribute: (key, value) => {
        safely('handle.setAttribute', () => span?.setAttribute(key, value), undefined, this.logger, this.onError);
      },
    };
  }

  private shouldSample(): boolean {
    return this.sampleRate >= 1 || Math.random() < this.sampleRate;
  }

  /**
   * Flush on exit so buffered spans are not lost (FR-1.15). These listeners only
   * flush; they never alter host error semantics (NFR-3.3), and they are removed
   * on shutdown so a re-init does not accumulate them.
   */
  private registerShutdownHooks(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;
    this.exitHook = (): void => {
      void this.shutdown();
    };
    process.once('beforeExit', this.exitHook);
    process.once('SIGINT', this.exitHook);
    process.once('SIGTERM', this.exitHook);
  }

  private removeShutdownHooks(): void {
    if (!this.exitHook) return;
    process.off('beforeExit', this.exitHook);
    process.off('SIGINT', this.exitHook);
    process.off('SIGTERM', this.exitHook);
    this.exitHook = undefined;
    this.shutdownRegistered = false;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function inertHandle(traceId: string): TraceHandle {
  return { traceId, setAttribute: () => {} };
}
