/**
 * Session-scoped analysis.
 *
 * These cover the gap the architecture review found: MAST FM-1.4 and FM-2.1 are
 * defined ACROSS turns, and in a real chat application each turn is its own
 * trace, so a trace-scoped detector can never observe them.
 */

import { createNoopLogger } from '@anvaya/core';
import { describe, expect, it } from 'vitest';
import {
  SessionAnalyzer,
  detectConversationReset,
  detectHistoryLoss,
  toSessionTurn,
} from '../src/analysis/session.js';
import { CausalAttributor } from '../src/analysis/attributor.js';
import { BaselineManager } from '../src/analysis/baselines.js';
import { IncidentClusterer } from '../src/analysis/clusterer.js';
import { CohortCorrelator } from '../src/analysis/correlator.js';
import { TraceEnricher } from '../src/analysis/enricher.js';
import { AlertDispatcher } from '../src/alerts/dispatcher.js';
import { configSchema } from '../src/config/schema.js';
import { createRegistry } from '../src/detectors/index.js';
import { AnalysisPipeline } from '../src/pipeline/pipeline.js';
import { SqliteStorage } from '../src/storage/sqlite/storage.js';
import { Metrics } from '../src/telemetry/metrics.js';
import { TEST_CONFIG, trace } from './fixtures.js';

const logger = createNoopLogger();
const config = configSchema.parse({});
const options = { thresholds: TEST_CONFIG.detection.thresholds, logger };

function turnWith(messages: { role: 'user' | 'assistant'; content: string }[], captured = true) {
  const t = trace()
    .session('s1')
    .span({
      name: 'llm.answer',
      kind: 'llm',
      llm: captured
        ? { inputMessages: messages, inputMessageCount: messages.length }
        : { inputMessageCount: messages.length },
    })
    .normalized();
  return toSessionTurn(t);
}

function msgs(n: number, from = 1) {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `turn ${from + i}`,
  }));
}

describe('toSessionTurn', () => {
  it('projects message count and fingerprints from a trace', () => {
    const turn = turnWith(msgs(4));
    expect(turn.messageCount).toBe(4);
    expect(turn.messageFingerprints).toHaveLength(4);
    // Fingerprints are hashes — content must not survive the projection.
    expect(JSON.stringify(turn)).not.toContain('turn 1');
  });

  it('keeps the count when content capture is off', () => {
    const turn = turnWith(msgs(6), false);
    expect(turn.messageCount).toBe(6);
    expect(turn.messageFingerprints).toHaveLength(0);
  });
});

describe('CTX-003 · history loss across turns (MAST FM-1.4)', () => {
  it('fires when messages the model previously saw disappear', () => {
    const previous = turnWith(msgs(6));
    const current = turnWith(msgs(2, 5)); // only the last two survive

    const finding = detectHistoryLoss(
      { sessionId: 's1', service: 'svc', previous, current, turnIndex: 3 },
      options,
    );

    expect(finding).toBeDefined();
    expect(finding?.code).toBe('CTX-003');
    expect(finding?.traceId).toBe(current.traceId);
    expect(finding?.evidence.find((e) => e.label === 'method')?.value).toBe('message-fingerprint');
    expect(finding?.evidence.find((e) => e.label === 'previousTrace')?.value).toBe(previous.traceId);
    // Summarisation looks identical from here, so it must not read as confirmed.
    expect(finding?.confidence).toBeLessThan(0.8);
  });

  it('stays silent when the conversation simply grows', () => {
    const previous = turnWith(msgs(4));
    const current = turnWith(msgs(6));
    expect(
      detectHistoryLoss(
        { sessionId: 's1', service: 'svc', previous, current, turnIndex: 2 },
        options,
      ),
    ).toBeUndefined();
  });

  it('stays silent on a one-message window slide', () => {
    const previous = turnWith(msgs(6));
    const current = turnWith(msgs(5, 2));
    expect(
      detectHistoryLoss(
        { sessionId: 's1', service: 'svc', previous, current, turnIndex: 2 },
        options,
      ),
    ).toBeUndefined();
  });

  it('degrades to count-only evidence at lower confidence without content', () => {
    const previous = turnWith(msgs(8), false);
    const current = turnWith(msgs(2), false);

    const finding = detectHistoryLoss(
      { sessionId: 's1', service: 'svc', previous, current, turnIndex: 4 },
      options,
    );

    expect(finding).toBeDefined();
    expect(finding?.evidence.find((e) => e.label === 'method')?.value).toBe('message-count');
    // Count alone cannot distinguish a drop from a summarisation.
    expect(finding?.confidence).toBeLessThanOrEqual(0.6);
  });
});

