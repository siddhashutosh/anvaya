import { api } from '../lib/api';
import {
  FAMILY_LABELS,
  formatCost,
  formatCount,
  formatDuration,
  formatPercent,
  severityColor,
} from '../lib/format';
import { useAsync } from '../lib/hooks';
import { BarRow, Card, EmptyState, ErrorState, Loading, StatTile } from '../components/primitives';
import { TimeseriesChart } from '../components/TimeseriesChart';
import { SEVERITIES } from '../lib/format';

export function Overview({
  range,
  navigate,
}: {
  range: { from: number; to: number };
  navigate: (path: string) => void;
}) {
  const stats = useAsync(() => api.overview(range), [range.from, range.to]);
  const series = useAsync(
    () => api.timeseries({ ...range, bucketMs: Math.max(3_600_000, (range.to - range.from) / 60) }),
    [range.from, range.to],
  );

  if (stats.loading) return <Loading rows={4} />;
  if (stats.error) return <ErrorState error={stats.error} onRetry={stats.reload} />;
  if (!stats.data) return null;

  const s = stats.data;

  if (s.traceCount === 0) {
    return (
      <EmptyState title="No traces yet">
        <p>
          Instrument an application with <code>@anvaya/sdk</code>, or seed a demo dataset to
          explore the dashboard.
        </p>
        <pre style={{ textAlign: 'left', maxWidth: 460, margin: '14px auto 0' }}>
          {`npm run seed   # 120 traces with injected failures`}
        </pre>
      </EmptyState>
    );
  }

  const maxCode = Math.max(1, ...s.topCodes.map((c) => c.count));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid grid-tiles">
        <StatTile
          label="Traces"
          value={formatCount(s.traceCount)}
          note={`${formatCount(s.incidentCount)} incidents`}
        />
        <StatTile
          label="Failure rate"
          value={formatPercent(s.failureRate)}
          note={`${formatCount(s.errorTraceCount)} failed traces`}
          tone={s.failureRate > 0.1 ? 'high' : undefined}
        />
        <StatTile
          label="Findings"
          value={formatCount(s.findingCount)}
          note={`${formatCount(s.openIncidentCount)} open incidents`}
        />
        <StatTile label="p95 latency" value={formatDuration(s.p95DurationMs)} note={`p50 ${formatDuration(s.p50DurationMs)}`} />
        <StatTile label="Spend" value={formatCost(s.totalCostUsd)} note={`${formatCount(s.totalTokens)} tokens`} />
      </div>

      <div className="grid grid-2">
        <Card title="Trace volume">
          {series.loading && <Loading rows={1} />}
          {series.error && <ErrorState error={series.error} onRetry={series.reload} />}
          {series.data && <TimeseriesChart buckets={series.data.buckets} />}
        </Card>

        <Card title="Findings by severity">
          <div className="stack" style={{ gap: 2 }}>
            {SEVERITIES.map((sev) => (
              <BarRow
                key={sev}
                name={sev}
                value={s.bySeverity[sev] ?? 0}
                max={Math.max(1, ...Object.values(s.bySeverity))}
                color={severityColor(sev)}
                onClick={() => navigate(`/findings?severity=${sev}`)}
              />
            ))}
          </div>
        </Card>
      </div>

      <Card
        title="Top failure modes"
        actions={
          <button className="btn" onClick={() => navigate('/taxonomy')}>
            Browse taxonomy
          </button>
        }
      >
        {s.topCodes.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            No findings in this window.
          </p>
        ) : (
          <div className="stack" style={{ gap: 2 }}>
            {s.topCodes.map((c) => (
              <BarRow
                key={c.code}
                code={c.code}
                name={`${c.name ?? c.code} · ${FAMILY_LABELS[c.family ?? ''] ?? ''}`}
                value={c.count}
                max={maxCode}
                color={severityColor(c.severity)}
                onClick={() => navigate(`/findings?code=${c.code}`)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
