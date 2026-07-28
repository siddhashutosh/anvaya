import type { DetectorTier, Severity } from '../types/common.js';

export type TaxonomyFamily = 'INF' | 'CTX' | 'RET' | 'GEN' | 'AGT' | 'TOL' | 'SEC' | 'ECO';

export const TAXONOMY_FAMILIES: readonly TaxonomyFamily[] = Object.freeze([
  'INF',
  'CTX',
  'RET',
  'GEN',
  'AGT',
  'TOL',
  'SEC',
  'ECO',
] as const);

export const FAMILY_LABELS: Readonly<Record<TaxonomyFamily, string>> = Object.freeze({
  INF: 'Infrastructure & transport',
  CTX: 'Input & context',
  RET: 'Retrieval & grounding',
  GEN: 'Generation quality',
  AGT: 'Agent & orchestration',
  TOL: 'Tool & function calling',
  SEC: 'Safety & security',
  ECO: 'Economics & drift',
});

/** e.g. `RET-002`. Codes are permanent and additive-only — see ADR-0004. */
export type TaxonomyCode = string;

export interface FailureSource {
  readonly kind: 'research' | 'standard' | 'operational';
  readonly ref: string;
  readonly note?: string;
}

export interface FailureMode {
  readonly code: TaxonomyCode;
  readonly family: TaxonomyFamily;
  readonly name: string;
  readonly definition: string;
  readonly defaultSeverity: Severity;
  /** The cheapest tier that can assert this mode. */
  readonly tier: DetectorTier;
  readonly evidenceRequired: readonly string[];
  readonly remediation: string;
  readonly source: FailureSource;
  /** Directed propagation edges consumed by the attribution engine. */
  readonly causes: readonly TaxonomyCode[];
  /** Measured frequency where the source reports one (currently MAST modes only). */
  readonly observedFrequency?: number;
  readonly deprecated?: boolean;
  readonly supersededBy?: TaxonomyCode;
}
