/**
 * The never-throw guarantee (ADR-0005, FR-1.16, EH-11).
 *
 * The SDK runs inside the user's request path. An observability tool that takes
 * down the system it observes is worse than no observability tool, so no public
 * SDK method may propagate its own error into host code.
 *
 * The rule is precise, and both halves are asserted by test:
 *   - The SDK never throws its OWN errors into host code.
 *   - The SDK never suppresses the HOST's errors (see observe.ts, which records
 *     the exception and re-throws it unchanged).
 */

import { AnvayaError, ERROR_CODES, type Logger } from '@anvaya/core';

export type ErrorHook = (error: AnvayaError) => void;

export function safely<T>(
  op: string,
  fn: () => T,
  fallback: T,
  logger: Logger,
  onError?: ErrorHook,
): T {
  try {
    return fn();
  } catch (e) {
    report(op, e, logger, onError);
    return fallback;
  }
}

export async function safelyAsync<T>(
  op: string,
  fn: () => Promise<T>,
  fallback: T,
  logger: Logger,
  onError?: ErrorHook,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    report(op, e, logger, onError);
    return fallback;
  }
}

function report(op: string, e: unknown, logger: Logger, onError?: ErrorHook): void {
  const error = AnvayaError.from(e, {
    code: ERROR_CODES.SDK_INTERNAL,
    category: 'internal',
    context: { op },
  });
  logger.warn(`anvaya sdk: ${op} failed (suppressed)`, { err: error, op });
  if (onError) {
    try {
      onError(error);
    } catch {
      // A throwing error hook must not defeat the guarantee it was called under.
    }
  }
}
