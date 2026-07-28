import { useState } from 'react';
import { api } from '../lib/api';
import { formatCost, formatCount, formatDuration, formatRelative } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { Card, EmptyState, ErrorState, Loading, SeverityBadge } from '../components/primitives';

export function Traces({
  range,
  navigate,
}: {
  range: { from: number; to: number };
  navigate: (path: string) => void;
}) {
  const [status, setStatus] = useState<string>('');
  const [onlyFindings, setOnlyFindings] = useState(false);

  const traces = useAsync(
    () =>
      api.traces({
        ...range,
        status: status || undefined,
        hasFindings: onlyFindings ? 'true' : undefined,
        limit: 100,
      }),
    [range.from, range.to, status, onlyFindings],
  );

  return (
    <div className="stack">
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="ok">Succeeded</option>
          <option value="error">Failed</option>
        </select>
        <label className="row small" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={onlyFindings}
            onChange={(e) => setOnlyFindings(e.target.checked)}
          />
          Only traces with findings
        </label>
        {traces.data && (
          <span className="small muted">{formatCount(traces.data.total)} matching</span>
        )}
      </div>

      {traces.loading && <Loading rows={4} />}
      {traces.error && <ErrorState error={traces.error} onRetry={traces.reload} />}

      {traces.data && traces.data.items.length === 0 && (
        <EmptyState title="No traces match these filters">
          <p className="small">Widen the time range or clear the filters.</p>
        </EmptyState>
      )}

      {traces.data && traces.data.items.length > 0 && (
        <Card>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Trace</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Spans</th>
                  <th>Findings</th>
                  <th>Worst</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {traces.data.items.map((t) => (
                  <tr
                    key={t.traceId}
                    className="clickable"
                    onClick={() => navigate(`/traces/${t.traceId}`)}
                  >
                    <td>
                      <div style={{ fontWeight: 550 }}>{t.name}</div>
                      <div className="mono muted">{t.traceId.slice(0, 16)}…</div>
                    </td>
                    <td className="num small">{formatRelative(t.startTime)}</td>
                    <td className="num">{formatDuration(t.durationMs)}</td>
                    <td className="num">{t.spanCount}</td>
                    <td className="num">{t.findingCount}</td>
                    <td>{t.worstSeverity ? <SeverityBadge severity={t.worstSeverity} /> : <span className="muted small">—</span>}</td>
                    <td className="num">{formatCost(t.totalCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
