/**
 * L2 statistical detectors â€” INF-005, RET-002, RET-004, RET-007, TOL-006, ECO-002, ECO-003.
 *
 * This is the tier that catches the failure mode per-request checks cannot see:
 * gradual degradation. Every detector here requires a baseline and emits nothing
 * rather than a low-quality finding when it lacks one (FR-3.12).
 *
 * Drift thresholds follow the standard convention â€” PSI < 0.1 stable,
 * 0.1-0.25 moderate, > 0.25 significant â€” and are configurable.
 */

import {
  jensenShannon,
  normalisedEntropy,
  psi,
  type Evidence,
  type Finding,
  type SpanRecord,
} from '@anvaya/core';
import { evidence, finding, type DetectionContext, type Detector } from '../types.js';

function zEvidence(observed: number, stats: { mean: number; count: number }): Evidence {
  return {
    label: 'observed',
    value: Number(observed.toFixed(3)),
    comparison: {
      baseline: Number(stats.mean.toFixed(3)),
      delta: Number((observed - stats.mean).toFixed(3)),
      samples: stats.count,
    },
  };
}

function stddevOf(stats: { m2: number; count: number }): number {
  return stats.count > 1 ? Math.sqrt(stats.m2 / (stats.count - 1)) : 0;
}

function zScore(value: number, stats: { mean: number; m2: number; count: number }): number {
  const sd = stddevOf(stats);
  if (sd === 0) return 0;
  return (value - stats.mean) / sd;
}

export const latencyOutlierDetector: Detector = {
  id: 'inf.latency-outlier',
  tier: 'L2',
  emits: ['INF-005'],
  cost: 'free',
  requiresBaseline: true,
  description: 'Span duration far above its rolling baseline.',
  supports: (t) => t.byKind.llm.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.llm) {
      const stats = ctx.baselines.get('llm.duration_ms', span.llm?.requestModel ?? 'unknown');
      if (!stats || stats.count < ctx.config.minBaselineSamples) continue;

      const z = zScore(span.durationMs, stats);
      if (z < ctx.thresholds.zScore) continue;

      out.push(
        finding({
          ctx,
          detector: latencyOutlierDetector,
          code: 'INF-005',
          spanId: span.spanId,
          confidence: Math.min(0.9, 0.5 + 0.05 * z),
          detail: `"${span.name}" took ${Math.round(span.durationMs)}ms against a baseline of ${Math.round(stats.mean)}ms (z=${z.toFixed(1)}).`,
          evidence: [
            zEvidence(span.durationMs, stats),
            evidence('zScore', Number(z.toFixed(2))),
            evidence('model', span.llm?.requestModel ?? 'unknown'),
            evidence('outputTokens', span.llm?.outputTokens ?? 0),
          ],
        }),
      );
    }
    return out;
  },
};

/**
 * RET-002 Â· Retrieval quality collapse â€” Barnett FP2, the origin of a great many
 * failures that surface as hallucination.
 */
