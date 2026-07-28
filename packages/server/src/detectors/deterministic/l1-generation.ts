/**
 * L1 generation detectors — GEN-003, GEN-004, GEN-005, GEN-007, GEN-008, AGT-006, AGT-009.
 *
 * Lexical heuristics over span content. Confidence is deliberately capped below
 * the `confirmed` band (0.8) for every semantic judgment here: token overlap is a
 * proxy for entailment, not entailment, and FR-7.9 forbids presenting a proxy as
 * a fact.
 */

import {
  contentTokens,
  longestRepeatedNgram,
  ngramRepetitionRatio,
  overlapRatio,
  splitSentences,
  type Finding,
  type SpanRecord,
} from '@anvaya/core';
import { evidence, finding, type Detector } from '../types.js';

function assistantText(span: SpanRecord): string {
  return (span.llm?.outputMessages ?? [])
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('\n')
    .trim();
}

function userText(span: SpanRecord): string {
  return (span.llm?.inputMessages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n')
    .trim();
}

/** The final assistant-producing LLM span — the one the user actually sees. */
function finalLlmSpan(spans: readonly SpanRecord[]): SpanRecord | undefined {
  const withOutput = spans.filter((s) => assistantText(s).length > 0);
  return withOutput[withOutput.length - 1];
}

/**
 * GEN-004 · Ungrounded claim. Groundedness against retrieved context is the best
 * production signal because it checks a concrete relationship rather than making
 * an open-ended judgment about the world.
 */
export const groundednessDetector: Detector = {
  id: 'gen.groundedness-lexical',
  tier: 'L1',
  emits: ['GEN-004'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Sentences unsupported by retrieved context (lexical overlap proxy).',
  supports: (t) =>
    t.byKind.retriever.length > 0 && t.byKind.llm.some((s) => assistantText(s).length > 0),
  async run(ctx) {
    const answerSpan = finalLlmSpan(ctx.trace.byKind.llm);
    if (!answerSpan) return [];

    const answer = assistantText(answerSpan);
    if (answer.length === 0) return [];

    // Build the source token set from every retrieved document plus tool results.
    const sourceTokens = new Set<string>();
    for (const span of ctx.trace.byKind.retriever) {
      for (const doc of span.retrieval?.documents ?? []) {
        if (doc.content) for (const t of contentTokens(doc.content)) sourceTokens.add(t);
      }
    }
    for (const span of ctx.trace.byKind.tool) {
      if (span.tool?.result) for (const t of contentTokens(span.tool.result)) sourceTokens.add(t);
    }
    // Nothing to ground against: silence is correct, not a finding.
    if (sourceTokens.size === 0) return [];

    const supportFloor = ctx.thresholds.groundednessSupport;
    const sentences = splitSentences(answer);

    const judged: { sentence: string; support: number }[] = [];
    for (const sentence of sentences) {
      // Short sentences are too noisy to judge lexically.
      if (contentTokens(sentence).length < 6) continue;
      judged.push({ sentence, support: overlapRatio(sentence, sourceTokens) });
    }
    if (judged.length === 0) return [];

    const unsupported = judged.filter((j) => j.support < supportFloor);
    const ratio = unsupported.length / judged.length;
    if (ratio <= ctx.thresholds.groundednessUnsupportedRatio) return [];

    const findings: Finding[] = [
      finding({
        ctx,
        detector: groundednessDetector,
        code: 'GEN-004',
        spanId: answerSpan.spanId,
        // Capped at 0.75: this is lexical overlap, not entailment.
        confidence: Math.min(0.75, 0.3 + ratio),
        detail: `${unsupported.length} of ${judged.length} sentences share almost no vocabulary with the retrieved context. Fix retrieval first — check RET-001, RET-002 and RET-003 before rewriting the prompt.`,
        evidence: [
          evidence('method', 'lexical-overlap'),
          evidence('sentencesJudged', judged.length),
          evidence('unsupported', unsupported.length),
          evidence('unsupportedRatio', Number(ratio.toFixed(2))),
          evidence('supportFloor', supportFloor),
          evidence('example', (unsupported[0]?.sentence ?? '').slice(0, 160)),
        ],
      }),
    ];
    return findings;
  },
};

export const schemaViolationDetector: Detector = {
  id: 'gen.schema-violation',
  tier: 'L1',
  emits: ['GEN-005'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Structured output failed to parse (Barnett FP5, OWASP LLM05).',
  supports: (t) => t.byKind.llm.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.llm) {
      // Only judge spans that were asked for structured output.
      const expectsJson =
        span.attributes['output.format'] === 'json' ||
        span.attributes['response_format'] === 'json' ||
        span.attributes['gen_ai.output.type'] === 'json';
      if (!expectsJson) continue;

      const text = assistantText(span);
      if (text.length === 0) continue;

      let parseError: string | undefined;
      try {
        JSON.parse(stripCodeFence(text));
      } catch (e) {
        parseError = e instanceof Error ? e.message : String(e);
      }
      if (!parseError) continue;

      out.push(
        finding({
          ctx,
          detector: schemaViolationDetector,
          code: 'GEN-005',
          spanId: span.spanId,
          confidence: 0.95,
          detail:
            'JSON output failed to parse. Use provider-native structured-output or tool-calling modes rather than asking for JSON in prose.',
          evidence: [
            evidence('parseError', parseError.slice(0, 160)),
            evidence('outputLength', text.length),
            evidence('finishReason', span.llm?.finishReason ?? 'unknown'),
          ],
        }),
      );
    }
    return out;
  },
};

function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text.trim());
  return fenced?.[1] ?? text;
}

