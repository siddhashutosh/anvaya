/**
 * L3 judge tier.
 *
 * These run against a REAL local HTTP server speaking the Anthropic Messages API
 * wire format, not a mocked `fetch`. Everything except the network hop to
 * Anthropic's own hosts is therefore exercised: request construction, headers,
 * response parsing, error classification, budget accounting, and timeouts.
 *
 * The distinction matters and is worth stating plainly: this proves the CLIENT
 * is correct against the documented contract. It does not prove Anthropic's
 * service behaves as documented — for that, point `judge.baseUrl` at the real
 * host with a key and run the same assertions.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createNoopLogger } from '@anvaya/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, type JudgeConfig } from '../src/config/schema.js';
import { AnthropicJudge, createJudge } from '../src/detectors/judge/provider.js';
import {
  faithfulnessJudge,
  specAdherenceJudge,
  unsafeOutputJudge,
} from '../src/detectors/judge/l3-semantic.js';
import { runSandboxed } from '../src/detectors/sandbox.js';
import { context, trace } from './fixtures.js';

const logger = createNoopLogger();

// ── a local stand-in for the Messages API ───────────────────────────────────

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

type Responder = (req: CapturedRequest) => { status: number; body: unknown; delayMs?: number };

class FakeAnthropic {
  private server: Server | undefined;
  readonly requests: CapturedRequest[] = [];
  responder: Responder = () => ({ status: 200, body: verdictBody(true, 0.9, 'looks wrong') });

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          /* leave empty */
        }
        const captured: CapturedRequest = {
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body,
        };
        this.requests.push(captured);

        const { status, body: payload, delayMs } = this.responder(captured);
        const send = (): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (delayMs) setTimeout(send, delayMs);
        else send();
      });
    });

    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}

/** A well-formed Messages API response carrying a judge verdict. */
function verdictBody(verdict: boolean, confidence: number, rationale: string, text?: string) {
  return {
    id: 'msg_test',
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
    usage: { input_tokens: 850, output_tokens: 45 },
    content: [
      { type: 'text', text: text ?? JSON.stringify({ verdict, confidence, rationale }) },
    ],
  };
}

function judgeConfig(baseUrl: string, over: Partial<JudgeConfig> = {}): JudgeConfig {
  return configSchema.parse({
    judge: { enabled: true, provider: 'anthropic', apiKey: 'sk-ant-test-key', baseUrl, ...over },
  }).judge;
}

let fake: FakeAnthropic;
let baseUrl: string;

beforeEach(async () => {
  fake = new FakeAnthropic();
  baseUrl = await fake.start();
});

afterEach(async () => {
  await fake.stop();
});

// ── request construction ────────────────────────────────────────────────────

describe('AnthropicJudge · request', () => {
  it('posts a well-formed Messages API request with the documented headers', async () => {
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'sk-ant-test-key');

    const result = await judge.judge({
      question: 'How long do refunds take?',
      context: 'Refunds are processed within 5 business days.',
      output: 'Refunds are instant with no time limit.',
      rubric: 'Does the output assert facts unsupported by the context?',
    });

    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);

    const req = fake.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant-test-key');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers['content-type']).toBe('application/json');

    expect(req.body.model).toBe('claude-haiku-4-5-20251001');
    expect(req.body.max_tokens).toBe(512);
    expect(String(req.body.system)).toContain('strict evaluator');

    const messages = req.body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    // All four parts of the judge prompt must reach the model.
    expect(messages[0]?.content).toContain('RUBRIC:');
    expect(messages[0]?.content).toContain('How long do refunds take?');
    expect(messages[0]?.content).toContain('5 business days');
    expect(messages[0]?.content).toContain('instant with no time limit');
  });

  it('instructs the judge to default to "not present" when uncertain', async () => {
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');
    await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });

    // A false positive costs a human an investigation and erodes trust in every
    // other finding, so the bias must be explicit in the system prompt.
    expect(String(fake.requests[0]?.body.system)).toContain('not present');
  });

  it('truncates oversized inputs rather than sending an unbounded prompt', async () => {
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');
    await judge.judge({
      question: 'q'.repeat(20_000),
      context: 'c'.repeat(40_000),
      output: 'o'.repeat(30_000),
      rubric: 'r',
    });

    const content = (fake.requests[0]?.body.messages as { content: string }[])[0]!.content;
    expect(content).toContain('[truncated]');
    // 4000 + 8000 + 6000 caps plus scaffolding — comfortably bounded.
    expect(content.length).toBeLessThan(20_000);
  });

  it('honours a custom baseUrl including a path prefix (gateway/proxy case)', async () => {
    const judge = new AnthropicJudge(judgeConfig(`${baseUrl}/gateway/`), logger, 'k');
    await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    // Trailing slash normalised, prefix preserved.
    expect(fake.requests[0]?.path).toBe('/gateway/v1/messages');
  });
});

