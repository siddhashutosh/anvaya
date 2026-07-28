/**
 * L0 agent detectors — AGT-003, AGT-005, AGT-007, AGT-008, SEC-006.
 *
 * These implement MAST's most frequent failure modes using nothing but the shape
 * of the span tree. That is the central economic argument of the design
 * (ADR-0003): step repetition alone is 17.14% of all observed multi-agent
 * failures and costs a hash-map pass to detect.
 */

import {
  jaccard,
  stableHash,
  tokenize,
  type Finding,
  type SpanRecord,
} from '@anvaya/core';
import { estimateCostUsd } from '../../ingest/pricing.js';
import { evidence, finding, type Detector } from '../types.js';

/**
 * A signature that identifies "the same step" across iterations: kind, name, and
 * a hash of the payload that defines the work being done.
 */
function stepSignature(span: SpanRecord): string {
  const payload =
    span.tool?.arguments ??
    span.retrieval?.query ??
    span.llm?.inputMessages?.map((m) => m.content).join('\n') ??
    '';
  const toolName = span.tool?.toolName ?? '';
  return `${span.kind}|${span.name}|${toolName}|${stableHash(payload)}`;
}

function payloadTokens(span: SpanRecord): Set<string> {
  const payload =
    span.tool?.arguments ?? span.retrieval?.query ?? span.llm?.reasoningText ?? span.name;
  return new Set(tokenize(payload));
}

function spanTokens(span: SpanRecord): number {
  return (span.llm?.inputTokens ?? 0) + (span.llm?.outputTokens ?? 0);
}

function spanCost(span: SpanRecord): number {
  return (
    span.llm?.costUsd ??
    estimateCostUsd(
      span.llm?.responseModel ?? span.llm?.requestModel,
      span.llm?.inputTokens ?? 0,
      span.llm?.outputTokens ?? 0,
      span.llm?.cacheReadTokens ?? 0,
    )
  );
}

/**
 * AGT-003 · Step repetition — MAST FM-1.3, the single most frequent failure mode.
 * Detected as a repeated signature with near-identical payloads. No model call.
 */
export const stepRepetitionDetector: Detector = {
  id: 'agt.step-repetition',
  tier: 'L0',
  emits: ['AGT-003'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Repeated identical steps in the span tree (MAST FM-1.3).',
  supports: (t) => t.spans.length >= 3,
  async run(ctx) {
    const minCount = ctx.thresholds.stepRepetitionCount;
    const minSimilarity = ctx.thresholds.stepRepetitionSimilarity;

    const groups = new Map<string, SpanRecord[]>();
    for (const span of ctx.trace.spans) {
      if (!['tool', 'llm', 'agent', 'retriever'].includes(span.kind)) continue;
      const key = stepSignature(span);
      const group = groups.get(key) ?? [];
      group.push(span);
      groups.set(key, group);
    }

    const out: Finding[] = [];
    for (const [key, group] of groups) {
      if (group.length < minCount) continue;

      // Guard against grouping genuinely different work that happens to share a
      // name: require the payloads to actually be near-identical.
      const similarity = meanPairwiseSimilarity(group);
      if (similarity < minSimilarity) continue;

      const repeats = group.slice(1);
      const wastedTokens = repeats.reduce((sum, s) => sum + spanTokens(s), 0);
      const wastedCost = repeats.reduce((sum, s) => sum + spanCost(s), 0);
      const anchor = group[0];
      if (!anchor) continue;

      out.push(
        finding({
          ctx,
          detector: stepRepetitionDetector,
          code: 'AGT-003',
          spanId: anchor.spanId,
          confidence: Math.min(0.95, 0.5 + 0.1 * (group.length - minCount)),
          detail: `"${anchor.name}" ran ${group.length} times with near-identical input. Add explicit progress state and deduplicate the action history fed back to the agent.`,
          evidence: [
            evidence('step', anchor.name),
            evidence('repetitions', group.length),
            evidence('similarity', Number(similarity.toFixed(2))),
            evidence('wastedTokens', wastedTokens),
            evidence('wastedCostUsd', Number(wastedCost.toFixed(4))),
            evidence('signature', key.slice(0, 80)),
          ],
        }),
      );
    }
    return out;
  },
};

function meanPairwiseSimilarity(spans: readonly SpanRecord[]): number {
  if (spans.length < 2) return 1;
  const tokenSets = spans.map(payloadTokens);
  // Compare each against the first rather than all pairs: O(n) instead of O(n²),
  // and sufficient because a loop repeats the same payload.
  const base = tokenSets[0];
  if (!base) return 1;

  let total = 0;
  for (let i = 1; i < tokenSets.length; i++) {
    const other = tokenSets[i];
    if (other) total += jaccard(base, other);
  }
  return total / (tokenSets.length - 1);
}

/** AGT-005 · Unaware of termination conditions — MAST FM-1.5. */
export const iterationCapDetector: Detector = {
  id: 'agt.iteration-cap',
  tier: 'L0',
  emits: ['AGT-005'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Agent reached or exceeded its iteration ceiling (MAST FM-1.5).',
  supports: (t) => t.byKind.agent.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.agent) {
      const iteration = span.agent?.iteration;
      const max = span.agent?.maxIterations;
      if (iteration === undefined || max === undefined || max <= 0) continue;
      if (iteration < max) continue;

      out.push(
        finding({
          ctx,
          detector: iterationCapDetector,
          code: 'AGT-005',
          spanId: span.spanId,
          confidence: 0.9,
          detail: `Agent "${span.agent?.agentName ?? span.name}" hit its iteration ceiling (${iteration}/${max}) rather than terminating on a goal condition. Make termination an explicit, checkable predicate.`,
          evidence: [
            evidence('agent', span.agent?.agentName ?? span.name),
            evidence('iteration', iteration),
            evidence('maxIterations', max),
            evidence('traceTokens', ctx.trace.metrics.totalTokens),
          ],
        }),
      );
    }
    return out;
  },
};

