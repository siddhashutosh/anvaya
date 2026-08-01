/**
 * HTTP layer (FR-6.*).
 *
 * Driven through Fastify's `inject`, so routing, middleware, auth, the error
 * envelope and serialisation are all exercised for real — none of which had any
 * coverage before.
 */

import { createNoopLogger, type SpanRecord } from '@anvaya/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { configSchema, type Config } from '../src/config/schema.js';
import { createRegistry } from '../src/detectors/index.js';
import { SpanQueue } from '../src/ingest/queue.js';
import { AnalysisPipeline } from '../src/pipeline/pipeline.js';
import { IngestWorker } from '../src/pipeline/worker.js';
import { SqliteStorage } from '../src/storage/sqlite/storage.js';
import { Metrics } from '../src/telemetry/metrics.js';
import { AlertDispatcher } from '../src/alerts/dispatcher.js';
import { CausalAttributor } from '../src/analysis/attributor.js';
import { BaselineManager } from '../src/analysis/baselines.js';
import { IncidentClusterer } from '../src/analysis/clusterer.js';
import { CohortCorrelator } from '../src/analysis/correlator.js';
import { TraceEnricher } from '../src/analysis/enricher.js';
import { SessionAnalyzer } from '../src/analysis/session.js';
import { Redactor } from '@anvaya/core';
import { trace } from './fixtures.js';

const logger = createNoopLogger();

interface Harness {
  app: FastifyInstance;
  storage: SqliteStorage;
  worker: IngestWorker;
  close: () => Promise<void>;
}

async function harness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const config: Config = configSchema.parse(overrides);
  const storage = new SqliteStorage({ path: ':memory:', busyTimeoutMs: 1000, logger });
  await storage.init();

  const metrics = new Metrics();
  const pipeline = new AnalysisPipeline({
    registry: createRegistry(),
    enricher: new TraceEnricher(),
    attributor: new CausalAttributor(),
    clusterer: new IncidentClusterer({ windowMs: 3_600_000, autoResolveMs: 3_600_000, storage, logger }),
    correlator: new CohortCorrelator({ storage, cohortKeys: [], minLift: 2, minSamples: 20, logger }),
    baselines: new BaselineManager(storage, logger),
    sessionAnalyzer: new SessionAnalyzer({ thresholds: config.detection.thresholds, logger }),
    storage,
    alerts: new AlertDispatcher(config, logger),
    config,
    metrics,
    logger,
  });

  const worker = new IngestWorker({
    queue: new SpanQueue({ maxSize: config.ingest.maxQueueSize, logger }),
    pipeline,
    metrics,
    logger,
    traceIdleMs: 0,
    maxPendingTraces: config.ingest.maxPendingTraces,
    maxSpansPerTrace: config.ingest.maxSpansPerTrace,
    sweepIntervalMs: 100_000,
    concurrency: 1,
  });

  const app = await createApp({
    storage,
    worker,
    registry: createRegistry(),
    metrics,
    config,
    redactor: new Redactor(),
    judgeConfigured: false,
    logger,
  });

  return {
    app,
    storage,
    worker,
    close: async () => {
      await app.close();
      await storage.close();
    },
  };
}

function wireSpans(): unknown[] {
  const { spans } = trace()
    .span({ name: 'root', kind: 'chain' })
    .span({
      name: 'llm.answer',
      kind: 'llm',
      parent: 0,
      // A known model, so the pricing table yields a non-zero cost and the
      // showback endpoint has something real to attribute.
      llm: {
        requestModel: 'claude-sonnet-5',
        inputTokens: 100_000,
        outputTokens: 20_000,
        finishReason: 'length',
      },
    })
    .build();
  return spans as unknown as SpanRecord[];
}

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.close();
});

// ── health & meta ───────────────────────────────────────────────────────────

