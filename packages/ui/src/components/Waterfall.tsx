/**
 * Time-proportional span waterfall (FR-7.4, FR-7.5).
 *
 * The attributed origin is visually primary and its symptoms are subordinate, so
 * a reader sees one diagnosis rather than N equal red badges.
 */

import { formatDuration, severityColor } from '../lib/format';
import type { Finding, SpanKind, SpanRecord } from '../lib/types';

const KIND_COLOR: Record<SpanKind, string> = {
  llm: 'var(--series-1)',
  retriever: 'var(--seq-450)',
  reranker: 'var(--seq-250)',
  embedding: 'var(--seq-250)',
  tool: 'var(--status-warning)',
  agent: 'var(--status-good)',
  guardrail: 'var(--status-serious)',
  evaluator: 'var(--seq-600)',
  chain: 'var(--baseline)',
  prompt: 'var(--baseline)',
  unknown: 'var(--text-muted)',
};

interface Row {
  span: SpanRecord;
  depth: number;
}

/** Flatten the tree depth-first so parents render immediately above children. */
function flatten(spans: SpanRecord[]): Row[] {
  const byParent = new Map<string | undefined, SpanRecord[]>();
  const ids = new Set(spans.map((s) => s.spanId));

  for (const span of spans) {
    // A span whose parent was never ingested is treated as a root, not hidden.
    const key = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : undefined;
    const list = byParent.get(key) ?? [];
    list.push(span);
    byParent.set(key, list);
  }

  const rows: Row[] = [];
  const walk = (parent: string | undefined, depth: number): void => {
    const children = (byParent.get(parent) ?? []).sort((a, b) => a.startTime - b.startTime);
    for (const span of children) {
      rows.push({ span, depth });
      if (depth < 12) walk(span.spanId, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

export function Waterfall({
  spans,
  findings,
  originFindingId,
  onSelectSpan,
  selectedSpanId,
}: {
  spans: SpanRecord[];
  findings: Finding[];
  originFindingId?: string;
  onSelectSpan?: (spanId: string) => void;
  selectedSpanId?: string;
}) {
  if (spans.length === 0) return <p className="muted">No spans recorded.</p>;

  const traceStart = Math.min(...spans.map((s) => s.startTime));
  const traceEnd = Math.max(...spans.map((s) => s.endTime));
  const total = Math.max(1, traceEnd - traceStart);

  const findingsBySpan = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!f.spanId) continue;
    const list = findingsBySpan.get(f.spanId) ?? [];
    list.push(f);
    findingsBySpan.set(f.spanId, list);
  }

  const rows = flatten(spans);

  return (
    <div>
      {rows.map(({ span, depth }) => {
        const left = ((span.startTime - traceStart) / total) * 100;
        const width = Math.max(0.6, (span.durationMs / total) * 100);
        const spanFindings = findingsBySpan.get(span.spanId) ?? [];
        const isOrigin = spanFindings.some((f) => f.findingId === originFindingId);
        const worst = spanFindings.reduce<Finding | undefined>(
          (acc, f) => (!acc || f.severity === 'critical' ? f : acc),
          undefined,
        );

        return (
          <div
            key={span.spanId}
            className="waterfall-row"
            onClick={() => onSelectSpan?.(span.spanId)}
            style={{
              cursor: onSelectSpan ? 'pointer' : undefined,
              background: selectedSpanId === span.spanId ? 'var(--hover)' : undefined,
            }}
          >
            <div className="waterfall-name" style={{ paddingLeft: depth * 12 }}>
              <span className="kind-chip">{span.kind}</span>
              <span
                style={{
                  fontWeight: isOrigin ? 650 : 400,
                  color: span.status === 'error' ? 'var(--status-critical)' : undefined,
                }}
              >
                {span.name}
              </span>
              {spanFindings.length > 0 && (
                <span
                  className="sev-dot"
                  style={{ background: severityColor(worst?.severity ?? 'info') }}
                  title={`${spanFindings.length} finding(s)`}
                />
              )}
            </div>

            <div className="waterfall-track">
              <div
                className="waterfall-bar"
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  background:
                    span.status === 'error'
                      ? 'var(--status-critical)'
                      : KIND_COLOR[span.kind],
                  // 2px surface ring so overlapping bars stay separable.
                  boxShadow: isOrigin ? '0 0 0 2px var(--surface-1), 0 0 0 4px var(--sev-critical)' : undefined,
                }}
                title={`${span.name} — ${formatDuration(span.durationMs)}`}
              />
            </div>

            <div className="waterfall-dur">{formatDuration(span.durationMs)}</div>
          </div>
        );
      })}
    </div>
  );
}