describe('CTX-004 · conversation reset across turns (MAST FM-2.1)', () => {
  it('fires when a real conversation restarts from one message', () => {
    const previous = turnWith(msgs(6));
    const current = turnWith([{ role: 'user', content: 'brand new question' }]);

    const finding = detectConversationReset(
      { sessionId: 's1', service: 'svc', previous, current, turnIndex: 4 },
      options,
    );

    expect(finding?.code).toBe('CTX-004');
    expect(finding?.evidence.find((e) => e.label === 'carriedOver')?.value).toBe(0);
  });

  it('stays silent when context carried over', () => {
    const shared = msgs(6);
    const previous = turnWith(shared);
    // One message survived, so this is a window slide and not a reset.
    const current = turnWith([shared[5]!]);

    expect(
      detectConversationReset(
        { sessionId: 's1', service: 'svc', previous, current, turnIndex: 4 },
        options,
      ),
    ).toBeUndefined();
  });

  it('stays silent when there was no conversation to reset', () => {
    const previous = turnWith(msgs(2));
    const current = turnWith([{ role: 'user', content: 'next' }]);
    expect(
      detectConversationReset(
        { sessionId: 's1', service: 'svc', previous, current, turnIndex: 1 },
        options,
      ),
    ).toBeUndefined();
  });
});

describe('SessionAnalyzer', () => {
  it('survives a detector that throws', () => {
    const analyzer = new SessionAnalyzer(options);
    const previous = turnWith(msgs(6));
    // A malformed turn must not take down session analysis.
    const broken = { ...turnWith(msgs(1)), messageFingerprints: null as never };

    expect(() =>
      analyzer.analyze({
        sessionId: 's1',
        service: 'svc',
        previous,
        current: broken,
        turnIndex: 2,
      }),
    ).not.toThrow();
  });
});

