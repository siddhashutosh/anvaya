/**
 * Detector fault isolation (ADR-0006, FR-3.3).
 *
 * A detector that throws must never stop ingestion. Its failure becomes an
 * INF-006 finding — Anvaya observes itself with the same mechanism it observes
 * everything else, so a broken detector shows up where someone will actually see
 * it rather than in a log nobody reads.
 */

import {
  AnvayaError,
  DetectorError,
  ERROR_CODES,
  TAXONOMY_VERSION,
  newFindingId,
  requireMode,
  type Finding,
  type Logger,
} from '@anvaya/core';
import type { DetectorOutcome } from '../storage/types.js';
import type { DetectionContext, Detector } from './types.js';

export interface SandboxResult {
  readonly findings: readonly Finding[];
  readonly outcome: DetectorOutcome;
  readonly durationMs: number;
}

export interface SandboxOptions {
  readonly budgetMs: number;
  readonly minBaselineSamples: number;
  readonly shortCircuitConfidence: number;
  readonly logger: Logger;
}

export async function runSandboxed(
  detector: Detector,
  makeContext: (signal: AbortSignal) => DetectionContext,
  options: SandboxOptions,
): Promise<SandboxResult> {
  const started = performance.now();
  const controller = new AbortController();
  const ctx = makeContext(controller.signal);

  // 1. supports() gate — declining is normal, not an error.
  if (!detector.supports(ctx.trace)) {
    return { findings: [], outcome: 'skipped:unsupported', durationMs: 0 };
  }

  // 2. Baseline gate — emit nothing rather than a low-quality finding (FR-3.12).
  if (detector.requiresBaseline && !hasEnoughBaseline(detector, ctx, options.minBaselineSamples)) {
    return { findings: [], outcome: 'skipped:insufficient-baseline', durationMs: 0 };
  }

  // 3. Short-circuit gate — never pay L3 for what a cheaper tier already asserted.
  if (detector.cost === 'billed' && isCovered(detector, ctx, options.shortCircuitConfidence)) {
    return { findings: [], outcome: 'skipped:covered', durationMs: 0 };
  }
  if (detector.cost === 'billed' && !ctx.judge) {
    return { findings: [], outcome: 'skipped:unconfigured', durationMs: 0 };
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new DetectorError(`detector ${detector.id} exceeded ${options.budgetMs}ms`, {
            code: ERROR_CODES.DETECTOR_TIMEOUT,
            context: { detectorId: detector.id, budgetMs: options.budgetMs },
          }),
        );
      }, options.budgetMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    const produced = await Promise.race([detector.run(ctx), timeout]);
    const durationMs = performance.now() - started;

    // 6. Contract enforcement — a detector may not assert outside its `emits`.
    const allowed = new Set(detector.emits);
    const findings = produced.filter((f) => {
      if (allowed.has(f.code)) return true;
      options.logger.warn('detector emitted an undeclared code; dropping finding', {
        detectorId: detector.id,
        taxonomyCode: f.code,
        declared: detector.emits.join(','),
      });
      return false;
    });

    return { findings, outcome: 'ok', durationMs };
  } catch (e) {
    const durationMs = performance.now() - started;
    const error = AnvayaError.from(e, {
      code: ERROR_CODES.DETECTOR_FAILED,
      category: 'detector',
      context: { detectorId: detector.id },
    });
    const timedOut = error.code === ERROR_CODES.DETECTOR_TIMEOUT;

    options.logger.error('detector failed', {
      err: error,
      detectorId: detector.id,
      traceId: ctx.trace.trace.traceId,
      durationMs,
    });

    return {
      findings: [selfObservationFinding(detector, ctx, error, durationMs)],
      outcome: timedOut ? 'timeout' : 'failed',
      durationMs,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** INF-006 — Anvaya reporting its own failure through its own taxonomy. */
function selfObservationFinding(
  detector: Detector,
  ctx: DetectionContext,
  error: AnvayaError,
  durationMs: number,
): Finding {
  const mode = requireMode('INF-006');
  return {
    findingId: newFindingId(),
    traceId: ctx.trace.trace.traceId,
    code: 'INF-006',
    severity: mode.defaultSeverity,
    confidence: 1,
    detectorId: 'anvaya.sandbox',
    tier: 'L0',
    title: mode.name,
    detail: `Detector "${detector.id}" failed: ${error.message}`,
    evidence: [
      { label: 'detector', value: detector.id },
      { label: 'error', value: error.code },
      { label: 'elapsedMs', value: Math.round(durationMs) },
    ],
    role: 'standalone',
    taxonomyVersion: TAXONOMY_VERSION,
    createdAt: Date.now(),
  };
}

function hasEnoughBaseline(
  detector: Detector,
  ctx: DetectionContext,
  minSamples: number,
): boolean {
  // A detector declares it needs history; the specific metric is its own concern,
  // so the gate uses the trace-level baseline as a proxy for "we have seen enough".
  const anchor = ctx.baselines.get('trace.duration_ms', 'global');
  return (anchor?.count ?? 0) >= minSamples;
}

function isCovered(
  detector: Detector,
  ctx: DetectionContext,
  threshold: number,
): boolean {
  return detector.emits.every((code) =>
    ctx.existing.some((f) => f.code === code && f.confidence >= threshold),
  );
}
