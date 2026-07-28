/**
 * L1 security detectors — SEC-001..SEC-004, TOL-003.
 *
 * Mapped to OWASP Top 10 for LLM Applications (2025). Two non-negotiables here:
 *   - Findings record the CLASS of secret detected, never the value (NFR-4.4).
 *     A security finding that quotes the secret has re-created the exposure.
 *   - Pattern matching catches naive injection only. These are signals, not
 *     defences, and the remediation text says so.
 */

import {
  Redactor,
  longestCommonSubstring,
  type Finding,
  type SpanRecord,
} from '@anvaya/core';
import { evidence, finding, type Detector } from '../types.js';

const INJECTION_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'instruction-override', pattern: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+instructions?/i },
  { name: 'instruction-override', pattern: /disregard\s+(?:all\s+)?(?:previous|prior|your)\s+(?:instructions?|rules?|prompt)/i },
  { name: 'role-hijack', pattern: /you\s+are\s+now\s+(?:a|an|in)\s+/i },
  { name: 'role-hijack', pattern: /\bact\s+as\s+(?:if\s+you\s+are\s+)?(?:a\s+)?(?:DAN|jailbroken|unrestricted)/i },
  { name: 'prompt-exfiltration', pattern: /(?:reveal|print|repeat|show|output)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instructions)/i },
  { name: 'delimiter-injection', pattern: /(?:^|\n)\s*(?:###\s*)?(?:system|assistant)\s*:\s*/i },
  { name: 'safety-bypass', pattern: /\b(?:developer|god|admin)\s+mode\s+(?:enabled|on|activated)/i },
];

function scanInjection(text: string): { name: string; index: number } | undefined {
  for (const { name, pattern } of INJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { name, index: match.index };
  }
  return undefined;
}

function userText(span: SpanRecord): string {
  return (span.llm?.inputMessages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
}

function assistantText(span: SpanRecord): string {
  return (span.llm?.outputMessages ?? [])
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('\n');
}

/** SEC-001 · Direct prompt injection — OWASP LLM01. */
export const directInjectionDetector: Detector = {
  id: 'sec.injection-direct',
  tier: 'L1',
  emits: ['SEC-001'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Instruction-override patterns in user input (OWASP LLM01).',
  supports: (t) => t.byKind.llm.some((s) => userText(s).length > 0),
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.llm) {
      const text = userText(span);
      if (text.length === 0) continue;

      const hit = scanInjection(text);
      if (!hit) continue;

      out.push(
        finding({
          ctx,
          detector: directInjectionDetector,
          code: 'SEC-001',
          spanId: span.spanId,
          confidence: 0.7,
          detail:
            'User input contains an instruction-override pattern. Pattern matching catches naive attempts only — the real mitigation is privilege separation: assume the model can be turned, and constrain what a turned model can do.',
          evidence: [
            evidence('patternClass', hit.name),
            evidence('position', hit.index),
            evidence('inputLength', text.length),
          ],
        }),
      );
    }
    return out;
  },
};

/**
 * SEC-002 · Indirect prompt injection — OWASP LLM01, indirect variant.
 * The more dangerous one, because nobody is watching the corpus.
 */
export const indirectInjectionDetector: Detector = {
  id: 'sec.injection-indirect',
  tier: 'L1',
  emits: ['SEC-002'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Instruction-like patterns in retrieved or tool-returned content (OWASP LLM01).',
  supports: (t) =>
    t.byKind.retriever.some((s) => (s.retrieval?.documents ?? []).some((d) => d.content)) ||
    t.byKind.tool.some((s) => Boolean(s.tool?.result)),
  async run(ctx) {
    const out: Finding[] = [];

    for (const span of ctx.trace.byKind.retriever) {
      for (const doc of span.retrieval?.documents ?? []) {
        if (!doc.content) continue;
        const hit = scanInjection(doc.content);
        if (!hit) continue;

        out.push(
          finding({
            ctx,
            detector: indirectInjectionDetector,
            code: 'SEC-002',
            spanId: span.spanId,
            confidence: 0.75,
            detail: `Retrieved document "${doc.id}" contains instruction-like content that the model may treat as trusted. Delimit untrusted content structurally.`,
            evidence: [
              evidence('source', 'retrieved-document'),
              evidence('documentId', doc.id),
              evidence('patternClass', hit.name),
              evidence('position', hit.index),
            ],
          }),
        );
      }
    }

    for (const span of ctx.trace.byKind.tool) {
      const result = span.tool?.result;
      if (!result) continue;
      const hit = scanInjection(result);
      if (!hit) continue;

      out.push(
        finding({
          ctx,
          detector: indirectInjectionDetector,
          code: 'SEC-002',
          spanId: span.spanId,
          confidence: 0.75,
          detail: `Tool "${span.tool?.toolName}" returned instruction-like content. Tool output from an external service is untrusted input.`,
          evidence: [
            evidence('source', 'tool-result'),
            evidence('tool', span.tool?.toolName ?? span.name),
            evidence('patternClass', hit.name),
            evidence('position', hit.index),
          ],
        }),
      );
    }

    return out;
  },
};

/** SEC-003 · Sensitive information disclosure — OWASP LLM02. Classes only, never values. */
export const secretEgressDetector: Detector = {
  id: 'sec.secret-egress',
  tier: 'L1',
  emits: ['SEC-003'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Credentials or PII patterns in model output (OWASP LLM02).',
  supports: (t) => t.byKind.llm.some((s) => assistantText(s).length > 0),
  async run(ctx) {
    // A dedicated Redactor in scan mode: it reports classes and never returns values.
    const scanner = new Redactor();
    const out: Finding[] = [];

    for (const span of ctx.trace.byKind.llm) {
      const text = assistantText(span);
      if (text.length === 0) continue;

      const hits = scanner
        .scan(text)
        // Emails and phones alone are too noisy to page on; credentials are not.
        .filter((h) => !['email', 'phone', 'ipv4'].includes(h.class));
      if (hits.length === 0) continue;

      out.push(
        finding({
          ctx,
          detector: secretEgressDetector,
          code: 'SEC-003',
          spanId: span.spanId,
          confidence: 0.85,
          detail: `Model output matched ${hits.length} credential pattern class(es). Scan egress, not only ingress.`,
          evidence: [
            // The class and count only. The value never appears here or in storage.
            evidence('classes', hits.map((h) => `${h.class}×${h.count}`).join(', ')),
            evidence('totalMatches', hits.reduce((n, h) => n + h.count, 0)),
            evidence('note', 'values are never recorded'),
          ],
        }),
      );
    }
    return out;
  },
};

/** SEC-004 · System prompt leakage — OWASP LLM07. */
export const systemPromptLeakDetector: Detector = {
  id: 'sec.system-prompt-leak',
  tier: 'L1',
  emits: ['SEC-004'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Distinctive system-prompt fragments appearing in output (OWASP LLM07).',
  supports: (t) =>
    t.byKind.llm.some((s) => (s.llm?.systemInstructions?.length ?? 0) > 0 && assistantText(s).length > 0),
  async run(ctx) {
    const minChars = ctx.thresholds.systemPromptLeakChars;
    const out: Finding[] = [];

    for (const span of ctx.trace.byKind.llm) {
      const system = span.llm?.systemInstructions ?? '';
      const output = assistantText(span);
      if (system.length < minChars || output.length === 0) continue;

      const matched = longestCommonSubstring(system, output);
      if (matched < minChars) continue;

      out.push(
        finding({
          ctx,
          detector: systemPromptLeakDetector,
          code: 'SEC-004',
          spanId: span.spanId,
          confidence: Math.min(0.9, 0.5 + matched / (minChars * 4)),
          detail: `A ${matched}-character fragment of the system prompt appears verbatim in the output. The correct mitigation is not to hide the prompt but to ensure it contains nothing whose disclosure is harmful.`,
          evidence: [
            evidence('matchedChars', matched),
            evidence('threshold', minChars),
            evidence('systemPromptChars', system.length),
          ],
        }),
      );
    }
    return out;
  },
};

/** TOL-003 · Tool argument validation failure — OWASP LLM05. */
export const toolArgumentDetector: Detector = {
  id: 'tol.argument-validation',
  tier: 'L1',
  emits: ['TOL-003'],
  cost: 'free',
  requiresBaseline: false,
  description: 'Generated tool arguments failed the declared parameter schema.',
  supports: (t) => t.byKind.tool.some((s) => s.tool?.parameterSchema !== undefined),
  async run(ctx) {
    const out: Finding[] = [];
    for (const span of ctx.trace.byKind.tool) {
      const schema = span.tool?.parameterSchema as
        | { required?: string[]; properties?: Record<string, { type?: string }> }
        | undefined;
      const rawArgs = span.tool?.arguments;
      if (!schema || !rawArgs) continue;

      const errors: string[] = [];
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        errors.push('arguments are not valid JSON');
      }

      if (parsed) {
        for (const key of schema.required ?? []) {
          if (!(key in parsed)) errors.push(`missing required property "${key}"`);
        }
        for (const [key, value] of Object.entries(parsed)) {
          const expected = schema.properties?.[key]?.type;
          if (!expected) continue;
          const actual = Array.isArray(value) ? 'array' : typeof value;
          if (expected !== actual && !(expected === 'integer' && actual === 'number')) {
            errors.push(`"${key}" expected ${expected}, got ${actual}`);
          }
        }
      }
      if (errors.length === 0) continue;

      out.push(
        finding({
          ctx,
          detector: toolArgumentDetector,
          code: 'TOL-003',
          spanId: span.spanId,
          confidence: 0.9,
          detail: `Arguments for "${span.tool?.toolName}" violate its parameter schema. Tighten the schema — enums beat free strings — and feed validation errors back to the model rather than failing the turn.`,
          evidence: [
            evidence('tool', span.tool?.toolName ?? span.name),
            evidence('violations', errors.length),
            evidence('errors', errors.slice(0, 4).join('; ')),
          ],
        }),
      );
    }
    return out;
  },
};

export const L1_SECURITY_DETECTORS: readonly Detector[] = [
  directInjectionDetector,
  indirectInjectionDetector,
  secretEgressDetector,
  systemPromptLeakDetector,
  toolArgumentDetector,
];
