/**
 * L1 context and retrieval detectors — CTX-002..CTX-005, RET-003, RET-005, RET-006, ECO-005.
 *
 * RET-003 (consolidation loss) is the notable one: the gap between "retrieved"
 * and "actually in the prompt" is where reranking cutoffs, dedup and token
 * budgets silently discard the answer, and it is one of the most
 * under-instrumented steps in a RAG stack (Barnett FP3).
 */

import {
  DAY,
  contentTokens,
  estimateTokens,
  jaccard,
  type Finding,
  type SpanRecord,
} from '@anvaya/core';
import { evidence, finding, type Detector } from '../types.js';

function promptText(span: SpanRecord): string {
  const system = span.llm?.systemInstructions ?? '';
  const messages = (span.llm?.inputMessages ?? []).map((m) => m.content).join('\n');
  return `${system}\n${messages}`;
}

/** CTX-002 · Context truncation (Barnett FP3). */
export const promptTruncationDetector: Detector = {
  id: 'ctx.truncation',
  tier: 'L1',
  emits: ['CTX-002'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Content was dropped during prompt assembly.',
  // Gates on the intended-token attribute rather than on captured messages:
  // this detector works on metadata alone, so requiring content would disable it
  // in the default (captureContent: false) configuration.
  supports: (t) =>
    t.byKind.llm.some((s) => typeof s.attributes['prompt.intended_tokens'] === 'number'),
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.llm) {
      const intended = span.attributes['prompt.intended_tokens'];
      if (typeof intended !== 'number' || intended <= 0) continue;

      const actual = span.llm?.inputTokens ?? estimateTokens(promptText(span));
      // 2% tolerance absorbs tokenizer estimation noise.
      if (actual >= intended * 0.98) continue;

      const dropped = intended - actual;
      out.push(
        finding({
          ctx,
          detector: promptTruncationDetector,
          code: 'CTX-002',
          spanId: span.spanId,
          confidence: 0.85,
          detail: `${dropped} tokens were dropped during prompt assembly. Truncation is usually silent and usually drops the middle — make the assembly step explicit and log what it discarded.`,
          evidence: [
            evidence('intendedTokens', intended),
            evidence('actualTokens', actual),
            evidence('droppedTokens', dropped),
          ],
        }),
      );
    }
    return out;
  },
};

/**
 * CTX-003 · Conversation history loss — MAST FM-1.4, WITHIN a single trace.
 *
 * This catches the narrower case of one request making several model calls and
 * losing turns between them. The cross-trace case — which is the normal shape of
 * a chat application, one trace per turn — is handled by the session analyzer in
 * `analysis/session.ts`, because no trace-scoped detector can see it.
 */
export const historyLossDetector: Detector = {
  id: 'ctx.history-loss',
  tier: 'L1',
  emits: ['CTX-003'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Turns lost between model calls within one trace (MAST FM-1.4, intra-trace).',
  supports: (t) => t.byKind.llm.length >= 2,
  async run(ctx) {
    const spans = ctx.trace.byKind.llm.filter((s) => (s.llm?.inputMessages?.length ?? 0) > 0);
    if (spans.length < 2) return [];

    const out: Finding[] = [];
    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1];
      const cur = spans[i];
      if (!prev || !cur) continue;

      const prevTurns = prev.llm?.inputMessages?.length ?? 0;
      const curTurns = cur.llm?.inputMessages?.length ?? 0;
      // Message lists should grow within a session; shrinking means turns went missing.
      if (curTurns >= prevTurns || prevTurns === 0) continue;

      const lost = prevTurns - curTurns;
      // A single-turn shift is ordinary windowing; a large drop is not.
      if (lost < 2) continue;

      out.push(
        finding({
          ctx,
          detector: historyLossDetector,
          code: 'CTX-003',
          spanId: cur.spanId,
          confidence: 0.65,
          detail: `The message list shrank from ${prevTurns} to ${curTurns} turns between consecutive calls. Usually a windowing bug or an over-aggressive summariser — verify the memory layer preserves the turns it claims to.`,
          evidence: [
            evidence('previousTurns', prevTurns),
            evidence('currentTurns', curTurns),
            evidence('lostTurns', lost),
            evidence('sessionId', ctx.trace.trace.sessionId ?? 'none'),
          ],
        }),
      );
    }
    return out;
  },
};

