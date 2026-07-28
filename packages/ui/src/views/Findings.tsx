import { useState } from 'react';
import { api } from '../lib/api';
import { FAMILY_LABELS, SEVERITIES, formatCount, formatRelative } from '../lib/format';
import { useAsync } from '../lib/hooks';
import {
  Card,
  ConfidenceBar,
  EmptyState,
  ErrorState,
  Loading,
  SeverityBadge,
} from '../components/primitives';

export function Findings({
  range,
  navigate,
  initialCode,
  initialSeverity,
}: {
  range: { from: number; to: number };
  navigate: (p: string) => void;
  initialCode?: string;
  initialSeverity?: string;
}) {
  const [code, setCode] = useState(initialCode ?? '');
  const [family, setFamily] = useState('');
  const [severity, setSeverity] = useState(initialSeverity ?? '');
  const [role, setRole] = useState('');

  const findings = useAsync(
    () =>
      api.findings({
        ...range,
        code: code || undefined,
        family: family || undefined,
        severity: severity || undefined,
        role: role || undefined,
        limit: 150,
      }),
    [range.from, range.to, code, family, severity, role],
  );

  const taxonomy = useAsync(() => api.taxonomy(), []);
  const modes = new Map((taxonomy.data?.modes ?? []).map((m) => [m.code, m]));

  return (
    <div className="stack">
      <div className="filters">
        <select value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Family">
          <option value="">All families</option>
          {Object.entries(FAMILY_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {key} · {label}
            </option>
          ))}
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
          <option value="">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="">Any role</option>
          <option value="origin">Origin (root cause)</option>
          <option value="symptom">Symptom</option>
          <option value="standalone">Standalone</option>
        </select>
        <input
          type="search"
          placeholder="Code, e.g. RET-002"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          aria-label="Taxonomy code"
          style={{ width: 150 }}
        />
        {findings.data && (
          <span className="small muted">{formatCount(findings.data.total)} matching</span>
        )}
      </div>

      {findings.loading && <Loading rows={4} />}
      {findings.error && <ErrorState error={findings.error} onRetry={findings.reload} />}

      {findings.data && findings.data.items.length === 0 && (
        <EmptyState title="No findings match these filters">
          <p className="small">
            An empty result is a good outcome — it means no detector fired for this slice.
          </p>
        </EmptyState>
      )}

      {findings.data && findings.data.items.length > 0 && (
        <Card>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Failure mode</th>
                  <th>Severity</th>
                  <th>Confidence</th>
                  <th>Role</th>
                  <th>Tier</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {findings.data.items.map((f) => (
                  <tr
                    key={f.findingId}
                    className="clickable"
                    onClick={() => navigate(`/traces/${f.traceId}`)}
                  >
                    <td className="mono">{f.code}</td>
                    <td>
                      <div style={{ fontWeight: 550 }}>{modes.get(f.code)?.name ?? f.title}</div>
                      <div className="small muted" style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {f.detail}
                      </div>
                    </td>
                    <td>
                      <SeverityBadge severity={f.severity} />
                    </td>
                    <td>
                      <ConfidenceBar confidence={f.confidence} />
                    </td>
                    <td className="small">{f.role}</td>
                    <td className="small mono">{f.tier}</td>
                    <td className="small num">{formatRelative(f.createdAt)}</td>
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
