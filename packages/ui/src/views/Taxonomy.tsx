import { useState } from 'react';
import { api } from '../lib/api';
import { FAMILY_LABELS, formatPercent, severityColor } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { Card, ErrorState, Loading, SeverityBadge } from '../components/primitives';

export function Taxonomy() {
  const [family, setFamily] = useState('');
  const [query, setQuery] = useState('');
  const taxonomy = useAsync(() => api.taxonomy(), []);
  const detectors = useAsync(() => api.detectors(), []);

  if (taxonomy.loading) return <Loading rows={4} />;
  if (taxonomy.error) return <ErrorState error={taxonomy.error} onRetry={taxonomy.reload} />;
  if (!taxonomy.data) return null;

  const detectorsByCode = new Map<string, string[]>();
  for (const d of detectors.data?.detectors ?? []) {
    for (const code of d.emits) {
      detectorsByCode.set(code, [...(detectorsByCode.get(code) ?? []), d.id]);
    }
  }

  const needle = query.trim().toLowerCase();
  const modes = taxonomy.data.modes.filter((m) => {
    if (family && m.family !== family) return false;
    if (!needle) return true;
    return (
      m.code.toLowerCase().includes(needle) ||
      m.name.toLowerCase().includes(needle) ||
      m.definition.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="stack">
      <div className="filters">
        <select value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Family">
          <option value="">All families ({taxonomy.data.modes.length} modes)</option>
          {Object.entries(FAMILY_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {key} · {label}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Search definitions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search taxonomy"
          style={{ width: 240 }}
        />
        <span className="small muted">
          taxonomy v{taxonomy.data.version} · {modes.length} shown
        </span>
      </div>

      <div className="stack">
        {modes.map((mode) => (
          <Card key={mode.code}>
            <div className="finding-head">
              <span className="finding-code">{mode.code}</span>
              <span className="finding-title">{mode.name}</span>
              <span style={{ flex: 1 }} />
              <span className="kind-chip">{mode.tier}</span>
              <SeverityBadge severity={mode.defaultSeverity} />
            </div>

            <p className="finding-detail" style={{ marginTop: 4 }}>
              {mode.definition}
            </p>

            <div className="evidence" style={{ marginBottom: 10 }}>
              <span className="evidence-item">family: {FAMILY_LABELS[mode.family] ?? mode.family}</span>
              <span className="evidence-item">source: {mode.source.ref}</span>
              {mode.observedFrequency !== undefined && (
                <span
                  className="evidence-item"
                  style={{ borderColor: severityColor(mode.defaultSeverity) }}
                >
                  measured frequency: {formatPercent(mode.observedFrequency, 2)}
                </span>
              )}
              {detectorsByCode.get(mode.code)?.map((id) => (
                <span className="evidence-item" key={id}>
                  detector: {id}
                </span>
              ))}
              {mode.causes.length > 0 && (
                <span className="evidence-item">causes: {mode.causes.join(', ')}</span>
              )}
            </div>

            {mode.source.note && (
              <p className="small muted" style={{ margin: '0 0 8px' }}>
                {mode.source.note}
              </p>
            )}

            <div className="remediation">{mode.remediation}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