export const retrievalQualityDetector: Detector = {
  id: 'ret.quality-collapse',
  tier: 'L2',
  emits: ['RET-002'],
  cost: 'free',
  requiresBaseline: true,
  description: 'Top-k relevance scores materially below baseline (Barnett FP2).',
  supports: (t) =>
    t.byKind.retriever.some((s) => (s.retrieval?.documents ?? []).some((d) => d.score !== undefined)),
  async run(ctx) {
    const out: Finding[] = [];

    for (const span of ctx.trace.byKind.retriever) {
      const scores = (span.retrieval?.documents ?? [])
        .map((d) => d.score)
        .filter((s): s is number => typeof s === 'number');
      if (scores.length === 0) continue;

      const scope = span.retrieval?.indexName ?? 'default';
      const stats = ctx.baselines.get('retrieval.top1_score', scope);
      if (!stats || stats.count < ctx.config.minBaselineSamples) continue;

      const top1 = Math.max(...scores);
      const z = zScore(top1, stats);
      // Only a collapse matters; an unusually good retrieval is not a failure.
      if (z > -ctx.thresholds.retrievalScoreZ) continue;

      out.push(
        finding({
          ctx,
          detector: retrievalQualityDetector,
          code: 'RET-002',
          spanId: span.spanId,
          confidence: Math.min(0.95, 0.6 + 0.05 * Math.abs(z)),
          detail: `Top-1 relevance was ${top1.toFixed(2)} against a baseline of ${stats.mean.toFixed(2)} over ${stats.count} samples. The answer may be in the corpus but ranking too low â€” check reranker top-k, chunking strategy, and query-document vocabulary gap.`,
          evidence: [
            zEvidence(top1, stats),
            evidence('zScore', Number(z.toFixed(2))),
            evidence('meanTopK', Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3))),
            evidence('index', scope),
            evidence('documentsReturned', scores.length),
          ],
        }),
      );
    }
    return out;
  },
};

export const retrievalLatencyDetector: Detector = {
  id: 'ret.latency-degradation',
  tier: 'L2',
  emits: ['RET-004'],
  cost: 'free',
  requiresBaseline: true,
  description: 'Retrieval duration far above its rolling baseline.',
  supports: (t) => t.byKind.retriever.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.retriever) {
      const scope = span.retrieval?.indexName ?? 'default';
      const stats = ctx.baselines.get('retrieval.duration_ms', scope);
      if (!stats || stats.count < ctx.config.minBaselineSamples) continue;

      const z = zScore(span.durationMs, stats);
      if (z < ctx.thresholds.zScore) continue;

      out.push(
        finding({
          ctx,
          detector: retrievalLatencyDetector,
          code: 'RET-004',
          spanId: span.spanId,
          confidence: Math.min(0.9, 0.5 + 0.05 * z),
          detail: `Retrieval took ${Math.round(span.durationMs)}ms against a ${Math.round(stats.mean)}ms baseline. Index growth without re-tuning, missing ANN parameters, or a cold cache.`,
          evidence: [
            zEvidence(span.durationMs, stats),
            evidence('zScore', Number(z.toFixed(2))),
            evidence('index', scope),
          ],
        }),
      );
    }
    return out;
  },
};

/**
 * RET-007 Â· Embedding space weakness â€” OWASP LLM08. An embedding-model version
 * mismatch between index time and query time produces exactly this signature.
 */
export const embeddingWeaknessDetector: Detector = {
  id: 'ret.embedding-weakness',
  tier: 'L2',
  emits: ['RET-007'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Retrieval score distribution collapsed toward uniformity (OWASP LLM08).',
  supports: (t) =>
    t.byKind.retriever.some(
      (s) => (s.retrieval?.documents ?? []).filter((d) => typeof d.score === 'number').length >= 5,
    ),
  async run(ctx) {
    const out: Finding[] = [];

    for (const span of ctx.trace.byKind.retriever) {
      const scores = (span.retrieval?.documents ?? [])
        .map((d) => d.score)
        .filter((s): s is number => typeof s === 'number');
      if (scores.length < 5) continue;

      // A discriminating embedding space produces spread; uniform scores mean the
      // ranker is no longer distinguishing relevant from irrelevant.
      const entropy = normalisedEntropy(scores);
      if (entropy < ctx.thresholds.scoreEntropyFloor) continue;

      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;

      out.push(
        finding({
          ctx,
          detector: embeddingWeaknessDetector,
          code: 'RET-007',
          spanId: span.spanId,
          confidence: 0.65,
          detail: `Retrieval scores are almost uniform (normalised entropy ${entropy.toFixed(3)}), so the embedding space is not discriminating. Verify the index and the query use the same embedding model version.`,
          evidence: [
            evidence('scoreEntropy', Number(entropy.toFixed(3))),
            evidence('entropyFloor', ctx.thresholds.scoreEntropyFloor),
            evidence('scoreVariance', Number(variance.toFixed(5))),
            evidence('documents', scores.length),
          ],
        }),
      );
    }
    return out;
  },
};

export const toolLatencyDetector: Detector = {
  id: 'tol.latency-degradation',
  tier: 'L2',
  emits: ['TOL-006'],
  cost: 'free',
  requiresBaseline: true,
  description: 'Tool duration far above its per-tool baseline.',
  supports: (t) => t.byKind.tool.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.tool) {
      const toolName = span.tool?.toolName ?? span.name;
      const stats = ctx.baselines.get('tool.duration_ms', toolName);
      if (!stats || stats.count < ctx.config.minBaselineSamples) continue;

      const z = zScore(span.durationMs, stats);
      if (z < ctx.thresholds.zScore) continue;

      out.push(
        finding({
          ctx,
          detector: toolLatencyDetector,
          code: 'TOL-006',
          spanId: span.spanId,
          confidence: Math.min(0.9, 0.5 + 0.05 * z),
          detail: `Tool "${toolName}" took ${Math.round(span.durationMs)}ms against a ${Math.round(stats.mean)}ms baseline. Use per-tool timeouts â€” a slow tool inside an agent loop multiplies by the iteration count.`,
          evidence: [
            zEvidence(span.durationMs, stats),
            evidence('zScore', Number(z.toFixed(2))),
            evidence('tool', toolName),
          ],
        }),
      );
    }
    return out;
  },
};

