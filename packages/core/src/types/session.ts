/**
 * Session types.
 *
 * A session is an ordered sequence of traces sharing a conversation id. Several
 * MAST failure modes are inherently session-scoped rather than trace-scoped —
 * FM-1.4 (loss of conversation history) and FM-2.1 (conversation reset) are
 * defined across turns, and in any real chat application each turn is its own
 * trace. Detecting them therefore requires comparing adjacent traces, which no
 * trace-scoped detector can do.
 */

import type { Severity } from './common.js';

/** One turn's contribution to the session, reduced to what session detectors need. */
export interface SessionTurn {
  readonly traceId: string;
  readonly startTime: number;
  readonly durationMs: number;
  /** Number of messages in the largest input message list on this trace. */
  readonly messageCount: number;
  /** Stable fingerprints of the input messages, oldest first. */
  readonly messageFingerprints: readonly string[];
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly status: 'ok' | 'error' | 'unset';
}

/**
 * Two adjacent turns of one session. Detection compares only the newest pair,
 * so folding a trace into its session is O(1) rather than re-scanning the whole
 * conversation on every turn.
 */
export interface SessionWindow {
  readonly sessionId: string;
  readonly service: string;
  readonly previous: SessionTurn;
  readonly current: SessionTurn;
  /** Turns recorded for this session so far, for context in evidence. */
  readonly turnIndex: number;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly service: string;
  readonly environment: string;
  readonly traceCount: number;
  readonly startTime: number;
  readonly lastSeen: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly findingCount: number;
  readonly errorCount: number;
  readonly worstSeverity?: Severity;
}