describe('GET /health (FR-6.1)', () => {
  it('reports component status without authentication', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.components.storage.ok).toBe(true);
    expect(body.components.detection.detectors).toBeGreaterThan(40);
    expect(body.taxonomyVersion).toBe('1.0.0');
  });

  it('surfaces queue and oversize-drop counters', async () => {
    const body = (await h.app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.components.ingest).toHaveProperty('dropped');
    // A silent drop would make the tool lie about its own coverage.
    expect(body.components.ingest).toHaveProperty('droppedOversizeSpans');
  });
});

describe('GET /v1/meta', () => {
  it('advertises supported wire formats', async () => {
    const body = (await h.app.inject({ method: 'GET', url: '/v1/meta' })).json();
    expect(body.capabilities.formats).toEqual(['anvaya', 'otel-genai', 'openinference']);
    expect(body.taxonomySize).toBe(56);
  });
});

// ── ingest ──────────────────────────────────────────────────────────────────

describe('POST /v1/ingest (FR-6.2, FR-2.3)', () => {
  it('accepts a valid batch with 202 and an ack', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: { service: 'svc', environment: 'test', spans: wireSpans() },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: 2, rejected: 0 });
  });

  it('ingests the valid spans of a partially-invalid batch', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        service: 'svc',
        spans: [...wireSpans(), { name: 'broken', kind: 'not-a-real-kind' }],
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    // One bad span must never reject the whole batch.
    expect(body.accepted).toBe(2);
    expect(body.rejected).toBe(1);
    expect(body.errors[0].index).toBe(2);
  });

  it('rejects a structurally invalid payload with field-level detail', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: { environment: 'test', spans: [] },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.requestId).toMatch(/^req_/);
  });

  it('redacts secrets server-side even when the client did not (NFR-4.2)', async () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX';
    const { spans } = trace()
      .span({
        name: 'llm.answer',
        kind: 'llm',
        llm: { inputMessages: [{ role: 'user', content: `key ${secret}` }] },
      })
      .build();

    await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: { service: 'svc', spans },
    });
    await h.worker.tick();

    const list = (await h.app.inject({ method: 'GET', url: '/v1/traces' })).json();
    const detail = (
      await h.app.inject({ method: 'GET', url: `/v1/traces/${list.items[0].traceId}` })
    ).json();

    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(JSON.stringify(detail)).toContain('[REDACTED:api_key]');
  });

  it('accepts the OTel GenAI wire format', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: {
        format: 'otel-genai',
        service: 'svc',
        spans: [
          {
            traceId: 'a'.repeat(32),
            spanId: 'b'.repeat(16),
            name: 'chat',
            startTime: 1_760_000_000_000,
            endTime: 1_760_000_001_000,
            status: { code: 1 },
            attributes: {
              'gen_ai.operation.name': 'chat',
              'gen_ai.provider.name': 'anthropic',
              'gen_ai.usage.input_tokens': 10,
            },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1);
  });
});

// ── query endpoints ─────────────────────────────────────────────────────────

