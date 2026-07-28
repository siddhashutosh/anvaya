/**
 * A fake RAG + agent application, instrumented with @anvaya/sdk.
 *
 * There is no real model call here — the point is to demonstrate the
 * instrumentation surface and to prove the two guarantees that matter most:
 *
 *   1. Instrumenting takes under 10 lines (NFR-6.1).
 *   2. With the collector STOPPED, this program still runs to completion at the
 *      same speed and with the same output (NFR-3.1, AC-8). Try it: kill the
 *      server and run this again.
 *
 * Run:  npm run example
 */

import {
  init,
  observeAgent,
  observeGuardrail,
  observeLLM,
  observeRetrieval,
  observeTool,
} from '@anvaya/sdk';

// ── 1. instrument (this is the whole setup) ─────────────────────────────────
const anvaya = init({
  endpoint: process.env.ANVAYA_ENDPOINT ?? 'http://localhost:4319',
  service: 'example-node-agent',
  environment: 'development',
  // Off by default. Turned on here so the L1 content detectors have something to
  // read — in production this is a deliberate privacy decision (ADR-0007).
  captureContent: true,
});

// ── a pretend knowledge base and toolset ────────────────────────────────────

const KB = [
  { id: 'kb-refunds', score: 0.86, content: 'Refunds are processed within 5 business days of approval. Customers must request a refund within 30 days of purchase.' },
  { id: 'kb-shipping', score: 0.61, content: 'Domestic shipping takes 2-4 business days. International shipping takes 7-14 business days.' },
  { id: 'kb-hours', score: 0.44, content: 'Support is available Monday to Friday, 9am to 5pm local time.' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchKb(query, degraded) {
  await sleep(40 + Math.random() * 60);
  // "Degraded" simulates the Barnett FP2 case: the right document is in the
  // corpus but ranks too low, which surfaces downstream as a bad answer.
  return degraded
    ? KB.map((d) => ({ ...d, score: Number((d.score * 0.45).toFixed(3)) })).reverse()
    : KB;
}

async function lookupOrder(orderId, shouldFail) {
  await sleep(60 + Math.random() * 80);
  if (shouldFail) throw new Error('ECONNRESET: order service closed the connection');
  return { orderId, status: 'delivered', deliveredAt: '2026-07-20' };
}

async function callModel({ answer, inputTokens, outputTokens, finishReason }) {
  await sleep(120 + Math.random() * 200);
  return {
    content: [{ type: 'text', text: answer }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    stop_reason: finishReason,
    model: 'claude-sonnet-5',
  };
}

// ── 2. one instrumented request ─────────────────────────────────────────────

async function handleRequest({ question, sessionId, degraded, toolFails, loops }) {
  return anvaya.trace(
    'handle-support-request',
    async (t) => {
      t.setAttribute('route', degraded ? 'refunds' : 'general');
      t.setAttribute('task.class', 'read-only');

      await observeGuardrail('input-guardrail', async () => {
        await sleep(8);
        return { passed: true };
      });

      const docs = await observeRetrieval(
        'kb.search',
        { indexName: 'support-kb', topK: 3, scoreThreshold: 0.3 },
        () => searchKb(question, degraded),
        (result) => ({ query: question, documents: result }),
      );

      const context = docs.map((d) => `[${d.id}] ${d.content}`).join('\n');

      await observeAgent(
        'support-agent',
        {
          agentName: 'support-agent',
          agentRole: 'customer support assistant',
          objective: `Answer accurately using only the knowledge base: "${question}"`,
          iteration: loops ? 8 : 1,
          maxIterations: 8,
          declaredSubtasks: ['retrieve policy', 'draft answer'],
          completedSubtasks: loops ? ['retrieve policy'] : ['retrieve policy', 'draft answer'],
          terminated: true,
          reasoningText: 'I will call lookup_order_status to confirm the order before answering.',
        },
        async () => {
          // A loop repeats the same call with identical arguments — the AGT-003
          // signature (MAST FM-1.3, the most frequent multi-agent failure).
          const attempts = loops ? 4 : 1;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
              await observeTool(
                'tool.lookup_order_status',
                {
                  toolName: 'lookup_order_status',
                  toolType: 'function',
                  arguments: JSON.stringify({ orderId: 'ORD-88213' }),
                  attempt,
                  mutating: false,
                  availableTools: ['lookup_order_status', 'escalate_to_human'],
                },
                () => lookupOrder('ORD-88213', toolFails),
                (result) => ({ toolName: 'lookup_order_status', result: JSON.stringify(result) }),
              );
              break;
            } catch (error) {
              // The SDK recorded and re-threw the ORIGINAL error — host control
              // flow is completely unchanged (ADR-0005).
              if (attempt === attempts) {
                console.log(`   tool failed after ${attempt} attempt(s): ${error.message}`);
              }
            }
          }
        },
      );

      const answer = degraded
        ? 'Refunds are issued instantly with no time limit, and you can call our 24/7 refund hotline.'
        : 'Refunds are processed within 5 business days of approval, and must be requested within 30 days of purchase.';

      const response = await observeLLM(
        'llm.answer',
        {
          provider: 'anthropic',
          requestModel: 'claude-sonnet-5',
          maxTokens: 512,
          temperature: 0.2,
          contextLimit: 200_000,
          systemInstructions:
            'You are a support assistant. Answer ONLY from the provided knowledge base excerpts.',
          inputMessages: [
            { role: 'user', content: `Knowledge base:\n${context}\n\nQuestion: ${question}` },
          ],
        },
        () =>
          callModel({
            answer,
            inputTokens: 900 + context.length / 4,
            outputTokens: 60,
            finishReason: 'end_turn',
          }),
        (result) => ({
          responseModel: result.model,
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          finishReason: result.stop_reason,
          outputMessages: [{ role: 'assistant', content: result.content[0].text }],
        }),
      );

      return response.content[0].text;
    },
    { sessionId },
  );
}

// ── 3. run a small workload ─────────────────────────────────────────────────

const SCENARIOS = [
  { label: 'healthy', question: 'How long do refunds take?', degraded: false, toolFails: false, loops: false },
  { label: 'degraded retrieval', question: 'How long do refunds take?', degraded: true, toolFails: false, loops: false },
  { label: 'tool failure + agent loop', question: 'Where is my order?', degraded: false, toolFails: true, loops: true },
  { label: 'healthy', question: 'When will my international order arrive?', degraded: false, toolFails: false, loops: false },
];

const started = Date.now();

for (const [i, scenario] of SCENARIOS.entries()) {
  const answer = await handleRequest({ ...scenario, sessionId: `example-session-${i}` });
  console.log(`\n[${scenario.label}] ${scenario.question}`);
  console.log(`   → ${answer}`);
}

await anvaya.flush();
await anvaya.shutdown();

const stats = anvaya.stats;
console.log(`\nCompleted ${SCENARIOS.length} requests in ${Date.now() - started}ms`);
console.log(
  `Anvaya: ${stats.spansRecorded} spans recorded, ${stats.sent} sent, ` +
    `${stats.failed} failed, ${stats.dropped} dropped, circuit ${stats.circuitState}`,
);

if (stats.failed > 0) {
  console.log(
    '\nThe collector was unreachable — note that every request above still completed.\n' +
      'That is the ADR-0005 guarantee: Anvaya cannot break the app it observes.',
  );
} else {
  console.log('\nOpen the dashboard and look for the "degraded retrieval" trace:');
  console.log('  RET-002 should be the ORIGIN, with GEN-004 as its symptom.');
}