export const degenerateOutputDetector: Detector = {
  id: 'gen.degenerate-output',
  tier: 'L1',
  emits: ['GEN-007'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Output is empty, whitespace-only, or pathologically repetitive.',
  supports: (t) => t.byKind.llm.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.llm) {
      // A span with no captured output is not evidence of empty output — content
      // capture may simply be off. Require a reported token count of zero.
      const text = assistantText(span);
      const reportedTokens = span.llm?.outputTokens;

      if (reportedTokens === 0 && span.status !== 'error') {
        out.push(
          finding({
            ctx,
            detector: degenerateOutputDetector,
            code: 'GEN-007',
            spanId: span.spanId,
            confidence: 0.9,
            detail: 'The model returned zero output tokens. Check INF-001 first.',
            evidence: [
              evidence('outputTokens', 0),
              evidence('finishReason', span.llm?.finishReason ?? 'unknown'),
            ],
          }),
        );
        continue;
      }

      if (text.length === 0) continue;

      const ratio = ngramRepetitionRatio(text, 4);
      if (ratio < ctx.thresholds.repetitionRatio) continue;

      const worst = longestRepeatedNgram(text, 4);
      out.push(
        finding({
          ctx,
          detector: degenerateOutputDetector,
          code: 'GEN-007',
          spanId: span.spanId,
          confidence: Math.min(0.85, 0.4 + ratio),
          detail: `${(ratio * 100).toFixed(0)}% of 4-grams in the output are repeats. Usually a sampling-parameter pathology or a degenerate prompt.`,
          evidence: [
            evidence('repetitionRatio', Number(ratio.toFixed(2))),
            evidence('longestRepeat', worst.ngram.slice(0, 80)),
            evidence('repeatCount', worst.count),
            evidence('temperature', span.llm?.temperature ?? -1),
          ],
        }),
      );
    }
    return out;
  },
};

const REFUSAL_PATTERNS = [
  /\bi (?:can(?:'|no)t|am (?:un|not )able to|won'?t) (?:help|assist|provide|answer|comply)/i,
  /\bi'?m (?:sorry|afraid)[^.]{0,40}(?:can(?:'|no)t|unable)/i,
  /\bas an ai (?:language )?model\b/i,
  /\bi (?:do not|don'?t) have (?:access|information|the ability)/i,
];

