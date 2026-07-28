import { useState } from 'react';
import { api } from '../lib/api';
import { formatCost, formatCount, formatDuration, formatTime } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { Card, ErrorState, Loading, StatTile } from '../components/primitives';
import { FindingCard } from '../components/FindingCard';
import { Waterfall } from '../components/Waterfall';

export function TraceDetail({ traceId, navigate }: { traceId: string; navigate: (p: string) => void }) {
  const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>(undefined);
  const detail = useAsync(() => api.trace(traceId), [traceId]);

  if (detail.loading) return <Loading rows={4} />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return null;

  const { trace, spans, findings, attribution, taxonomy } = detail.data;

  const byId = new Map(findings.map((f) => [f.findingId, f]));
  const spanName = (spanId?: string): string | undefined =>
    spanId ? spans.find((s) => s.spanId === spanId)?.name : undefined;

  // Origin first, then its symptoms, then everything else — the reading order
  // that matches the diagnosis rather than the detection order.
  const ordered = [...findings].sort((a, b) => {
    const rank = (r: string): number => (r === 'origin' ? 0 : r === 'symptom' ? 1 : 2);
    return rank(a.role) - rank(b.role) || b.confidence - a.confidence;
  });

  const selected = selectedSpanId ? spans.find((s) => s.spanId === selectedSpanId) : undefined;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/traces')}>
        ← All traces
      </button>

      <div className="grid grid-tiles">
        <StatTile label="Duration" value={formatDuration(trace.durationMs)} note={formatTime(trace.startTime)} />
        <StatTile label="Spans" value={String(trace.spanCount)} note={trace.service} />
        <StatTile
          label="Findings"
          value={String(findings.length)}
          note={trace.status === 'error' ? 'trace errored' : 'HTTP-level success'}
          tone={trace.worstSeverity}
        />
        <StatTile
          label="Tokens"
          value={formatCount(trace.totalInputTokens + trace.totalOutputTokens)}
          note={formatCost(trace.totalCostUsd)}
        />
      </div>

      {attribution && attribution.chain.length > 0 && (
        <Card title="Diagnosis">
          <p style={{ margin: '0 0 12px', fontSize: 14 }}>{attribution.summary}</p>
          <div className="chain">
            {attribution.chain.map((link, i) => (
              <span key={link.findingId} className="row" style={{ gap: 8 }}>
                {i > 0 && <span className="chain-arrow">→</span>}
                <span className="finding-code">{link.code}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card title="Span waterfall">
        <Waterfall
          spans={spans}
          findings={findings}
          originFindingId={attribution?.originFindingId}
          onSelectSpan={(id) => setSelectedSpanId(id === selectedSpanId ? undefined : id)}
          selectedSpanId={selectedSpanId}
        />
      </Card>

      {selected && (
        <Card title={`Span · ${selected.name}`}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 }}>
            <Field label="Kind" value={selected.kind} />
            <Field label="Status" value={selected.status} />
            <Field label="Duration" value={formatDuration(selected.durationMs)} />
            {selected.llm?.requestModel && <Field label="Model" value={selected.llm.requestModel} />}
            {selected.llm?.inputTokens !== undefined && (
              <Field label="Input tokens" value={String(selected.llm.inputTokens)} />
            )}
            {selected.llm?.outputTokens !== undefined && (
              <Field label="Output tokens" value={String(selected.llm.outputTokens)} />
            )}
            {selected.llm?.finishReason && (
              <Field label="Finish reason" value={selected.llm.finishReason} />
            )}
            {selected.tool?.toolName && <Field label="Tool" value={selected.tool.toolName} />}
            {selected.retrieval?.indexName && (
              <Field label="Index" value={selected.retrieval.indexName} />
            )}
            {selected.retrieval?.documents && (
              <Field
                label="Top score"
                value={String(
                  Math.max(...selected.retrieval.documents.map((d) => d.score ?? 0)).toFixed(3),
                )}
              />
            )}
          </div>
          {selected.statusMessage && (
            <p className="small" style={{ color: 'var(--status-critical)', marginBottom: 0 }}>
              {selected.statusMessage}
            </p>
          )}
        </Card>
      )}

      <div>
        <h2 className="card-title">Findings ({findings.length})</h2>
        <div className="stack">
          {ordered.length === 0 && (
            <p className="muted small">No findings — every detector passed on this trace.</p>
          )}
          {ordered.map((f) => (
            <FindingCard
              key={f.findingId}
              finding={f}
              mode={taxonomy[f.code]}
              spanName={spanName(f.spanId)}
              causedByCode={f.causedBy ? byId.get(f.causedBy)?.code : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tile-label">{label}</div>
      <div className="mono" style={{ marginTop: 3 }}>
        {value}
      </div>
    </div>
  );
}