export const costSpikeDetector: Detector = {
  id: 'eco.cost-spike',
  tier: 'L2',
  emits: ['ECO-002'],
  cost: 'free',
  requiresBaseline: true,
  description: 'Trace cost far above its rolling baseline.',
  supports: (t) => t.metrics.totalCostUsd > 0,
  async run(ctx) {
    const stats = ctx.baselines.get('trace.cost_usd', 'global');
    if (!stats || stats.count < ctx.config.minBaselineSamples) return [];

    const cost = ctx.trace.metrics.totalCostUsd;
    const z = zScore(cost, stats);
    if (z < ctx.thresholds.zScore) return [];

    const topSpan = topCostSpan(ctx);
    return [
      finding({
        ctx,
        detector: costSpikeDetector,
        code: 'ECO-002',
        ...(topSpan ? { spanId: topSpan.spanId } : {}),
        confidence: Math.min(0.9, 0.5 + 0.05 * z),
        detail: `Trace cost $${cost.toFixed(4)} against a baseline of $${stats.mean.toFixed(4)} (z=${z.toFixed(1)}). Attribute to a span before acting â€” a spike whose origin is AGT-003 is a control-flow bug, not a pricing problem.`,
        evidence: [
          zEvidence(cost, stats),
          evidence('zScore', Number(z.toFixed(2))),
          evidence('llmCalls', ctx.trace.metrics.llmCallCount),
          evidence('totalTokens', ctx.trace.metrics.totalTokens),
          ...(topSpan ? [evidence('topSpan', topSpan.name)] : []),
        ],
      }),
    ];
  },
};

function topCostSpan(ctx: DetectionContext): SpanRecord | undefined {
  return [...ctx.trace.byKind.llm].sort(
    (a, b) =>
      (b.llm?.inputTokens ?? 0) + (b.llm?.outputTokens ?? 0) -
      ((a.llm?.inputTokens ?? 0) + (a.llm?.outputTokens ?? 0)),
  )[0];
}

/** Features watched for distribution shift. */
const DRIFT_FEATURES: readonly { metric: string; scope: string; value: (ctx: DetectionContext) => number | undefined }[] = [
  { metric: 'trace.duration_ms', scope: 'global', value: (c) => c.trace.trace.durationMs },
  { metric: 'trace.output_tokens', scope: 'global', value: (c) => c.trace.metrics.totalOutputTokens },
  { metric: 'trace.cost_usd', scope: 'global', value: (c) => c.trace.metrics.totalCostUsd },
  {
    metric: 'retrieval.top1_score',
    scope: 'default',
    value: (c) => {
      const scores = c.trace.byKind.retriever.flatMap((s) =>
        (s.retrieval?.documents ?? []).map((d) => d.score).filter((x): x is number => typeof x === 'number'),
      );
      return scores.length > 0 ? Math.max(...scores) : undefined;
    },
  },
];

