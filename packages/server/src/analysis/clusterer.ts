/**
 * IncidentClusterer — groups related findings across traces into incidents.
 *
 * Incidents, not raw findings, are the on-call unit. Thirty-four traces sharing
 * one root cause is one page, not thirty-four.
 */

import {
  HOUR,
  SEVERITY_RANK,
  getMode,
  maxSeverity,
  newIncidentId,
  type Attribution,
  type CohortHypothesis,
  type Finding,
  type Incident,
  type Logger,
  type NormalizedTrace,
  type Severity,
} from '@anvaya/core';
import type { Storage } from '../storage/types.js';

export interface IncidentClustererOptions {
  readonly windowMs: number;
  readonly autoResolveMs: number;
  readonly storage: Storage;
  readonly logger: Logger;
}

export class IncidentClusterer {
  private readonly logger: Logger;

  constructor(private readonly options: IncidentClustererOptions) {
    this.logger = options.logger.child('clusterer');
  }

  /**
   * Fold one analysed trace into the incident set. Returns incidents that were
   * created or updated, so the caller can decide whether to alert.
   */
  async ingest(
    trace: NormalizedTrace,
    findings: readonly Finding[],
    attribution: Attribution,
    cohorts: readonly CohortHypothesis[] = [],
  ): Promise<readonly Incident[]> {
    if (findings.length === 0) return [];

    const anchor = this.pickAnchor(findings, attribution);
    if (!anchor) return [];

    const operation = this.operationOf(trace, anchor);
    const now = Date.now();
    const since = now - this.options.windowMs;

    const existing = await this.options.storage.findOpenIncident(anchor.code, operation, since);
    const mode = getMode(anchor.code);

    const incident: Incident = existing
      ? {
          ...existing,
          severity: (maxSeverity(existing.severity, anchor.severity) ?? anchor.severity) as Severity,
          lastSeen: now,
          occurrences: existing.occurrences + 1,
          // Bounded: an incident that fires thousands of times must not grow a
          // thousand-element array in memory or in the row.
          traceIds: [...existing.traceIds, trace.trace.traceId].slice(-200),
          ...(cohorts.length > 0 ? { cohorts } : {}),
          ...(attribution.summary ? { hypothesis: attribution.summary } : {}),
        }
      : {
          incidentId: newIncidentId(),
          code: anchor.code,
          originOperation: operation,
          severity: anchor.severity,
          status: 'open',
          firstSeen: now,
          lastSeen: now,
          occurrences: 1,
          traceIds: [trace.trace.traceId],
          title: `${mode?.name ?? anchor.code} at ${operation}`,
          hypothesis: attribution.summary,
          cohorts,
        };

    await this.options.storage.upsertIncident(incident);

    if (!existing) {
      this.logger.info('incident opened', {
        incidentId: incident.incidentId,
        taxonomyCode: incident.code,
        severity: incident.severity,
        operation,
      });
    }

    return [incident];
  }

  /** Close incidents that have gone quiet. Called on a timer. */
  async sweep(): Promise<number> {
    const cutoff = Date.now() - this.options.autoResolveMs;
    const resolved = await this.options.storage.resolveStaleIncidents(cutoff);
    if (resolved > 0) this.logger.info('auto-resolved stale incidents', { count: resolved });
    return resolved;
  }

  /** Prefer the attributed origin; fall back to the most severe finding. */
  private pickAnchor(
    findings: readonly Finding[],
    attribution: Attribution,
  ): Finding | undefined {
    if (attribution.originFindingId) {
      const origin = findings.find((f) => f.findingId === attribution.originFindingId);
      if (origin) return origin;
    }
    return [...findings].sort((a, b) => {
      const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      return sev !== 0 ? sev : b.confidence - a.confidence;
    })[0];
  }

  /**
   * The operation name is half the clustering key, so the same failure at two
   * different pipeline stages produces two incidents — which is correct, because
   * they have different fixes.
   */
  private operationOf(trace: NormalizedTrace, finding: Finding): string {
    if (finding.spanId) {
      const span = trace.index.get(finding.spanId);
      if (span) return span.name;
    }
    return trace.trace.name;
  }
}

export const DEFAULT_INCIDENT_WINDOW_MS = 6 * HOUR;
