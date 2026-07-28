/**
 * Circuit breaker for the ingest transport (FR-1.14).
 *
 * Without one, a collector outage means every flush pays a full timeout, which
 * turns "Anvaya is down" into "the host is spending its time waiting on Anvaya".
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenMax: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private halfOpenAttempts = 0;
  private current: CircuitState = 'closed';

  constructor(private readonly options: CircuitBreakerOptions) {}

  get state(): CircuitState {
    // Lazily transition out of `open` once the cooldown has elapsed, so callers
    // observe the correct state without a background timer.
    if (this.current === 'open' && Date.now() - this.openedAt >= this.options.cooldownMs) {
      this.current = 'half_open';
      this.halfOpenAttempts = 0;
    }
    return this.current;
  }

  canAttempt(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'half_open') return this.halfOpenAttempts < this.options.halfOpenMax;
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.halfOpenAttempts = 0;
    this.current = 'closed';
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      this.trip();
      return;
    }
    this.failures++;
    if (this.failures >= this.options.failureThreshold) this.trip();
  }

  recordAttempt(): void {
    if (this.state === 'half_open') this.halfOpenAttempts++;
  }

  private trip(): void {
    this.current = 'open';
    this.openedAt = Date.now();
    this.failures = 0;
  }
}
