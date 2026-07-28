/**
 * Pattern-based redaction (ADR-0007).
 *
 * Two guarantees this module must never break:
 *   1. The redacted value never contains the original secret.
 *   2. A RedactionResult reports the CLASS of what was found and never the value
 *      (NFR-4.4) — a security finding that quotes the secret has re-created the
 *      exposure it is reporting.
 */

import { defaultPatterns, luhnValid, type RedactionPattern, type SecretClass } from './patterns.js';

export type { RedactionPattern, SecretClass };

export interface SecretHit {
  readonly class: SecretClass;
  readonly count: number;
}

export interface RedactionResult {
  readonly value: string;
  readonly hits: readonly SecretHit[];
}

export interface RedactorOptions {
  readonly enabled?: boolean;
  readonly patterns?: readonly RedactionPattern[];
  readonly customPatterns?: readonly RedactionPattern[];
  /** Strings longer than this are truncated before scanning, to bound host CPU cost. */
  readonly maxScanLength?: number;
}

const DEFAULT_MAX_SCAN_LENGTH = 200_000;

export class Redactor {
  private readonly enabled: boolean;
  private readonly patterns: readonly RedactionPattern[];
  private readonly maxScanLength: number;

  constructor(options: RedactorOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.maxScanLength = options.maxScanLength ?? DEFAULT_MAX_SCAN_LENGTH;
    this.patterns = [
      ...(options.patterns ?? defaultPatterns()),
      ...(options.customPatterns ?? []),
    ].filter((p) => p.enabled);
  }

  /** Replace every match; report only the classes found. */
  redact(value: string): RedactionResult {
    if (!this.enabled || value.length === 0) return { value, hits: [] };

    const input = value.length > this.maxScanLength ? value.slice(0, this.maxScanLength) : value;
    const tail = value.length > this.maxScanLength ? value.slice(this.maxScanLength) : '';

    const counts = new Map<SecretClass, number>();
    let out = input;

    for (const p of this.patterns) {
      // Fresh RegExp each pass: /g patterns carry lastIndex state.
      const re = new RegExp(p.pattern.source, p.pattern.flags);
      out = out.replace(re, (match) => {
        if (p.name === 'credit_card' && !luhnValid(match)) return match;
        counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
        return p.replacement;
      });
    }

    return {
      value: out + tail,
      hits: [...counts.entries()].map(([cls, count]) => ({ class: cls, count })),
    };
  }

  /** Detect without mutating. Drives SEC-003 sensitive-information-disclosure. */
  scan(value: string): readonly SecretHit[] {
    return this.redact(value).hits;
  }

  /**
   * Deep-walk an object, redacting every string. Structure and non-string values
   * are preserved. Cycles are handled; depth is bounded.
   */
  redactObject<T>(obj: T, maxDepth = 8): { value: T; hits: readonly SecretHit[] } {
    if (!this.enabled) return { value: obj, hits: [] };

    const counts = new Map<SecretClass, number>();
    const seen = new WeakSet<object>();

    const walk = (node: unknown, depth: number): unknown => {
      if (depth > maxDepth) return node;
      if (typeof node === 'string') {
        const result = this.redact(node);
        for (const hit of result.hits) {
          counts.set(hit.class, (counts.get(hit.class) ?? 0) + hit.count);
        }
        return result.value;
      }
      if (node === null || typeof node !== 'object') return node;
      if (seen.has(node)) return '[Circular]';
      seen.add(node);

      if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
      if (node instanceof Error) return node.message;

      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(node)) {
        out[key] = walk(val, depth + 1);
      }
      return out;
    };

    return {
      value: walk(obj, 0) as T,
      hits: [...counts.entries()].map(([cls, count]) => ({ class: cls, count })),
    };
  }
}

/** Shared instance for callers that do not need custom patterns. */
export const defaultRedactor = new Redactor();
