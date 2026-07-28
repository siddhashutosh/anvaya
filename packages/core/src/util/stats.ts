/**
 * Statistical primitives for the L2 detector tier (HLD §7.3).
 *
 * Thresholds referenced here follow the conventions established in the drift
 * literature: PSI < 0.1 stable, 0.1-0.25 moderate, > 0.25 significant.
 */

import type { BaselineStats } from '../types/finding.js';

/** Reservoir size for raw samples retained per baseline, bounding memory. */
export const SAMPLE_RESERVOIR = 200;

export const PSI_MODERATE = 0.1;
export const PSI_SIGNIFICANT = 0.25;

/**
 * Welford's online algorithm — numerically stable single-pass mean and variance.
 * Chosen over recomputation so baselines update incrementally (FR-5.8).
 */
export class WelfordAccumulator {
  private n = 0;
  private mu = 0;
  private m2v = 0;
  private lo = Number.POSITIVE_INFINITY;
  private hi = Number.NEGATIVE_INFINITY;
  private reservoir: number[] = [];

  static fromJSON(stats: BaselineStats): WelfordAccumulator {
    const acc = new WelfordAccumulator();
    acc.n = stats.count;
    acc.mu = stats.mean;
    acc.m2v = stats.m2;
    acc.lo = stats.min;
    acc.hi = stats.max;
    acc.reservoir = [...stats.samples];
    return acc;
  }

  push(x: number): void {
    if (!Number.isFinite(x)) return;
    this.n++;
    const delta = x - this.mu;
    this.mu += delta / this.n;
    this.m2v += delta * (x - this.mu);
    if (x < this.lo) this.lo = x;
    if (x > this.hi) this.hi = x;

    this.reservoir.push(x);
    if (this.reservoir.length > SAMPLE_RESERVOIR) this.reservoir.shift();
  }

  get count(): number {
    return this.n;
  }
  get mean(): number {
    return this.mu;
  }
  get variance(): number {
    return this.n > 1 ? this.m2v / (this.n - 1) : 0;
  }
  get stddev(): number {
    return Math.sqrt(this.variance);
  }
  get samples(): readonly number[] {
    return this.reservoir;
  }

  /** Returns 0 when there is no spread — a zero-variance baseline cannot flag outliers. */
  zScore(x: number): number {
    const sd = this.stddev;
    if (sd === 0 || !Number.isFinite(sd)) return 0;
    return (x - this.mu) / sd;
  }

  toJSON(): BaselineStats {
    return {
      count: this.n,
      mean: this.mu,
      m2: this.m2v,
      min: this.n > 0 ? this.lo : 0,
      max: this.n > 0 ? this.hi : 0,
      samples: [...this.reservoir],
    };
  }
}

/**
 * Fold-based min/max.
 *
 * `Math.min(...xs)` throws RangeError past roughly 125k arguments. Span counts
 * are attacker- and bug-controlled — a runaway agent loop is exactly the trace
 * Anvaya exists to catch — so the spread form must not be used on anything
 * derived from ingested data.
 */
export function minOf(xs: readonly number[]): number {
  let lo = Number.POSITIVE_INFINITY;
  for (const x of xs) if (x < lo) lo = x;
  return lo === Number.POSITIVE_INFINITY ? 0 : lo;
}

export function maxOf(xs: readonly number[]): number {
  let hi = Number.NEGATIVE_INFINITY;
  for (const x of xs) if (x > hi) hi = x;
  return hi === Number.NEGATIVE_INFINITY ? 0 : hi;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Median absolute deviation — robust to the skew typical of latency data. */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Modified z-score using MAD. The 0.6745 constant makes it comparable to a standard z. */
export function modifiedZScore(x: number, xs: readonly number[]): number {
  const d = mad(xs);
  if (d === 0) return 0;
  return (0.6745 * (x - median(xs))) / d;
}

export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/** Equal-width histogram counts over an explicit or derived range. */
export function histogram(
  xs: readonly number[],
  bins: number,
  range?: readonly [number, number],
): number[] {
  const counts = new Array<number>(bins).fill(0);
  if (xs.length === 0 || bins <= 0) return counts;

  const lo = range ? range[0] : Math.min(...xs);
  const hi = range ? range[1] : Math.max(...xs);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) {
    counts[0] = xs.length;
    return counts;
  }

  const width = (hi - lo) / bins;
  for (const x of xs) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((x - lo) / width)));
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return counts;
}

function normalise(counts: readonly number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  return counts.map((c) => c / total);
}

const EPSILON = 1e-6;

/**
 * Population Stability Index over a shared binning of the two samples.
 *
 * Both samples are binned over the union range so the comparison is meaningful;
 * epsilon smoothing avoids log(0) on empty bins.
 */
export function psi(
  reference: readonly number[],
  current: readonly number[],
  bins = 10,
): number {
  if (reference.length === 0 || current.length === 0) return 0;

  const lo = Math.min(...reference, ...current);
  const hi = Math.max(...reference, ...current);
  const range: [number, number] = [lo, hi];

  const r = normalise(histogram(reference, bins, range));
  const c = normalise(histogram(current, bins, range));

  let total = 0;
  for (let i = 0; i < bins; i++) {
    const ri = (r[i] ?? 0) + EPSILON;
    const ci = (c[i] ?? 0) + EPSILON;
    total += (ci - ri) * Math.log(ci / ri);
  }
  return Math.abs(total);
}

/**
 * Jensen-Shannon divergence between two distributions (base 2, so bounded [0,1]).
 * Symmetric, unlike KL, which is why it is the default drift metric here.
 */
export function jensenShannon(p: readonly number[], q: readonly number[]): number {
  const len = Math.max(p.length, q.length);
  const pn = normalise(Array.from({ length: len }, (_, i) => p[i] ?? 0));
  const qn = normalise(Array.from({ length: len }, (_, i) => q[i] ?? 0));

  let divergence = 0;
  for (let i = 0; i < len; i++) {
    const pi = pn[i] ?? 0;
    const qi = qn[i] ?? 0;
    const mi = (pi + qi) / 2;
    if (mi === 0) continue;
    if (pi > 0) divergence += (pi / 2) * Math.log2(pi / mi);
    if (qi > 0) divergence += (qi / 2) * Math.log2(qi / mi);
  }
  return Math.max(0, Math.min(1, divergence));
}

/** Shannon entropy of a value distribution, normalised to [0,1]. Drives RET-007. */
export function normalisedEntropy(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const dist = normalise(values.map((v) => Math.max(0, v)));
  let h = 0;
  for (const p of dist) {
    if (p > 0) h -= p * Math.log2(p);
  }
  const maxH = Math.log2(dist.length);
  return maxH === 0 ? 0 : h / maxH;
}
