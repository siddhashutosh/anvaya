/**
 * Text primitives for the L1 heuristic tier.
 *
 * Everything here is deliberately lexical, not semantic. That is the point: L1
 * must run for free on every trace (ADR-0003). Detectors built on these functions
 * cap their confidence accordingly, so a lexical proxy is never presented as an
 * entailment judgment.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in', 'on', 'at',
  'by', 'for', 'with', 'about', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'they', 'we',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
  'may', 'might', 'must', 'not', 'no', 'so', 'than', 'there', 'here', 'from', 'into',
  'your', 'their', 'our', 'his', 'her', 'them', 'us', 'me', 'my',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Sentence split that tolerates abbreviations and decimals well enough for scoring. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'([])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Fraction of a claim's content tokens that also appear in the source.
 * This is the L1 groundedness proxy (GEN-004).
 */
export function overlapRatio(claim: string, sourceTokens: ReadonlySet<string>): number {
  const tokens = contentTokens(claim);
  if (tokens.length === 0) return 1;
  let hits = 0;
  for (const t of tokens) if (sourceTokens.has(t)) hits++;
  return hits / tokens.length;
}

/** Fraction of n-grams that are repeats. Drives GEN-007 degenerate output. */
export function ngramRepetitionRatio(text: string, n = 4): number {
  const tokens = tokenize(text);
  if (tokens.length < n * 2) return 0;

  const seen = new Set<string>();
  let repeats = 0;
  let total = 0;
  for (let i = 0; i + n <= tokens.length; i++) {
    const gram = tokens.slice(i, i + n).join(' ');
    total++;
    if (seen.has(gram)) repeats++;
    else seen.add(gram);
  }
  return total === 0 ? 0 : repeats / total;
}

export function longestRepeatedNgram(text: string, n = 4): { ngram: string; count: number } {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (let i = 0; i + n <= tokens.length; i++) {
    const gram = tokens.slice(i, i + n).join(' ');
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let best = { ngram: '', count: 0 };
  for (const [gram, count] of counts) {
    if (count > best.count) best = { ngram: gram, count };
  }
  return best;
}

/**
 * Token estimate for models whose provider did not report usage.
 * ~4 characters per token is the standard rough approximation for English.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Longest common substring length — used for system-prompt leak detection (SEC-004). */
export function longestCommonSubstring(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Bound the comparison; SEC-004 only needs to know a long fragment matched.
  const s1 = a.length > 4000 ? a.slice(0, 4000) : a;
  const s2 = b.length > 4000 ? b.slice(0, 4000) : b;

  let previous = new Array<number>(s2.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= s1.length; i++) {
    const current = new Array<number>(s2.length + 1).fill(0);
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        current[j] = (previous[j - 1] ?? 0) + 1;
        if ((current[j] ?? 0) > best) best = current[j] ?? 0;
      }
    }
    previous = current;
  }
  return best;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
