/**
 * Lookup and graph queries over the failure taxonomy.
 *
 * The catalog itself is pure data (catalog.ts); all behaviour lives here.
 */

import { ConfigurationError } from '../errors/errors.js';
import { CATALOG, TAXONOMY_VERSION } from './catalog.js';
import type { FailureMode, TaxonomyCode, TaxonomyFamily } from './types.js';

const BY_CODE: ReadonlyMap<TaxonomyCode, FailureMode> = new Map(
  CATALOG.map((mode) => [mode.code, mode] as const),
);

/** Maximum depth for transitive cause resolution. Keeps attribution O(1)-ish and
 * prevents a pathological chain from linking unrelated findings. */
const MAX_CAUSAL_DEPTH = 4;

export { TAXONOMY_VERSION, CATALOG };

export function getMode(code: TaxonomyCode): FailureMode | undefined {
  return BY_CODE.get(code);
}

/**
 * Strict lookup. A missing code means a detector referenced a mode that does not
 * exist, which is a programming error, not a runtime condition.
 */
export function requireMode(code: TaxonomyCode): FailureMode {
  const mode = BY_CODE.get(code);
  if (!mode) {
    throw new ConfigurationError(`Unknown taxonomy code: ${code}`, {
      code: 'TAXONOMY_UNKNOWN_CODE',
      category: 'configuration',
      context: { taxonomyCode: code },
    });
  }
  return mode;
}

export function allModes(): readonly FailureMode[] {
  return CATALOG;
}

export function allCodes(): readonly TaxonomyCode[] {
  return CATALOG.map((m) => m.code);
}

export function byFamily(family: TaxonomyFamily): readonly FailureMode[] {
  return CATALOG.filter((m) => m.family === family);
}

export function familyOf(code: TaxonomyCode): TaxonomyFamily | undefined {
  return getMode(code)?.family;
}

/** Direct propagation edges: modes this one is known to cause. */
export function causes(code: TaxonomyCode): readonly TaxonomyCode[] {
  return getMode(code)?.causes ?? [];
}

/**
 * Is `downstream` reachable from `upstream` along `causes` edges within
 * MAX_CAUSAL_DEPTH? Bounded BFS, so transitive chains such as
 * RET-002 -> GEN-004 -> GEN-008 resolve without being hardcoded.
 */
export function isCausedBy(downstream: TaxonomyCode, upstream: TaxonomyCode): boolean {
  return causalDistance(upstream, downstream) > 0;
}

/**
 * Shortest number of `causes` hops from `from` to `to`.
 * Returns 0 when they are the same code, -1 when unreachable within the depth bound.
 */
export function causalDistance(from: TaxonomyCode, to: TaxonomyCode): number {
  if (from === to) return 0;

  const seen = new Set<TaxonomyCode>([from]);
  let frontier: TaxonomyCode[] = [from];

  for (let depth = 1; depth <= MAX_CAUSAL_DEPTH; depth++) {
    const next: TaxonomyCode[] = [];
    for (const node of frontier) {
      for (const child of causes(node)) {
        if (child === to) return depth;
        if (!seen.has(child)) {
          seen.add(child);
          next.push(child);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return -1;
}

/** All modes carrying a measured frequency, sorted most frequent first. */
export function modesByObservedFrequency(): readonly FailureMode[] {
  return CATALOG.filter((m) => typeof m.observedFrequency === 'number').sort(
    (a, b) => (b.observedFrequency ?? 0) - (a.observedFrequency ?? 0),
  );
}
