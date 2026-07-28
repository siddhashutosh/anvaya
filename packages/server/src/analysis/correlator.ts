/**
 * CohortCorrelator — finds cohorts where a failure concentrates (FR-4.7).
 *
 * This is how a bad model rollout, a broken route, or one pathological tenant is
 * found. Output is ALWAYS phrased as a hypothesis: this is correlational
 * evidence, and presenting correlation as cause is exactly the kind of confident
 * wrongness the whole product exists to catch.
 */

import { DAY, type CohortHypothesis, type Logger, type TaxonomyCode, type TimeRange } from '@anvaya/core';
import type { Storage } from '../storage/types.js';

export interface CohortCorrelatorOptions {
  readonly storage: Storage;
  readonly cohortKeys: readonly string[];
  readonly minLift: number;
  readonly minSamples: number;
  readonly logger: Logger;
}

export class CohortCorrelator {
  private readonly logger: Logger;

  constructor(private readonly options: CohortCorrelatorOptions) {
    this.logger = options.logger.child('correlator');
  }

  async correlate(
    code: TaxonomyCode,
    range: TimeRange = { from: Date.now() - DAY, to: Date.now() },
  ): Promise<readonly CohortHypothesis[]> {
    const base = await this.options.storage.codeRate(code, range);
    if (base.total < this.options.minSamples || base.withCode === 0) return [];

    const baseRate = base.withCode / base.total;
    if (baseRate >= 0.9) return []; // Ubiquitous: no cohort explains it.

    const hypotheses: CohortHypothesis[] = [];

    for (const key of this.options.cohortKeys) {
      let counts;
      try {
        counts = await this.options.storage.cohortCounts(code, key, range);
      } catch (e) {
        // A cohort key that does not exist in the attributes is not an error.
        this.logger.debug('cohort query failed', { err: e, cohortKey: key });
        continue;
      }

      for (const cohort of counts) {
        if (cohort.total < this.options.minSamples) continue;
        const inCohortRate = cohort.withCode / cohort.total;
        if (inCohortRate === 0) continue;

        const lift = inCohortRate / baseRate;
        if (lift < this.options.minLift) continue;

        hypotheses.push({
          key,
          value: cohort.value,
          lift: Number(lift.toFixed(2)),
          inCohortRate: Number(inCohortRate.toFixed(4)),
          baseRate: Number(baseRate.toFixed(4)),
          samples: cohort.total,
          statement: `Hypothesis: ${code} occurs ${lift.toFixed(1)}× more often when ${key}="${cohort.value}" (${(inCohortRate * 100).toFixed(1)}% vs ${(baseRate * 100).toFixed(1)}% baseline, n=${cohort.total}). This is correlation, not a confirmed cause.`,
        });
      }
    }

    return hypotheses.sort((a, b) => b.lift - a.lift).slice(0, 5);
  }
}