/** AGT-007 · Premature termination — MAST FM-3.1. */
export const prematureTerminationDetector: Detector = {
  id: 'agt.premature-termination',
  tier: 'L0',
  emits: ['AGT-007'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Agent terminated with declared subtasks unresolved (MAST FM-3.1).',
  supports: (t) => t.byKind.agent.some((s) => (s.agent?.declaredSubtasks?.length ?? 0) > 0),
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.agent) {
      const declared = span.agent?.declaredSubtasks ?? [];
      if (declared.length === 0) continue;

      const completed = new Set(span.agent?.completedSubtasks ?? []);
      const unresolved = declared.filter((task) => !completed.has(task));
      if (unresolved.length === 0) continue;

      // Only a terminated agent has *prematurely* terminated. An in-flight agent
      // with open subtasks is just working.
      if (span.agent?.terminated !== true) continue;

      out.push(
        finding({
          ctx,
          detector: prematureTerminationDetector,
          code: 'AGT-007',
          spanId: span.spanId,
          confidence: 0.85,
          detail: `Agent terminated with ${unresolved.length} of ${declared.length} subtasks unresolved. Do not treat "stopped producing tool calls" as "task complete".`,
          evidence: [
            evidence('declaredSubtasks', declared.length),
            evidence('completedSubtasks', completed.size),
            evidence('unresolved', unresolved.slice(0, 5).join('; ')),
          ],
        }),
      );
    }
    return out;
  },
};

const VERIFICATION_HINTS = ['verify', 'check', 'confirm', 'validate', 'read', 'get', 'fetch', 'list'];

/**
 * AGT-008 · No or incomplete verification — MAST FM-3.2.
 * Structurally detectable: a state-changing tool call with no subsequent read-back.
 */
export const missingVerificationDetector: Detector = {
  id: 'agt.missing-verification',
  tier: 'L0',
  emits: ['AGT-008'],
  cost: 'free',
  requiresBaseline: false,
  description: 'State-changing tool call with no subsequent verification (MAST FM-3.2).',
  supports: (t) => t.byKind.tool.some((s) => s.tool?.mutating === true),
  async run(ctx) {
    const tools = ctx.trace.byKind.tool;
    const out: Finding[] = [];

    for (const span of tools) {
      if (span.tool?.mutating !== true) continue;
      if (span.status === 'error') continue; // TOL-002 owns failed writes.

      const laterSpans = [...tools, ...ctx.trace.byKind.guardrail, ...ctx.trace.byKind.evaluator]
        .filter((s) => s.startTime > span.endTime);

      const verified = laterSpans.some((s) => {
        if (s.kind === 'evaluator' || s.kind === 'guardrail') return true;
        if (s.tool?.mutating === true) return false;
        const name = (s.tool?.toolName ?? s.name).toLowerCase();
        return VERIFICATION_HINTS.some((hint) => name.includes(hint));
      });
      if (verified) continue;

      out.push(
        finding({
          ctx,
          detector: missingVerificationDetector,
          code: 'AGT-008',
          spanId: span.spanId,
          confidence: 0.7,
          detail: `State-changing tool "${span.tool?.toolName}" was not followed by any verification step. Every write should be followed by a read-back.`,
          evidence: [
            evidence('tool', span.tool?.toolName ?? span.name),
            evidence('mutating', true),
            evidence('subsequentSpans', laterSpans.length),
          ],
        }),
      );
    }
    return out;
  },
};

/**
 * SEC-006 · Guardrail bypass. A guardrail whose verdict is ignored is worse than
 * no guardrail — it produces false assurance.
 */
export const guardrailBypassDetector: Detector = {
  id: 'sec.guardrail-bypass',
  tier: 'L0',
  emits: ['SEC-006'],
  cost: 'free',
  requiresBaseline: false,
  description: 'A guardrail ran and its blocking verdict was not enforced.',
  supports: (t) => t.byKind.guardrail.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.guardrail) {
      const blocked =
        span.attributes['guardrail.blocked'] === true ||
        span.attributes['guardrail.verdict'] === 'block' ||
        span.attributes['guardrail.passed'] === false;
      if (!blocked) continue;

      // If the guardrail said block, nothing downstream should have run.
      const downstream = ctx.trace.spans.filter(
        (s) => s.startTime > span.endTime && (s.kind === 'llm' || s.kind === 'tool'),
      );
      if (downstream.length === 0) continue;

      out.push(
        finding({
          ctx,
          detector: guardrailBypassDetector,
          code: 'SEC-006',
          spanId: span.spanId,
          confidence: 0.85,
          detail: `Guardrail "${span.name}" returned a blocking verdict but ${downstream.length} subsequent model/tool call(s) ran anyway.`,
          evidence: [
            evidence('guardrail', span.name),
            evidence('downstreamSpans', downstream.length),
            evidence('firstDownstream', downstream[0]?.name ?? 'unknown'),
          ],
        }),
      );
    }
    return out;
  },
};

export const L0_AGENT_DETECTORS: readonly Detector[] = [
  stepRepetitionDetector,
  iterationCapDetector,
  prematureTerminationDetector,
  missingVerificationDetector,
  guardrailBypassDetector,
];