/**
 * CTX-004 · Conversation reset — MAST FM-2.1, WITHIN a single trace.
 * The cross-trace case is handled by the session analyzer; see above.
 */
export const conversationResetDetector: Detector = {
  id: 'ctx.conversation-reset',
  tier: 'L1',
  emits: ['CTX-004'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Message list restarted between calls in one trace (MAST FM-2.1, intra-trace).',
  supports: (t) => Boolean(t.trace.sessionId) && t.byKind.llm.length >= 2,
  async run(ctx) {
    const spans = ctx.trace.byKind.llm.filter((s) => s.llm?.inputMessages !== undefined);
    if (spans.length < 2) return [];

    const out: Finding[] = [];
    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1];
      const cur = spans[i];
      if (!prev || !cur) continue;

      const prevTurns = prev.llm?.inputMessages?.length ?? 0;
      const curTurns = cur.llm?.inputMessages?.length ?? 0;
      // Back to a single user turn after a real conversation is a reset, not a window.
      if (prevTurns < 3 || curTurns > 1) continue;

      out.push(
        finding({
          ctx,
          detector: conversationResetDetector,
          code: 'CTX-004',
          spanId: cur.spanId,
          confidence: 0.7,
          detail: `The conversation restarted from ${curTurns} turn(s) after ${prevTurns}. Session-key collision, cache eviction, or a failed state load silently falling back to a new session.`,
          evidence: [
            evidence('turnsBefore', prevTurns),
            evidence('turnsAfter', curTurns),
            evidence('sessionId', ctx.trace.trace.sessionId ?? 'none'),
          ],
        }),
      );
    }
    return out;
  },
};

