/**
 * Structured logging (SRS §8).
 *
 * Invariants:
 *   - Logging never throws (LG-8). A failing sink degrades to a dropped record.
 *   - Every record passes through redaction before reaching a sink (LG-6);
 *     Anvaya's own logs cannot leak what its storage protects.
 *   - Level is checked before context construction (LG-10).
 */

import { AnvayaError } from '../errors/base.js';
import { ERROR_CODES } from '../errors/codes.js';
import { Redactor } from '../redaction/redactor.js';
import { ConsoleSink, type LogFormat } from './sinks.js';
import { LOG_LEVELS, type LogContext, type Logger, type LogLevel, type LogRecord, type LogSink } from './types.js';

export interface LoggerOptions {
  readonly name: string;
  readonly level?: LogLevel;
  readonly format?: LogFormat;
  readonly sinks?: readonly LogSink[];
  readonly redactor?: Redactor;
  readonly baseContext?: LogContext;
  readonly includeStack?: boolean;
}

interface SharedState {
  level: LogLevel;
  readonly sinks: readonly LogSink[];
  readonly redactor: Redactor;
  readonly includeStack: boolean;
}

class LoggerImpl implements Logger {
  constructor(
    readonly name: string,
    private readonly context: LogContext,
    private readonly shared: SharedState,
  ) {}

  isEnabled(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.shared.level];
  }

  child(name: string, context: LogContext = {}): Logger {
    return new LoggerImpl(
      this.name ? `${this.name}.${name}` : name,
      { ...this.context, ...context },
      this.shared,
    );
  }

  trace(message: string, context?: LogContext): void {
    this.emit('trace', message, context);
  }
  debug(message: string, context?: LogContext): void {
    this.emit('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.emit('info', message, context);
  }
  warn(message: string, context?: LogContext & { err?: unknown }): void {
    this.emit('warn', message, context);
  }
  error(message: string, context?: LogContext & { err?: unknown }): void {
    this.emit('error', message, context);
  }
  fatal(message: string, context?: LogContext & { err?: unknown }): void {
    this.emit('fatal', message, context);
  }

  private emit(level: LogLevel, message: string, context?: LogContext & { err?: unknown }): void {
    // The whole method is defensive: a logging failure must never become an
    // application failure.
    try {
      if (!this.isEnabled(level)) return;

      const { err, ...rest } = context ?? {};
      const merged: LogContext = { ...this.context, ...rest };

      const redacted = this.shared.redactor.redactObject(merged);
      const redactedMessage = this.shared.redactor.redact(message).value;

      const record: LogRecord = {
        timestamp: new Date().toISOString(),
        level,
        logger: this.name,
        message: redactedMessage,
        context: redacted.value,
        ...(err !== undefined ? { error: this.serializeError(err) } : {}),
      };

      for (const sink of this.shared.sinks) {
        try {
          sink.write(record);
        } catch {
          // A broken sink must not break the others, or the caller.
        }
      }
    } catch {
      // Deliberately empty: logging is best-effort by contract (LG-8).
    }
  }

  private serializeError(err: unknown) {
    const typed = AnvayaError.from(err, {
      code: ERROR_CODES.INTERNAL,
      category: 'internal',
    });
    const chain = typed.causeChain(this.shared.includeStack);
    // Redact error messages too — they can echo user content.
    return chain.map((e) => ({
      ...e,
      message: this.shared.redactor.redact(e.message).value,
    }));
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const shared: SharedState = {
    level: options.level ?? 'info',
    sinks: options.sinks ?? [new ConsoleSink(options.format ?? 'json')],
    redactor: options.redactor ?? new Redactor(),
    includeStack: options.includeStack ?? true,
  };
  return new LoggerImpl(options.name, options.baseContext ?? {}, shared);
}

/**
 * A logger that discards everything. Used as the default in library code so a
 * caller who supplies no logger still gets working, silent behaviour.
 */
export function createNoopLogger(name = 'noop'): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    name,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    isEnabled: () => false,
    child: () => logger,
  };
  return logger;
}
