/**
 * Configuration loading (FR-8.1, FR-8.2, LG-12) and the OTel event-form adapter.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from '../src/config/loader.js';
import { getAdapter } from '../src/ingest/adapters/index.js';

const dirs: string[] = [];

function tempConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvaya-cfg-'));
  dirs.push(dir);
  const path = join(dir, 'anvaya.config.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('config loading', () => {
  it('starts from defaults with no file and no environment (NFR-6.2)', () => {
    const config = loadConfig({ env: {}, file: undefined });
    expect(config.server.port).toBe(4319);
    expect(config.detection.enabled).toBe(true);
    // The billed tier must never default on.
    expect(config.judge.enabled).toBe(false);
    expect(config.detection.tiers.L3).toBe(false);
  });

  it('applies file values over defaults', () => {
    const file = tempConfig({ server: { port: 9999 }, detection: { minBaselineSamples: 7 } });
    const config = loadConfig({ file, env: {} });
    expect(config.server.port).toBe(9999);
    expect(config.detection.minBaselineSamples).toBe(7);
    // Untouched sections keep their defaults.
    expect(config.server.host).toBe('127.0.0.1');
  });

  it('lets environment override the file', () => {
    const file = tempConfig({ server: { port: 9999 } });
    const config = loadConfig({ file, env: { ANVAYA_PORT: '4000' } });
    expect(config.server.port).toBe(4000);
  });

  it('coerces typed environment values', () => {
    const config = loadConfig({
      env: {
        ANVAYA_PORT: '5000',
        ANVAYA_DEV_MODE: 'true',
        ANVAYA_CORS_ORIGINS: 'http://a.test, http://b.test',
        ANVAYA_RETENTION_DAYS: '14',
      },
    });
    expect(config.server.port).toBe(5000);
    expect(config.server.devMode).toBe(true);
    expect(config.server.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
    expect(config.retention.maxAgeDays).toBe(14);
  });

  it('treats an API key alone as insufficient to enable the judge (ADR-0003)', () => {
    const config = loadConfig({ env: { ANTHROPIC_API_KEY: 'sk-ant-xyz' } });
    expect(config.judge.apiKey).toBe('sk-ant-xyz');
    // A key on disk is not consent to spend money.
    expect(config.judge.enabled).toBe(false);
  });

  it('aborts on invalid configuration with a precise message (FR-8.2)', () => {
    const file = tempConfig({ server: { port: 70_000 } });
    expect(() => loadConfig({ file, env: {} })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ file, env: {} })).toThrow(/server\.port/);
  });

  it('aborts when an explicitly-named config file is missing', () => {
    expect(() => loadConfig({ file: '/definitely/not/here.json', env: {} })).toThrow(
      /Could not read config file/,
    );
  });

  it('tolerates a missing DEFAULT config file', () => {
    // Zero-configuration startup is a hard requirement.
    expect(() => loadConfig({ env: {} })).not.toThrow();
  });

  it('freezes the result so nothing can mutate config at runtime', () => {
    const config = loadConfig({ env: {} });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.detection.thresholds)).toBe(true);
  });

  it('masks secrets for the startup log (LG-12)', () => {
    const config = loadConfig({
      env: { ANTHROPIC_API_KEY: 'sk-ant-supersecret', ANVAYA_API_KEY: 'ingest-secret' },
    });
    const rendered = JSON.stringify(redactConfig(config));

    expect(rendered).not.toContain('sk-ant-supersecret');
    expect(rendered).not.toContain('ingest-secret');
    expect(rendered).toContain('[REDACTED]');
    // Non-secret configuration must remain legible.
    expect(rendered).toContain('4319');
  });
});

describe('OTel GenAI adapter · message content', () => {
  const ctx = { service: 'svc', environment: 'test' };

  function otelSpan(extra: Record<string, unknown>) {
    return {
      traceId: 't1',
      spanId: 's1',
      name: 'chat',
      startTime: 1_760_000_000_000,
      endTime: 1_760_000_001_000,
      status: { code: 1 },
      attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'anthropic' },
      ...extra,
    };
  }

  it('reads messages from LOG EVENTS, the form the conventions prescribe', () => {
    // Reading only span attributes silently discarded every prompt and
    // completion from a spec-compliant emitter, disabling all L1 content checks.
    const result = getAdapter('otel-genai').adapt(
      otelSpan({
        events: [
          { name: 'gen_ai.system.message', timestamp: 1, attributes: { content: 'You are terse.' } },
          { name: 'gen_ai.user.message', timestamp: 2, attributes: { content: 'How long do refunds take?' } },
          { name: 'gen_ai.choice', timestamp: 3, attributes: { content: 'Five business days.' } },
        ],
      }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const llm = result.value.llm;
    expect(llm?.inputMessages).toHaveLength(2);
    expect(llm?.inputMessages?.[0]?.role).toBe('system');
    expect(llm?.inputMessages?.[1]?.content).toContain('refunds');
    expect(llm?.outputMessages?.[0]?.role).toBe('assistant');
    expect(llm?.outputMessages?.[0]?.content).toBe('Five business days.');
    // The count is what session detection relies on.
    expect(llm?.inputMessageCount).toBe(2);
  });

  it('reads messages from span attributes in array form', () => {
    const result = getAdapter('otel-genai').adapt(
      otelSpan({
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.input.messages': [{ role: 'user', content: 'hello' }],
          'gen_ai.output.messages': [{ role: 'assistant', content: 'hi' }],
        },
      }),
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.llm?.inputMessages?.[0]?.content).toBe('hello');
    expect(result.value.llm?.outputMessages?.[0]?.content).toBe('hi');
  });

  it('reads messages supplied as a JSON string', () => {
    const result = getAdapter('otel-genai').adapt(
      otelSpan({
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.input.messages': JSON.stringify([{ role: 'user', content: 'stringified' }]),
        },
      }),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.llm?.inputMessages?.[0]?.content).toBe('stringified');
  });

  it('reads the parts form used by newer emitters', () => {
    const result = getAdapter('otel-genai').adapt(
      otelSpan({
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.input.messages': [
            { role: 'user', parts: [{ type: 'text', content: 'part one' }, { type: 'text', content: 'part two' }] },
          ],
        },
      }),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.llm?.inputMessages?.[0]?.content).toBe('part one\npart two');
    }
  });

  it('ignores malformed message payloads instead of failing the span', () => {
    const result = getAdapter('otel-genai').adapt(
      otelSpan({
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.input.messages': 'not json at all {{{',
        },
      }),
      ctx,
    );
    // The span still ingests; only the unreadable content is skipped.
    expect(result.ok).toBe(true);
  });

  it('captures system instructions', () => {
    const result = getAdapter('otel-genai').adapt(
      otelSpan({
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.system_instructions': 'Answer only from context.',
        },
      }),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.llm?.systemInstructions).toBe('Answer only from context.');
    }
  });
});
