/**
 * L0 tool detectors — TOL-001, TOL-002, TOL-004, TOL-005, RET-001.
 *
 * The action layer: where an AI product stops being a text generator and starts
 * having real-world consequences.
 */

import { stableHash, type Finding, type SpanRecord } from '@anvaya/core';
import { evidence, finding, type Detector } from '../types.js';

export const unknownToolDetector: Detector = {
  id: 'tol.unknown-tool',
  tier: 'L0',
  emits: ['TOL-001'],
  cost: 'free',
  requiresBaseline: false,
  description: 'The model called a tool not present in its declared tool set.',
  supports: (t) => t.byKind.tool.some((s) => (s.tool?.availableTools?.length ?? 0) > 0),
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.tool) {
      const available = span.tool?.availableTools;
      const called = span.tool?.toolName;
      if (!available || available.length === 0 || !called) continue;
      if (available.includes(called)) continue;

      out.push(
        finding({
          ctx,
          detector: unknownToolDetector,
          code: 'TOL-001',
          spanId: span.spanId,
          confidence: 0.95,
          detail: `The model called "${called}", which is not in its declared tool set. Return a structured error naming the valid tools rather than a generic failure.`,
          evidence: [
            evidence('requested', called),
            evidence('availableCount', available.length),
            evidence('available', available.slice(0, 8).join(', ')),
          ],
        }),
      );
    }
    return out;
  },
};

export const toolErrorDetector: Detector = {
  id: 'tol.execution-error',
  tier: 'L0',
  emits: ['TOL-002'],
  cost: 'free',
  requiresBaseline: false,
  description: 'A tool call raised an error or returned a failure status.',
  supports: (t) => t.byKind.tool.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.tool) {
      const failed = span.status === 'error' || Boolean(span.tool?.error);
      if (!failed) continue;

      out.push(
        finding({
          ctx,
          detector: toolErrorDetector,
          code: 'TOL-002',
          spanId: span.spanId,
          confidence: 0.95,
          detail: `Tool "${span.tool?.toolName ?? span.name}" failed. A swallowed tool error becomes a hallucination — the model invents a plausible result. Surface the failure into the agent's context.`,
          evidence: [
            evidence('tool', span.tool?.toolName ?? span.name),
            evidence('attempt', span.tool?.attempt ?? 1),
            evidence(
              'error',
              (span.tool?.error ?? span.statusMessage ?? 'unknown').slice(0, 200),
            ),
          ],
        }),
      );
    }
    return out;
  },
};

/**
 * TOL-004 · Retry storm. Retries without backoff turn a transient blip into a
 * self-inflicted outage, and the cost is unbounded.
 */
export const retryStormDetector: Detector = {
  id: 'tol.retry-storm',
  tier: 'L0',
  emits: ['TOL-004'],
  cost: 'free',
  requiresBaseline: false,
  description: 'The same call was retried beyond threshold, typically without backoff.',
  supports: (t) => t.byKind.tool.length >= 2,
  async run(ctx) {
    const threshold = ctx.thresholds.retryStormAttempts;
    const groups = new Map<string, SpanRecord[]>();

    for (const span of ctx.trace.byKind.tool) {
      const key = `${span.tool?.toolName ?? span.name}|${stableHash(span.tool?.arguments ?? '')}`;
      const group = groups.get(key) ?? [];
      group.push(span);
      groups.set(key, group);
    }

    const out: Finding[] = [];
    for (const [, group] of groups) {
      const attempts =
        Math.max(...group.map((s) => s.tool?.attempt ?? 1), group.length);
      if (attempts < threshold) continue;

      const ordered = [...group].sort((a, b) => a.startTime - b.startTime);
      const gaps: number[] = [];
      for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1];
        const cur = ordered[i];
        if (prev && cur) gaps.push(cur.startTime - prev.endTime);
      }

      // Flat gaps mean fixed-delay retries; growing gaps mean backoff is working.
      const hasBackoff =
        gaps.length >= 2 && gaps.every((g, i) => i === 0 || g >= (gaps[i - 1] ?? 0) * 1.5);

      const anchor = ordered[0];
      if (!anchor) continue;

      out.push(
        finding({
          ctx,
          detector: retryStormDetector,
          code: 'TOL-004',
          spanId: anchor.spanId,
          confidence: hasBackoff ? 0.6 : 0.9,
          severity: hasBackoff ? 'high' : 'critical',
          detail: hasBackoff
            ? `"${anchor.tool?.toolName ?? anchor.name}" retried ${attempts} times with backoff. Cap total attempts, not just attempts per layer — nested retries multiply.`
            : `"${anchor.tool?.toolName ?? anchor.name}" retried ${attempts} times with no observable backoff. Add exponential backoff with jitter and a total attempt cap.`,
          evidence: [
            evidence('tool', anchor.tool?.toolName ?? anchor.name),
            evidence('attempts', attempts),
            evidence('backoffObserved', hasBackoff),
            evidence('gapsMs', gaps.slice(0, 6).join(', ') || 'n/a'),
          ],
        }),
      );
    }
    return out;
  },
};

