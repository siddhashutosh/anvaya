import { api } from '../lib/api';
import { formatCost, formatCount, formatDuration, formatRelative } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { Card, EmptyState, ErrorState, Loading, SeverityBadge } from '../components/primitives';

/**
 * Sessions are a first-class view rather than a filter over traces: two MAST
 * failure modes (FM-1.4 loss of conversation history, FM-2.1 conversation reset)
 * are only observable across the trace boundary.
 */
export function Sessions({
  range,
  navigate,
}: {
  range: { from: number; to: number };
  navigate: (p: string) => void;
}) {
  const sessions = useAsync(
    () => api.sessions({ ...range, minTraces: 2, limit: 100 }),
    [range.from, range.to],
  );

  if (sessions.loading) return <Loading rows={4} />;
  if (sessions.error) return <ErrorState error={sessions.error} onRetry={sessions.reload} />;

  if (!sessions.data || sessions.data.items.length === 0) {
    return (
      <EmptyState title="No multi-turn sessions in this window">
        <p className="small">
          A session is a set of traces sharing a conversation id. Pass{' '}
          <code>sessionId</code> to <code>anvaya.trace(...)</code> to group turns, and
          cross-turn failures such as <code>CTX-003</code> become detectable.
        </p>
      </EmptyState>
    );
  }

  return (
    <div className="stack">
      <div className="filters">
        <span className="small muted">
          {formatCount(sessions.data.total)} sessions with 2 or more turns
        </span>
      </div>

      <Card>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Turns</th>
                <th>Duration</th>
                <th>Findings</th>
                <th>Worst</th>
                <th>Errors</th>
                <th>Cost</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.items.map((s) => (
                <tr
                  key={s.sessionId}
                  className="clickable"
                  onClick={() => navigate(`/sessions/${encodeURIComponent(s.sessionId)}`)}
                >
                  <td className="mono">{s.sessionId}</td>
                  <td className="num">{s.traceCount}</td>
                  <td className="num">{formatDuration(s.lastSeen - s.startTime)}</td>
                  <td className="num">{s.findingCount}</td>
                  <td>
                    {s.worstSeverity ? (
                      <SeverityBadge severity={s.worstSeverity} />
                    ) : (
                      <span className="muted small">—</span>
                    )}
                  </td>
                  <td className="num">{s.errorCount}</td>
                  <td className="num">{formatCost(s.totalCostUsd)}</td>
                  <td className="num small">{formatRelative(s.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export function SessionDetail({
  sessionId,
  navigate,
}: {
  sessionId: string;
  navigate: (p: string) => void;
}) {
  const detail = useAsync(() => api.session(sessionId), [sessionId]);

  if (detail.loading) return <Loading rows={3} />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return null;

  const { traces, findings, taxonomy } = detail.data;
  const findingsByTrace = new Map<string, typeof findings>();
  for (const f of findings) {
    findingsByTrace.set(f.traceId, [...(findingsByTrace.get(f.traceId) ?? []), f]);
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/sessions')}>
        ← All sessions
      </button>

      <Card title={`Conversation · ${traces.length} turns`}>
        <div className="stack" style={{ gap: 8 }}>
          {traces.map((t, i) => {
            const turnFindings = findingsByTrace.get(t.traceId) ?? [];
            return (
              <div
                key={t.traceId}
                className="waterfall-row"
                style={{ gridTemplateColumns: '52px minmax(0,1fr) 120px', cursor: 'pointer' }}
                onClick={() => navigate(`/traces/${t.traceId}`)}
              >
                <span className="kind-chip">turn {i + 1}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="mono small">{t.traceId.slice(0, 20)}…</div>
                  {turnFindings.length > 0 && (
                    <div className="row" style={{ gap: 6, marginTop: 4 }}>
                      {turnFindings.map((f) => (
                        <span
                          key={f.findingId}
                          className="finding-code"
                          title={taxonomy[f.code]?.name ?? f.code}
                        >
                          {f.code}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="waterfall-dur">
                  {formatDuration(t.durationMs)} · {formatCost(t.totalCostUsd)}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {findings.length > 0 && (
        <Card title="Cross-turn findings">
          <div className="stack" style={{ gap: 10 }}>
            {findings
              .filter((f) => f.detectorId.startsWith('session.'))
              .map((f) => (
                <div key={f.findingId} className="finding">
                  <div className="finding-head">
                    <span className="finding-code">{f.code}</span>
                    <span className="finding-title">{taxonomy[f.code]?.name ?? f.title}</span>
                  </div>
                  <p className="finding-detail">{f.detail}</p>
                  {taxonomy[f.code]?.remediation && (
                    <div className="remediation">{taxonomy[f.code]?.remediation}</div>
                  )}
                </div>
              ))}
            {findings.filter((f) => f.detectorId.startsWith('session.')).length === 0 && (
              <p className="muted small" style={{ margin: 0 }}>
                No cross-turn failures detected in this session.
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
