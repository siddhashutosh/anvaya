/**
 * The Anvaya failure taxonomy — 57 modes across 8 families.
 *
 * This file is DATA, not code (NFR-5.3). It contains no logic, so it can be
 * reviewed by a non-engineer and diffed meaningfully. Lookup and graph queries
 * live in `registry.ts`.
 *
 * Codes are permanent and additive-only (ADR-0004): a mode may be deprecated,
 * never renumbered or reused.
 *
 * Grounded in:
 *   - MAST, Cemri et al., arXiv:2503.13657 — all 14 modes, with measured frequencies
 *   - Barnett et al., CAIN 2024, arXiv:2401.05856 — all 7 RAG failure points
 *   - A Systematic Taxonomy of Failure Modes in RAG Systems, TrustNLP 2026
 *   - OWASP Top 10 for LLM Applications 2025 — 6 entries
 *   - Hallucination-detection and drift-detection literature
 *
 * The normative prose version is docs/04-failure-taxonomy.md; a test asserts the
 * two agree (AC-14).
 */

import type { FailureMode } from './types.js';

// 1.1.0 — adds SEC-007 (injection-consequent action). Minor, not patch: a new
// mode is additive for anyone reading findings, but a consumer that switches
// exhaustively over codes has a new case, and the version is how they find out.
export const TAXONOMY_VERSION = '1.1.0';