/** TOL-005 · Excessive agency — OWASP LLM06. The failure mode with real blast radius. */
export const excessiveAgencyDetector: Detector = {
  id: 'tol.excessive-agency',
  tier: 'L0',
  emits: ['TOL-005'],
  cost: 'free',
  requiresBaseline: false,
  description: 'More tools, or higher-privilege tools, than the task required (OWASP LLM06).',
  supports: (t) => t.byKind.tool.length > 0,
  async run(ctx) {
    const tools = ctx.trace.byKind.tool;
    const limit = ctx.thresholds.excessiveToolCalls;
    const out: Finding[] = [];

    const privileged = tools.filter((s) => s.tool?.privileged === true);
    const mutating = tools.filter((s) => s.tool?.mutating === true);

    // A read-only request that performed writes is the sharper signal, so it is
    // reported at higher confidence than raw call volume.
    const taskClass = ctx.trace.trace.attributes['task.class'];
    if (taskClass === 'read-only' && mutating.length > 0) {
      const anchor = mutating[0];
      out.push(
        finding({
          ctx,
          detector: excessiveAgencyDetector,
          code: 'TOL-005',
          ...(anchor ? { spanId: anchor.spanId } : {}),
          confidence: 0.9,
          detail: `A read-only task performed ${mutating.length} state-changing tool call(s). Grant the minimum tool set per task class.`,
          evidence: [
            evidence('taskClass', 'read-only'),
            evidence('mutatingCalls', mutating.length),
            evidence('tools', mutating.map((s) => s.tool?.toolName ?? '?').join(', ')),
          ],
        }),
      );
    }

    if (tools.length > limit) {
      out.push(
        finding({
          ctx,
          detector: excessiveAgencyDetector,
          code: 'TOL-005',
          confidence: 0.6,
          severity: 'high',
          detail: `${tools.length} tool calls in one trace, above the configured ceiling of ${limit}. Check AGT-003 first — a loop produces this shape.`,
          evidence: [
            evidence('toolCalls', tools.length),
            evidence('ceiling', limit),
            evidence('privilegedCalls', privileged.length),
            evidence('distinctTools', ctx.trace.metrics.distinctToolNames.length),
          ],
        }),
      );
    }

    return out;
  },
};

/** RET-001 · Zero retrieval hits — Barnett FP1 (missing content). */
export const zeroRetrievalDetector: Detector = {
  id: 'ret.zero-hits',
  tier: 'L0',
  emits: ['RET-001'],
  cost: 'free',
  requiresBaseline: false,
  description: 'A retrieval returned no documents above the relevance floor (Barnett FP1).',
  supports: (t) => t.byKind.retriever.length > 0,
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.retriever) {
      const docs = span.retrieval?.documents ?? [];
      const threshold = span.retrieval?.scoreThreshold;
      const usable =
        threshold === undefined ? docs : docs.filter((d) => (d.score ?? 1) >= threshold);
      if (usable.length > 0) continue;

      out.push(
        finding({
          ctx,
          detector: zeroRetrievalDetector,
          code: 'RET-001',
          spanId: span.spanId,
          confidence: 0.95,
          detail:
            docs.length === 0
              ? 'Retrieval returned no documents. Either the corpus lacks the content — in which case the product should say so, not answer — or the index is empty or misconfigured.'
              : `All ${docs.length} retrieved documents fell below the relevance threshold of ${threshold}.`,
          evidence: [
            evidence('index', span.retrieval?.indexName ?? 'unknown'),
            evidence('documentsReturned', docs.length),
            evidence('aboveThreshold', usable.length),
            ...(threshold !== undefined ? [evidence('scoreThreshold', threshold)] : []),
          ],
        }),
      );
    }
    return out;
  },
};

export const L0_TOOL_DETECTORS: readonly Detector[] = [
  unknownToolDetector,
  toolErrorDetector,
  retryStormDetector,
  excessiveAgencyDetector,
  zeroRetrievalDetector,
];