/** CTX-005 · Malformed input. */
export const malformedInputDetector: Detector = {
  id: 'ctx.malformed-input',
  tier: 'L1',
  emits: ['CTX-005'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Empty or out-of-bounds user input reached the model.',
  supports: (t) => t.byKind.llm.some((s) => (s.llm?.inputMessages?.length ?? 0) > 0),
  async run(ctx) {
    const first = ctx.trace.byKind.llm.find((s) => (s.llm?.inputMessages?.length ?? 0) > 0);
    if (!first) return [];

    const userMessages = (first.llm?.inputMessages ?? []).filter((m) => m.role === 'user');
    if (userMessages.length === 0) return [];

    const text = userMessages.map((m) => m.content).join('\n').trim();
    if (text.length > 0) return [];

    return [
      finding({
        ctx,
        detector: malformedInputDetector,
        code: 'CTX-005',
        spanId: first.spanId,
        confidence: 0.9,
        detail:
          'Empty user input reached the model. Validate before spending an inference call — this means an upstream validation gap.',
        evidence: [
          evidence('userMessages', userMessages.length),
          evidence('inputLength', 0),
        ],
      }),
    ];
  },
};

/** RET-003 · Consolidation loss — Barnett FP3. */
export const consolidationLossDetector: Detector = {
  id: 'ret.consolidation-loss',
  tier: 'L1',
  emits: ['RET-003'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Documents were retrieved but never reached the prompt (Barnett FP3).',
  supports: (t) =>
    t.byKind.retriever.some((s) => (s.retrieval?.documents ?? []).some((d) => d.content)) &&
    t.byKind.llm.some((s) => promptText(s).trim().length > 0),
  async run(ctx) {
    const retrieved = ctx.trace.byKind.retriever.flatMap((s) => s.retrieval?.documents ?? []);
    const withContent = retrieved.filter((d) => d.content && d.content.length > 20);
    if (withContent.length === 0) return [];

    // Which documents made it into any prompt issued after retrieval?
    const promptTokenSets = ctx.trace.byKind.llm.map((s) => new Set(contentTokens(promptText(s))));
    if (promptTokenSets.length === 0) return [];

    const dropped: string[] = [];
    for (const doc of withContent) {
      const docTokens = new Set(contentTokens(doc.content ?? ''));
      if (docTokens.size === 0) continue;

      const present = promptTokenSets.some((prompt) => {
        let hits = 0;
        for (const t of docTokens) if (prompt.has(t)) hits++;
        return hits / docTokens.size >= 0.5;
      });
      if (!present) dropped.push(doc.id);
    }

    if (dropped.length === 0) return [];

    const ratio = dropped.length / withContent.length;
    return [
      finding({
        ctx,
        detector: consolidationLossDetector,
        code: 'RET-003',
        spanId: ctx.trace.byKind.retriever[0]?.spanId,
        confidence: Math.min(0.75, 0.35 + ratio * 0.5),
        detail: `${dropped.length} of ${withContent.length} retrieved documents do not appear in any prompt. This is where reranking cutoffs, dedup and token budgets silently discard the answer.`,
        evidence: [
          evidence('retrieved', withContent.length),
          evidence('missingFromPrompt', dropped.length),
          evidence('droppedRatio', Number(ratio.toFixed(2))),
          evidence('droppedIds', dropped.slice(0, 6).join(', ')),
        ],
      }),
    ];
  },
};

/** RET-005 · Redundant retrieval. */
export const redundantRetrievalDetector: Detector = {
  id: 'ret.redundant',
  tier: 'L1',
  emits: ['RET-005'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Near-duplicate chunks consuming context budget without adding information.',
  supports: (t) =>
    t.byKind.retriever.some((s) => (s.retrieval?.documents ?? []).filter((d) => d.content).length >= 3),
  async run(ctx) {
    const out: Finding[] = [];

    for (const span of ctx.trace.byKind.retriever) {
      const docs = (span.retrieval?.documents ?? []).filter((d) => d.content);
      if (docs.length < 3) continue;

      const tokenSets = docs.map((d) => new Set(contentTokens(d.content ?? '')));
      let duplicatePairs = 0;
      let wastedTokens = 0;

      for (let i = 0; i < tokenSets.length; i++) {
        for (let j = i + 1; j < tokenSets.length; j++) {
          const a = tokenSets[i];
          const b = tokenSets[j];
          if (!a || !b) continue;
          if (jaccard(a, b) >= 0.8) {
            duplicatePairs++;
            wastedTokens += estimateTokens(docs[j]?.content ?? '');
          }
        }
      }

      const maxPairs = (docs.length * (docs.length - 1)) / 2;
      const ratio = maxPairs === 0 ? 0 : duplicatePairs / maxPairs;
      if (ratio < ctx.thresholds.duplicateRetrievalRatio) continue;

      out.push(
        finding({
          ctx,
          detector: redundantRetrievalDetector,
          code: 'RET-005',
          spanId: span.spanId,
          confidence: 0.7,
          detail: `${duplicatePairs} near-duplicate document pairs among ${docs.length} results. Overlapping chunk windows are the usual cause — dedup at index time and at retrieval time.`,
          evidence: [
            evidence('documents', docs.length),
            evidence('duplicatePairs', duplicatePairs),
            evidence('duplicateRatio', Number(ratio.toFixed(2))),
            evidence('wastedTokensEstimate', wastedTokens),
          ],
        }),
      );
    }
    return out;
  },
};

/** RET-006 · Index staleness. An indexing pipeline that silently stopped is a classic. */
export const indexStalenessDetector: Detector = {
  id: 'ret.index-staleness',
  tier: 'L1',
  emits: ['RET-006'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Retrieved documents are older than the configured freshness bound.',
  supports: (t) =>
    t.byKind.retriever.some((s) => (s.retrieval?.documents ?? []).some((d) => d.timestamp)),
  async run(ctx) {
    const boundMs = ctx.thresholds.indexStalenessDays * DAY;
    const now = ctx.trace.trace.startTime;
    const out: Finding[] = [];

    for (const span of ctx.trace.byKind.retriever) {
      const dated = (span.retrieval?.documents ?? []).filter(
        (d): d is typeof d & { timestamp: number } => typeof d.timestamp === 'number',
      );
      if (dated.length === 0) continue;

      const newest = Math.max(...dated.map((d) => d.timestamp));
      const age = now - newest;
      if (age < boundMs) continue;

      out.push(
        finding({
          ctx,
          detector: indexStalenessDetector,
          code: 'RET-006',
          spanId: span.spanId,
          confidence: 0.75,
          detail: `The newest retrieved document is ${Math.round(age / DAY)} days old. Alert on index write recency, not only on read quality — a stopped indexing pipeline goes undetected for a long time.`,
          evidence: [
            evidence('newestDocumentAgeDays', Math.round(age / DAY)),
            evidence('freshnessBoundDays', ctx.thresholds.indexStalenessDays),
            evidence('datedDocuments', dated.length),
            evidence('index', span.retrieval?.indexName ?? 'unknown'),
          ],
        }),
      );
    }
    return out;
  },
};

/** ECO-005 · Cache inefficiency. A varying prefix defeats prefix caching entirely. */
export const cacheEfficiencyDetector: Detector = {
  id: 'eco.cache-efficiency',
  tier: 'L1',
  emits: ['ECO-005'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Prompt-cache hit ratio below expectation for a stable-prefix workload.',
  supports: (t) =>
    t.byKind.llm.some(
      (s) => s.llm?.cacheReadTokens !== undefined || s.llm?.cacheCreationTokens !== undefined,
    ),
  async run(ctx) {
    const spans = ctx.trace.byKind.llm.filter(
      (s) => (s.llm?.inputTokens ?? 0) >= ctx.thresholds.minCachedPromptTokens,
    );
    if (spans.length < 2) return [];

    const totalInput = spans.reduce((n, s) => n + (s.llm?.inputTokens ?? 0), 0);
    const totalRead = spans.reduce((n, s) => n + (s.llm?.cacheReadTokens ?? 0), 0);
    const totalCreated = spans.reduce((n, s) => n + (s.llm?.cacheCreationTokens ?? 0), 0);

    // Caching was never attempted; that is a configuration choice, not a defect.
    if (totalRead === 0 && totalCreated === 0) return [];

    const hitRatio = totalInput === 0 ? 0 : totalRead / totalInput;
    if (hitRatio >= ctx.thresholds.cacheHitRatioFloor) return [];

    return [
      finding({
        ctx,
        detector: cacheEfficiencyDetector,
        code: 'ECO-005',
        confidence: 0.7,
        detail: `Cache hit ratio is ${(hitRatio * 100).toFixed(1)}% across ${spans.length} large prompts. A varying prefix — a timestamp or a shuffled tool list at the top of the system prompt — defeats prefix caching entirely. Order the prompt stable-first.`,
        evidence: [
          evidence('hitRatio', Number(hitRatio.toFixed(3))),
          evidence('floor', ctx.thresholds.cacheHitRatioFloor),
          evidence('cacheReadTokens', totalRead),
          evidence('cacheCreationTokens', totalCreated),
          evidence('totalInputTokens', totalInput),
        ],
      }),
    ];
  },
};

export const L1_CONTEXT_DETECTORS: readonly Detector[] = [
  promptTruncationDetector,
  historyLossDetector,
  conversationResetDetector,
  malformedInputDetector,
  consolidationLossDetector,
  redundantRetrievalDetector,
  indexStalenessDetector,
  cacheEfficiencyDetector,
];
