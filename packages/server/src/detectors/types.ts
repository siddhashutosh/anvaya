/**
 * The detector contract (HLD §7.1).
 *
 * Detectors are pure over (trace, baselines) with the single exception of the L3
 * judge tier. That purity is what makes them testable in isolation, individually
 * togglable, and safe to sandbox.
 */

import {
  DetectorError,
  ERROR_CODES,
  TAXONOMY_VERSION,
  newFindingId,
  requireMode,
  type BaselineStats,
  type DetectorTier,
  type Evidence,
  type Finding,
  type Logger,
  type NormalizedTrace,
  type Severity,
  type TaxonomyCode,
} from '@anvaya/core';
import type { DetectionConfig, Thresholds } from '../config/schema.js';
import type { JudgeProvider } from './judge/provider.js';

export type CostClass = 'free' | 'cheap' | 'billed';

export interface BaselineReader {
  get(metric: string, scope?: string): BaselineStats | undefined;
  samples(metric: string, scope?: string): readonly number[];
}

export interface DetectionContext {
  readonly trace: NormalizedTrace;
  readonly baselines: BaselineReader;
  readonly config: DetectionConfig;
  readonly thresholds: Thresholds;
  readonly logger: Logger;
  /** Findings already produced by cheaper tiers — enables short-circuiting. */
  readonly existing: readonly Finding[];
  readonly judge?: JudgeProvider;
  readonly signal: AbortSignal;
}

export interface Detector {
  readonly id: string;
  readonly tier: DetectorTier;
  readonly emits: readonly TaxonomyCode[];
  readonly cost: CostClass;
  readonly requiresBaseline: boolean;
  readonly description: string;
  /** Decline traces this detector cannot analyse. Declining is normal, not an error. */
  supports(trace: NormalizedTrace): boolean;
  run(ctx: DetectionContext): Promise<readonly Finding[]>;
}

export interface FindingInput {
  readonly ctx: DetectionContext;
  readonly detector: Detector;
  readonly code: TaxonomyCode;
  readonly spanId?: string;
  readonly confidence: number;
  readonly title?: string;
  readonly detail: string;
  readonly evidence: readonly Evidence[];
  readonly severity?: Severity;
}

/**
 * The sole construction path for findings. Centralising it is what enforces
 * FR-3.15 (every finding is complete) and FR-3.16 (no finding without evidence).
 */
export function finding(input: FindingInput): Finding {
  if (input.evidence.length === 0) {
    throw new DetectorError(
      `detector ${input.detector.id} emitted ${input.code} without evidence`,
      {
        code: ERROR_CODES.DETECTOR_CONTRACT_VIOLATION,
        context: { detectorId: input.detector.id, taxonomyCode: input.code },
      },
    );
  }

  const mode = requireMode(input.code);
  const confidence = Math.min(1, Math.max(0, input.confidence));

  return {
    findingId: newFindingId(),
    traceId: input.ctx.trace.trace.traceId,
    ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
    code: input.code,
    severity: input.severity ?? mode.defaultSeverity,
    confidence,
    detectorId: input.detector.id,
    tier: input.detector.tier,
    title: input.title ?? mode.name,
    detail: input.detail,
    evidence: input.evidence,
    role: 'standalone',
    taxonomyVersion: TAXONOMY_VERSION,
    createdAt: Date.now(),
  };
}

export function evidence(
  label: string,
  value: string | number | boolean,
  comparison?: Evidence['comparison'],
): Evidence {
  return { label, value, ...(comparison ? { comparison } : {}) };
}