// ── response parsing ────────────────────────────────────────────────────────

describe('AnthropicJudge · response parsing', () => {
  it('parses a clean verdict and reports token usage', async () => {
    fake.responder = () => ({ status: 200, body: verdictBody(true, 0.82, 'three unsupported claims') });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    const result = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe(true);
    expect(result.value.confidence).toBeCloseTo(0.82, 5);
    expect(result.value.rationale).toBe('three unsupported claims');
    expect(result.value.tokensUsed).toBe(895);
  });

  it('recovers JSON wrapped in a code fence despite instructions', async () => {
    // Models do this routinely; refusing to parse it would silently disable L3.
    fake.responder = () => ({
      status: 200,
      body: verdictBody(true, 0.7, '', '```json\n{"verdict": true, "confidence": 0.7, "rationale": "fenced"}\n```'),
    });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    const result = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rationale).toBe('fenced');
  });

  it('recovers JSON preceded by prose', async () => {
    fake.responder = () => ({
      status: 200,
      body: verdictBody(false, 0, '', 'Sure — here is my assessment:\n{"verdict": false, "confidence": 0.9, "rationale": "grounded"}'),
    });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    const result = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.verdict).toBe(false);
  });

  it('defaults a missing confidence to 0.5 rather than assuming certainty', async () => {
    fake.responder = () => ({
      status: 200,
      body: verdictBody(true, 0, '', '{"verdict": true, "rationale": "no confidence field"}'),
    });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    const result = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.confidence).toBe(0.5);
  });

  it('clamps an out-of-range confidence into [0,1]', async () => {
    fake.responder = () => ({
      status: 200,
      body: verdictBody(true, 0, '', '{"verdict": true, "confidence": 7, "rationale": "overconfident"}'),
    });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    const result = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    if (result.ok) expect(result.value.confidence).toBe(1);
  });

  it('returns a typed error, not a crash, on unparseable output', async () => {
    fake.responder = () => ({ status: 200, body: verdictBody(true, 0, '', 'I am not going to answer in JSON.') });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    const result = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('JUDGE_UNAVAILABLE');
      expect(result.error.category).toBe('detector');
    }
  });

  it('rejects a non-boolean verdict rather than coercing it', async () => {
    fake.responder = () => ({
      status: 200,
      body: verdictBody(true, 0, '', '{"verdict": "maybe", "confidence": 0.9, "rationale": "hedging"}'),
    });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');
    const result = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(result.ok).toBe(false);
  });
});

// ── error classification ────────────────────────────────────────────────────