export const CATALOG: readonly FailureMode[] = Object.freeze([
  // ───────────────────────────── INF · Infrastructure & transport ─────────────────────────────
  {
    code: 'INF-001',
    family: 'INF',
    name: 'Provider API error',
    definition:
      'A model-provider call returned a non-success status, or the span carries an exception event of provider origin.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['span status', 'http status', 'provider error code'],
    remediation:
      'Check the provider status page. Confirm the failure is not a malformed request (4xx) before blaming the provider. Ensure a fallback provider or graceful degradation path exists.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['GEN-007', 'AGT-007'],
  },
  {
    code: 'INF-002',
    family: 'INF',
    name: 'Provider timeout',
    definition: 'A model or tool call exceeded its configured deadline and did not return.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['span duration', 'configured timeout'],
    remediation:
      'Timeouts shorter than p99 latency guarantee failures. Compare the configured timeout against measured p99. Prefer streaming so partial output survives a slow tail.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['AGT-007', 'TOL-004'],
  },
  {
    code: 'INF-003',
    family: 'INF',
    name: 'Rate limit exhaustion',
    definition: 'The provider returned 429 or a quota-exceeded status, or throttling was observed.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['http status 429', 'retry-after', 'request rate'],
    remediation:
      'Apply client-side rate limiting with jitter and exponential backoff, and batch requests. Retry storms make this worse, not better — see TOL-004.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['TOL-004', 'ECO-002'],
  },
  {
    code: 'INF-004',
    family: 'INF',
    name: 'Authentication failure',
    definition: 'A call failed authentication or authorization (401/403).',
    defaultSeverity: 'critical',
    tier: 'L0',
    evidenceRequired: ['http status', 'target service'],
    remediation:
      'Expired or rotated credential, wrong environment, or insufficient scope. Check key expiry before anything else.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: [],
  },
  {
    code: 'INF-005',
    family: 'INF',
    name: 'Latency outlier',
    definition:
      'Span duration exceeds the rolling baseline for its operation by more than the configured z-score threshold.',
    defaultSeverity: 'medium',
    tier: 'L2',
    evidenceRequired: ['duration', 'baseline mean', 'baseline stddev', 'z-score', 'sample size'],
    remediation:
      'Isolate the slow layer — provider, retrieval, or tool. Long output generation is a common cause; check max_tokens and whether streaming is enabled.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['INF-002'],
  },
  {
    code: 'INF-006',
    family: 'INF',
    name: 'Detector execution failure',
    definition:
      'An Anvaya detector threw or exceeded its own time budget. Self-observability: Anvaya reports its own failures through the same mechanism it reports everything else.',
    defaultSeverity: 'low',
    tier: 'L0',
    evidenceRequired: ['detector id', 'error class', 'elapsed ms'],
    remediation:
      "This is Anvaya's own bug. The pipeline continues by design (ADR-0006); this finding exists so the failure is never silent. Disable the detector via config if it recurs.",
    source: { kind: 'operational', ref: 'operational practice' },
    causes: [],
  },

  // ───────────────────────────────── CTX · Input & context ─────────────────────────────────
  {
    code: 'CTX-001',
    family: 'CTX',
    name: 'Context window overflow',
    definition:
      "Assembled prompt tokens exceeded, or came within the configured margin of, the model's context limit.",
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['input tokens', 'context limit', 'utilisation ratio'],
    remediation:
      'Cap retrieved-chunk count, summarise conversation history, or move to a larger-context model. Drop lowest-scoring chunks first rather than truncating the tail.',
    source: { kind: 'operational', ref: 'operational practice; relates to Barnett FP3' },
    causes: ['CTX-002', 'RET-003', 'GEN-003'],
  },
  {
    code: 'CTX-002',
    family: 'CTX',
    name: 'Context truncation',
    definition:
      'Content was dropped during prompt assembly, measured by comparing intended against actual assembled content.',
    defaultSeverity: 'high',
    tier: 'L1',
    evidenceRequired: ['intended tokens', 'actual tokens', 'dropped segments'],
    remediation:
      'Truncation is usually silent and usually drops the middle. Make the assembly step explicit and log what it discarded.',
    source: {
      kind: 'research',
      ref: 'Barnett et al. FP3, arXiv:2401.05856',
      note: 'not in context — consolidation strategy limitation',
    },
    causes: ['GEN-003', 'GEN-001', 'RET-003'],
  },
  {
    code: 'CTX-003',
    family: 'CTX',
    name: 'Conversation history loss',
    definition:
      "Turns present in earlier requests of a session are absent from a later request's message list, without an intentional reset.",
    defaultSeverity: 'high',
    tier: 'L1',
    evidenceRequired: ['session id', 'turn indices present', 'missing range'],
    remediation:
      'Usually a windowing bug or an over-aggressive summariser. Verify the memory layer preserves the turns it claims to.',
    source: {
      kind: 'research',
      ref: 'MAST FM-1.4, arXiv:2503.13657',
      note: 'unexpected context truncation, disregarding recent interaction history',
    },
    causes: ['AGT-003', 'AGT-009', 'GEN-001'],
    observedFrequency: 0.0333,
  },
  {
    code: 'CTX-004',
    family: 'CTX',
    name: 'Conversation reset',
    definition:
      "A session's message list restarted from empty mid-session with no user-initiated reset.",
    defaultSeverity: 'medium',
    tier: 'L1',
    evidenceRequired: ['session id', 'turn index at reset'],
    remediation:
      'Session-key collision, cache eviction, or a failed state load silently falling back to a new session. Check the memory backend for silent misses.',
    source: {
      kind: 'research',
      ref: 'MAST FM-2.1, arXiv:2503.13657',
      note: 'unexpected or unwarranted restarting of a dialogue',
    },
    causes: ['AGT-003', 'CTX-003'],
    observedFrequency: 0.0233,
  },
  {
    code: 'CTX-005',
    family: 'CTX',
    name: 'Malformed input',
    definition:
      "User input was empty, exceeded configured length bounds, or failed the application's own input contract.",
    defaultSeverity: 'medium',
    tier: 'L1',
    evidenceRequired: ['input length', 'validation errors'],
    remediation:
      'Validate before spending an inference call. Empty input reaching a model means an upstream validation gap.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['GEN-007', 'SEC-001'],
  },

  // ─────────────────────────────── RET · Retrieval & grounding ───────────────────────────────
  {
    code: 'RET-001',
    family: 'RET',
    name: 'Zero retrieval hits',
    definition: 'A retrieval span returned no documents, or none above the relevance floor.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['query', 'result count', 'score threshold', 'index name'],
    remediation:
      'Either the corpus genuinely lacks the content — in which case the correct product behaviour is to say so, not to answer — or the index is empty or misconfigured. Confirm which before touching the prompt.',
    source: {
      kind: 'research',
      ref: 'Barnett et al. FP1, arXiv:2401.05856',
      note: 'missing content',
    },
    causes: ['GEN-004', 'GEN-001', 'GEN-008'],
  },
  {
    code: 'RET-002',
    family: 'RET',
    name: 'Retrieval quality collapse',
    definition:
      'Top-k relevance scores fell materially below the rolling baseline for comparable queries.',
    defaultSeverity: 'high',
    tier: 'L2',
    evidenceRequired: ['top-1 score', 'mean top-k score', 'baseline distribution', 'sample size'],
    remediation:
      'The answer is in the corpus but ranks too low. Check reranker configuration and top-k; check whether chunking changed; check for a query-document vocabulary gap. Parsing and chunking errors propagate to up to 37% of answer failures.',
    source: {
      kind: 'research',
      ref: 'Barnett et al. FP2, arXiv:2401.05856',
      note: 'missed top-ranked documents',
    },
    causes: ['GEN-004', 'GEN-001', 'GEN-002'],
  },
  {
    code: 'RET-003',
    family: 'RET',
    name: 'Consolidation loss',
    definition: "Documents were retrieved but did not reach the model's prompt.",
    defaultSeverity: 'high',
    tier: 'L1',
    evidenceRequired: ['retrieved document ids', 'ids present in prompt', 'difference'],
    remediation:
      'One of the most under-instrumented steps in a RAG stack. The gap between "retrieved" and "in the prompt" is where reranking cutoffs, dedup, and token budgets silently discard the answer.',
    source: {
      kind: 'research',
      ref: 'Barnett et al. FP3, arXiv:2401.05856',
      note: 'not in context',
    },
    causes: ['GEN-001', 'GEN-003', 'GEN-004'],
  },
  {
    code: 'RET-004',
    family: 'RET',
    name: 'Retrieval latency degradation',
    definition: 'Retrieval span duration exceeds its rolling baseline beyond threshold.',
    defaultSeverity: 'medium',
    tier: 'L2',
    evidenceRequired: ['duration', 'baseline', 'z-score'],
    remediation: 'Index growth without re-tuning, missing ANN parameters, or a cold cache.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['INF-002'],
  },
  {
    code: 'RET-005',
    family: 'RET',
    name: 'Redundant retrieval',
    definition:
      'A substantial fraction of retrieved chunks are near-duplicates, consuming context budget without adding information.',
    defaultSeverity: 'low',
    tier: 'L1',
    evidenceRequired: ['duplicate ratio', 'wasted token estimate'],
    remediation:
      'Dedup at index time and at retrieval time. Overlapping chunk windows are the usual cause.',
    source: {
      kind: 'research',
      ref: 'TrustNLP 2026 RAG taxonomy',
      note: 'representation stage',
    },
    causes: ['CTX-001', 'RET-003'],
  },
  {
    code: 'RET-006',
    family: 'RET',
    name: 'Index staleness',
    definition:
      "Retrieved documents' age exceeds the configured freshness bound for a time-sensitive query.",
    defaultSeverity: 'medium',
    tier: 'L1',
    evidenceRequired: ['document timestamps', 'freshness bound'],
    remediation:
      'An indexing pipeline that has silently stopped is a common and long-undetected failure. Alert on index write recency, not only on read quality.',
    source: { kind: 'research', ref: 'TrustNLP 2026 RAG taxonomy', note: 'data stage' },
    causes: ['GEN-004'],
  },
  {
    code: 'RET-007',
    family: 'RET',
    name: 'Embedding space weakness',
    definition:
      'Retrieval score distribution has collapsed toward uniformity — the embedding space no longer discriminates.',
    defaultSeverity: 'medium',
    tier: 'L2',
    evidenceRequired: ['score variance', 'score entropy', 'baseline comparison'],
    remediation:
      'Embedding-model version mismatch between index time and query time is the classic cause and produces exactly this signature. Verify both sides use the same model.',
    source: {
      kind: 'standard',
      ref: 'OWASP LLM08 (2025)',
      note: 'vector and embedding weaknesses',
    },
    causes: ['RET-002'],
  },

  // ──────────────────────────────── GEN · Generation quality ────────────────────────────────
  {
    code: 'GEN-001',
    family: 'GEN',
    name: 'Answer not extracted',
    definition:
      'The answer was present in the provided context but the model failed to extract it.',
    defaultSeverity: 'high',
    tier: 'L3',
    evidenceRequired: ['context excerpt', 'model output', 'judge rationale'],
    remediation:
      'Usually noise, contradiction, or lost-in-the-middle positioning. Reduce context volume before increasing it; place critical context at the start or end.',
    source: {
      kind: 'research',
      ref: 'Barnett et al. FP4, arXiv:2401.05856',
      note: 'not extracted',
    },
    causes: ['GEN-003', 'GEN-008'],
  },
  {
    code: 'GEN-002',
    family: 'GEN',
    name: 'Incorrect specificity',
    definition: 'The answer is too general or too specific for the question asked.',
    defaultSeverity: 'medium',
    tier: 'L3',
    evidenceRequired: ['query', 'output', 'judge rationale'],
    remediation:
      'Almost always a prompt-instruction gap about expected granularity. Few-shot examples at the target specificity fix it more reliably than adjectives.',
    source: {
      kind: 'research',
      ref: 'Barnett et al. FP6, arXiv:2401.05856',
      note: 'incorrect specificity',
    },
    causes: [],
  },
  {
    code: 'GEN-003',
    family: 'GEN',
    name: 'Incomplete answer',
    definition: 'A multi-part question received a response addressing only some parts.',
    defaultSeverity: 'high',
    tier: 'L1',
    evidenceRequired: ['sub-question count', 'addressed count', 'unaddressed list'],
    remediation:
      'Decompose multi-part queries explicitly rather than hoping the model tracks all parts. Check CTX-002 first — truncation causes this.',
    source: {
      kind: 'research',
      ref: 'Barnett et al. FP7, arXiv:2401.05856',
      note: 'incomplete answer',
    },
    causes: ['GEN-008'],
  },
  {
    code: 'GEN-004',
    family: 'GEN',
    name: 'Ungrounded claim',
    definition:
      'Assertions in the output are not supported by the retrieved context or any provided source.',
    defaultSeverity: 'critical',
    tier: 'L1',
    evidenceRequired: ['unsupported sentences', 'per-sentence support score', 'method'],
    remediation:
      'Groundedness against retrieved context is the best production signal because it checks a concrete relationship rather than making an open-ended judgment about the world. Fix retrieval first — check RET-001, RET-002 and RET-003 before rewriting the prompt.',
    source: {
      kind: 'research',
      ref: 'semantic entropy (Nature 2024); SelfCheckGPT arXiv:2303.08896; NLI groundedness',
    },
    causes: ['GEN-008', 'SEC-005'],
  },
  {
    code: 'GEN-005',
    family: 'GEN',
    name: 'Schema violation',
    definition: 'Structured output failed JSON parsing or JSON-Schema validation.',
    defaultSeverity: 'high',
    tier: 'L1',
    evidenceRequired: ['raw output', 'parse or schema errors'],
    remediation:
      'Use provider-native structured-output or tool-calling modes rather than asking for JSON in prose. Never eval model output; validate then coerce.',
    source: {
      kind: 'research',
      ref: 'Barnett et al. FP5, arXiv:2401.05856; OWASP LLM05 (2025)',
      note: 'wrong format',
    },
    causes: ['TOL-003', 'INF-001'],
  },
  {
    code: 'GEN-006',
    family: 'GEN',
    name: 'Output truncated',
    definition:
      'Generation stopped at the token limit rather than at a natural stop (finish_reason = length).',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['finish reason', 'output tokens', 'max tokens'],
    remediation:
      'Trivially detectable and frequently unhandled. A truncated JSON response also produces GEN-005. Raise max_tokens or instruct for brevity — but detect it either way.',
    source: {
      kind: 'operational',
      ref: 'operational practice; OTel gen_ai.response.finish_reasons',
    },
    causes: ['GEN-003', 'GEN-005'],
  },
  {
    code: 'GEN-007',
    family: 'GEN',
    name: 'Degenerate output',
    definition:
      'Output is empty, whitespace-only, or exhibits pathological n-gram repetition.',
    defaultSeverity: 'high',
    tier: 'L1',
    evidenceRequired: ['output length', 'repetition ratio', 'longest repeated n-gram'],
    remediation:
      'Sampling-parameter pathology, a degenerate prompt, or a provider fault. Check INF-001 first.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['GEN-003'],
  },
  {
    code: 'GEN-008',
    family: 'GEN',
    name: 'Unexpected refusal',
    definition: 'The model declined to answer a question that is in-policy for the product.',
    defaultSeverity: 'medium',
    tier: 'L1',
    evidenceRequired: ['refusal phrase', 'query'],
    remediation:
      'Over-triggered safety behaviour, or an ambiguous system prompt. Measure the refusal rate as a first-class metric — a rising refusal rate is a silent outage.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: [],
  },

  // ────────────────────────────── AGT · Agent & orchestration ──────────────────────────────
  {
    code: 'AGT-001',
    family: 'AGT',
    name: 'Disobey task specification',
    definition:
      'Failure to adhere to the specified constraints or requirements of a given task.',
    defaultSeverity: 'high',
    tier: 'L3',
    evidenceRequired: ['stated constraints', 'observed violation', 'judge rationale'],
    remediation:
      'Constraints buried in a long system prompt are frequently dropped. Promote them to a checklist and verify programmatically where possible.',
    source: { kind: 'research', ref: 'MAST FM-1.1, arXiv:2503.13657' },
    causes: ['AGT-004', 'GEN-002'],
    observedFrequency: 0.1098,
  },
  {
    code: 'AGT-002',
    family: 'AGT',
    name: 'Disobey role specification',
    definition:
      'An agent acted outside the responsibilities and constraints of its assigned role.',
    defaultSeverity: 'medium',
    tier: 'L3',
    evidenceRequired: ['role definition', 'out-of-role action', 'judge rationale'],
    remediation:
      'Rare but corrosive in multi-agent systems. Enforce roles with tool allow-lists, not with prose.',
    source: { kind: 'research', ref: 'MAST FM-1.2, arXiv:2503.13657' },
    causes: ['AGT-004', 'TOL-005'],
    observedFrequency: 0.005,
  },
  {
    code: 'AGT-003',
    family: 'AGT',
    name: 'Step repetition',
    definition: 'Unnecessary reiteration of previously completed steps in a process.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['repeated step signature', 'repetition count', 'span ids', 'wasted tokens'],
    remediation:
      'The single most common multi-agent failure mode, and detectable for free as a cycle in the span tree. Add explicit progress state, deduplicate the action history fed back to the agent, and cap iterations.',
    source: {
      kind: 'research',
      ref: 'MAST FM-1.3, arXiv:2503.13657',
      note: 'most frequent observed failure mode at 17.14%',
    },
    causes: ['ECO-002', 'AGT-005', 'INF-002'],
    observedFrequency: 0.1714,
  },
  {
    code: 'AGT-004',
    family: 'AGT',
    name: 'Task derailment',
    definition: 'Deviation from the intended objective or focus of a given task.',
    defaultSeverity: 'high',
    tier: 'L3',
    evidenceRequired: ['original objective', 'trajectory summary', 'divergence point'],
    remediation:
      'Restate the objective at each iteration rather than relying on context persistence. Derailment compounds — detect early steps, not the final answer.',
    source: { kind: 'research', ref: 'MAST FM-2.3, arXiv:2503.13657' },
    causes: ['AGT-007', 'ECO-002'],
    observedFrequency: 0.0715,
  },
  {
    code: 'AGT-005',
    family: 'AGT',
    name: 'Unaware of termination conditions',
    definition:
      'Lack of recognition of the criteria that should trigger termination; the agent runs past its stopping point.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['iteration count', 'configured maximum', 'tokens after satisfaction'],
    remediation:
      'Make the termination condition an explicit, checkable predicate rather than a natural-language instruction. Always set a hard iteration cap.',
    source: { kind: 'research', ref: 'MAST FM-1.5, arXiv:2503.13657' },
    causes: ['ECO-001', 'ECO-002', 'AGT-003'],
    observedFrequency: 0.0982,
  },
  {
    code: 'AGT-006',
    family: 'AGT',
    name: 'Reasoning-action mismatch',
    definition:
      'Discrepancy between the logical reasoning stated by the agent and the actions it actually took.',
    defaultSeverity: 'high',
    tier: 'L1',
    evidenceRequired: ['reasoning text', 'tools named in reasoning', 'tools invoked', 'difference'],
    remediation:
      'Detectable at L1 by set-differencing tool names in the reasoning text against actual tool-call spans — no judge required for the common case. Constrain actions to a declared plan and validate the plan before executing it.',
    source: {
      kind: 'research',
      ref: 'MAST FM-2.6, arXiv:2503.13657',
      note: 'second most frequent observed failure mode at 13.98%',
    },
    causes: ['AGT-004', 'AGT-007', 'GEN-004'],
    observedFrequency: 0.1398,
  },
  {
    code: 'AGT-007',
    family: 'AGT',
    name: 'Premature termination',
    definition:
      'Ending before all necessary information has been exchanged or all subtasks completed.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['declared subtasks', 'completed subtasks', 'unresolved list'],
    remediation:
      'Require an explicit completion check enumerating subtasks. Do not treat "the model stopped producing tool calls" as "the task is done".',
    source: { kind: 'research', ref: 'MAST FM-3.1, arXiv:2503.13657' },
    causes: ['GEN-003', 'AGT-008'],
    observedFrequency: 0.0782,
  },
  {
    code: 'AGT-008',
    family: 'AGT',
    name: 'No or incomplete verification',
    definition:
      'Omission of proper checking or confirmation of task outcomes, especially after state-changing actions.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['state-changing tool calls', 'verification spans present'],
    remediation:
      'Every write should be followed by a read-back. Structurally detectable: a write-class tool call with no verification span after it.',
    source: { kind: 'research', ref: 'MAST FM-3.2, arXiv:2503.13657' },
    causes: ['AGT-012', 'GEN-004'],
    observedFrequency: 0.0682,
  },
  {
    code: 'AGT-009',
    family: 'AGT',
    name: 'Fail to ask for clarification',
    definition:
      'Proceeding on incomplete or ambiguous input instead of requesting additional information.',
    defaultSeverity: 'medium',
    tier: 'L1',
    evidenceRequired: ['ambiguity markers', 'absence of clarification turn'],
    remediation:
      'Systems are rarely given permission to ask. Add an explicit "ask a clarifying question" action to the action space and reward using it.',
    source: {
      kind: 'research',
      ref: 'MAST FM-2.2, arXiv:2503.13657',
      note: 'third most frequent observed failure mode at 11.65%',
    },
    causes: ['AGT-001', 'GEN-002', 'GEN-004'],
    observedFrequency: 0.1165,
  },
  {
    code: 'AGT-010',
    family: 'AGT',
    name: 'Information withholding',
    definition:
      'An agent failed to share or communicate data that other agents needed for their decisions.',
    defaultSeverity: 'medium',
    tier: 'L3',
    evidenceRequired: ['information available', 'information transmitted', 'omission'],
    remediation:
      'Define hand-off contracts explicitly. Free-text hand-offs lose structure.',
    source: { kind: 'research', ref: 'MAST FM-2.4, arXiv:2503.13657' },
    causes: ['AGT-011', 'AGT-012'],
    observedFrequency: 0.0166,
  },
  {
    code: 'AGT-011',
    family: 'AGT',
    name: "Ignored peer input",
    definition: 'An agent disregarded or failed to adequately consider input from another agent.',
    defaultSeverity: 'low',
    tier: 'L3',
    evidenceRequired: ['peer message content', 'subsequent action', 'judge rationale'],
    remediation:
      'Rarest MAST mode. Require explicit acknowledgement of peer input in the hand-off schema.',
    source: { kind: 'research', ref: 'MAST FM-2.5, arXiv:2503.13657' },
    causes: ['AGT-004'],
    observedFrequency: 0.0017,
  },
  {
    code: 'AGT-012',
    family: 'AGT',
    name: 'Incorrect verification',
    definition:
      'Verification was performed but failed to validate correctly — a passing check on an incorrect outcome.',
    defaultSeverity: 'high',
    tier: 'L3',
    evidenceRequired: ['verification step', 'verdict', 'ground truth or judge assessment'],
    remediation:
      'More dangerous than AGT-008 because it manufactures false confidence. A verifier sharing the generator\'s model shares its blind spots — use an independent check.',
    source: { kind: 'research', ref: 'MAST FM-3.3, arXiv:2503.13657' },
    causes: ['GEN-004'],
    observedFrequency: 0.0666,
  },

  // ───────────────────────────── TOL · Tool & function calling ─────────────────────────────
  {
    code: 'TOL-001',
    family: 'TOL',
    name: 'Unknown tool invoked',
    definition: 'The model attempted to call a tool not present in its declared tool set.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['requested tool name', 'available tool names'],
    remediation:
      'Usually hallucinated from training priors or a stale system prompt. Return a structured error naming the valid tools rather than a generic failure.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['AGT-003', 'GEN-005'],
  },
  {
    code: 'TOL-002',
    family: 'TOL',
    name: 'Tool execution error',
    definition: 'A tool call raised an error or returned a failure status.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['tool name', 'error class', 'attempt number'],
    remediation:
      'Tool errors that are silently swallowed become hallucinations — the model invents a plausible result. Always surface the failure into the agent context.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['AGT-003', 'TOL-004', 'GEN-004'],
  },
  {
    code: 'TOL-003',
    family: 'TOL',
    name: 'Tool argument validation failure',
    definition: "Generated tool arguments failed the tool's parameter schema.",
    defaultSeverity: 'medium',
    tier: 'L1',
    evidenceRequired: ['provided arguments', 'parameter schema', 'validation errors'],
    remediation:
      'Tighten the parameter schema — enums beat free strings. Feed validation errors back to the model rather than failing the turn.',
    source: { kind: 'standard', ref: 'OWASP LLM05 (2025); operational practice' },
    causes: ['TOL-002', 'AGT-003'],
  },
  {
    code: 'TOL-004',
    family: 'TOL',
    name: 'Retry storm',
    definition:
      'The same call was retried beyond threshold within a window, typically without backoff.',
    defaultSeverity: 'critical',
    tier: 'L0',
    evidenceRequired: ['call signature', 'attempt count', 'inter-attempt intervals', 'cost'],
    remediation:
      'Retries without exponential backoff and jitter convert a transient blip into a self-inflicted outage, and the cost is unbounded. Cap total attempts, not just attempts per layer — nested retries multiply.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['ECO-002', 'INF-003'],
  },
  {
    code: 'TOL-005',
    family: 'TOL',
    name: 'Excessive agency',
    definition:
      'The agent invoked more tools, or higher-privilege tools, than the task required — including state-changing tools on a read-only request.',
    defaultSeverity: 'critical',
    tier: 'L0',
    evidenceRequired: ['tool call count', 'privileged tools invoked', 'task class'],
    remediation:
      'Grant the minimum tool set per task class. Require explicit confirmation for destructive actions. This is the failure mode with real-world blast radius — an agent with delete permissions and a prompt injection is an incident.',
    source: { kind: 'standard', ref: 'OWASP LLM06 (2025)', note: 'excessive agency' },
    causes: ['SEC-005', 'AGT-002'],
  },
  {
    code: 'TOL-006',
    family: 'TOL',
    name: 'Tool latency degradation',
    definition: 'Tool span duration exceeds its rolling baseline beyond threshold.',
    defaultSeverity: 'medium',
    tier: 'L2',
    evidenceRequired: ['duration', 'per-tool baseline', 'z-score'],
    remediation:
      'Use per-tool timeouts, not one global timeout. A slow tool inside an agent loop multiplies by the iteration count.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['INF-002', 'TOL-004'],
  },

  // ──────────────────────────────── SEC · Safety & security ────────────────────────────────
  {
    code: 'SEC-001',
    family: 'SEC',
    name: 'Direct prompt injection',
    definition: 'User input contains patterns attempting to override system instructions.',
    defaultSeverity: 'critical',
    tier: 'L1',
    evidenceRequired: ['matched pattern', 'position', 'pattern class'],
    remediation:
      'Pattern matching catches naive attempts only — treat it as a signal, not a defence. Real mitigation is privilege separation: assume the model can be turned, and constrain what a turned model can do.',
    source: {
      kind: 'standard',
      ref: 'OWASP LLM01 (2025)',
      note: 'top-ranked for the second consecutive edition',
    },
    causes: ['SEC-004', 'SEC-005', 'TOL-005'],
  },
  {
    code: 'SEC-002',
    family: 'SEC',
    name: 'Indirect prompt injection',
    definition:
      'Retrieved or tool-returned content contains instruction-like patterns that the model may treat as trusted.',
    defaultSeverity: 'critical',
    tier: 'L1',
    evidenceRequired: ['source document id', 'matched pattern', 'excerpt'],
    remediation:
      'The more dangerous variant, because nobody is watching the corpus. Scan retrieved documents, not just user input. Delimit untrusted content structurally.',
    source: { kind: 'standard', ref: 'OWASP LLM01 (2025)', note: 'indirect variant' },
    causes: ['SEC-004', 'SEC-005', 'TOL-005'],
  },
  {
    code: 'SEC-003',
    family: 'SEC',
    name: 'Sensitive information disclosure',
    definition: 'Output contains credentials, keys, or PII patterns.',
    defaultSeverity: 'critical',
    tier: 'L1',
    evidenceRequired: ['detected pattern class', 'position'],
    remediation:
      'Scan egress, not only ingress. Anvaya records the class of secret detected and never the secret itself.',
    source: { kind: 'standard', ref: 'OWASP LLM02 (2025)' },
    causes: ['SEC-005'],
  },
  {
    code: 'SEC-004',
    family: 'SEC',
    name: 'System prompt leakage',
    definition: 'Output contains distinctive fragments of the system prompt.',
    defaultSeverity: 'high',
    tier: 'L1',
    evidenceRequired: ['matched fragment length', 'similarity score'],
    remediation:
      'The correct mitigation is not to hide the prompt but to ensure the prompt contains nothing whose disclosure is harmful. Secrets do not belong in system prompts.',
    source: { kind: 'standard', ref: 'OWASP LLM07 (2025)' },
    causes: ['SEC-005'],
  },
  {
    code: 'SEC-005',
    family: 'SEC',
    name: 'Unsafe output',
    definition: "Output violates the product's declared content policy.",
    defaultSeverity: 'critical',
    tier: 'L3',
    evidenceRequired: ['policy category', 'judge rationale'],
    remediation: 'Policy must be explicit and machine-checkable before it can be measured.',
    source: { kind: 'standard', ref: 'OWASP LLM05 (2025); operational practice' },
    causes: [],
  },
  {
    code: 'SEC-006',
    family: 'SEC',
    name: 'Guardrail bypass',
    definition:
      'A guardrail span was expected on this path but is absent, or it ran and its verdict was not enforced.',
    defaultSeverity: 'critical',
    tier: 'L0',
    evidenceRequired: ['expected guardrail', 'spans present', 'enforcement outcome'],
    remediation:
      'A guardrail whose verdict is ignored is worse than no guardrail — it produces false assurance. Structurally detectable and worth alerting on.',
    source: { kind: 'standard', ref: 'operational practice; OWASP LLM01 (2025)' },
    causes: ['SEC-005', 'SEC-003'],
  },
  {
    code: 'SEC-007',
    family: 'SEC',
    name: 'Injection-consequent action',
    definition:
      'Instruction-like content that entered from an untrusted source — a retrieved document or a tool result — demonstrably reached a privileged sink: the arguments of a later tool call, or the final output.',
    defaultSeverity: 'critical',
    tier: 'L1',
    evidenceRequired: [
      'source span and origin',
      'sink span and kind',
      'matched fragment length',
      'ordering',
    ],
    remediation:
      'This is the mode that says the injection WORKED, as distinct from SEC-001/SEC-002 which say one was attempted. Treat it as an incident, not an alert: identify what the influenced call was permitted to do, and constrain that permission. Content arriving from a retriever or a tool is data, and a model that can be instructed by its own inputs must not hold a capability you would not grant the author of those inputs.',
    source: {
      kind: 'standard',
      ref: 'OWASP LLM01 (2025); OWASP LLM06 (2025)',
      note: 'the consequence half of indirect injection, observable only across a whole trace',
    },
    causes: ['SEC-003', 'SEC-005', 'TOL-005'],
  },

  // ─────────────────────────────── ECO · Economics & drift ───────────────────────────────
  {
    code: 'ECO-001',
    family: 'ECO',
    name: 'Token budget exceeded',
    definition: 'Total tokens for a trace exceeded the configured budget.',
    defaultSeverity: 'high',
    tier: 'L0',
    evidenceRequired: ['total tokens', 'budget', 'top-consuming spans'],
    remediation:
      'Check AGT-003 and AGT-005 first — loops are the usual cause and the budget breach is the symptom.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['ECO-002'],
  },
  {
    code: 'ECO-002',
    family: 'ECO',
    name: 'Cost spike',
    definition: 'Trace cost exceeds the rolling baseline beyond threshold.',
    defaultSeverity: 'high',
    tier: 'L2',
    evidenceRequired: ['cost', 'baseline mean', 'baseline stddev', 'z-score'],
    remediation:
      'Attribute to a span before acting. A cost spike whose origin is AGT-003 is a control-flow bug, not a pricing problem.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['ECO-001'],
  },
  {
    code: 'ECO-003',
    family: 'ECO',
    name: 'Feature drift',
    definition:
      "A monitored feature's distribution has shifted from the reference window beyond threshold (PSI > 0.1 moderate, > 0.25 significant; or JS divergence beyond its bound).",
    defaultSeverity: 'medium',
    tier: 'L2',
    evidenceRequired: ['feature name', 'PSI', 'JS divergence', 'window sizes'],
    remediation:
      'Drift is a leading indicator, not a failure in itself. Investigate what changed — corpus, traffic mix, model version, prompt.',
    source: {
      kind: 'research',
      ref: 'drift-detection literature (PSI, Jensen-Shannon, KS, MMD)',
      note: 'thresholds follow the standard 0.1 / 0.25 convention',
    },
    // Deliberately empty. Drift is a LEADING INDICATOR, not a cause: retrieval
    // quality does not collapse *because* a distribution shifted, they are
    // co-observations of the same underlying change. Modelling drift as a cause
    // makes it outrank the real origin during attribution and buries the finding
    // that actually tells you what to fix.
    causes: [],
  },
  {
    code: 'ECO-004',
    family: 'ECO',
    name: 'Failure rate burst',
    definition:
      'Occurrences of a taxonomy code in the current window exceed its historical rate beyond threshold.',
    defaultSeverity: 'high',
    tier: 'L2',
    evidenceRequired: ['code', 'current rate', 'baseline rate', 'ratio'],
    remediation: 'The generic "something changed" alarm. Correlate with deploy times.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: [],
  },
  {
    code: 'ECO-005',
    family: 'ECO',
    name: 'Cache inefficiency',
    definition:
      'Prompt-cache read ratio is materially below expectation for a workload with a stable prefix.',
    defaultSeverity: 'low',
    tier: 'L1',
    evidenceRequired: ['cache read tokens', 'cache creation tokens', 'hit ratio'],
    remediation:
      'A varying prefix — a timestamp or a shuffled tool list at the top of the system prompt — defeats prefix caching entirely. Order the prompt stable-first.',
    source: {
      kind: 'operational',
      ref: 'operational practice; OTel gen_ai.usage.cache_read.input_tokens',
    },
    causes: ['ECO-002'],
  },
  {
    code: 'ECO-006',
    family: 'ECO',
    name: 'Cohort divergence',
    definition:
      'A taxonomy code concentrates in one cohort — model version, route, tenant, or region — far above its base rate.',
    defaultSeverity: 'medium',
    tier: 'L2',
    evidenceRequired: ['cohort key', 'in-cohort rate', 'base rate', 'lift', 'sample sizes'],
    remediation:
      'How a bad model rollout, a broken route, or one pathological tenant is found. Reported as a correlation hypothesis, never as a cause.',
    source: { kind: 'operational', ref: 'operational practice' },
    causes: ['ECO-004'],
  },
] as const satisfies readonly FailureMode[]);