/**
 * Drift is a property of a WINDOW, not of a trace, so emitting it on every trace
 * in a drifting window would bury every other finding under identical copies.
 * This map rate-limits emission to once per feature per cooldown bucket, keyed on
 * trace time rather than wall-clock so replays and backfills behave identically.
 */
const DRIFT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const lastDriftEmit = new Map<string, number>();

/** Test hook: drift state is intentionally cross-trace, so tests must reset it. */
export function resetDriftState(): void {
  lastDriftEmit.clear();
}

/**
 * ECO-003 Â· Feature drift.
 *
 * Emits only at the SIGNIFICANT threshold (PSI > 0.25). Moderate drift is
 * genuinely common and genuinely uninteresting on its own; alerting on it is the
 * fastest route to a user who ignores the tool.
 */
export const featureDriftDetector: Detector = {
  id: 'eco.feature-drift',
  tier: 'L2',
  emits: ['ECO-003'],
  cost: 'free',
  requiresBaseline: true,
  description: 'Monitored feature distribution shifted significantly (PSI / JS divergence).',
  supports: () => true,
  async run(ctx) {
    const out: Finding[] = [];
    const bucket = Math.floor(ctx.trace.trace.startTime / DRIFT_COOLDOWN_MS);

    for (const feature of DRIFT_FEATURES) {
      const reference = ctx.baselines.samples(feature.metric, feature.scope);
      if (reference.length < ctx.config.minBaselineSamples) continue;

      // Reference = the older half; current = the most recent quarter. Comparing
      // adjacent halves of a rolling reservoir finds a shift in any trending
      // series, which is too sensitive to be actionable.
      const refEnd = Math.floor(reference.length / 2);
      const curStart = Math.floor(reference.length * 0.75);
      const older = reference.slice(0, refEnd);
      const recent = reference.slice(curStart);
      if (older.length < 15 || recent.length < 15) continue;

      const psiValue = psi(older, recent);
      if (psiValue <= ctx.thresholds.psiSignificant) continue;

      const cooldownKey = `${feature.metric}::${feature.scope}::${bucket}`;
      if (lastDriftEmit.get(cooldownKey) === bucket) continue;
      lastDriftEmit.set(cooldownKey, bucket);

      const js = jensenShannon(older, recent);

      out.push(
        finding({
          ctx,
          detector: featureDriftDetector,
          code: 'ECO-003',
          confidence: 0.8,
          // Never promoted above medium: drift is an indicator, and letting it
          // outrank a concrete failure would make it the attributed origin.
          severity: 'medium',
          detail: `"${feature.metric}" shifted significantly (PSI ${psiValue.toFixed(3)}, threshold ${ctx.thresholds.psiSignificant}). Drift is a leading indicator, not a failure â€” investigate what changed: corpus, traffic mix, model version, or prompt.`,
          evidence: [
            evidence('feature', feature.metric),
            evidence('psi', Number(psiValue.toFixed(4))),
            evidence('jensenShannon', Number(js.toFixed(4))),
            evidence('referenceWindow', older.length),
            evidence('currentWindow', recent.length),
            evidence('threshold', ctx.thresholds.psiSignificant),
          ],
        }),
      );
    }
    return out;
  },
};

export const L2_DETECTORS: readonly Detector[] = [
  latencyOutlierDetector,
  retrievalQualityDetector,
  retrievalLatencyDetector,
  embeddingWeaknessDetector,
  toolLatencyDetector,
  costSpikeDetector,
  featureDriftDetector,
];