describe('AnthropicJudge · error handling', () => {
  it('classifies 5xx as retryable and 4xx as terminal', async () => {
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    fake.responder = () => ({ status: 503, body: { error: 'overloaded' } });
    const server = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(server.ok).toBe(false);
    if (!server.ok) expect(server.error.retryable).toBe(true);

    fake.responder = () => ({ status: 400, body: { error: 'bad request' } });
    const client = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(client.ok).toBe(false);
    if (!client.ok) expect(client.error.retryable).toBe(false);
  });

  it('times out a slow provider instead of hanging the detector', async () => {
    fake.responder = () => ({ status: 200, body: verdictBody(true, 0.9, 'slow'), delayMs: 400 });
    const judge = new AnthropicJudge(judgeConfig(baseUrl, { timeoutMs: 80 }), logger, 'k');

    const result = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('timed out');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('never leaks the API key into an error', async () => {
    fake.responder = () => ({ status: 401, body: { error: 'invalid key' } });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'sk-ant-supersecret-value');

    const result = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error.toJSON(true))).not.toContain('supersecret');
    }
  });
});

// ── budget ──────────────────────────────────────────────────────────────────

describe('AnthropicJudge · budget (FR-3.14)', () => {
  it('spends down the daily budget and refuses once exhausted', async () => {
    // 900 tokens per call, 2000 budget, 500 reserved per request.
    const judge = new AnthropicJudge(
      judgeConfig(baseUrl, { dailyTokenBudget: 2000, maxTokensPerTrace: 500 }),
      logger,
      'k',
    );

    expect(judge.remainingBudget).toBe(2000);

    const first = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(first.ok).toBe(true);
    expect(judge.remainingBudget).toBe(1105); // 2000 - 895

    const second = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(second.ok).toBe(true);
    expect(judge.remainingBudget).toBe(210);

    // Below the per-request reservation: refuse BEFORE spending.
    const third = await judge.judge({ question: 'q', context: 'c', output: 'o', rubric: 'r' });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe('JUDGE_BUDGET_EXCEEDED');

    // The refusal must not have hit the network.
    expect(fake.requests).toHaveLength(2);
  });
});

// ── factory gating ──────────────────────────────────────────────────────────

describe('createJudge · gating (ADR-0003)', () => {
  it('returns undefined when the tier is disabled, even with a key', () => {
    const config = configSchema.parse({
      judge: { enabled: false, provider: 'anthropic', apiKey: 'sk-ant-x' },
    }).judge;
    // A key on disk is not consent to spend money.
    expect(createJudge(config, logger)).toBeUndefined();
  });

  it('returns undefined when enabled but unconfigured (AC-12)', () => {
    const config = configSchema.parse({ judge: { enabled: true, provider: 'anthropic' } }).judge;
    expect(createJudge(config, logger)).toBeUndefined();
  });

  it('returns a provider only when enabled AND configured', () => {
    expect(createJudge(judgeConfig(baseUrl), logger)).toBeDefined();
  });
});

// ── detectors driven by a live-shaped judge ─────────────────────────────────

