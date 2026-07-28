/**
 * Session-level analysis.
 *
 * Trace-scoped detectors cannot see across turns, but two MAST modes are defined
 * across turns:
 *
 *   FM-1.4 loss of conversation history  → CTX-003
 *   FM-2.1 conversation reset            → CTX-004
 *
 * In any real chat application each user turn is its own trace, so a purely
 * trace-scoped implementation of those two modes can never fire on the case they
 * were derived from. This module closes that gap.
 *
 * Only the newest ADJACENT PAIR of turns is compared, so folding a trace into
 * its session is O(1) per trace rather than re-scanning the whole conversation
 * on every turn — and a given regression is reported once, on the turn where it
 * became visible, rather than repeatedly for the rest of the session.
 */

import {
  TAXONOMY_VERSION,
  newFindingId,
  requireMode,
  stableHash,
  type Finding,
  type Logger,
  type NormalizedTrace,
  type SessionTurn,
  type SessionWindow,
  type SpanRecord,
} from '@anvaya/core';
import type { Thresholds } from '../config/schema.js';

/** Fingerprint a message so turns can be compared without retaining content. */
function fingerprint(role: string, content: string): string {
  return `${role}:${stableHash(content)}`;
}

/**
 * The span carrying the fullest view of the conversation.
 *
 * Ranks on `inputMessageCount` first: that field is metadata and survives
 * `captureContent: false`, which is the configuration session detection must
 * keep working in. Ranking on `inputMessages` alone silently returned nothing
 * in the default privacy posture.
 */
function largestMessageList(spans: readonly SpanRecord[]): SpanRecord['llm'] | undefined {
  let best: SpanRecord['llm'] | undefined;
  let bestLength = -1;
  for (const span of spans) {
    const length = span.llm?.inputMessageCount ?? span.llm?.inputMessages?.length ?? -1;
    if (length > bestLength) {
      bestLength = length;
      best = span.llm;
    }
  }
  return bestLength >= 0 ? best : undefined;
}

/** Reduce a trace to the session-relevant projection. */
export function toSessionTurn(trace: NormalizedTrace): SessionTurn {
  const llm = largestMessageList(trace.byKind.llm);
  const messages = llm?.inputMessages ?? [];

  // The count is metadata and survives content capture being off; fingerprints
  // require content and are simply absent otherwise. Detectors degrade rather
  // than disappear — see detectHistoryLoss.
  const messageCount = llm?.inputMessageCount ?? messages.length;

  return {
    traceId: trace.trace.traceId,
    startTime: trace.trace.startTime,
    durationMs: trace.trace.durationMs,
    messageCount,
    messageFingerprints: messages.map((m) => fingerprint(m.role, m.content)),
    totalTokens: trace.metrics.totalTokens,
    costUsd: trace.metrics.totalCostUsd,
    status: trace.trace.status,
  };
}

export interface SessionDetectionOptions {
  readonly thresholds: Thresholds;
  readonly logger: Logger;
}

function sessionFinding(input: {
  window: SessionWindow;
  code: string;
  detectorId: string;
  confidence: number;
  detail: string;
  evidence: Finding['evidence'];
}): Finding {
  const mode = requireMode(input.code);
  return {
    findingId: newFindingId(),
    // Attached to the CURRENT trace: that is the turn a user would be looking at
    // when they notice the assistant forgot the conversation.
    traceId: input.window.current.traceId,
    code: input.code,
    severity: mode.defaultSeverity,
    confidence: input.confidence,
    detectorId: input.detectorId,
    tier: 'L1',
    title: mode.name,
    detail: input.detail,
    evidence: input.evidence,
    role: 'standalone',
    taxonomyVersion: TAXONOMY_VERSION,
    createdAt: Date.now(),
  };
}

/**
 * CTX-003 · Conversation history loss (MAST FM-1.4).
 *
 * Turns the model saw on the previous request are absent from this one. Compared
 * by fingerprint rather than by count, so a summariser that legitimately
 * *replaces* history is distinguishable from a windowing bug that *drops* it.
 */
