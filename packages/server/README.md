# @anvaya/server

The **[Anvaya](https://github.com/siddhashutosh/anvaya)** collector — ingest, detection,
causal attribution, storage, API, and the dashboard, in one process on one port.

```bash
npx @anvaya/server
```

Then open <http://localhost:4319>. Requires Node.js ≥ 20. No Docker, no external database,
no API key.

Instrument your app with [`@anvaya/sdk`](https://www.npmjs.com/package/@anvaya/sdk) and
point it at that endpoint.

## What it does

Traditional software fails loudly. An AI product's worst failures return **HTTP 200** with
a confident, well-formatted, wrong answer — no exception, normal latency, valid JSON.

Anvaya names the failure from a **56-mode taxonomy** and attributes it to the span that
*caused* it, rather than the span where you noticed it:

```
Incident #47   RET-002 Retrieval quality collapse
  origin       span kb.search      confidence 0.92 (confirmed)
  symptoms     GEN-004 ungrounded claim ×31, GEN-008 wrong answer ×12
  remediation  reranker misconfigured, chunk-size mismatch, or a
               query-document vocabulary gap
```

You fix one thing instead of twelve.

## Detection tiers

| Tier | Mechanism | Cost | Default |
|---|---|---|---|
| **L0** Structural | span tree, status, timings, cycles | ~0 | **on** |
| **L1** Heuristic | regex, schema, token overlap, set ops | ~0 | **on** |
| **L2** Statistical | PSI / JS drift, z-score, MAD | ~0 | **on** |
| **L3** Judge | LLM-as-judge | **billed** | **off** |

**43 of the 56 modes are detected with zero model calls.** L3 is off by default — an API
key alone is not consent to spend. Without it, L3 reports `skipped:unconfigured`, an
informational outcome and never an error.

## Commands

```bash
npx @anvaya/server            # serve (default)
npx @anvaya/server --help     # all commands
```

## Configuration

Everything runs with zero configuration. Common environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ANVAYA_PORT` | `4319` | Collector port |
| `ANVAYA_DB_PATH` | `./data/anvaya.db` | SQLite file |
| `DATABASE_URL` | *(none)* | Postgres connection; switches storage driver |
| `ANVAYA_API_KEY` | *(none)* | Shared ingest/read key; unauthenticated with a warning if unset |
| `ANVAYA_INGEST_ACCEPT_WRITES` | `true` | Set `false` for a read-only instance |
| `ANVAYA_JUDGE_ENABLED` | `false` | Enable the billed L3 tier |
| `ANVAYA_LOG_LEVEL` | `info` | `trace`…`fatal` |

## Ingest without the SDK

Already emitting OpenTelemetry? POST straight to the collector — `otel-genai` and
`openinference` are both accepted:

```
POST /v1/ingest    { "format": "otel-genai", "service": "...", "spans": [ ... ] }
```

## Licence

Apache-2.0 — see [LICENSE](./LICENSE).
