/**
 * CausalAttributor — turns findings into a diagnosis (HLD §8).
 *
 * This is the component that distinguishes Anvaya from a trace viewer. Detection
 * says "these six things are wrong"; attribution says "this one thing is wrong
 * and the other five are its consequences".
 *
 * That distinction is also the primary defence against false-positive fatigue:
 * 34 traces with one root cause should be one page, not thirty-four.
 */

import {
  SEVERITY_RANK,
  causalDistance,
  getMode,
  isCausedBy,
  type Attribution,
  type AttributionLink,
  type Finding,
  type NormalizedTrace,
} from '@anvaya/core';

export interface AttributionResult {
  readonly findings: readonly Finding[];
  readonly attribution: Attribution;
}

export class CausalAttributor {
  attribute(trace: NormalizedTrace, findings: readonly Finding[]): AttributionResult {
    if (findings.length === 0) {
      return {
        findings,
        attribution: { traceId: trace.trace.traceId, chain: [], summary: 'No findings.' },
      };
    }

    // Pass 1 — causal ordering: earliest and shallowest first, severity breaking ties.
    const ordered = [...findings].sort((a, b) => {
      const at = this.spanStart(trace, a);
      const bt = this.spanStart(trace, b);
      if (at !== bt) return at - bt;
      const ad = this.depth(trace, a);
      const bd = this.depth(trace, b);
      if (ad !== bd) return ad - bd;
      return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    });

    // Pass 2 — apply taxonomy propagation edges.
    //
    // Each downstream finding is linked to its NEAREST cause, not merely to the
    // first one found. With RET-002 -> GEN-004 -> GEN-008 all present, linking
    // GEN-008 to RET-002 (distance 2) is technically true but loses the
    // propagation path; linking it to GEN-004 (distance 1) renders the chain the
    // way the failure actually travelled.
    const roles = new Map<string, { role: Finding['role']; causedBy?: string }>();
    for (const f of ordered) roles.set(f.findingId, { role: 'standalone' });

    for (let j = 0; j < ordered.length; j++) {
      const downstream = ordered[j];
      if (!downstream) continue;

      let best: { finding: Finding; distance: number } | undefined;

      for (let i = 0; i < j; i++) {
        const upstream = ordered[i];
        if (!upstream) continue;
        if (!isCausedBy(downstream.code, upstream.code)) continue;

        // The upstream finding must actually precede the downstream one, either
        // in time or by being its ancestor in the span tree.
        if (!this.precedes(trace, upstream, downstream)) continue;

        const distance = causalDistance(upstream.code, downstream.code);
        if (distance <= 0) continue;
        if (!best || distance < best.distance) best = { finding: upstream, distance };
      }

      if (best) {
        roles.set(downstream.findingId, { role: 'symptom', causedBy: best.finding.findingId });
      }
    }

    // Pass 3 — pick the origin from what remains unexplained.
    const candidates = ordered.filter((f) => roles.get(f.findingId)?.role !== 'symptom');
    const origin = this.pickOrigin(candidates);

    if (origin) {
      roles.set(origin.findingId, { role: 'origin' });
    }

    const resolved = ordered.map((f) => {
      const entry = roles.get(f.findingId);
      return {
        ...f,
        role: entry?.role ?? 'standalone',
        ...(entry?.causedBy !== undefined ? { causedBy: entry.causedBy } : {}),
      } satisfies Finding;
    });

    const chain = origin ? this.buildChain(resolved, origin.findingId) : [];

    return {
      findings: resolved,
      attribution: {
        traceId: trace.trace.traceId,
        ...(origin ? { originFindingId: origin.findingId } : {}),
        chain,
        summary: this.summarise(trace, resolved, origin),
      },
    };
  }

  private pickOrigin(candidates: readonly Finding[]): Finding | undefined {
    if (candidates.length === 0) return undefined;
    // Prefer severity, then confidence, then earliest — a high-confidence critical
    // finding is a better diagnosis than an early low-confidence guess.
    return [...candidates].sort((a, b) => {
      const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sev !== 0) return sev;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.createdAt - b.createdAt;
    })[0];
  }

  private buildChain(findings: readonly Finding[], originId: string): Attribution['chain'] {
    const byCause = new Map<string, Finding[]>();
    for (const f of findings) {
      if (!f.causedBy) continue;
      const list = byCause.get(f.causedBy) ?? [];
      list.push(f);
      byCause.set(f.causedBy, list);
    }

    const chain: AttributionLink[] = [];
    const seen = new Set<string>();
    let current = findings.find((f) => f.findingId === originId);

    // Depth-bounded walk: a cyclic causedBy graph must not hang the pipeline.
    while (current && !seen.has(current.findingId) && chain.length < 8) {
      seen.add(current.findingId);
      chain.push({ findingId: current.findingId, code: current.code, title: current.title });
      // Follow the most severe consequence at each step.
      const next = (byCause.get(current.findingId) ?? []).sort(
        (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
      )[0];
      current = next;
    }
    return chain;
  }

  private summarise(
    trace: NormalizedTrace,
    findings: readonly Finding[],
    origin: Finding | undefined,
  ): string {
    if (!origin) return `${findings.length} finding(s), no single origin identified.`;

    const mode = getMode(origin.code);
    const spanName = origin.spanId ? trace.index.get(origin.spanId)?.name : undefined;
    const symptoms = findings.filter((f) => f.causedBy === origin.findingId);

    const where = spanName ? ` at "${spanName}"` : '';
    const head = `${mode?.name ?? origin.code}${where} is the likely origin`;

    if (symptoms.length === 0) return `${head}.`;
    const names = symptoms.map((s) => getMode(s.code)?.name ?? s.code).join(', ');
    return `${head}, which produced ${symptoms.length} downstream symptom(s): ${names}.`;
  }

  private spanStart(trace: NormalizedTrace, finding: Finding): number {
    if (!finding.spanId) return trace.trace.startTime;
    return trace.index.get(finding.spanId)?.startTime ?? trace.trace.startTime;
  }

  private depth(trace: NormalizedTrace, finding: Finding): number {
    if (!finding.spanId) return 0;
    return trace.ancestors.get(finding.spanId)?.length ?? 0;
  }

  private precedes(trace: NormalizedTrace, upstream: Finding, downstream: Finding): boolean {
    const upSpan = upstream.spanId ? trace.index.get(upstream.spanId) : undefined;
    const downSpan = downstream.spanId ? trace.index.get(downstream.spanId) : undefined;

    // Trace-level findings have no span; ordering falls back to detection time.
    if (!upSpan || !downSpan) return upstream.createdAt <= downstream.createdAt;
    if (upSpan.startTime <= downSpan.startTime) return true;

    // An ancestor span encloses its descendants, so it precedes them causally even
    // if the recorded start times are equal or noisy.
    const ancestors = trace.ancestors.get(downSpan.spanId) ?? [];
    return ancestors.includes(upSpan.spanId);
  }
}
