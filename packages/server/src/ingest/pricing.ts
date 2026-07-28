/**
 * Model pricing, used to derive cost when the SDK did not supply it (DR-4).
 *
 * Prices are USD per million tokens. This table is a convenience, not a billing
 * source of truth — the version is recorded on every cost so a stale table is
 * detectable rather than silently wrong.
 */

export const PRICING_VERSION = '2026-07';

interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
}

/** Matched by longest prefix, so `claude-opus-5-20260101` resolves to `claude-opus-5`. */
const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-fable-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1': { input: 2, output: 8 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
};

export function priceFor(model: string | undefined): Price | undefined {
  if (!model) return undefined;
  const normalised = model.toLowerCase();

  let best: Price | undefined;
  let bestLength = 0;
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (normalised.startsWith(prefix) && prefix.length > bestLength) {
      best = price;
      bestLength = prefix.length;
    }
  }
  return best;
}

export function estimateCostUsd(
  model: string | undefined,
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
): number {
  const price = priceFor(model);
  if (!price) return 0;

  const billableInput = Math.max(0, inputTokens - cacheReadTokens);
  const cacheRate = price.cacheRead ?? price.input;

  return (
    (billableInput * price.input) / 1_000_000 +
    (cacheReadTokens * cacheRate) / 1_000_000 +
    (outputTokens * price.output) / 1_000_000
  );
}
