import type { DetectorTier, Severity } from './common.js';
import type { TaxonomyCode } from '../taxonomy/types.js';

/**
 * A single piece of justification for a finding. Findings may never be emitted
 * without at least one (FR-3.16) — this is how Anvaya avoids laundering a
 * heuristic guess as a fact.
 */
export interface Evidence {
  readonly label: string;
  readonly value: string | number | boolean;
  readonly comparison?: {
    readonly baseline: number;
    readonly delta: number;
    readonly samples: number;
  };
}

/**
 * Attribution role. `origin` is the diagnosed cause, `symptom` is downstream of
 * a known propagation edge, `standalone` is unrelated to any other finding.
 */
export type FindingRole = 'origin' | 'symptom' | 'standalone';

export interface Finding {
  readonly findingId: string;
  readonly traceId: string;
  readonly spanId?: string;
  readonly code: TaxonomyCode;
  readonly severity: Severity;
  /** [0,1]. Rendered as a qualitative band in every user-facing surface (FR-7.9). */
  readonly confidence: number;
  readonly detectorId: string;
  readonly tier: DetectorTier;
  readonly title: string;
  readonly detail: string;
  readonly evidence: readonly Evidence[];
  readonly role: FindingRole;
  /** findingId of the upstream cause, when role === 'symptom'. */
  readonly causedBy?: string;
  readonly taxonomyVersion: string;
  readonly createdAt: number;
}

export interface AttributionLink {
  readonly findingId: string;
  readonly code: TaxonomyCode;
  readonly title: string;
}

/** The diagnosis for one trace: which finding is the cause, and how it propagated. */
export interface Attribution {
  readonly traceId: string;
  readonly originFindingId?: string;
  readonly chain: readonly AttributionLink[];
  readonly summary: string;
}

export type IncidentStatus = 'open' | 'resolved';

export interface CohortHypothesis {
  readonly key: string;
  readonly value: string;
  readonly lift: number;
  readonly inCohortRate: number;
  readonly baseRate: number;
  readonly samples: number;
  /** Always phrased as a hypothesis — this is correlational evidence (FR-4.7). */
  readonly statement: string;
}

export interface Incident {
  readonly incidentId: string;
  readonly code: TaxonomyCode;
  readonly originOperation: string;
  readonly severity: Severity;
  readonly status: IncidentStatus;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly occurrences: number;
  readonly traceIds: readonly string[];
  readonly title: string;
  readonly hypothesis?: string;
  readonly cohorts: readonly CohortHypothesis[];
}

export interface BaselineStats {
  readonly count: number;
  readonly mean: number;
  /** Sum of squares of differences from the current mean (Welford's M2). */
  readonly m2: number;
  readonly min: number;
  readonly max: number;
  /** Reservoir of recent raw values, used for PSI/JS histograms and MAD. */
  readonly samples: readonly number[];
}

export interface BaselineRow {
  readonly metric: string;
  readonly scope: string;
  readonly stats: BaselineStats;
  readonly updatedAt: number;
}