export function detectHistoryLoss(
  window: SessionWindow,
  options: SessionDetectionOptions,
): Finding | undefined {
  const { previous, current } = window;
  if (previous.messageCount === 0 || current.messageCount === 0) return undefined;

  // A conversation normally grows. A shrink of one turn is ordinary windowing.
  const minLost = options.thresholds.sessionHistoryLossMessages;
  const lost = previous.messageCount - current.messageCount;
  if (lost < minLost) return undefined;

  // With content capture on, fingerprints separate a windowing bug that DROPS
  // history from a summariser that legitimately REPLACES it. Without them the
  // count alone is still a signal, just a weaker one.
  const haveFingerprints =
    previous.messageFingerprints.length > 0 && current.messageFingerprints.length > 0;

  let dropped = lost;
  let method = 'message-count';

  if (haveFingerprints) {
    const currentSet = new Set(current.messageFingerprints);
    dropped = previous.messageFingerprints.filter((f) => !currentSet.has(f)).length;
    method = 'message-fingerprint';
    if (dropped < minLost) return undefined;
  }

  const retainedRatio =
    previous.messageCount === 0 ? 1 : Math.max(0, 1 - dropped / previous.messageCount);

  return sessionFinding({
    window,
    code: 'CTX-003',
    detectorId: 'session.history-loss',
    // Cross-turn evidence is strong, but a deliberate summarisation step can
    // look identical, so this stays in the `likely` band. Count-only evidence
    // cannot tell the two apart at all and is capped lower again.
    confidence: haveFingerprints
      ? Math.min(0.78, 0.45 + dropped * 0.05)
      : Math.min(0.6, 0.35 + dropped * 0.03),
    detail: `Between turns, the message list fell from ${previous.messageCount} to ${current.messageCount} and ${dropped} previously-present message(s) disappeared. Usually a windowing bug or an over-aggressive summariser — verify the memory layer preserves the turns it claims to.`,
    evidence: [
      { label: 'method', value: method },
      { label: 'sessionId', value: window.sessionId },
      { label: 'turnIndex', value: window.turnIndex },
      { label: 'previousMessages', value: previous.messageCount },
      { label: 'currentMessages', value: current.messageCount },
      { label: 'droppedMessages', value: dropped },
      { label: 'retainedRatio', value: Number(retainedRatio.toFixed(2)) },
      { label: 'previousTrace', value: previous.traceId },
    ],
  });
}

/**
 * CTX-004 · Conversation reset (MAST FM-2.1).
 *
 * The session restarted from a single turn after a substantive conversation, and
 * nothing from the prior context survived.
 */
export function detectConversationReset(
  window: SessionWindow,
  options: SessionDetectionOptions,
): Finding | undefined {
  const { previous, current } = window;

  // Only a real conversation can be "reset"; a couple of turns is not one.
  if (previous.messageCount < options.thresholds.sessionResetMinPriorMessages) return undefined;
  if (current.messageCount > 1) return undefined;

  // Nothing carried over at all — the distinguishing signal versus a window
  // slide. Only checkable when fingerprints exist; on metadata alone the drop
  // from a real conversation to a single message is itself the signal.
  const haveFingerprints =
    previous.messageFingerprints.length > 0 && current.messageFingerprints.length > 0;
  if (haveFingerprints) {
    const currentSet = new Set(current.messageFingerprints);
    const carriedOver = previous.messageFingerprints.filter((f) => currentSet.has(f));
    if (carriedOver.length > 0) return undefined;
  }

  return sessionFinding({
    window,
    code: 'CTX-004',
    detectorId: 'session.conversation-reset',
    confidence: 0.75,
    detail: `The session restarted from ${current.messageCount} message(s) after ${previous.messageCount}, with nothing carried over. Session-key collision, cache eviction, or a failed state load silently falling back to a new session.`,
    evidence: [
      { label: 'sessionId', value: window.sessionId },
      { label: 'turnIndex', value: window.turnIndex },
      { label: 'messagesBefore', value: previous.messageCount },
      { label: 'messagesAfter', value: current.messageCount },
      { label: 'carriedOver', value: 0 },
      { label: 'previousTrace', value: previous.traceId },
    ],
  });
}

const SESSION_DETECTORS = [detectHistoryLoss, detectConversationReset] as const;

/**
 * Runs every session-scoped detector over the newest adjacent pair.
 *
 * Each detector is individually guarded for the same reason trace detectors are
 * (ADR-0006): one failing check must not cost the caller its session analysis.
 */
export class SessionAnalyzer {
  constructor(private readonly options: SessionDetectionOptions) {}

  analyze(window: SessionWindow): readonly Finding[] {
    const findings: Finding[] = [];
    for (const detect of SESSION_DETECTORS) {
      try {
        const finding = detect(window, this.options);
        if (finding) findings.push(finding);
      } catch (e) {
        this.options.logger.warn('session detector failed', {
          err: e,
          sessionId: window.sessionId,
        });
      }
    }
    return findings;
  }
}
