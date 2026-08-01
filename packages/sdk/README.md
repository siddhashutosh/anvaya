# @anvaya/sdk

Instrumentation SDK for **[Anvaya](https://github.com/siddhashutosh/anvaya)** — AI failure
observability. It captures execution traces from an AI application and ships them to an
Anvaya collector, which names the failure and attributes it to the span that caused it.

```bash
npm install @anvaya/sdk
```

Requires Node.js ≥ 20.

## Usage

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

You need a collector running to receive the spans:

```bash
git clone https://github.com/siddhashutosh/anvaya.git
cd anvaya && npm install && npm run build && npm start
```

The dashboard is served by the same process on `http://localhost:4319`.

## Design guarantees

**The SDK cannot break the app it observes.** It never throws and never blocks. If the
collector is down, slow, or was never started, your request completes at exactly the same
speed and spans are dropped rather than queued without bound. Stop the collector mid-run
and nothing changes for your users.

**Content capture is off by default.** Metadata alone — token counts, latencies, span
shape, tool names — drives structural and statistical detection. Turn content capture on
only if you want the heuristic and judge tiers to inspect text.

**Redaction runs in your process, before transport.** API keys, bearer tokens, private
keys, AWS keys, JWTs, emails, phone numbers, Luhn-valid card numbers and SSNs are removed
before anything leaves your machine, then again server-side as defence in depth.

## Not using this SDK?

You don't need it. If you already emit OpenTelemetry, POST straight to the collector:

```
POST /v1/ingest    { "format": "otel-genai", "service": "...", "spans": [ ... ] }
```

`otel-genai` and `openinference` are both accepted.

## Licence

Apache-2.0 — see [LICENSE](./LICENSE).
