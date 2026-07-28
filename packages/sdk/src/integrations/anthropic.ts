/**
 * Anthropic-shaped client instrumentation (FR-1.17).
 *
 * Structurally typed against the Messages API response rather than importing the
 * SDK, so `@anvaya/sdk` takes no dependency on any provider package.
 */

import type { LlmPayload } from '@anvaya/core';
import { observeLLM, type LlmMeta } from '../observe.js';

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface AnthropicContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly name?: string;
}

export interface AnthropicMessageResponse {
  readonly id?: string;
  readonly model?: string;
  readonly stop_reason?: string | null;
  readonly usage?: AnthropicUsage;
  readonly content?: readonly AnthropicContentBlock[];
}

/** Map an Anthropic response into the internal LLM payload. */
export function extractAnthropic(response: AnthropicMessageResponse): Partial<LlmPayload> {
  const text = (response.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('\n');

  // Thinking blocks become reasoningText, which is what AGT-006
  // (reasoning-action mismatch, MAST FM-2.6) compares against tool calls.
  const reasoning = (response.content ?? [])
    .filter((b) => b.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking ?? '')
    .join('\n');

  return {
    provider: 'anthropic',
    ...(response.model ? { responseModel: response.model } : {}),
    ...(response.usage?.input_tokens !== undefined
      ? { inputTokens: response.usage.input_tokens }
      : {}),
    ...(response.usage?.output_tokens !== undefined
      ? { outputTokens: response.usage.output_tokens }
      : {}),
    ...(response.usage?.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: response.usage.cache_read_input_tokens }
      : {}),
    ...(response.usage?.cache_creation_input_tokens !== undefined
      ? { cacheCreationTokens: response.usage.cache_creation_input_tokens }
      : {}),
    ...(response.stop_reason ? { finishReason: response.stop_reason } : {}),
    ...(text ? { outputMessages: [{ role: 'assistant' as const, content: text }] } : {}),
    ...(reasoning ? { reasoningText: reasoning } : {}),
  };
}

/** Wrap an Anthropic `messages.create` call in an instrumented span. */
export function observeAnthropic<T extends AnthropicMessageResponse>(
  name: string,
  meta: LlmMeta,
  fn: () => Promise<T>,
): Promise<T> {
  return observeLLM(name, { provider: 'anthropic', ...meta }, fn, extractAnthropic);
}
