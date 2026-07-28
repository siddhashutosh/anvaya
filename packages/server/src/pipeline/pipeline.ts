/**
 * AnalysisPipeline — the six stages of HLD §5.2.
 *
 *   enrich -> detect -> attribute -> correlate -> persist -> notify
 *
 * Stages 2-4 each have their own error boundary (EH-7): a stage failure is
 * logged, counted, and the pipeline continues with partial results. A trace with
 * no findings is still worth storing; losing the trace because attribution threw
 * would be a worse outcome than losing the diagnosis.
 */

import {
  AnvayaError,
  ERROR_CODES,
  maxSeverity,
  type CohortHypothesis,
  type Finding,
  type Logger,
  type NormalizedTrace,
  type SessionTurn,
  type SessionWindow,
  type Severity,
  type SpanRecord,
  type TraceRecord,
} from '@anvaya/core';
import { SessionAnalyzer, toSessionTurn } from '../analysis/session.js';
import { CausalAttributor } from '../analysis/attributor.js';
import { BaselineManager } from '../analysis/baselines.js';
import { IncidentClusterer } from '../analysis/clusterer.js';
import { CohortCorrelator } from '../analysis/correlator.js';
import { TraceEnricher } from '../analysis/enricher.js';
import type { AlertDispatcher } from '../alerts/dispatcher.js';
import type { Config } from '../config/schema.js';
import { runSandboxed } from '../detectors/sandbox.js';
import type { DetectorRegistry } from '../detectors/registry.js';
import type { JudgeProvider } from '../detectors/judge/provider.js';
import type { DetectionContext } from '../detectors/types.js';
import type { DetectorRun, Storage } from '../storage/types.js';
import type { Metrics } from '../telemetry/metrics.js';

export interface AnalysisPipelineDeps {
  readonly registry: DetectorRegistry;
  readonly enricher: TraceEnricher;
  readonly attributor: CausalAttributor;
  readonly clusterer: IncidentClusterer;
  readonly correlator: CohortCorrelator;
  readonly baselines: BaselineManager;
  readonly sessionAnalyzer: SessionAnalyzer;
  readonly storage: Storage;
  readonly alerts: AlertDispatcher;
  readonly config: Config;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly judge?: JudgeProvider;
}

export interface AnalysisOutcome {
  readonly traceId: string;
  readonly findings: readonly Finding[];
  readonly incidentCount: number;
  readonly durationMs: number;
}

export class AnalysisPipeline {
  private readonly logger: Logger;

  constructor(private readonly deps: AnalysisPipelineDeps) {
    this.logger = deps.logger.child('pipeline');
  }

  async analyze(trace: TraceRecord, spans: readonly SpanRecord[]): Promise<AnalysisOutcome> {
    const started = performance.now();
    const log = this.logger.child('trace', { traceId: trace.traceId });

    // ── stage 1: enrich ─────────────────────────────────────────────────────
    let normalized: NormalizedTrace;
    try {
      normalized = this.deps.enricher.enrich(trace, spans);
    } catch (e) {
      // Enrichment is the one stage with no useful partial result.
      log.error('enrichment failed; trace dropped', { err: e });
      this.deps.metrics.counter('pipeline.enrich_failed');
      return { traceId: trace.traceId, findings: [], incidentCount: 0, durationMs: 0 };
    }

    // ── stage 2: detect ─────────────────────────────────────────────────────
    const { findings: rawFindings, runs } = await this.detect(normalized, log);

    // ── stage 2b: session-scoped detect ─────────────────────────────────────
    // MAST FM-1.4 and FM-2.1 are defined ACROSS turns, and in a real chat app
    // each turn is its own trace, so no trace-scoped detector can see them.
    const sessionTurn = toSessionTurn(normalized);
    const sessionFindings = await this.detectSession(normalized, sessionTurn, log);
    const allFindings = [...rawFindings, ...sessionFindings];

    // ── stage 3: attribute ──────────────────────────────────────────────────
    let findings: readonly Finding[] = allFindings;
    let attribution = {
      traceId: trace.traceId,
      chain: [] as never[],
      summary: '',
    } as ReturnType<CausalAttributor['attribute']>['attribution'];

    try {
      const result = this.deps.attributor.attribute(normalized, allFindings);
      findings = result.findings;
      attribution = result.attribution;
    } catch (e) {
      log.error('attribution failed; keeping unattributed findings', { err: e });
      this.deps.metrics.counter('pipeline.attribution_failed');
    }

    // ── stage 4: correlate + cluster ────────────────────────────────────────
    let incidentCount = 0;
    let cohorts: readonly CohortHypothesis[] = [];
    try {
      const origin = findings.find((f) => f.findingId === attribution.originFindingId);
      if (origin) {
        cohorts = await this.deps.correlator.correlate(origin.code);
      }
      const incidents = await this.deps.clusterer.ingest(normalized, findings, attribution, cohorts);
      incidentCount = incidents.length;

      // ── stage 6: notify ───────────────────────────────────────────────────
      for (const incident of incidents) {
        await this.deps.alerts.dispatch(incident);
      }
    } catch (e) {
      log.error('correlation or clustering failed; findings are still persisted', { err: e });
      this.deps.metrics.counter('pipeline.clustering_failed');
    }

    // ── stage 5: persist ────────────────────────────────────────────────────
    const worst = findings.reduce<Severity | undefined>(
      (acc, f) => maxSeverity(acc, f.severity),
      undefined,
    );

    const finalTrace: TraceRecord = {
      ...normalized.trace,
      findingCount: findings.length,
      ...(worst ? { worstSeverity: worst } : {}),
    };

    await this.persist(
      {
        trace: finalTrace,
        spans: normalized.spans,
        findings,
        attribution,
        detectorRuns: runs,
        sessionTurn,
      },
      log,
    );

    // Baselines update AFTER detection so a trace is never compared against a
    // baseline that already contains it.
    try {
      this.deps.baselines.update(normalized);
    } catch (e) {
      log.warn('baseline update failed', { err: e });
    }

    const durationMs = performance.now() - started;
    this.deps.metrics.observe('pipeline.duration_ms', durationMs);
    this.deps.metrics.counter('pipeline.traces_analysed');
    this.deps.metrics.counter('pipeline.findings_emitted', findings.length);

    log.debug('trace analysed', {
      findings: findings.length,
      incidents: incidentCount,
      durationMs: Math.round(durationMs),
    });

    return { traceId: trace.traceId, findings, incidentCount, durationMs };
  }

