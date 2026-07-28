/**
 * Primitive vocabulary shared across every Anvaya package.
 *
 * Timestamps are epoch milliseconds (DR-2); durations are milliseconds (DR-3);
 * costs are USD (DR-4).
 */

/** Attribute values are scalars or scalar arrays. Nested objects are serialised (DR-5). */
export type AttributeValue = string | number | boolean | readonly string[] | readonly number[];

export type AttributeMap = Readonly<Record<string, AttributeValue>>;

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type DetectorTier = 'L0' | 'L1' | 'L2' | 'L3';

/** Ordering used whenever severities must be compared. Higher is worse. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});

export const TIER_ORDER: readonly DetectorTier[] = Object.freeze(['L0', 'L1', 'L2', 'L3'] as const);

export function maxSeverity(a: Severity | undefined, b: Severity | undefined): Severity | undefined {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export interface TimeRange {
  readonly from: number;
  readonly to: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly nextCursor?: string;
}

/**
 * Qualitative confidence bands (FR-7.9). A heuristic finding must never be
 * presented with the same weight as a deterministic one, so every surface that
 * shows a finding renders its band.
 */
export const CONFIDENCE_BANDS = Object.freeze({
  possible: Object.freeze({ min: 0, max: 0.5 }),
  likely: Object.freeze({ min: 0.5, max: 0.8 }),
  confirmed: Object.freeze({ min: 0.8, max: 1.01 }),
});

export type ConfidenceBand = keyof typeof CONFIDENCE_BANDS;

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= CONFIDENCE_BANDS.confirmed.min) return 'confirmed';
  if (confidence >= CONFIDENCE_BANDS.likely.min) return 'likely';
  return 'possible';
}
