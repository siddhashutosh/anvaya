/**
 * Sandbox isolation (AC-7), causal attribution (AC-9), adapters, storage, and an
 * end-to-end pipeline run.
 */

import { createNoopLogger, type Finding } from '@anvaya/core';
import { describe, expect, it } from 'vitest';
import { AlertDispatcher } from '../src/alerts/dispatcher.js';
import { CausalAttributor } from '../src/analysis/attributor.js';
import { BaselineManager } from '../src/analysis/baselines.js';
import { IncidentClusterer } from '../src/analysis/clusterer.js';
import { CohortCorrelator } from '../src/analysis/correlator.js';
import { TraceEnricher } from '../src/analysis/enricher.js';
import { configSchema } from '../src/config/schema.js';
import { createRegistry } from '../src/detectors/index.js';
import { runSandboxed } from '../src/detectors/sandbox.js';
import { finding, type Detector } from '../src/detectors/types.js';
import { getAdapter } from '../src/ingest/adapters/index.js';
import { TraceAssembler } from '../src/ingest/assembler.js';
import { estimateCostUsd } from '../src/ingest/pricing.js';
import { SpanQueue } from '../src/ingest/queue.js';
import { AnalysisPipeline } from '../src/pipeline/pipeline.js';
import { SqliteStorage } from '../src/storage/sqlite/storage.js';
import { Metrics } from '../src/telemetry/metrics.js';
import { context, trace } from './fixtures.js';

const logger = createNoopLogger();
const config = configSchema.parse({});

// ── ADR-0006 · detector fault isolation ─────────────────────────────────────