export const refusalDetector: Detector = {
  id: 'gen.refusal',
  tier: 'L1',
  emits: ['GEN-008'],
  cost: 'free',
  requiresBaseline: false,
  description: 'The model declined to answer. A rising refusal rate is a silent outage.',
  supports: (t) => t.byKind.llm.some((s) => assistantText(s).length > 0),
  async run(ctx) {
    const span = finalLlmSpan(ctx.trace.byKind.llm);
    if (!span) return [];
    const text = assistantText(span);

    const matched = REFUSAL_PATTERNS.find((p) => p.test(text));
    if (!matched) return [];

    return [
      finding({
        ctx,
        detector: refusalDetector,
        code: 'GEN-008',
        spanId: span.spanId,
        // Whether a refusal is *unexpected* depends on policy Anvaya cannot see,
        // so this stays in the "likely" band at most.
        confidence: 0.6,
        detail:
          'The response reads as a refusal. Measure the refusal rate as a first-class metric — if this question is in-policy, an over-triggered safety behaviour or an ambiguous system prompt is the usual cause.',
        evidence: [
          evidence('pattern', matched.source.slice(0, 60)),
          evidence('excerpt', text.slice(0, 160)),
          evidence('outputTokens', span.llm?.outputTokens ?? 0),
        ],
      }),
    ];
  },
};

export const incompleteAnswerDetector: Detector = {
  id: 'gen.incomplete-answer',
  tier: 'L1',
  emits: ['GEN-003'],
  cost: 'free',
  requiresBaseline: false,
  description: 'A multi-part question received a partial response (Barnett FP7).',
  supports: (t) => t.byKind.llm.some((s) => userText(s).length > 0),
  async run(ctx) {
    const span = finalLlmSpan(ctx.trace.byKind.llm);
    if (!span) return [];

    const question = userText(span);
    const answer = assistantText(span);
    if (question.length === 0 || answer.length === 0) return [];

    // Count question marks and enumerated sub-questions as a proxy for parts.
    const questionMarks = (question.match(/\?/g) ?? []).length;
    const enumerated = (question.match(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s+/g) ?? []).length;
    const parts = Math.max(questionMarks, enumerated);
    if (parts < 2) return [];

    const answerSentences = splitSentences(answer).length;
    // A single-sentence answer to a four-part question is the signal.
    if (answerSentences >= parts) return [];

    return [
      finding({
        ctx,
        detector: incompleteAnswerDetector,
        code: 'GEN-003',
        spanId: span.spanId,
        confidence: 0.5,
        detail: `The question appears to have ${parts} parts but the answer has only ${answerSentences} sentence(s). Check CTX-002 first — truncation causes this. Decompose multi-part queries explicitly.`,
        evidence: [
          evidence('detectedParts', parts),
          evidence('answerSentences', answerSentences),
          evidence('questionMarks', questionMarks),
          evidence('enumeratedItems', enumerated),
        ],
      }),
    ];
  },
};

/**
 * AGT-006 · Reasoning-action mismatch — MAST FM-2.6, the second most frequent
 * failure mode, detectable at L1 by set-differencing tool names.
 */