describe('trace, finding and taxonomy endpoints', () => {
  beforeEach(async () => {
    await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: { service: 'svc', environment: 'test', spans: wireSpans() },
    });
    await h.worker.tick();
  });

  it('lists traces and returns full detail with taxonomy cards', async () => {
    const list = (await h.app.inject({ method: 'GET', url: '/v1/traces' })).json();
    expect(list.items.length).toBe(1);
    expect(list.total).toBe(1);

    const detail = (
      await h.app.inject({ method: 'GET', url: `/v1/traces/${list.items[0].traceId}` })
    ).json();

    expect(detail.spans).toHaveLength(2);
    // GEN-006 is deterministic on finishReason=length.
    expect(detail.findings.map((f: { code: string }) => f.code)).toContain('GEN-006');
    // Remediation must travel with the finding so the UI never hardcodes it.
    expect(detail.taxonomy['GEN-006'].remediation).toBeTruthy();
  });

  it('404s an unknown trace with the standard envelope', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/traces/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.json().error.requestId).toMatch(/^req_/);
  });

  it('filters findings by code and by role', async () => {
    const byCode = (await h.app.inject({ method: 'GET', url: '/v1/findings?code=GEN-006' })).json();
    expect(byCode.items.length).toBeGreaterThan(0);
    expect(byCode.items.every((f: { code: string }) => f.code === 'GEN-006')).toBe(true);

    const none = (await h.app.inject({ method: 'GET', url: '/v1/findings?code=SEC-001' })).json();
    expect(none.items).toHaveLength(0);
  });

  it('serves the full taxonomy and a single mode', async () => {
    const all = (await h.app.inject({ method: 'GET', url: '/v1/taxonomy' })).json();
    expect(all.modes).toHaveLength(56);

    const one = (await h.app.inject({ method: 'GET', url: '/v1/taxonomy/AGT-003' })).json();
    expect(one.name).toBe('Step repetition');
    expect(one.observedFrequency).toBeCloseTo(0.1714, 4);

    const missing = await h.app.inject({ method: 'GET', url: '/v1/taxonomy/ZZZ-999' });
    expect(missing.statusCode).toBe(404);
  });

  it('serves overview, timeseries and cost stats', async () => {
    const overview = (await h.app.inject({ method: 'GET', url: '/v1/stats/overview' })).json();
    expect(overview.traceCount).toBe(1);
    expect(overview.topCodes[0]).toHaveProperty('name');

    const series = (await h.app.inject({ method: 'GET', url: '/v1/stats/timeseries' })).json();
    expect(Array.isArray(series.buckets)).toBe(true);

    const cost = (await h.app.inject({ method: 'GET', url: '/v1/stats/cost?key=service' })).json();
    expect(cost.key).toBe('service');
    expect(cost.buckets[0].value).toBe('svc');
    expect(cost.buckets[0].share).toBeCloseTo(1, 5);
  });

  it('caps timeseries buckets so a wide range cannot exhaust memory', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/stats/timeseries?from=0&to=${Date.now()}&bucketMs=1000`,
    });
    expect(res.json().buckets.length).toBeLessThanOrEqual(501);
  });

  it('rejects an inverted time range', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/stats/overview?from=2000&to=1000' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_QUERY');
  });

  it('lists detectors with tier, cost and enablement', async () => {
    const body = (await h.app.inject({ method: 'GET', url: '/v1/detectors' })).json();
    expect(body.detectors.length).toBeGreaterThan(40);

    const l3 = body.detectors.filter((d: { tier: string }) => d.tier === 'L3');
    // L3 is off by default, so nothing billed may report as enabled.
    expect(l3.every((d: { enabled: boolean }) => !d.enabled)).toBe(true);
  });
});

// ── sessions ────────────────────────────────────────────────────────────────

describe('session endpoints', () => {
  it('lists sessions and returns a session with its turns', async () => {
    for (const offset of [0, 1000]) {
      const { spans } = trace()
        .session('sess-1')
        .span({
          name: 'llm.answer',
          kind: 'llm',
          offsetMs: offset,
          llm: { inputTokens: 10, outputTokens: 5, inputMessageCount: 2 },
        })
        .build();
      await h.app.inject({
        method: 'POST',
        url: '/v1/ingest',
        payload: { service: 'svc', sessionId: 'sess-1', spans },
      });
      await h.worker.tick();
    }

    const list = (await h.app.inject({ method: 'GET', url: '/v1/sessions' })).json();
    const session = list.items.find((s: { sessionId: string }) => s.sessionId === 'sess-1');
    expect(session.traceCount).toBe(2);

    const detail = (await h.app.inject({ method: 'GET', url: '/v1/sessions/sess-1' })).json();
    expect(detail.traces).toHaveLength(2);

    const missing = await h.app.inject({ method: 'GET', url: '/v1/sessions/nope' });
    expect(missing.statusCode).toBe(404);
  });
});

// ── auth & errors ───────────────────────────────────────────────────────────

describe('authentication (FR-2.10, NFR-4.5)', () => {
  it('rejects unauthenticated requests when a key is configured', async () => {
    const secured = await harness({ ingest: { apiKey: 'super-secret-key' } });

    const denied = await secured.app.inject({ method: 'GET', url: '/v1/traces' });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe('AUTH_MISSING');
    // The configured key must never be echoed back.
    expect(JSON.stringify(denied.json())).not.toContain('super-secret-key');

    const wrong = await secured.app.inject({
      method: 'GET',
      url: '/v1/traces',
      headers: { authorization: 'Bearer wrong-key-here' },
    });
    expect(wrong.statusCode).toBe(401);

    const allowed = await secured.app.inject({
      method: 'GET',
      url: '/v1/traces',
      headers: { authorization: 'Bearer super-secret-key' },
    });
    expect(allowed.statusCode).toBe(200);

    await secured.close();
  });

  it('keeps /health and /v1/meta public so liveness never depends on a secret', async () => {
    const secured = await harness({ ingest: { apiKey: 'k' } });
    expect((await secured.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await secured.app.inject({ method: 'GET', url: '/v1/meta' })).statusCode).toBe(200);
    await secured.close();
  });
});

describe('dashboard hosting (single-origin deployment)', () => {
  it('serves the built dashboard at the root', async () => {
    // The HLD's production topology is one process serving both API and UI.
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<div id="root">');
  });

  it('falls back to the SPA shell so deep links survive a refresh', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/traces/abc123' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('keeps the JSON envelope for unknown API paths', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('does not serve HTML for non-GET requests', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns JSON 404s when UI serving is disabled', async () => {
    const apiOnly = await harness({ server: { serveUi: false } });
    const res = await apiOnly.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await apiOnly.close();
  });

  it('allows the built dashboard origin, not just the dev server', async () => {
    // Allowing only :5173 blocked the *built* UI, which is the one that ships.
    const config = configSchema.parse({});
    expect(config.server.corsOrigins).toContain('http://localhost:5173');
    expect(config.server.corsOrigins).toContain('http://localhost:4173');
  });
});

describe('trust-boundary array bounds', () => {
  it('rejects a span whose document list exceeds the cap', async () => {
    const { spans } = trace()
      .span({
        name: 'search',
        kind: 'retriever',
        retrieval: {
          indexName: 'kb',
          documents: Array.from({ length: 1001 }, (_, i) => ({ id: `d${i}`, score: 0.5 })),
        },
      })
      .build();

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: { service: 'svc', spans },
    });

    // Accepted batch, rejected span — the bound is enforced per span.
    expect(res.statusCode).toBe(202);
    expect(res.json().rejected).toBe(1);
  });

  it('accepts a document list at the cap', async () => {
    const { spans } = trace()
      .span({
        name: 'search',
        kind: 'retriever',
        retrieval: {
          indexName: 'kb',
          documents: Array.from({ length: 1000 }, (_, i) => ({ id: `d${i}`, score: 0.5 })),
        },
      })
      .build();

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/ingest',
      payload: { service: 'svc', spans },
    });
    expect(res.json().accepted).toBe(1);
  });
});

describe('error envelope (FR-6.11, FR-6.12, NFR-4.6)', () => {
  it('attaches a request id to every response', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });

  it('returns the standard envelope for an unknown route', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('omits stack traces outside dev mode', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/traces/missing-id' });
    expect(res.json().error.stack).toBeUndefined();
  });

  it('includes a stack in dev mode', async () => {
    const dev = await harness({ server: { devMode: true } });
    const res = await dev.app.inject({ method: 'GET', url: '/v1/traces/missing-id' });
    expect(res.json().error.stack).toBeTruthy();
    await dev.close();
  });
});
