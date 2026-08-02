# Anvaya

**AI failure observability.** Anvaya instruments an AI product, ingests its execution
traces, and answers the question tracing and eval tools don't:

> **Why did it fail, and how?**

*Anvaya* (अन्वय) is Sanskrit for *the logical connection between things; the sequence that
makes a thing intelligible*.

**Live demo → [anvaya-liard.vercel.app](https://anvaya-liard.vercel.app)** — real seeded
traffic with injected failures. It is read-only: the demo refuses spans so its database
stays a shop window. Run it locally to ingest your own.

```
┌──────────────┐   spans   ┌────────────────────────────┐        ┌───────────┐
│  your AI app │──────────▶│  ingest → detect → attribute│───────▶│ dashboard │
│  + @anvaya/sdk│           │  56 named failure modes    │        │  triage   │
└──────────────┘           └────────────────────────────┘        └───────────┘
```

---

## The problem

Traditional software fails loudly: a 500, a stack trace, a p99 spike. An AI product's
worst failures return **HTTP 200 with a confident, well-formatted, wrong answer**.

| Signal | Traditional bug | AI failure |
|---|---|---|
| HTTP status | 500 | **200** |
| Exception thrown | yes | **no** |
| Latency | spike | **normal** |
| Output shape | malformed | **perfectly valid JSON** |
| Actually correct | — | **no** |

Every classical monitor is green while the product is failing its users.

## What Anvaya does differently

Langfuse, Phoenix, Helicone and Braintrust all do two things well: **tracing** (what
happened) and **evaluation** (was the output good). Neither is diagnosis.

Anvaya adds the third thing:

1. **A named, research-grounded failure taxonomy** — 56 modes, not freeform scores.
2. **Detectors that map evidence to taxonomy codes**, cheapest tier first.
3. **Causal attribution across the span tree** — a bad answer points at the *retrieval
   step that caused it*, not at itself.

The result is not "confidence 0.62". It is:

```
Incident #47   RET-002 Retrieval quality collapse
  origin       span kb.search        confidence 0.92 (confirmed)
  symptoms     GEN-004 ungrounded claim ×31, GEN-008 wrong answer ×12
  cohort       route=refunds fires 8.4× base rate  (hypothesis)
  remediation  reranker misconfigured, chunk-size mismatch, or a query-document
               vocabulary gap. Check reranker top-k and chunking strategy.
```

---

## Quick start

Needs **Node.js ≥ 20**. No Docker, no external database, no API key.

```bash
npx @anvaya/server      # collector + dashboard on :4319
```

Or from source, which also gets you the seed data:

```bash
npm install
npm run build
npm run seed            # 150 demo traces with injected failures (optional)
npm start               # collector + dashboard together on :4319
```

Open <http://localhost:4319>. The server hosts the dashboard itself — one process, one
port, no CORS. With seeded data, go to **Traces → any trace with findings** and look at
the **Diagnosis** card.

For live reload while developing:

```bash
npm run dev             # collector on :4319, Vite dashboard on :5173
```

Run the instrumented example app against it:

```bash
npm run example
```

Then **stop the collector and run it again** — every request still completes at the same
speed. That is **ADR-0005**: Anvaya cannot break the app
it observes.

## Instrumenting your app

### Getting the SDK

```bash
npm install @anvaya/sdk
```

[![npm](https://img.shields.io/npm/v/@anvaya/sdk)](https://www.npmjs.com/package/@anvaya/sdk)
— Node.js ≥ 20. Pulls in [`@anvaya/core`](https://www.npmjs.com/package/@anvaya/core), which
carries the taxonomy and shared types.

You'll also need a collector running to receive the spans — see [Quick start](#quick-start)
above. Or skip the SDK entirely and post OpenTelemetry spans to `/v1/ingest`; see the note
below the example.

### Then, under ten lines

```ts
import { init, observeLLM, observeRetrieval } from '@anvaya/sdk';

const anvaya = init({ endpoint: 'http://localhost:4319', service: 'my-app' });

await anvaya.trace('handle-request', async () => {
  const docs = await observeRetrieval('search', { indexName: 'kb' },
    () => store.search(query), (r) => ({ documents: r }));

  return observeLLM('answer', { provider: 'anthropic', requestModel: 'claude-opus-5' },
    () => client.messages.create({ ... }), extractAnthropic);
});
```

Already emitting OpenTelemetry? Post to `/v1/ingest` with `format: "otel-genai"` or
`"openinference"` instead — no SDK required.

---

## The failure taxonomy

**56 modes across 8 families**, covering all 14 [MAST](https://arxiv.org/abs/2503.13657)
modes, all 7 [Barnett](https://arxiv.org/pdf/2401.05856) RAG failure points, and 6
[OWASP LLM Top 10 (2025)](https://genai.owasp.org/llm-top-10/) entries.

| Family | Modes | Concern |
|---|---|---|
| `INF` | 6 | The plumbing broke |
| `CTX` | 5 | What went into the model was wrong |
| `RET` | 7 | The facts never arrived |
| `GEN` | 8 | The model produced a bad answer |
| `AGT` | 12 | The control flow went wrong |
| `TOL` | 6 | The action layer failed |
| `SEC` | 6 | Somebody is being harmed or attacked |
| `ECO` | 6 | It is getting worse or more expensive |

Full catalog: **docs/04-failure-taxonomy.md**, or browse it in
the dashboard's **Taxonomy** view.

### Two analysis scopes

Most modes are observable inside one trace. Two are not:

| Mode | MAST | Why a trace is the wrong unit |
|---|---|---|
| `CTX-003` | FM-1.4 | *Loss of conversation history* is defined **across turns** |
| `CTX-004` | FM-2.1 | *Conversation reset* is defined **across turns** |

In a real chat application each user turn is its own trace, so a trace-scoped
detector never sees two turns together. Anvaya therefore analyses **sessions** as
well — comparing each trace against its immediate predecessor. This works with
content capture off, because message *counts* are metadata, not content.
See **ADR-0008**.

## Tiered detection

Detection runs cheapest-first. This is not just frugality — it follows from the data:

| MAST mode | Frequency | Cheapest detection |
|---|---|---|
| FM-1.3 Step repetition | **17.14%** | L0 — a cycle in the span tree |
| FM-2.6 Reasoning-action mismatch | **13.98%** | L1 — set difference on tool names |
| FM-2.2 Fail to ask for clarification | **11.65%** | L1 — pattern match |

**The most common failures are the cheapest to catch.** Paying an LLM to detect a graph
cycle is indefensible.

| Tier | Mechanism | Cost | Default |
|---|---|---|---|
| **L0** Structural | span tree, status, timings, cycles | ~0 | **on** |
| **L1** Heuristic | regex, schema, token overlap, set ops | ~0 | **on** |
| **L2** Statistical | PSI / JS drift, z-score, MAD | ~0 | **on** |
| **L3** Judge | LLM-as-judge | **billed** | **off** |

L0–L2 cover **43 of the 56 modes**. With no API key configured, L3 reports
`skipped:unconfigured` — an informational outcome, never an error.

## Confidence is never hidden

Every finding renders a qualitative band — **possible** (< 0.5), **likely** (0.5–0.8),
**confirmed** (> 0.8). A lexical-overlap groundedness check caps at 0.75 and *cannot*
present as confirmed. False-positive fatigue is the fastest way to kill an observability
tool, so heuristics are never laundered as facts.

---

## Deploying

Anvaya runs in two shapes. The code is identical; only the host differs.

| | **Self-hosted** | **Serverless** |
|---|---|---|
| Storage | SQLite file | Postgres (Neon) |
| Ingest | queue + background worker | analysed inline, in the request |
| Maintenance | `setInterval` | cron → `/v1/maintenance/sweep` |
| Config | *(default)* | `DATABASE_URL` + `ANVAYA_INGEST_MODE=inline` |

```bash
vercel deploy --prod          # dashboard + API, one project
```

Without a `DATABASE_URL` the deployment falls back to SQLite in `/tmp` — fully
working but **ephemeral**, and `/v1/meta` reports
`deployment.ephemeralStorage: true` so nothing pretends otherwise. Attach a Neon
database and set `DATABASE_URL` to make it durable; no other change is needed.

Why the rearchitecting was necessary — and what it cost — is in
**ADR-0009**.

## Project layout

```
anvaya/
├── packages/
│   ├── core/                 types · taxonomy · errors · logging · redaction
│   ├── sdk/                  tracer · spans · resilient transport
│   ├── server/               ingest · detectors · analysis · storage · API
│   └── ui/                   React dashboard  (its own package)
├── examples/node-agent/      runnable instrumented demo
└── scripts/
```

Dependency direction is acyclic and enforced: `ui → server → core`, `sdk → core`.

## Design record

The full engineering record — design document, SRS, HLD, LLD, the 56-mode failure
taxonomy and nine ADRs — is maintained but kept out of this repository. Available
on request.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Build every package |
| `npm run build:libs` | Build core, sdk, server (skip the UI bundle) |
| `npm test` | Run the full test suite (238 tests) |
| `npm run typecheck` | Strict typecheck across all packages |
| `npm run lint` | ESLint |
| `npm run dev` | Collector + dashboard together |
| `npm run seed -- --traces 500` | Seed a larger demo dataset |
| `npm start` | Production server |
| `npm run example` | Run the instrumented example app |

## Configuration

Defaults → `anvaya.config.json` → environment, validated at startup. Everything runs with
zero configuration; the common environment variables are:

| Variable | Default | Purpose |
|---|---|---|
| `ANVAYA_PORT` | `4319` | Collector port |
| `ANVAYA_DB_PATH` | `./data/anvaya.db` | SQLite file |
| `ANVAYA_API_KEY` | *(none)* | Shared ingest/read key; unauthenticated with a startup warning if unset. **Set `VITE_ANVAYA_API_KEY` to match**, or the dashboard 401s |
| `ANVAYA_INGEST_ACCEPT_WRITES` | `true` | Set `false` for a read-only instance: `/v1/ingest` returns 403, reads still work |
| `ANVAYA_LOG_LEVEL` | `info` | `trace`…`fatal` |
| `ANVAYA_JUDGE_ENABLED` | `false` | Enable the billed L3 tier |
| `ANVAYA_JUDGE_BASE_URL` | Anthropic | Point the judge at a gateway or proxy |
| `ANTHROPIC_API_KEY` | *(none)* | Judge credential (also needs the flag above — a key alone is not consent to spend) |

Full list with comments: [`.env.example`](.env.example).

Detector thresholds are configurable per detector — see
[`config/schema.ts`](packages/server/src/config/schema.ts).

## Privacy

- **Content capture is off by default.** L0 and L2 detection work fully on metadata alone.
- **Redaction runs in your process, before transport** — API keys, bearer tokens, private
  keys, AWS keys, JWTs, emails, phone numbers, Luhn-valid card numbers, SSNs — then again
  server-side as defence in depth.
- **Security findings record the secret *class*, never the value.** A finding that quotes
  the secret has re-created the exposure it is reporting.

See **ADR-0007**.

## What this is not

Not an LLM gateway or proxy (Anvaya never sits in your request path). Not a prompt-management
platform. Not an offline eval harness — an eval harness gates quality *before* merge, on
examples you chose in advance; Anvaya explains what production actually does, on traffic
you never anticipated. They are complementary.

## References

1. Cemri et al., **Why Do Multi-Agent LLM Systems Fail?** [arXiv:2503.13657](https://arxiv.org/abs/2503.13657)
2. Barnett et al., **Seven Failure Points When Engineering a RAG System.** CAIN 2024, [arXiv:2401.05856](https://arxiv.org/pdf/2401.05856)
3. **A Systematic Taxonomy of Failure Modes in RAG Systems.** [TrustNLP 2026](https://aclanthology.org/2026.trustnlp-main.27/)
4. **OpenTelemetry GenAI semantic conventions.** [opentelemetry.io](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
5. **OpenInference specification.** [Arize](https://arize-ai.github.io/openinference/spec/semantic_conventions.html)
6. Farquhar et al., **Detecting hallucinations using semantic entropy.** Nature, 2024
7. **OWASP Top 10 for LLM Applications 2025.** [genai.owasp.org](https://genai.owasp.org/llm-top-10/)
8. **Methods to detect drift in ML embeddings.** [Evidently AI](https://www.evidentlyai.com/blog/embedding-drift-detection)

## Licence

**Apache License 2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Apache rather than MIT for the patent grant: contributors grant an express patent
licence, and it terminates for anyone who brings a patent suit over the work. It also
requires modified files to say they were changed, and does not grant rights to the
Anvaya name.
