/**
 * SDK tests.
 *
 * The two headline assertions here are the halves of ADR-0005:
 *   - the SDK never throws its OWN errors into host code, and
 *   - it never suppresses the HOST's.
 */

import { ok, err, TransportError, createNoopLogger, type IngestAck, type Result } from '@anvaya/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnvayaClient,
  CircuitBreaker,
  observeLLM,
  observeRetrieval,
  observeTool,
  init,
  shutdown,
  type Transport,
  type TransportPayload,
} from '../src/index.js';

class FakeTransport implements Transport {
  readonly batches: TransportPayload[] = [];
  circuitState = 'closed';
  failNext = false;
  throwNext = false;

  async send(payload: TransportPayload): Promise<Result<IngestAck, TransportError>> {
    if (this.throwNext) throw new Error('transport exploded');
    this.batches.push(payload);
    if (this.failNext) {
      return err(new TransportError('simulated failure', { retryable: true }));
    }
    return ok({ accepted: payload.spans.length, rejected: 0, errors: [] });
  }

  get spans(): unknown[] {
    return this.batches.flatMap((b) => b.spans);
  }
}

function makeClient(transport: Transport, overrides = {}): AnvayaClient {
  return new AnvayaClient({
    endpoint: 'http://localhost:4319',
    service: 'test',
    captureContent: true,
    flushIntervalMs: 60_000, // never auto-flush during a test
    transport,
    logger: createNoopLogger(),
    ...overrides,
  });
}

afterEach(async () => {
  await shutdown();
});

describe('tracing', () => {
  it('records a root span and nested children with correct parenting', async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    init({ endpoint: 'x', service: 'test', transport, logger: createNoopLogger() });

    // Use the module-level client so observe* helpers can find it.
    const active = init({
      endpoint: 'http://localhost:4319',
      service: 'test',
      captureContent: true,
      flushIntervalMs: 60_000,
      transport,
      logger: createNoopLogger(),
    });

    await active.trace('root', async () => {
      await observeRetrieval('search', { indexName: 'kb' }, async () => [{ id: 'a', score: 0.9 }], (r) => ({
        documents: r,
      }));
      await observeLLM('answer', { provider: 'anthropic', requestModel: 'm' }, async () => ({ text: 'hi' }));
    });
    await active.flush();

    const spans = transport.spans as { name: string; parentSpanId?: string; kind: string }[];
    expect(spans.map((s) => s.name).sort()).toEqual(['answer', 'root', 'search']);

    const root = spans.find((s) => s.name === 'root');
    const search = spans.find((s) => s.name === 'search');
    expect(root?.parentSpanId).toBeUndefined();
    expect(search?.parentSpanId).toBe((root as { spanId?: string })?.spanId);
    expect(search?.kind).toBe('retriever');
    void client;
  });

  it('captures retrieval scores and llm token counts', async () => {
    const transport = new FakeTransport();
    const active = init({
      endpoint: 'http://localhost:4319',
      service: 'test',
      captureContent: true,
      flushIntervalMs: 60_000,
      transport,
      logger: createNoopLogger(),
    });

    await active.trace('root', async () => {
      await observeRetrieval('search', { indexName: 'kb' }, async () => [{ id: 'a', score: 0.83 }], (r) => ({
        documents: r,
      }));
      await observeLLM(
        'answer',
        { provider: 'anthropic', requestModel: 'claude-sonnet-5' },
        async () => ({ inputTokens: 100, outputTokens: 20 }),
        (r) => ({ inputTokens: r.inputTokens, outputTokens: r.outputTokens }),
      );
    });
    await active.flush();

    const spans = transport.spans as {
      name: string;
      retrieval?: { documents?: { score?: number }[] };
      llm?: { inputTokens?: number };
    }[];
    expect(spans.find((s) => s.name === 'search')?.retrieval?.documents?.[0]?.score).toBe(0.83);
    expect(spans.find((s) => s.name === 'answer')?.llm?.inputTokens).toBe(100);
  });
});

