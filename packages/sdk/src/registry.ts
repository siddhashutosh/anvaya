/**
 * Module-level client registry.
 *
 * Kept separate from client.ts so `observe*` helpers can reach the active client
 * without a circular import.
 */

import type { AnvayaClient } from './client.js';

let active: AnvayaClient | undefined;

export function setClient(client: AnvayaClient): void {
  active = client;
}

/** Undefined before init(). Every consumer must handle that (IF-1.1). */
export function getClient(): AnvayaClient | undefined {
  return active;
}

export function clearClient(): void {
  active = undefined;
}
