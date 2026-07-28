/**
 * Errors, logging, redaction, and statistics.
 *
 * These four are the cross-cutting concerns the brief called out explicitly, so
 * their invariants are asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest';
import {
  AnvayaError,
  ERROR_CODES,
  MemorySink,
  Redactor,
  StorageError,
  ValidationError,
  WelfordAccumulator,
  confidenceBand,
  createLogger,
  err,
  jensenShannon,
  mad,
  maxSeverity,
  modifiedZScore,
  ngramRepetitionRatio,
  ok,
  overlapRatio,
  partition,
  psi,
  splitSentences,
  unwrapOr,
  type LogSink,
} from '../src/index.js';

describe('errors', () => {
  it('carries a stable code, category, and http status', () => {
    const e = new ValidationError('bad input');
    expect(e.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(e.category).toBe('validation');
    expect(e.httpStatus).toBe(400);
    expect(e.retryable).toBe(false);
  });

  it('marks storage and transport errors retryable by default', () => {
    expect(new StorageError('down').retryable).toBe(true);
    expect(new ValidationError('nope').retryable).toBe(false);
  });

  it('passes an already-typed error through from()', () => {
    const original = new ValidationError('original');
    const converted = AnvayaError.from(original, {
      code: ERROR_CODES.INTERNAL,
      category: 'internal',
    });
    expect(converted).toBe(original);
  });

  it('wraps an unknown error and preserves cause', () => {
    const cause = new Error('driver exploded');
    const wrapped = AnvayaError.from(cause, {
      code: ERROR_CODES.STORAGE_WRITE_FAILED,
      category: 'storage',
    });
    expect(wrapped).toBeInstanceOf(AnvayaError);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.message).toBe('driver exploded');
  });

  it('flattens the full cause chain', () => {
    const root = new Error('socket closed');
    const mid = new StorageError('query failed', { cause: root });
    const top = new AnvayaError('request failed', {
      code: ERROR_CODES.INTERNAL,
      category: 'internal',
      cause: mid,
    });
    const chain = top.causeChain();
    expect(chain).toHaveLength(3);
    expect(chain[2]?.message).toBe('socket closed');
  });

  it('omits the stack from toJSON unless asked (NFR-4.6)', () => {
    const e = new ValidationError('oops');
    expect(e.toJSON().stack).toBeUndefined();
    expect(e.toJSON(true).stack).toBeTruthy();
  });
});

describe('Result', () => {
  it('partitions a batch into values and errors', () => {
    const results = [ok(1), err(new ValidationError('a')), ok(3)];
    const { values, errors } = partition(results);
    expect(values).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
  });

  it('unwraps with a fallback', () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
    expect(unwrapOr(err('x'), 0)).toBe(0);
  });
});

describe('logging', () => {
  it('filters by level', () => {
    const sink = new MemorySink();
    const log = createLogger({ name: 'test', level: 'warn', sinks: [sink] });
    log.debug('invisible');
    log.warn('visible');
    expect(sink.all()).toHaveLength(1);
    expect(sink.all()[0]?.message).toBe('visible');
  });

  it('merges parent context into children', () => {
    const sink = new MemorySink();
    const log = createLogger({
      name: 'root',
      level: 'trace',
      sinks: [sink],
      baseContext: { service: 'anvaya' },
    });
    log.child('worker', { traceId: 't1' }).info('working', { spanId: 's1' });

    const record = sink.all()[0];
    expect(record?.logger).toBe('root.worker');
    expect(record?.context).toMatchObject({ service: 'anvaya', traceId: 't1', spanId: 's1' });
  });

  it('redacts secrets from message and context (LG-6)', () => {
    const sink = new MemorySink();
    const log = createLogger({ name: 'test', level: 'trace', sinks: [sink] });
    log.info('using key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX', {
      auth: 'Bearer abcdefghijklmnopqrstuvwxyz012345',
    });

    const record = sink.all()[0];
    expect(record?.message).not.toContain('sk-ant-api03');
    expect(record?.message).toContain('[REDACTED:api_key]');
    expect(JSON.stringify(record?.context)).not.toContain('abcdefghijklmnop');
  });

  it('never throws when a sink throws (LG-8)', () => {
    const exploding: LogSink = {
      name: 'exploding',
      write() {
        throw new Error('sink is broken');
      },
    };
    const survivor = new MemorySink();
    const log = createLogger({ name: 'test', level: 'trace', sinks: [exploding, survivor] });

    expect(() => log.info('still fine')).not.toThrow();
    // A broken sink must not stop the others.
    expect(survivor.all()).toHaveLength(1);
  });

  it('serialises errors with code, category, and cause chain (LG-7)', () => {
    const sink = new MemorySink();
    const log = createLogger({ name: 'test', level: 'trace', sinks: [sink] });
    log.error('it broke', { err: new StorageError('write failed') });

    const record = sink.all()[0];
    expect(record?.error?.[0]?.code).toBe(ERROR_CODES.STORAGE_QUERY_FAILED);
    expect(record?.error?.[0]?.category).toBe('storage');
  });
});

describe('redaction', () => {
  const redactor = new Redactor();

  it.each([
    ['sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX', 'api_key'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws_key'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private_key'],
    ['a@example.com', 'email'],
    ['123-45-6789', 'ssn'],
  ])('redacts %s as %s', (value, expected) => {
    const result = redactor.redact(`prefix ${value} suffix`);
    expect(result.value).not.toContain(value);
    expect(result.hits.map((h) => h.class)).toContain(expected);
  });

  it('only redacts Luhn-valid card numbers', () => {
    // Valid test card number.
    expect(redactor.redact('4242424242424242').hits.map((h) => h.class)).toContain('credit_card');
    // Same length, fails Luhn — an ordinary long number must survive.
    expect(redactor.redact('1234567812345678').value).toBe('1234567812345678');
  });

  it('leaves IPv4 alone by default', () => {
    // Enabled by default this mangles service hosts and version strings.
    expect(redactor.redact('host 127.0.0.1').value).toBe('host 127.0.0.1');
  });

  it('reports the class but never the value (NFR-4.4)', () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX';
    const hits = redactor.scan(`key=${secret}`);
    expect(JSON.stringify(hits)).not.toContain(secret);
    expect(hits[0]?.class).toBe('api_key');
  });

  it('walks nested objects and preserves structure', () => {
    const { value, hits } = redactor.redactObject({
      user: { email: 'a@example.com', name: 'Ada' },
      counts: [1, 2, 3],
    });
    expect(value.user.name).toBe('Ada');
    expect(value.user.email).not.toContain('example.com');
    expect(value.counts).toEqual([1, 2, 3]);
    expect(hits.map((h) => h.class)).toContain('email');
  });

  it('handles circular references without hanging', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(() => redactor.redactObject(node)).not.toThrow();
  });

  it('is a no-op when disabled', () => {
    const off = new Redactor({ enabled: false });
    expect(off.redact('a@example.com').value).toBe('a@example.com');
  });
});

describe('statistics', () => {
  it('matches a naive mean and variance', () => {
    const values = [4, 8, 15, 16, 23, 42];
    const acc = new WelfordAccumulator();
    values.forEach((v) => acc.push(v));

    const expectedMean = values.reduce((a, b) => a + b, 0) / values.length;
    const expectedVar =
      values.reduce((sum, v) => sum + (v - expectedMean) ** 2, 0) / (values.length - 1);

    expect(acc.mean).toBeCloseTo(expectedMean, 10);
    expect(acc.variance).toBeCloseTo(expectedVar, 8);
    expect(acc.count).toBe(6);
  });

  it('round-trips through JSON', () => {
    const acc = new WelfordAccumulator();
    [1, 2, 3, 4, 5].forEach((v) => acc.push(v));
    const restored = WelfordAccumulator.fromJSON(acc.toJSON());
    expect(restored.mean).toBeCloseTo(acc.mean, 10);
    expect(restored.count).toBe(acc.count);
  });

  it('returns z-score 0 for a zero-variance baseline', () => {
    const acc = new WelfordAccumulator();
    [5, 5, 5, 5].forEach((v) => acc.push(v));
    expect(acc.zScore(99)).toBe(0);
  });

  it('reports ~0 PSI for identical distributions', () => {
    const values = Array.from({ length: 200 }, (_, i) => i % 20);
    expect(psi(values, values)).toBeLessThan(0.01);
  });

  it('exceeds the significant threshold for a clear shift', () => {
    const reference = Array.from({ length: 200 }, (_, i) => i % 10);
    const shifted = Array.from({ length: 200 }, (_, i) => 50 + (i % 10));
    expect(psi(reference, shifted)).toBeGreaterThan(0.25);
  });

  it('keeps Jensen-Shannon symmetric and bounded', () => {
    const p = [10, 20, 30, 40];
    const q = [40, 30, 20, 10];
    expect(jensenShannon(p, q)).toBeCloseTo(jensenShannon(q, p), 10);
    expect(jensenShannon(p, q)).toBeGreaterThanOrEqual(0);
    expect(jensenShannon(p, q)).toBeLessThanOrEqual(1);
    expect(jensenShannon(p, p)).toBeCloseTo(0, 10);
  });

  it('uses MAD to resist outliers', () => {
    const values = [10, 11, 12, 11, 10, 1000];
    expect(mad(values)).toBeLessThan(5);
    expect(modifiedZScore(1000, values)).toBeGreaterThan(3.5);
  });
});

describe('text heuristics', () => {
  it('scores overlap against a source token set', () => {
    const source = new Set(['refunds', 'processed', 'business', 'days', 'approval']);
    expect(overlapRatio('Refunds are processed within business days', source)).toBeGreaterThan(0.6);
    expect(overlapRatio('Bananas grow in tropical climates worldwide', source)).toBeLessThan(0.2);
  });

  it('detects n-gram repetition', () => {
    const repetitive = 'the same thing again '.repeat(10);
    expect(ngramRepetitionRatio(repetitive)).toBeGreaterThan(0.5);
    expect(ngramRepetitionRatio('a genuinely varied sentence about several distinct topics')).toBe(0);
  });

  it('splits sentences', () => {
    expect(splitSentences('One thing. Two things! Three things?')).toHaveLength(3);
  });
});

describe('severity and confidence', () => {
  it('orders severity', () => {
    expect(maxSeverity('low', 'critical')).toBe('critical');
    expect(maxSeverity(undefined, 'medium')).toBe('medium');
    expect(maxSeverity('high', undefined)).toBe('high');
  });

  it('bands confidence so a heuristic never reads as a fact (FR-7.9)', () => {
    expect(confidenceBand(0.3)).toBe('possible');
    expect(confidenceBand(0.5)).toBe('likely');
    expect(confidenceBand(0.79)).toBe('likely');
    expect(confidenceBand(0.8)).toBe('confirmed');
    expect(confidenceBand(1)).toBe('confirmed');
  });
});
