import type { Severity } from './types';

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatRelative(epochMs: number): string {
  const delta = Date.now() - epochMs;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Status-palette colour per severity. Always rendered alongside the label. */
export function severityColor(severity: Severity): string {
  return `var(--sev-${severity})`;
}

/**
 * Confidence band (FR-7.9). This mapping is the mechanism that stops a heuristic
 * finding from being presented with the same weight as a deterministic one.
 */
export function confidenceBand(confidence: number): 'possible' | 'likely' | 'confirmed' {
  if (confidence >= 0.8) return 'confirmed';
  if (confidence >= 0.5) return 'likely';
  return 'possible';
}

export function bandColor(band: 'possible' | 'likely' | 'confirmed'): string {
  if (band === 'confirmed') return 'var(--seq-600)';
  if (band === 'likely') return 'var(--seq-450)';
  return 'var(--seq-250)';
}

export const FAMILY_LABELS: Record<string, string> = {
  INF: 'Infrastructure & transport',
  CTX: 'Input & context',
  RET: 'Retrieval & grounding',
  GEN: 'Generation quality',
  AGT: 'Agent & orchestration',
  TOL: 'Tool & function calling',
  SEC: 'Safety & security',
  ECO: 'Economics & drift',
};

export const RANGES: { label: string; ms: number }[] = [
  { label: 'Last hour', ms: 3_600_000 },
  { label: 'Last 24 hours', ms: 86_400_000 },
  { label: 'Last 7 days', ms: 7 * 86_400_000 },
  { label: 'Last 30 days', ms: 30 * 86_400_000 },
];
