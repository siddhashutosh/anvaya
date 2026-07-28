/**
 * Detector registry (FR-3.1, FR-3.17).
 *
 * Registration is the only integration point: adding a detector is one new file
 * plus one line here (NFR-5.4), and third-party detectors register the same way
 * without forking.
 */

import { ConfigurationError, ERROR_CODES, TIER_ORDER, type DetectorTier } from '@anvaya/core';
import type { DetectionConfig } from '../config/schema.js';
import type { Detector } from './types.js';

export class DetectorRegistry {
  private readonly detectors = new Map<string, Detector>();

  register(detector: Detector): void {
    if (this.detectors.has(detector.id)) {
      throw new ConfigurationError(`duplicate detector id: ${detector.id}`, {
        code: ERROR_CODES.DETECTOR_DUPLICATE_ID,
        context: { detectorId: detector.id },
      });
    }
    this.detectors.set(detector.id, detector);
  }

  registerAll(detectors: readonly Detector[]): void {
    for (const d of detectors) this.register(d);
  }

  get(id: string): Detector | undefined {
    return this.detectors.get(id);
  }

  all(): readonly Detector[] {
    return [...this.detectors.values()];
  }

  byTier(tier: DetectorTier): readonly Detector[] {
    return this.all().filter((d) => d.tier === tier);
  }

  /**
   * Enabled detectors in tier order L0 -> L1 -> L2 -> L3 (FR-3.2). Ordering here
   * rather than at the call site keeps the cheapest-first invariant in one place.
   */
  enabledFor(config: DetectionConfig): readonly Detector[] {
    if (!config.enabled) return [];
    const disabled = new Set(config.disabledDetectors);

    const out: Detector[] = [];
    for (const tier of TIER_ORDER) {
      if (!config.tiers[tier]) continue;
      for (const detector of this.byTier(tier)) {
        if (disabled.has(detector.id)) continue;
        out.push(detector);
      }
    }
    return out;
  }

  get size(): number {
    return this.detectors.size;
  }
}