export const reasoningActionMismatchDetector: Detector = {
  id: 'agt.reasoning-action-mismatch',
  tier: 'L1',
  emits: ['AGT-006'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Tools named in reasoning differ from tools actually invoked (MAST FM-2.6).',
  supports: (t) =>
    (t.metrics.distinctToolNames.length > 0 ||
      t.byKind.tool.some((s) => (s.tool?.availableTools?.length ?? 0) > 0)) &&
    [...t.byKind.llm, ...t.byKind.agent].some(
      (s) => (s.llm?.reasoningText ?? s.agent?.reasoningText ?? '').length > 0,
    ),
  async run(ctx) {
    // The vocabulary must include tools that were DECLARED but never invoked —
    // "said it would, didn't" is the more interesting half of this failure, and
    // those names never appear in the invoked-tool list by definition.
    const inventory = new Set<string>(ctx.trace.metrics.distinctToolNames);
    for (const span of ctx.trace.byKind.tool) {
      for (const name of span.tool?.availableTools ?? []) inventory.add(name);
    }
    if (inventory.size === 0) return [];

    const out: Finding[] = [];
    const reasoners = [...ctx.trace.byKind.llm, ...ctx.trace.byKind.agent];

    for (const span of reasoners) {
      const reasoning = span.llm?.reasoningText ?? span.agent?.reasoningText ?? '';
      if (reasoning.length === 0) continue;

      const lower = reasoning.toLowerCase();
      const mentioned = [...inventory].filter((tool) => lower.includes(tool.toLowerCase()));
      if (mentioned.length === 0) continue;

      // Only tools invoked *after* this reasoning count as acting on it.
      const actual = new Set(
        ctx.trace.byKind.tool
          .filter((s) => s.startTime >= span.startTime)
          .map((s) => s.tool?.toolName)
          .filter((n): n is string => typeof n === 'string'),
      );

      const missing = mentioned.filter((tool) => !actual.has(tool));
      const extra = [...actual].filter((tool) => !mentioned.includes(tool));
      const divergence = missing.length + extra.length;
      if (divergence === 0) continue;

      out.push(
        finding({
          ctx,
          detector: reasoningActionMismatchDetector,
          code: 'AGT-006',
          spanId: span.spanId,
          // Capped at 0.8 — lexical mention is not the same as stated intent.
          confidence: Math.min(0.8, 0.45 + 0.1 * divergence),
          detail: `The agent's reasoning references ${mentioned.length} tool(s) but ${missing.length} were never called and ${extra.length} were called without being mentioned. Constrain actions to a declared plan and validate the plan before executing it.`,
          evidence: [
            evidence('mentioned', mentioned.join(', ')),
            evidence('invoked', [...actual].join(', ') || 'none'),
            evidence('saidNotDone', missing.join(', ') || 'none'),
            evidence('doneNotSaid', extra.join(', ') || 'none'),
          ],
        }),
      );
    }
    return out;
  },
};

const AMBIGUITY_MARKERS = [
  /\bit\b(?!\s+is\b)/i,
  /\bthat one\b/i,
  /\bthe (?:other|previous|last) one\b/i,
  /\bsomething like\b/i,
  /\bwhatever\b/i,
];

/** AGT-009 · Fail to ask for clarification — MAST FM-2.2, third most frequent. */
export const missingClarificationDetector: Detector = {
  id: 'agt.missing-clarification',
  tier: 'L1',
  emits: ['AGT-009'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Proceeded on ambiguous input without asking (MAST FM-2.2).',
  supports: (t) => t.byKind.llm.some((s) => userText(s).length > 0),
  async run(ctx) {
    const first = ctx.trace.byKind.llm.find((s) => userText(s).length > 0);
    const last = finalLlmSpan(ctx.trace.byKind.llm);
    if (!first || !last) return [];

    const question = userText(first);
    const answer = assistantText(last);
    if (answer.length === 0) return [];

    // Short input plus a referential pronoun with no antecedent is the shape.
    const shortInput = contentTokens(question).length <= 8;
    const markers = AMBIGUITY_MARKERS.filter((p) => p.test(question));
    if (!shortInput || markers.length === 0) return [];

    // If the model asked a question back, it did the right thing.
    if (/\?\s*$/.test(answer.trim())) return [];

    return [
      finding({
        ctx,
        detector: missingClarificationDetector,
        code: 'AGT-009',
        spanId: last.spanId,
        confidence: 0.5,
        detail:
          'The input is short and contains an unresolved reference, and the system answered rather than asking. Add an explicit "ask a clarifying question" action to the action space.',
        evidence: [
          evidence('inputTokens', contentTokens(question).length),
          evidence('ambiguityMarkers', markers.length),
          evidence('askedBack', false),
          evidence('input', question.slice(0, 120)),
        ],
      }),
    ];
  },
};

export const L1_GENERATION_DETECTORS: readonly Detector[] = [
  groundednessDetector,
  schemaViolationDetector,
  degenerateOutputDetector,
  refusalDetector,
  incompleteAnswerDetector,
  reasoningActionMismatchDetector,
  missingClarificationDetector,
];
