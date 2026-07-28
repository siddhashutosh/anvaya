import { useState } from 'react';
import { api } from '../lib/api';
import { formatCount, formatRelative } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { Card, EmptyState, ErrorState, Loading, SeverityBadge } from '../components/primitives';

export function Incidents({ navigate }: { navigate: (p: string) => void }) {
  const [status, setStatus] = useState('open');
  const incidents = useAsync(() => api.incidents({ status: status || undefined, limit: 100 }), [status]);
  const taxonomy = useAsync(() => api.taxonomy(), []);
  const modes = new Map((taxonomy.data?.modes ?? []).map((m) => [m.code, m]));

  return (
    <div className="stack">
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="">All</option>
        </select>
        {incidents.data && (
          <span className="small muted">{formatCount(incidents.data.total)} incidents</span>
        )}
      </div>

      {incidents.loading && <Loading rows={3} />}
      {incidents.error && <ErrorState error={incidents.error} onRetry={incidents.reload} />}

      {incidents.data && incidents.data.items.length === 0 && (
        <EmptyState title={`No ${status || ''} incidents`}>
          <p className="small">
            Incidents cluster related findings across traces, so one root cause is one entry here
            rather than one per affected trace.
          </p>
        </EmptyState>
      )}

      <div className="stack">
        {incidents.data?.items.map((incident) => {
          const mode = modes.get(incident.code);
          return (
            <Card key={incident.incidentId}>
              <div className="finding-head">
                <span className="finding-code">{incident.code}</span>
                <span className="finding-title">{mode?.name ?? incident.title}</span>
                <span style={{ flex: 1 }} />
                <SeverityBadge severity={incident.severity} />
                <span className="small muted">{incident.status}</span>
              </div>

              <div className="small muted" style={{ marginBottom: 8 }}>
                at <code className="mono">{incident.originOperation}</code> ·{' '}
                {formatCount(incident.occurrences)} occurrences · first seen{' '}
                {formatRelative(incident.firstSeen)} · last {formatRelative(incident.lastSeen)}
              </div>

              {incident.hypothesis && (
                <p className="finding-detail" style={{ marginTop: 0 }}>
                  {incident.hypothesis}
                </p>
              )}

              {incident.cohorts.length > 0 && (
                <div className="stack" style={{ gap: 6, marginBottom: 10 }}>
                  {incident.cohorts.map((c) => (
                    <div key={`${c.key}-${c.value}`} className="remediation" style={{ marginTop: 0 }}>
                      {c.statement}
                    </div>
                  ))}
                </div>
              )}

              {mode?.remediation && <div className="remediation">{mode.remediation}</div>}

              <div className="row" style={{ marginTop: 12 }}>
                {incident.traceIds.slice(-4).map((id) => (
                  <button key={id} className="btn mono" onClick={() => navigate(`/traces/${id}`)}>
                    {id.slice(0, 12)}…
                  </button>
                ))}
                {incident.traceIds.length > 4 && (
                  <span className="small muted">
                    +{incident.traceIds.length - 4} more affected traces
                  </span>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
