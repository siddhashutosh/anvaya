/**
 * @anvaya/sdk — instrumentation for AI applications.
 *
 * Minimal usage (NFR-6.1, under 10 lines):
 *
 *   import { init, observeLLM, observeRetrieval } from '@anvaya/sdk';
 *
 *   const anvaya = init({ endpoint: 'http://localhost:4319', service: 'my-app' });
 *
 *   await anvaya.trace('handle-request', async () => {
 *     const docs = await observeRetrieval('search', { indexName: 'kb' },
 *       () => store.search(q), (r) => ({ documents: r }));
 *     return observeLLM('answer', { provider: 'anthropic', requestModel: 'claude-opus-5' },
 *       () => client.messages.create({ ... }), extractAnthropic);
 *   });
 */

import { AnvayaClient, type SdkConfig } from './client.js';
import { clearClient, getClient, setClient } from './registry.js';

export { AnvayaClient } from './client.js';
export type { SdkConfig, SdkStats, SpanOptions, TraceHandle, TraceOptions } from './client.js';
export { SpanBuilder } from './span.js';
export type { SpanBuilderOptions } from './span.js';
export { getContext, runInContext, type SpanContext } from './context.js';
export { getClient } from './registry.js';
export { safely, safelyAsync, type ErrorHook } from './safely.js';

export {
  observeAgent,
  observeChain,
  observeEmbedding,
  observeGuardrail,
  observeLLM,
  observeReranker,
  observeRetrieval,
  observeTool,
} from './observe.js';
export type { AgentMeta, LlmMeta, RetrievalMeta, ToolMeta } from './observe.js';

export { CircuitBreaker } from './transport/circuit-breaker.js';
export type { CircuitBreakerOptions, CircuitState } from './transport/circuit-breaker.js';
export { BatchProcessor } from './transport/batch-processor.js';
export type { BatchProcessorOptions, BatchStats } from './transport/batch-processor.js';
export { HttpTransport } from './transport/http-transport.js';
export type { Transport, TransportPayload, HttpTransportOptions } from './transport/http-transport.js';

export { extractAnthropic, observeAnthropic } from './integrations/anthropic.js';
export type { AnthropicMessageResponse } from './integrations/anthropic.js';
export { extractOpenAi, observeOpenAi } from './integrations/openai.js';
export type { OpenAiChatResponse } from './integrations/openai.js';

/**
 * Initialise the SDK and register it as the process-wide active client.
 * Calling init twice replaces the client; the previous one is shut down.
 */
export function init(config: SdkConfig): AnvayaClient {
  const existing = getClient();
  if (existing) void existing.shutdown();

  const client = new AnvayaClient(config);
  setClient(client);
  return client;
}

/** Flush and detach the active client. Safe to call when none exists. */
export async function shutdown(): Promise<void> {
  const client = getClient();
  if (!client) return;
  await client.shutdown();
  clearClient();
}
