/** Time helpers. All Anvaya timestamps are epoch milliseconds, UTC (DR-2). */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function now(): number {
  return Date.now();
}

/** Bound any promise so no await is unbounded (NFR-2.4). */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
        // Do not hold the event loop open for a timeout that may never fire.
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, bounded by maxDelay. */
export function backoffDelay(attempt: number, baseMs = 250, maxMs = 30_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exponential);
}

export function bucketStart(timestamp: number, bucketMs: number): number {
  return Math.floor(timestamp / bucketMs) * bucketMs;
}
