/**
 * HTTP transport for span batches.
 *
 * Returns a Result rather than throwing (EH-6): a failed send is an expected
 * condition on this path, not an exceptional one.
 */

import {
  ERROR_CODES,
  TransportError,
  backoffDelay,
  err,
  ok,
  sleep,
  type IngestAck,
  type Logger,
  type Result,
} from '@anvaya/core';
import { CircuitBreaker } from './circuit-breaker.js';

export interface TransportPayload {
  readonly format: 'anvaya';
  readonly service: string;
  readonly environment: string;
  readonly spans: readonly unknown[];
}

export interface Transport {
  send(payload: TransportPayload): Promise<Result<IngestAck, TransportError>>;
  readonly circuitState: string;
}

export interface HttpTransportOptions {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly logger: Logger;
}

/** Statuses that will never succeed on retry (EH-9). */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 413, 422]);

export class HttpTransport implements Transport {
  private readonly url: string;
  private readonly breaker: CircuitBreaker;

  constructor(private readonly options: HttpTransportOptions) {
    this.url = `${options.endpoint.replace(/\/+$/, '')}/v1/ingest`;
    this.breaker = new CircuitBreaker({
      failureThreshold: 5,
      cooldownMs: 30_000,
      halfOpenMax: 1,
    });
  }

  get circuitState(): string {
    return this.breaker.state;
  }

  async send(payload: TransportPayload): Promise<Result<IngestAck, TransportError>> {
    if (!this.breaker.canAttempt()) {
      return err(
        new TransportError('circuit open; skipping send', {
          code: ERROR_CODES.TRANSPORT_CIRCUIT_OPEN,
          retryable: true,
          context: { spans: payload.spans.length },
        }),
      );
    }
    this.breaker.recordAttempt();

    let lastError: TransportError | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const result = await this.attempt(payload);
      if (result.ok) {
        this.breaker.recordSuccess();
        return result;
      }

      lastError = result.error;
      if (!result.error.retryable) {
        // Terminal: drop the batch rather than looping on a request that cannot
        // succeed. The breaker is not tripped — the collector is fine, we are not.
        this.options.logger.warn('anvaya sdk: batch rejected, dropping', {
          err: result.error,
          spans: payload.spans.length,
        });
        return result;
      }
      if (attempt < this.options.maxRetries) {
        await sleep(backoffDelay(attempt));
      }
    }

    this.breaker.recordFailure();
    return err(
      lastError ??
        new TransportError('send failed', {
          code: ERROR_CODES.TRANSPORT_FAILED,
          retryable: true,
        }),
    );
  }

  private async attempt(payload: TransportPayload): Promise<Result<IngestAck, TransportError>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;

      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryable = !NON_RETRYABLE_STATUS.has(response.status);
        const body = await response.text().catch(() => '');
        return err(
          new TransportError(`ingest returned ${response.status}`, {
            code: ERROR_CODES.TRANSPORT_FAILED,
            retryable,
            // Body is truncated: it may echo span content back at us.
            context: { status: response.status, body: body.slice(0, 200) },
          }),
        );
      }

      const ack = (await response.json()) as IngestAck;
      return ok(ack);
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      return err(
        new TransportError(aborted ? 'ingest request timed out' : 'ingest request failed', {
          code: aborted ? ERROR_CODES.TRANSPORT_TIMEOUT : ERROR_CODES.TRANSPORT_FAILED,
          retryable: true,
          cause: e,
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