describe('ADR-0005 · the never-throw guarantee', () => {
  it('does not propagate an SDK internal failure to the host', async () => {
    const transport = new FakeTransport();
    transport.throwNext = true;
    const client = makeClient(transport);

    // A transport that throws must not surface at the flush call site.
    await expect(client.flush()).resolves.toBeUndefined();
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  it('re-throws the host function error unchanged', async () => {
    const transport = new FakeTransport();
    const active = init({
      endpoint: 'http://localhost:4319',
      service: 'test',
      flushIntervalMs: 60_000,
      transport,
      logger: createNoopLogger(),
    });

    const hostError = new Error('the host blew up');

    await expect(
      active.trace('root', async () => {
        await observeTool('t', { toolName: 'x' }, async () => {
          throw hostError;
        });
      }),
    ).rejects.toBe(hostError); // identity, not just message — the error is unchanged

    await active.flush();
    const spans = transport.spans as { name: string; status: string; events: { name: string }[] }[];
    const toolSpan = spans.find((s) => s.name === 't');
    expect(toolSpan?.status).toBe('error');
    expect(toolSpan?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('runs the host function untouched when no client is initialised', async () => {
    await shutdown();
    const result = await observeLLM('answer', { provider: 'p' }, async () => 'still works');
    expect(result).toBe('still works');
  });

  it('is a no-op when disabled', async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport, { enabled: false });
    const result = await client.trace('root', async () => 42);
    expect(result).toBe(42);
    expect(transport.spans).toHaveLength(0);
  });
});

describe('transport resilience', () => {
  it('drops the oldest span on queue overflow and counts it', async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport, { maxQueueSize: 3, batchSize: 100 });

    for (let i = 0; i < 10; i++) {
      const span = client.startSpan(`span-${i}`, 'tool');
      if (span) client.record(span.end());
    }

    expect(client.stats.dropped).toBe(7);
    expect(client.stats.queued).toBe(3);
  });

  it('counts failures without throwing and without requeueing forever', async () => {
    const transport = new FakeTransport();
    transport.failNext = true;
    const client = makeClient(transport, { maxRetries: 0 });

    const span = client.startSpan('s', 'tool');
    if (span) client.record(span.end());
    await client.flush();

    expect(client.stats.failed).toBe(1);
    expect(client.stats.sent).toBe(0);
  });

  it('awaits an in-flight flush rather than returning early', async () => {
    // Regression: returning early here silently lost buffered spans at shutdown.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const slow: Transport = {
      circuitState: 'closed',
      async send(payload) {
        await gate;
        return ok({ accepted: payload.spans.length, rejected: 0, errors: [] });
      },
    };

    const client = makeClient(slow, { batchSize: 1 });
    const s1 = client.startSpan('a', 'tool');
    if (s1) client.record(s1.end());

    const first = client.flush();
    const second = client.flush(); // must await the first, not return immediately
    release?.();
    await Promise.all([first, second]);

    expect(client.stats.sent).toBe(1);
    expect(client.stats.queued).toBe(0);
  });
});

describe('circuit breaker', () => {
  it('opens after the failure threshold and recovers through half-open', () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, halfOpenMax: 1 });

    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canAttempt()).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(breaker.state).toBe('half_open');
    expect(breaker.canAttempt()).toBe(true);

    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    vi.useRealTimers();
  });

  it('re-opens when the half-open probe fails', () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, halfOpenMax: 1 });
    breaker.recordFailure();
    vi.advanceTimersByTime(501);
    expect(breaker.state).toBe('half_open');
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    vi.useRealTimers();
  });
});

describe('redaction at source (ADR-0007)', () => {
  it('never puts a secret on the wire', async () => {
    const transport = new FakeTransport();
    const active = init({
      endpoint: 'http://localhost:4319',
      service: 'test',
      captureContent: true,
      flushIntervalMs: 60_000,
      transport,
      logger: createNoopLogger(),
    });

    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX';
    await active.trace('root', async () => {
      await observeLLM(
        'answer',
        {
          provider: 'anthropic',
          inputMessages: [{ role: 'user', content: `my key is ${secret}` }],
        },
        async () => 'ok',
      );
    });
    await active.flush();

    const wire = JSON.stringify(transport.batches);
    expect(wire).not.toContain(secret);
    expect(wire).toContain('[REDACTED:api_key]');
  });

  it('omits content entirely when captureContent is off (the default)', async () => {
    const transport = new FakeTransport();
    const active = init({
      endpoint: 'http://localhost:4319',
      service: 'test',
      flushIntervalMs: 60_000,
      transport,
      logger: createNoopLogger(),
    });

    await active.trace('root', async () => {
      await observeLLM(
        'answer',
        {
          provider: 'anthropic',
          inputMessages: [{ role: 'user', content: 'sensitive customer question' }],
        },
        async () => ({ outputTokens: 5 }),
        (r) => ({ outputTokens: r.outputTokens }),
      );
    });
    await active.flush();

    const wire = JSON.stringify(transport.batches);
    expect(wire).not.toContain('sensitive customer question');
    // Metadata still flows, which is why L0/L2 detection works with capture off.
    expect(wire).toContain('"outputTokens":5');
  });
});