  /**
   * Session-scoped detection over the newest adjacent pair of turns.
   *
   * No-ops for traces with no session id, which is the correct default: a
   * single-shot request has no conversation to lose.
   */
  private async detectSession(
    trace: NormalizedTrace,
    turn: SessionTurn,
    log: Logger,
  ): Promise<readonly Finding[]> {
    const sessionId = trace.trace.sessionId;
    if (!sessionId) return [];

    try {
      const previous = await this.deps.storage.getPreviousSessionTurn(
        sessionId,
        trace.trace.startTime,
      );
      if (!previous) return [];

      const window: SessionWindow = {
        sessionId,
        service: trace.trace.service,
        previous: previous.turn,
        current: turn,
        turnIndex: previous.turnIndex + 1,
      };

      const findings = this.deps.sessionAnalyzer.analyze(window);
      if (findings.length > 0) {
        this.deps.metrics.counter('session.findings', findings.length);
      }
      return findings;
    } catch (e) {
      // Session analysis is additive; losing it must not cost the trace its
      // own findings.
      log.warn('session analysis failed', { err: e, sessionId });
      this.deps.metrics.counter('session.analysis_failed');
      return [];
    }
  }

  /** Runs every enabled detector in tier order, each individually sandboxed. */
  private async detect(
    trace: NormalizedTrace,
    log: Logger,
  ): Promise<{ findings: readonly Finding[]; runs: readonly DetectorRun[] }> {
    const detectors = this.deps.registry.enabledFor(this.deps.config.detection);
    const accumulated: Finding[] = [];
    const runs: DetectorRun[] = [];

    // Trace-level judge sampling: decided once, so an eligible trace either uses
    // the judge for all its L3 detectors or for none.
    const judgeSampled =
      this.deps.judge !== undefined && Math.random() < this.deps.config.judge.sampleRate;

    for (const detector of detectors) {
      const result = await runSandboxed(
        detector,
        (signal): DetectionContext => ({
          trace,
          baselines: this.deps.baselines,
          config: this.deps.config.detection,
          thresholds: this.deps.config.detection.thresholds,
          logger: log.child(detector.id, { detectorId: detector.id }),
          existing: accumulated,
          ...(detector.cost === 'billed' && judgeSampled && this.deps.judge
            ? { judge: this.deps.judge }
            : {}),
          signal,
        }),
        {
          budgetMs: this.deps.config.detection.detectorBudgetMs,
          minBaselineSamples: this.deps.config.detection.minBaselineSamples,
          shortCircuitConfidence: this.deps.config.detection.shortCircuitConfidence,
          logger: log,
        },
      );

      accumulated.push(...result.findings);
      runs.push({
        traceId: trace.trace.traceId,
        detectorId: detector.id,
        tier: detector.tier,
        outcome: result.outcome,
        durationMs: result.durationMs,
        findingCount: result.findings.length,
        createdAt: Date.now(),
      });

      this.deps.metrics.counter('detector.runs', 1, {
        detector: detector.id,
        outcome: result.outcome,
      });
      if (result.durationMs > 0) {
        this.deps.metrics.observe('detector.duration_ms', result.durationMs, {
          detector: detector.id,
        });
      }
    }

    return { findings: accumulated, runs };
  }

  private async persist(
    bundle: Parameters<Storage['saveTraceBundle']>[0],
    log: Logger,
  ): Promise<void> {
    try {
      await this.deps.storage.saveTraceBundle(bundle);
      return;
    } catch (e) {
      log.warn('persist failed; retrying once', { err: e });
    }

    try {
      await this.deps.storage.saveTraceBundle(bundle);
    } catch (e) {
      // Explicit loss, counted — never a silent drop (NFR-2.2).
      this.deps.metrics.counter('pipeline.traces_lost');
      log.error('persist failed after retry; trace lost', {
        err: AnvayaError.from(e, {
          code: ERROR_CODES.STORAGE_WRITE_FAILED,
          category: 'storage',
        }),
      });
    }
  }
}
