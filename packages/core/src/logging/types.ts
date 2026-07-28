import type { SerializedError } from '../errors/base.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVELS: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

export type LogContext = Record<string, unknown>;

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly logger: string;
  readonly message: string;
  readonly context: LogContext;
  readonly error?: readonly SerializedError[];
}

/** Sinks must never throw (LG-8). The Logger defends against it anyway. */
export interface LogSink {
  readonly name: string;
  write(record: LogRecord): void;
}

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext & { err?: unknown }): void;
  error(message: string, context?: LogContext & { err?: unknown }): void;
  fatal(message: string, context?: LogContext & { err?: unknown }): void;
  /** Child loggers inherit and extend parent context (LG-4). */
  child(name: string, context?: LogContext): Logger;
  /** Guard for expensive context construction on hot paths (LG-10). */
  isEnabled(level: LogLevel): boolean;
  readonly name: string;
}