describe('L3 detectors against the fake provider', () => {
  const sandboxOptions = {
    budgetMs: 5000,
    minBaselineSamples: 30,
    shortCircuitConfidence: 0.8,
    logger,
  };

  function ragTrace() {
    return trace()
      .span({
        name: 'kb.search',
        kind: 'retriever',
        offsetMs: 0,
        retrieval: {
          indexName: 'kb',
          documents: [{ id: 'a', score: 0.9, content: 'Refunds are processed within 5 business days.' }],
        },
      })
      .span({
        name: 'llm.answer',
        kind: 'llm',
        offsetMs: 100,
        llm: {
          inputMessages: [{ role: 'user', content: 'How long do refunds take?' }],
          outputMessages: [{ role: 'assistant', content: 'Refunds are instant with no deadline.' }],
        },
      })
      .normalized();
  }

  it('produces a GEN-004 finding when the judge returns verdict=true', async () => {
    fake.responder = () => ({ status: 200, body: verdictBody(true, 0.88, 'two claims are unsupported') });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');
    const t = ragTrace();

    const result = await runSandboxed(
      faithfulnessJudge,
      (signal) => context(t, { signal, judge }),
      sandboxOptions,
    );

    expect(result.outcome).toBe('ok');
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f.code).toBe('GEN-004');
    expect(f.tier).toBe('L3');
    expect(f.confidence).toBeCloseTo(0.88, 5);
    expect(f.detail).toContain('two claims are unsupported');
    expect(f.evidence.find((e) => e.label === 'method')?.value).toBe('llm-judge');
    expect(f.evidence.find((e) => e.label === 'tokensUsed')?.value).toBe(895);
  });

  it('emits nothing when the judge returns verdict=false', async () => {
    fake.responder = () => ({ status: 200, body: verdictBody(false, 0.95, 'fully grounded') });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    const result = await runSandboxed(
      faithfulnessJudge,
      (signal) => context(ragTrace(), { signal, judge }),
      sandboxOptions,
    );
    expect(result.findings).toHaveLength(0);
    expect(result.outcome).toBe('ok');
  });

  it('degrades to no findings — not a failure — when the provider errors', async () => {
    fake.responder = () => ({ status: 500, body: { error: 'boom' } });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    const result = await runSandboxed(
      faithfulnessJudge,
      (signal) => context(ragTrace(), { signal, judge }),
      sandboxOptions,
    );
    // A provider outage must not manufacture INF-006 noise on every trace.
    expect(result.outcome).toBe('ok');
    expect(result.findings).toHaveLength(0);
  });

  it('short-circuits when a cheaper tier already asserted the code (FR-3.14)', async () => {
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');
    const t = ragTrace();

    const existing = [
      {
        findingId: 'f1',
        traceId: t.trace.traceId,
        code: 'GEN-004',
        severity: 'critical' as const,
        confidence: 0.92,
        detectorId: 'gen.groundedness-lexical',
        tier: 'L1' as const,
        title: 'Ungrounded claim',
        detail: '',
        evidence: [{ label: 'x', value: 1 }],
        role: 'standalone' as const,
        taxonomyVersion: '1.0.0',
        createdAt: Date.now(),
      },
    ];

    const result = await runSandboxed(
      faithfulnessJudge,
      (signal) => context(t, { signal, judge, existing }),
      sandboxOptions,
    );

    expect(result.outcome).toBe('skipped:covered');
    // The money-saving assertion: no request was made at all.
    expect(fake.requests).toHaveLength(0);
  });

  it('sends the objective as the question for spec-adherence (MAST FM-1.1)', async () => {
    fake.responder = () => ({ status: 200, body: verdictBody(true, 0.75, 'ignored the word limit') });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    const t = trace()
      .span({
        name: 'agent',
        kind: 'agent',
        offsetMs: 0,
        agent: { agentName: 'a', objective: 'Answer in under 20 words and cite a source.' },
      })
      .span({
        name: 'llm.answer',
        kind: 'llm',
        offsetMs: 100,
        llm: { outputMessages: [{ role: 'assistant', content: 'A very long uncited answer.' }] },
      })
      .normalized();

    const result = await runSandboxed(
      specAdherenceJudge,
      (signal) => context(t, { signal, judge }),
      sandboxOptions,
    );

    expect(result.findings[0]?.code).toBe('AGT-001');
    const content = (fake.requests[0]?.body.messages as { content: string }[])[0]!.content;
    expect(content).toContain('under 20 words');
  });

  it('passes a declared content policy through to the safety judge', async () => {
    fake.responder = () => ({ status: 200, body: verdictBody(true, 0.9, 'violates clause 2') });
    const judge = new AnthropicJudge(judgeConfig(baseUrl), logger, 'k');

    const t = trace()
      .attrs({ 'policy.description': 'Never provide medical dosage advice.' })
      .span({
        name: 'llm.answer',
        kind: 'llm',
        llm: { outputMessages: [{ role: 'assistant', content: 'Take 400mg twice daily.' }] },
      })
      .normalized();

    const result = await runSandboxed(
      unsafeOutputJudge,
      (signal) => context(t, { signal, judge }),
      sandboxOptions,
    );

    expect(result.findings[0]?.code).toBe('SEC-005');
    const content = (fake.requests[0]?.body.messages as { content: string }[])[0]!.content;
    expect(content).toContain('medical dosage advice');
  });
});