describe('end-to-end · session detection across separate traces', () => {
  async function makePipeline() {
    const storage = new SqliteStorage({ path: ':memory:', busyTimeoutMs: 1000, logger });
    await storage.init();

    const pipeline = new AnalysisPipeline({
      registry: createRegistry(),
      enricher: new TraceEnricher(),
      attributor: new CausalAttributor(),
      clusterer: new IncidentClusterer({ windowMs: 3_600_000, autoResolveMs: 3_600_000, storage, logger }),
      correlator: new CohortCorrelator({ storage, cohortKeys: [], minLift: 2, minSamples: 20, logger }),
      baselines: new BaselineManager(storage, logger),
      sessionAnalyzer: new SessionAnalyzer(options),
      storage,
      alerts: new AlertDispatcher(config, logger),
      config,
      metrics: new Metrics(),
      logger,
    });

    return { storage, pipeline };
  }

  function turnTrace(sessionId: string, offsetMs: number, messages: { role: 'user' | 'assistant'; content: string }[]) {
    const b = trace().session(sessionId).span({
      name: 'llm.answer',
      kind: 'llm',
      offsetMs,
      llm: {
        provider: 'anthropic',
        requestModel: 'claude-sonnet-5',
        inputTokens: 500,
        outputTokens: 50,
        inputMessages: messages,
        inputMessageCount: messages.length,
        outputMessages: [{ role: 'assistant', content: 'a reply' }],
      },
    });
    return b.build();
  }

  it('detects history loss BETWEEN two separate traces of one session', async () => {
    const { storage, pipeline } = await makePipeline();

    // Turn 1: a healthy six-message conversation.
    const first = turnTrace('sess-A', 0, msgs(6));
    const firstOutcome = await pipeline.analyze(first.trace, first.spans);
    // Nothing to compare against yet.
    expect(firstOutcome.findings.map((f) => f.code)).not.toContain('CTX-003');

    // Turn 2, a separate trace: the memory layer dropped four messages.
    const second = turnTrace('sess-A', 60_000, msgs(2, 5));
    const secondOutcome = await pipeline.analyze(second.trace, second.spans);

    // This is the assertion the old trace-scoped design could never satisfy.
    expect(secondOutcome.findings.map((f) => f.code)).toContain('CTX-003');

    const stored = await storage.getTrace(second.trace.traceId);
    const finding = stored?.findings.find((f) => f.code === 'CTX-003');
    expect(finding?.detectorId).toBe('session.history-loss');
    expect(finding?.evidence.find((e) => e.label === 'previousTrace')?.value).toBe(
      first.trace.traceId,
    );

    await storage.close();
  });

  it('does not fire for a healthy growing conversation', async () => {
    const { storage, pipeline } = await makePipeline();

    const first = turnTrace('sess-B', 0, msgs(2));
    await pipeline.analyze(first.trace, first.spans);
    const second = turnTrace('sess-B', 60_000, msgs(4));
    const outcome = await pipeline.analyze(second.trace, second.spans);

    expect(outcome.findings.map((f) => f.code)).not.toContain('CTX-003');
    expect(outcome.findings.map((f) => f.code)).not.toContain('CTX-004');

    await storage.close();
  });

  it('reports a regression once, on the turn where it became visible', async () => {
    const { storage, pipeline } = await makePipeline();

    await (async () => {
      const t = turnTrace('sess-C', 0, msgs(8));
      await pipeline.analyze(t.trace, t.spans);
    })();

    const dropped = turnTrace('sess-C', 60_000, msgs(2, 7));
    const droppedOutcome = await pipeline.analyze(dropped.trace, dropped.spans);
    expect(droppedOutcome.findings.filter((f) => f.code === 'CTX-003')).toHaveLength(1);

    // The next turn continues normally from the reduced window, so it must not
    // re-report the same regression.
    const next = turnTrace('sess-C', 120_000, msgs(3, 7));
    const nextOutcome = await pipeline.analyze(next.trace, next.spans);
    expect(nextOutcome.findings.filter((f) => f.code === 'CTX-003')).toHaveLength(0);

    await storage.close();
  });

  it('ignores traces with no session id', async () => {
    const { storage, pipeline } = await makePipeline();
    const { trace: rec, spans } = trace()
      .span({ name: 'llm.answer', kind: 'llm', llm: { inputMessages: msgs(6), inputMessageCount: 6 } })
      .build();

    const outcome = await pipeline.analyze(rec, spans);
    expect(outcome.findings.map((f) => f.code)).not.toContain('CTX-003');
    await storage.close();
  });

  it('aggregates sessions and reports cost by cohort', async () => {
    const { storage, pipeline } = await makePipeline();

    for (const offset of [0, 60_000, 120_000]) {
      const t = turnTrace('sess-D', offset, msgs(3));
      await pipeline.analyze(t.trace, t.spans);
    }

    const sessions = await storage.listSessions({ range: { from: 0, to: Date.now() + 1000 } });
    const session = sessions.items.find((s) => s.sessionId === 'sess-D');
    expect(session?.traceCount).toBe(3);
    expect(session?.totalTokens).toBe(1650);

    const traces = await storage.getSessionTraces('sess-D');
    expect(traces).toHaveLength(3);
    // Ordered oldest-first so a session reads as a conversation.
    expect(traces[0]!.startTime).toBeLessThan(traces[2]!.startTime);

    const cost = await storage.costByCohort('service', { from: 0, to: Date.now() + 1000 });
    expect(cost[0]?.value).toBe('test-service');
    expect(cost[0]?.traces).toBe(3);

    await storage.close();
  });
});
