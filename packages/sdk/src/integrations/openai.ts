/**
 * OpenAI-shaped client instrumentation (FR-1.17).
 *
 * Structurally typed against the Chat Completions response; no dependency on the
 * provider package.
 */

import type { LlmPayload } from '@anvaya/core';
import { observeLLM, type LlmMeta } from '../observe.js';

interface OpenAiUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
}

interface OpenAiChoice {
  readonly finish_reason?: string | null;
  readonly message?: {
    readonly content?: string | null;
    readonly tool_calls?: readonly {
      readonly id?: string;
      readonly function?: { readonly name?: string; readonly arguments?: string };
    }[];
  };
}

export interface OpenAiChatResponse {
  readonly id?: string;
  readonly model?: string;
  readonly usage?: OpenAiUsage;
  readonly choices?: readonly OpenAiChoice[];
}

export function extractOpenAi(response: OpenAiChatResponse): Partial<LlmPayload> {
  const choice = response.choices?.[0];
  const content = choice?.message?.content ?? '';
  const toolCalls = (choice?.message?.tool_calls ?? []).map((tc) => ({
    ...(tc.id ? { id: tc.id } : {}),
    name: tc.function?.name ?? 'unknown',
    ...(tc.function?.arguments ? { arguments: tc.function.arguments } : {}),
  }));

  return {
    provider: 'openai',
    ...(response.model ? { responseModel: response.model } : {}),
    ...(response.usage?.prompt_tokens !== undefined
      ? { inputTokens: response.usage.prompt_tokens }
      : {}),
    ...(response.usage?.completion_tokens !== undefined
      ? { outputTokens: response.usage.completion_tokens }
      : {}),
    ...(response.usage?.prompt_tokens_details?.cached_tokens !== undefined
      ? { cacheReadTokens: response.usage.prompt_tokens_details.cached_tokens }
      : {}),
    ...(response.usage?.completion_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: response.usage.completion_tokens_details.reasoning_tokens }
      : {}),
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    ...(content || toolCalls.length > 0
      ? {
          outputMessages: [
            {
              role: 'assistant' as const,
              content,
              ...(toolCalls.length > 0 ? { toolCalls } : {}),
            },
          ],
        }
      : {}),
  };
}

export function observeOpenAi<T extends OpenAiChatResponse>(
  name: string,
  meta: LlmMeta,
  fn: () => Promise<T>,
): Promise<T> {
  return observeLLM(name, { provider: 'openai', ...meta }, fn, extractOpenAi);
}