const explodingDetector: Detector = {
  id: 'test.exploding',
  tier: 'L0',
  emits: ['AGT-003'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Always throws. Used to prove the sandbox holds.',
  supports: () => true,
  async run() {
    throw new Error('deliberate detector failure');
  },
};

const hangingDetector: Detector = {
  id: 'test.hanging',
  tier: 'L0',
  emits: ['AGT-003'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Never resolves. Used to prove the time budget holds.',
  supports: () => true,
  async run() {
    return new Promise(() => {
      /* never resolves */
    });
  },
};

const liarDetector: Detector = {
  id: 'test.liar',
  tier: 'L0',
  emits: ['AGT-003'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Emits a code it never declared.',
  supports: () => true,
  async run(ctx) {
    return [
      finding({
        ctx,
        detector: liarDetector,
        code: 'SEC-001',
        confidence: 1,
        detail: 'undeclared',
        evidence: [{ label: 'x', value: 1 }],
      }),
    ];
  },
};

const sandboxOptions = {
  budgetMs: 200,
  minBaselineSamples: 30,
  shortCircuitConfidence: 0.8,
  logger,
};

describe('ADR-0006 · detector sandbox', () => {
  const t = trace().span({ name: 'root', kind: 'chain' }).normalized();

  it('converts a throwing detector into an INF-006 finding and continues (AC-7)', async () => {
    const result = await runSandboxed(explodingDetector, (signal) => context(t, { signal }), sandboxOptions);

    expect(result.outcome).toBe('failed');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.code).toBe('INF-006');
    expect(result.findings[0]?.detail).toContain('test.exploding');
  });

  it('times out a hanging detector rather than blocking the pipeline', async () => {
    const result = await runSandboxed(hangingDetector, (signal) => context(t, { signal }), sandboxOptions);

    expect(result.outcome).toBe('timeout');
    expect(result.findings[0]?.code).toBe('INF-006');
  });

  it('drops findings whose codes the detector never declared', async () => {
    const result = await runSandboxed(liarDetector, (signal) => context(t, { signal }), sandboxOptions);
    expect(result.outcome).toBe('ok');
    expect(result.findings).toHaveLength(0);
  });

  it('records a supports() decline as a skip, not a failure', async () => {
    const declining: Detector = { ...explodingDetector, id: 'test.declines', supports: () => false };
    const result = await runSandboxed(declining, (signal) => context(t, { signal }), sandboxOptions);
    expect(result.outcome).toBe('skipped:unsupported');
    expect(result.findings).toHaveLength(0);
  });

  it('skips a billed detector when no judge is configured (AC-12)', async () => {
    const judged: Detector = { ...explodingDetector, id: 'test.judged', cost: 'billed' };
    const result = await runSandboxed(judged, (signal) => context(t, { signal }), sandboxOptions);
    expect(result.outcome).toBe('skipped:unconfigured');
  });

  it('short-circuits a billed detector already covered by a cheaper tier (FR-3.14)', async () => {
    const judged: Detector = { ...explodingDetector, id: 'test.covered', cost: 'billed' };
    const existing = [
      {
        findingId: 'f1',
        traceId: t.trace.traceId,
        code: 'AGT-003',
        severity: 'high',
        confidence: 0.95,
        detectorId: 'agt.step-repetition',
        tier: 'L0',
        title: 'Step repetition',
        detail: '',
        evidence: [{ label: 'x', value: 1 }],
        role: 'standalone',
        taxonomyVersion: '1.0.0',
        createdAt: Date.now(),
      } satisfies Finding,
    ];

    const result = await runSandboxed(
      judged,
      (signal) => context(t, { signal, existing, judge: { name: 'fake' } as never }),
      sandboxOptions,
    );
    expect(result.outcome).toBe('skipped:covered');
  });

  it('rejects a finding with no evidence (FR-3.16)', () => {
    const ctx = context(t);
    expect(() =>
      finding({
        ctx,
        detector: explodingDetector,
        code: 'AGT-003',
        confidence: 1,
        detail: 'no evidence',
        evidence: [],
      }),
    ).toThrow(/without evidence/);
  });
});

// ── attribution ─────────────────────────────────────────────────────────────

describe('causal attribution', () => {
  const attributor = new CausalAttributor();

  function makeFinding(over: Partial<Finding> & Pick<Finding, 'code' | 'severity'>): Finding {
    return {
      findingId: `f-${over.code}`,
      traceId: 't1',
      confidence: 0.9,
      detectorId: 'test',
      tier: 'L0',
      title: over.code,
      detail: '',
      evidence: [{ label: 'x', value: 1 }],
      role: 'standalone',
      taxonomyVersion: '1.0.0',
      createdAt: Date.now(),
      ...over,
    } as Finding;
  }

  it('attributes degraded retrieval as the ORIGIN and hallucination as a SYMPTOM (AC-9)', () => {
    const t = trace()
      .span({ name: 'kb.search', kind: 'retriever', offsetMs: 0, retrieval: { indexName: 'kb' } })
      .span({ name: 'llm.answer', kind: 'llm', offsetMs: 500, llm: {} })
      .normalized();

    const retrievalSpan = t.spans[0]!;
    const llmSpan = t.spans[1]!;

    const result = attributor.attribute(t, [
      // Deliberately passed in the WRONG order, and the hallucination has the
      // higher default severity — attribution must still name retrieval.
      makeFinding({ code: 'GEN-004', severity: 'critical', spanId: llmSpan.spanId }),
      makeFinding({ code: 'RET-002', severity: 'high', spanId: retrievalSpan.spanId }),
    ]);

    const origin = result.findings.find((f) => f.role === 'origin');
    const symptom = result.findings.find((f) => f.role === 'symptom');

    expect(origin?.code).toBe('RET-002');
    expect(symptom?.code).toBe('GEN-004');
    expect(symptom?.causedBy).toBe(origin?.findingId);
    expect(result.attribution.originFindingId).toBe(origin?.findingId);
    expect(result.attribution.summary).toContain('kb.search');
  });

  it('builds a transitive chain origin → symptom → symptom', () => {
    const t = trace()
      .span({ name: 'kb.search', kind: 'retriever', offsetMs: 0 })
      .span({ name: 'llm.answer', kind: 'llm', offsetMs: 500 })
      .normalized();

    const result = attributor.attribute(t, [
      makeFinding({ code: 'RET-002', severity: 'high', spanId: t.spans[0]!.spanId }),
      makeFinding({ code: 'GEN-004', severity: 'critical', spanId: t.spans[1]!.spanId }),
      makeFinding({ code: 'GEN-008', severity: 'medium', spanId: t.spans[1]!.spanId }),
    ]);

    expect(result.attribution.chain.map((c) => c.code)).toEqual(['RET-002', 'GEN-004', 'GEN-008']);
  });

  it('leaves unrelated findings standalone rather than inventing a cause', () => {
    const t = trace()
      .span({ name: 'a', kind: 'tool', offsetMs: 0 })
      .span({ name: 'b', kind: 'llm', offsetMs: 100 })
      .normalized();

    const result = attributor.attribute(t, [
      makeFinding({ code: 'INF-004', severity: 'critical', spanId: t.spans[0]!.spanId }),
      makeFinding({ code: 'ECO-005', severity: 'low', spanId: t.spans[1]!.spanId }),
    ]);

    expect(result.findings.filter((f) => f.role === 'symptom')).toHaveLength(0);
    expect(result.findings.filter((f) => f.role === 'origin')).toHaveLength(1);
  });

  it('does not let a later finding cause an earlier one', () => {
    const t = trace()
      .span({ name: 'llm.answer', kind: 'llm', offsetMs: 0 })
      .span({ name: 'kb.search', kind: 'retriever', offsetMs: 900 })
      .normalized();

    const result = attributor.attribute(t, [
      makeFinding({ code: 'GEN-004', severity: 'critical', spanId: t.spans[0]!.spanId }),
      makeFinding({ code: 'RET-002', severity: 'high', spanId: t.spans[1]!.spanId }),
    ]);

    // Retrieval happened AFTER generation here, so it cannot be the cause.
    expect(result.findings.find((f) => f.code === 'GEN-004')?.role).not.toBe('symptom');
  });

  it('handles an empty finding set', () => {
    const t = trace().span({ name: 'a', kind: 'chain' }).normalized();
    const result = attributor.attribute(t, []);
    expect(result.attribution.originFindingId).toBeUndefined();
    expect(result.attribution.summary).toBe('No findings.');
  });
});

// ── ingest ──────────────────────────────────────────────────────────────────

describe('ingest adapters', () => {
  const ctx = { service: 'svc', environment: 'test' };

  it('validates and passes through the native format', () => {
    const result = getAdapter('anvaya').adapt(
      {
        spanId: 'a'.repeat(16),
        traceId: 'b'.repeat(32),
        name: 'llm.answer',
        kind: 'llm',
        startTime: 1,
        endTime: 2,
        durationMs: 1,
        status: 'ok',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid span with a field-level message', () => {
    const result = getAdapter('anvaya').adapt({ name: 'x', kind: 'not-a-kind' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('invalid span');
  });

  it('maps OTel gen_ai attributes and preserves unknown keys (ADR-0002, IF-2.2)', () => {
    const result = getAdapter('otel-genai').adapt(
      {
        traceId: 't1',
        spanId: 's1',
        name: 'chat',
        startTimeUnixNano: 1_760_000_000_000_000_000,
        endTimeUnixNano: 1_760_000_001_000_000_000,
        status: { code: 1 },
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'anthropic',
          'gen_ai.request.model': 'claude-sonnet-5',
          'gen_ai.usage.input_tokens': 120,
          'gen_ai.usage.output_tokens': 40,
          'gen_ai.response.finish_reasons': ['length'],
          'gen_ai.conversation.id': 'sess-9',
          // A future/renamed attribute must survive rather than vanish.
          'gen_ai.some.future.attribute': 'still here',
        },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const span = result.value;
    expect(span.kind).toBe('llm');
    expect(span.llm?.provider).toBe('anthropic');
    expect(span.llm?.inputTokens).toBe(120);
    expect(span.llm?.finishReason).toBe('length');
    expect(span.durationMs).toBe(1000);
    expect(span.attributes['gen_ai.some.future.attribute']).toBe('still here');
    expect(span.attributes['anvaya.session_id']).toBe('sess-9');
  });

  it('maps OpenInference span kinds and retrieval documents', () => {
    const result = getAdapter('openinference').adapt(
      {
        traceId: 't1',
        spanId: 's1',
        name: 'search',
        startTime: 1_760_000_000_000,
        endTime: 1_760_000_000_120,
        statusCode: 'OK',
        attributes: {
          'openinference.span.kind': 'RETRIEVER',
          'input.value': 'refund policy',
          'retrieval.documents.0.document.id': 'kb-1',
          'retrieval.documents.0.document.score': 0.87,
          'session.id': 'sess-4',
        },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('retriever');
    expect(result.value.retrieval?.documents?.[0]).toMatchObject({ id: 'kb-1', score: 0.87 });
    expect(result.value.attributes['anvaya.session_id']).toBe('sess-4');
  });
});

describe('queue and assembler', () => {
  it('drops the oldest span on overflow and counts it', () => {
    const queue = new SpanQueue({ maxSize: 2, logger });
    const item = (id: string) => ({
      span: { spanId: id } as never,
      service: 'svc',
      environment: 'test',
      receivedAt: Date.now(),
    });

    queue.push(item('a'));
    queue.push(item('b'));
    expect(queue.push(item('c'))).toBe(false);
    expect(queue.dropped).toBe(1);
    expect(queue.size).toBe(2);
  });

  it('completes a trace when its root span arrives', () => {
    const completed: string[] = [];
    const assembler = new TraceAssembler({
      idleMs: 60_000,
      maxPending: 10,
      logger,
      onComplete: (t) => completed.push(t.traceId),
    });

    const base = { service: 'svc', environment: 'test', receivedAt: Date.now() };
    assembler.add({
      ...base,
      span: { spanId: 'child', traceId: 'T', parentSpanId: 'root', startTime: 1, endTime: 2, status: 'ok', name: 'c', kind: 'tool', durationMs: 1, attributes: {}, events: [] } as never,
    });
    expect(completed).toHaveLength(0);

    assembler.add({
      ...base,
      span: { spanId: 'root', traceId: 'T', startTime: 0, endTime: 3, status: 'ok', name: 'r', kind: 'chain', durationMs: 3, attributes: {}, events: [] } as never,
    });
    expect(completed).toEqual(['T']);
  });

  it('completes a trace that went idle without a root', () => {
    const completed: string[] = [];
    const assembler = new TraceAssembler({
      idleMs: 0,
      maxPending: 10,
      logger,
      onComplete: (t) => completed.push(t.traceId),
    });

    assembler.add({
      span: { spanId: 'orphan', traceId: 'T2', parentSpanId: 'missing', startTime: 1, endTime: 2, status: 'ok', name: 'o', kind: 'tool', durationMs: 1, attributes: {}, events: [] } as never,
      service: 'svc',
      environment: 'test',
      receivedAt: Date.now(),
    });

    assembler.sweep(Date.now() + 1000);
    expect(completed).toEqual(['T2']);
  });
});

describe('pricing', () => {
  it('prices by longest model prefix and discounts cached reads', () => {
    const full = estimateCostUsd('claude-opus-5-20260101', 1_000_000, 0, 0);
    expect(full).toBeCloseTo(15, 5);

    const cached = estimateCostUsd('claude-opus-5', 1_000_000, 0, 1_000_000);
    expect(cached).toBeLessThan(full);
  });

  it('returns 0 for an unknown model rather than guessing', () => {
    expect(estimateCostUsd('some-unknown-model', 1000, 1000)).toBe(0);
  });
});

// ── storage & end-to-end ────────────────────────────────────────────────────

async function makeStorage(): Promise<SqliteStorage> {
  const storage = new SqliteStorage({ path: ':memory:', busyTimeoutMs: 1000, logger });
  await storage.init();
  return storage;
}

describe('storage', () => {
  it('runs migrations idempotently', async () => {
    const storage = await makeStorage();
    await expect(storage.init()).resolves.toBeUndefined();
    expect((await storage.health()).ok).toBe(true);
    await storage.close();
  });

  it('round-trips a trace bundle and is idempotent on spanId (FR-2.7)', async () => {
    const storage = await makeStorage();
    const { trace: rec, spans } = trace()
      .span({ name: 'root', kind: 'chain' })
      .span({ name: 'llm', kind: 'llm', parent: 0, llm: { inputTokens: 10, outputTokens: 5 } })
      .build();

    const bundle = { trace: rec, spans, findings: [], detectorRuns: [] };
    await storage.saveTraceBundle(bundle);
    await storage.saveTraceBundle(bundle);

    const detail = await storage.getTrace(rec.traceId);
    expect(detail?.spans).toHaveLength(2);
    await storage.close();
  });

  it('filters, paginates, and purges', async () => {
    const storage = await makeStorage();
    for (let i = 0; i < 5; i++) {
      const { trace: rec, spans } = trace().span({ name: `t-${i}`, kind: 'chain' }).build();
      await storage.saveTraceBundle({ trace: rec, spans, findings: [], detectorRuns: [] });
    }

    const page = await storage.listTraces({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.nextCursor).toBeDefined();

    const purged = await storage.purgeOlderThan(Date.now());
    expect(purged.traces).toBe(5);
    expect((await storage.listTraces({})).total).toBe(0);
    await storage.close();
  });
});

describe('end-to-end pipeline', () => {
  it('analyses a degraded-retrieval trace and persists the diagnosis', async () => {
    const storage = await makeStorage();
    const metrics = new Metrics();
    const baselines = new BaselineManager(storage, logger);

    const pipeline = new AnalysisPipeline({
      registry: createRegistry(),
      enricher: new TraceEnricher(),
      attributor: new CausalAttributor(),
      clusterer: new IncidentClusterer({
        windowMs: config.analysis.incidentWindowMs,
        autoResolveMs: config.analysis.autoResolveMs,
        storage,
        logger,
      }),
      correlator: new CohortCorrelator({
        storage,
        cohortKeys: ['service'],
        minLift: 2,
        minSamples: 20,
        logger,
      }),
      baselines,
      storage,
      alerts: new AlertDispatcher(config, logger),
      config,
      metrics,
      logger,
    });

    const { trace: rec, spans } = trace()
      .span({ name: 'root', kind: 'chain', offsetMs: 0, durationMs: 2000 })
      .span({
        name: 'kb.search',
        kind: 'retriever',
        parent: 0,
        offsetMs: 50,
        retrieval: { indexName: 'kb', documents: [{ id: 'a', score: 0.9, content: 'Office hours are nine to five, Monday through Friday, excluding holidays.' }] },
      })
      .span({
        name: 'llm.answer',
        kind: 'llm',
        parent: 0,
        offsetMs: 900,
        llm: {
          provider: 'anthropic',
          requestModel: 'claude-sonnet-5',
          inputTokens: 900,
          outputTokens: 60,
          finishReason: 'length',
          outputMessages: [
            {
              role: 'assistant',
              content:
                'Refunds are issued instantly to the original payment method with no deadline whatsoever. Customers may also telephone the dedicated refund hotline at any hour.',
            },
          ],
        },
      })
      .build();

    const outcome = await pipeline.analyze(rec, spans);

    expect(outcome.findings.length).toBeGreaterThan(0);
    // Truncation is deterministic, so it must be present.
    expect(outcome.findings.map((f) => f.code)).toContain('GEN-006');
    // Ungrounded output is detectable at L1 from lexical overlap alone.
    expect(outcome.findings.map((f) => f.code)).toContain('GEN-004');

    const stored = await storage.getTrace(rec.traceId);
    expect(stored?.findings.length).toBe(outcome.findings.length);
    expect(stored?.attribution?.summary).toBeTruthy();
    expect(stored?.trace.findingCount).toBe(outcome.findings.length);

    const snapshot = metrics.snapshot();
    expect(snapshot.counters['pipeline.traces_analysed']).toBe(1);

    await storage.close();
  });

  it('keeps ingesting when a registered detector always throws (AC-7)', async () => {
    const storage = await makeStorage();
    const registry = createRegistry([explodingDetector]);
    const baselines = new BaselineManager(storage, logger);

    const pipeline = new AnalysisPipeline({
      registry,
      enricher: new TraceEnricher(),
      attributor: new CausalAttributor(),
      clusterer: new IncidentClusterer({ windowMs: 1000, autoResolveMs: 1000, storage, logger }),
      correlator: new CohortCorrelator({ storage, cohortKeys: [], minLift: 2, minSamples: 20, logger }),
      baselines,
      storage,
      alerts: new AlertDispatcher(config, logger),
      config,
      metrics: new Metrics(),
      logger,
    });

    const { trace: rec, spans } = trace().span({ name: 'root', kind: 'chain' }).build();
    const outcome = await pipeline.analyze(rec, spans);

    expect(outcome.findings.map((f) => f.code)).toContain('INF-006');
    // The trace was still stored — the pipeline did not abort.
    expect(await storage.getTrace(rec.traceId)).toBeDefined();

    await storage.close();
  });
});
