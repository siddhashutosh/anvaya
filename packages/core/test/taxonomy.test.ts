/**
 * Taxonomy integrity (AC-14).
 *
 * The catalog is the spec's executable form, so these tests assert the two
 * things that would silently break it: internal inconsistency, and divergence
 * from docs/04-failure-taxonomy.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  TAXONOMY_FAMILIES,
  TAXONOMY_VERSION,
  allCodes,
  byFamily,
  causalDistance,
  getMode,
  isCausedBy,
  modesByObservedFrequency,
  requireMode,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(here, '../../../docs/04-failure-taxonomy.md');

describe('taxonomy catalog', () => {
  it('has 57 modes across 8 families', () => {
    expect(CATALOG).toHaveLength(57);
    expect(TAXONOMY_FAMILIES).toHaveLength(8);
  });

  it('has unique, well-formed codes', () => {
    const codes = allCodes();
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^(INF|CTX|RET|GEN|AGT|TOL|SEC|ECO)-\d{3}$/);
    }
  });

  it('numbers each family gaplessly from 001', () => {
    for (const family of TAXONOMY_FAMILIES) {
      const numbers = byFamily(family)
        .map((m) => Number(m.code.split('-')[1]))
        .sort((a, b) => a - b);
      expect(numbers[0], `${family} starts at 001`).toBe(1);
      numbers.forEach((n, i) => expect(n, `${family} is gapless`).toBe(i + 1));
    }
  });

  it('gives every mode a definition, remediation, and source', () => {
    for (const mode of CATALOG) {
      expect(mode.definition.length, mode.code).toBeGreaterThan(20);
      expect(mode.remediation.length, mode.code).toBeGreaterThan(20);
      expect(mode.source.ref.length, mode.code).toBeGreaterThan(3);
      expect(mode.evidenceRequired.length, mode.code).toBeGreaterThan(0);
    }
  });

  it('only references codes that exist in causes edges', () => {
    for (const mode of CATALOG) {
      for (const target of mode.causes) {
        expect(getMode(target), `${mode.code} -> ${target}`).toBeDefined();
      }
    }
  });

  it('has no self-referential causes', () => {
    for (const mode of CATALOG) {
      expect(mode.causes, mode.code).not.toContain(mode.code);
    }
  });

  it('resolves transitive causal chains within the depth bound', () => {
    // The canonical propagation from Barnett: retrieval collapse surfaces as a
    // hallucination, which surfaces as a wrong answer.
    expect(isCausedBy('GEN-004', 'RET-002')).toBe(true);
    expect(causalDistance('RET-002', 'GEN-004')).toBe(1);
    expect(causalDistance('RET-002', 'GEN-008')).toBe(2);
    // And nothing spurious in reverse.
    expect(isCausedBy('RET-002', 'GEN-004')).toBe(false);
  });

  it('does not model drift as a cause of anything', () => {
    // Drift is a leading indicator. Modelling it as a cause makes it outrank the
    // real origin during attribution.
    expect(getMode('ECO-003')?.causes).toEqual([]);
  });

  it('covers all 14 MAST modes', () => {
    const mastCodes = [
      'AGT-001', 'AGT-002', 'AGT-003', 'CTX-003', 'AGT-005',
      'CTX-004', 'AGT-009', 'AGT-004', 'AGT-010', 'AGT-011',
      'AGT-006', 'AGT-007', 'AGT-008', 'AGT-012',
    ];
    for (const code of mastCodes) {
      const mode = requireMode(code);
      expect(mode.source.ref, code).toMatch(/MAST FM-\d\.\d/);
    }
    expect(new Set(mastCodes).size).toBe(14);
  });

  it("covers all 7 of Barnett's RAG failure points", () => {
    const fps = ['RET-001', 'RET-002', 'RET-003', 'GEN-001', 'GEN-005', 'GEN-002', 'GEN-003'];
    for (const code of fps) {
      expect(requireMode(code).source.ref, code).toMatch(/Barnett/);
    }
  });

  it('records MAST measured frequencies that sum to roughly 1', () => {
    const withFrequency = modesByObservedFrequency();
    expect(withFrequency.length).toBe(14);
    const total = withFrequency.reduce((sum, m) => sum + (m.observedFrequency ?? 0), 0);
    expect(total).toBeGreaterThan(0.98);
    expect(total).toBeLessThan(1.02);
    // Step repetition is the most frequent mode, which is why it is an L0 detector.
    expect(withFrequency[0]?.code).toBe('AGT-003');
    expect(withFrequency[0]?.tier).toBe('L0');
  });

  it('detects the top three MAST modes for free, together 42.8% of failures', () => {
    const topThree = modesByObservedFrequency().slice(0, 3);
    expect(topThree.map((m) => m.code)).toEqual(['AGT-003', 'AGT-006', 'AGT-009']);
    expect(topThree.every((m) => m.tier === 'L0' || m.tier === 'L1')).toBe(true);

    const share = topThree.reduce((sum, m) => sum + (m.observedFrequency ?? 0), 0);
    expect(share).toBeCloseTo(0.4277, 3);
  });

  it('needs the judge tier for exactly one of the five most frequent modes', () => {
    const topFive = modesByObservedFrequency().slice(0, 5);
    const judgeOnly = topFive.filter((m) => m.tier === 'L3');

    // FM-1.1 "disobey task specification" is genuinely semantic — no structural
    // signal identifies it, so it is the one common mode L0-L2 cannot reach.
    expect(judgeOnly.map((m) => m.code)).toEqual(['AGT-001']);

    const cheapShare = topFive
      .filter((m) => m.tier !== 'L3')
      .reduce((sum, m) => sum + (m.observedFrequency ?? 0), 0);
    expect(cheapShare).toBeCloseTo(0.5259, 3);
  });

  it('throws a typed error for an unknown code', () => {
    expect(() => requireMode('XXX-999')).toThrow(/Unknown taxonomy code/);
    expect(getMode('XXX-999')).toBeUndefined();
  });
});

// The design record is kept out of the published repository, so on a fresh
// clone there is nothing to compare against. Skipping is right here rather than
// failing: this suite guards the catalog against drifting from the prose spec,
// and where the prose is absent there is no drift to detect. The catalog tests
// above still run everywhere — they are the invariants a consumer depends on.
const HAS_DOC = existsSync(DOC_PATH);

describe.skipIf(!HAS_DOC)('catalog agrees with the taxonomy document (AC-14)', () => {
  // Read guarded, not just skipped: a describe body is evaluated during
  // collection even when every test inside it will be skipped, so an
  // unconditional read here fails the whole file before the skip applies.
  const doc = HAS_DOC ? readFileSync(DOC_PATH, 'utf8') : '';

  it('documents every code in the catalog', () => {
    for (const mode of CATALOG) {
      expect(doc, `${mode.code} must appear in the taxonomy document`).toContain(mode.code);
    }
  });

  it('documents every code with its exact name', () => {
    for (const mode of CATALOG) {
      expect(doc, `${mode.code} · ${mode.name}`).toContain(`${mode.code} · ${mode.name}`);
    }
  });

  it('declares the same version', () => {
    expect(doc).toContain(`Failure Taxonomy — v${TAXONOMY_VERSION}`);
  });

  it('declares the same mode count', () => {
    expect(doc).toContain(`${CATALOG.length} modes across 8 families`);
  });
});
