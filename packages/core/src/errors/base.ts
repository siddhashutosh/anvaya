/**
 * The single error base class (EH-1).
 *
 * Every error crossing a module boundary in Anvaya is an AnvayaError, carrying a
 * stable code, a category, a retryable flag, and structured context. The original
 * error is always preserved as `cause` (EH-5).
 */

import { ERROR_CODES, type ErrorCode } from './codes.js';

export type ErrorCategory =
  | 'validation'
  | 'configuration'
  | 'storage'
  | 'transport'
  | 'detector'
  | 'internal'
  | 'auth'
  | 'not_found'
  | 'rate_limit';

export interface AnvayaErrorOptions {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly retryable?: boolean;
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;
  readonly httpStatus?: number;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code: string;
  readonly category: string;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;
  readonly timestamp: number;
  readonly stack?: string;
}

const DEFAULT_STATUS: Readonly<Record<ErrorCategory, number>> = Object.freeze({
  validation: 400,
  auth: 401,
  not_found: 404,
  rate_limit: 429,
  configuration: 500,
  storage: 500,
  transport: 502,
  detector: 500,
  internal: 500,
});

const RETRYABLE_BY_DEFAULT: Readonly<Record<ErrorCategory, boolean>> = Object.freeze({
  validation: false,
  auth: false,
  not_found: false,
  rate_limit: true,
  configuration: false,
  storage: true,
  transport: true,
  detector: false,
  internal: false,
});

export class AnvayaError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;
  readonly httpStatus: number;
  readonly timestamp: number;

  constructor(message: string, options: AnvayaErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT[options.category];
    this.context = options.context ? { ...options.context } : {};
    this.httpStatus = options.httpStatus ?? DEFAULT_STATUS[options.category];
    this.timestamp = Date.now();

    // Preserve a clean stack across the subclass chain.
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }

  /**
   * Safe serialisation. Stacks are opt-in because they must not reach API clients
   * outside development mode (NFR-4.6).
   */
  toJSON(includeStack = false): SerializedError {
    const base: SerializedError = {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      context: this.context,
      timestamp: this.timestamp,
    };
    return includeStack && this.stack ? { ...base, stack: this.stack } : base;
  }

  /** The full cause chain, flattened outermost-first (EH-5, LG-7). */
  causeChain(includeStack = false): readonly SerializedError[] {
    const chain: SerializedError[] = [this.toJSON(includeStack)];
    let current: unknown = this.cause;
    // Bounded: a cyclic cause chain must not hang the logger.
    for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth++) {
      if (current instanceof AnvayaError) {
        chain.push(current.toJSON(includeStack));
        current = current.cause;
      } else if (current instanceof Error) {
        chain.push({
          name: current.name,
          message: current.message,
          code: ERROR_CODES.INTERNAL,
          category: 'internal',
          retryable: false,
          context: {},
          timestamp: 0,
          ...(includeStack && current.stack ? { stack: current.stack } : {}),
        });
        current = (current as { cause?: unknown }).cause;
      } else {
        chain.push({
          name: 'UnknownError',
          message: String(current),
          code: ERROR_CODES.INTERNAL,
          category: 'internal',
          retryable: false,
          context: {},
          timestamp: 0,
        });
        break;
      }
    }
    return chain;
  }

  /**
   * The single conversion point used at every catch site. An already-typed error
   * passes through unchanged; anything else is wrapped with `cause` preserved.
   */
  static from(err: unknown, fallback: AnvayaErrorOptions): AnvayaError {
    if (err instanceof AnvayaError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AnvayaError(message, { ...fallback, cause: err });
  }
}

export function isAnvayaError(err: unknown): err is AnvayaError {
  return err instanceof AnvayaError;
}

export function isRetryable(err: unknown): boolean {
  return err instanceof AnvayaError && err.retryable;
}
