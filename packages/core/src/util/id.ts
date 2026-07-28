/**
 * Identifier generation (DR-1): URL-safe, collision-resistant, and time-sortable
 * where feasible.
 *
 * `randomUUID` is avoided so ids stay short and lexically sortable by creation
 * time, which makes cursor pagination cheap.
 */

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBase36(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    // Non-null assertion avoided: randomBytes(length) always yields `length` bytes,
    // but noUncheckedIndexedAccess requires the guard.
    const b = bytes[i] ?? 0;
    out += ALPHABET[b % 36];
  }
  return out;
}

/** `prefix_<time-base36><random>` — sorts by creation time within a prefix. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBase36(10)}`;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** 32 hex characters, matching the OpenTelemetry trace-id width. */
export function newTraceId(): string {
  return randomHex(16);
}

/** 16 hex characters, matching the OpenTelemetry span-id width. */
export function newSpanId(): string {
  return randomHex(8);
}

export function newFindingId(): string {
  return newId('fnd');
}

export function newIncidentId(): string {
  return newId('inc');
}

export function newRequestId(): string {
  return newId('req');
}

/**
 * Deterministic short hash for grouping keys (step-repetition signatures,
 * incident keys). FNV-1a: fast, non-cryptographic, and stable across runs — the
 * last property matters because signatures are compared across processes.
 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
