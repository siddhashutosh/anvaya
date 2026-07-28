/**
 * The L3 judge tier (ADR-0003, FR-3.13, FR-3.14).
 *
 * Off by default. Every gate below must pass before a single token is spent, and
 * with no API key configured the tier reports `skipped:unconfigured` — an
 * informational outcome, never an error (AC-12).
 */

import {
  AnvayaError,
  ERROR_CODES,
  err,
  ok,
  withTimeout,
  type Logger,
  type Result,
} from '@anvaya/core';
import type { JudgeConfig } from '../../config/schema.js';

export interface JudgeRequest {
  readonly question: string;
  readonly context: string;
  readonly output: string;
  readonly rubric: string;
  readonly maxTokens?: number;
}

export interface JudgeVerdict {
  /** true means the failure the detector asked about IS present. */
  readonly verdict: boolean;
  readonly confidence: number;
  readonly rationale: string;
  readonly tokensUsed: number;
}

export interface JudgeProvider {
  readonly name: string;
  judge(request: JudgeRequest): Promise<Result<JudgeVerdict, AnvayaError>>;
  readonly remainingBudget: number;
}

interface AnthropicResponse {
  readonly content?: readonly { type: string; text?: string }[];
  readonly usage?: { input_tokens?: number; output_tokens?: number };
}

const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator of AI system behaviour inside an observability tool.
You will be given a rubric, the input context, and the system's output.
Decide whether the failure described by the rubric IS PRESENT.

Default to "not present" when the evidence is ambiguous: a false positive in an
observability tool costs a human an investigation and erodes trust in every other
finding.

Respond with ONLY a JSON object, no prose and no code fence:
{"verdict": boolean, "confidence": number between 0 and 1, "rationale": "one or two sentences"}`;

export class AnthropicJudge implements JudgeProvider {
  readonly name = 'anthropic';
  private spent = 0;

  constructor(
    private readonly config: JudgeConfig,
    private readonly logger: Logger,
    private readonly apiKey: string,
  ) {}

  get remainingBudget(): number {
    return Math.max(0, this.config.dailyTokenBudget - this.spent);
  }

  async judge(request: JudgeRequest): Promise<Result<JudgeVerdict, AnvayaError>> {
    const estimate = request.maxTokens ?? this.config.maxTokensPerTrace;
    if (this.remainingBudget < estimate) {
      return err(
        new AnvayaError('judge daily token budget exhausted', {
          code: ERROR_CODES.JUDGE_BUDGET_EXCEEDED,
          category: 'detector',
          context: { spent: this.spent, budget: this.config.dailyTokenBudget },
        }),
      );
    }

    const userPrompt = [
      `RUBRIC:\n${request.rubric}`,
      `QUESTION/INPUT:\n${truncate(request.question, 4000)}`,
      `CONTEXT PROVIDED TO THE SYSTEM:\n${truncate(request.context, 8000)}`,
      `SYSTEM OUTPUT:\n${truncate(request.output, 6000)}`,
    ].join('\n\n---\n\n');

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`;

    try {
      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.config.model,
            max_tokens: 512,
            system: JUDGE_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }],
          }),
        }),
        this.config.timeoutMs,
        () =>
          new AnvayaError('judge request timed out', {
            code: ERROR_CODES.JUDGE_UNAVAILABLE,
            category: 'detector',
            retryable: true,
          }),
      );

      if (!response.ok) {
        return err(
          new AnvayaError(`judge provider returned ${response.status}`, {
            code: ERROR_CODES.JUDGE_UNAVAILABLE,
            category: 'detector',
            retryable: response.status >= 500,
            context: { status: response.status },
          }),
        );
      }

      const body = (await response.json()) as AnthropicResponse;
      const tokensUsed = (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0);
      this.spent += tokensUsed;

      const text = (body.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');

      const parsed = parseVerdict(text);
      if (!parsed) {
        return err(
          new AnvayaError('judge returned unparseable output', {
            code: ERROR_CODES.JUDGE_UNAVAILABLE,
            category: 'detector',
            context: { excerpt: text.slice(0, 200) },
          }),
        );
      }

      return ok({ ...parsed, tokensUsed });
    } catch (e) {
      this.logger.warn('judge call failed', { err: e });
      return err(
        AnvayaError.from(e, {
          code: ERROR_CODES.JUDGE_UNAVAILABLE,
          category: 'detector',
          retryable: true,
        }),
      );
    }
  }
}

function parseVerdict(text: string): Omit<JudgeVerdict, 'tokensUsed'> | undefined {
  // Models occasionally wrap JSON in a fence despite instructions.
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return undefined;
  try {
    const raw = JSON.parse(match[0]) as {
      verdict?: unknown;
      confidence?: unknown;
      rationale?: unknown;
    };
    if (typeof raw.verdict !== 'boolean') return undefined;
    return {
      verdict: raw.verdict,
      confidence:
        typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0.5,
      rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
    };
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

/**
 * Build a judge provider, or undefined when the tier is not fully configured.
 * Returning undefined rather than throwing is what makes L3 absence a skip
 * rather than a failure.
 */
export function createJudge(config: JudgeConfig, logger: Logger): JudgeProvider | undefined {
  if (!config.enabled) return undefined;
  if (config.provider !== 'anthropic') return undefined;
  if (!config.apiKey) {
    logger.warn('judge tier is enabled but no API key is configured; L3 detectors will be skipped');
    return undefined;
  }
  return new AnthropicJudge(config, logger, config.apiKey);
}
