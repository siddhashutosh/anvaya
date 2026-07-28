import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';
import {
  bandColor,
  confidenceBand,
  formatCount,
  severityColor,
} from '../lib/format';
import type { Severity } from '../lib/types';

export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          {title && <h2 className="card-title" style={{ margin: 0 }}>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: Severity;
}) {
  return (
    <div className="card">
      <div className="tile-label">{label}</div>
      <div className="tile-value" style={tone ? { color: severityColor(tone) } : undefined}>
        {value}
      </div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

/**
 * Severity is always a dot PLUS the word. Status colour never carries meaning
 * alone — required for colour-blind and forced-colours readers.
 */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className="sev">
      <span className="sev-dot" style={{ background: severityColor(severity) }} aria-hidden="true" />
      {severity}
    </span>
  );
}

/**
 * The mechanical enforcement of FR-7.9: a confidence value is never shown as a
 * bare number, always with its qualitative band, so a 0.5 heuristic guess cannot
 * read like a 0.95 deterministic fact.
 */
export function ConfidenceBar({ confidence }: { confidence: number }) {
  const band = confidenceBand(confidence);
  return (
    <span className="confidence" title={`confidence ${confidence.toFixed(2)}`}>
      <span className="confidence-track">
        <span
          className="confidence-fill"
          style={{ width: `${Math.max(4, confidence * 100)}%`, background: bandColor(band) }}
        />
      </span>
      <span>{band}</span>
    </span>
  );
}

export function BarRow({
  name,
  code,
  value,
  max,
  color,
  onClick,
}: {
  name: string;
  code?: string;
  value: number;
  max: number;
  color: string;
  onClick?: () => void;
}) {
  const pct = max === 0 ? 0 : (value / max) * 100;
  return (
    <div
      className="bar-row"
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}
    >
      <div>
        <div className="bar-row-head">
          {code && <span className="bar-row-code">{code}</span>}
          <span className="bar-row-name">{name}</span>
        </div>
        <div className="bar-track">
          <div className="bar-fill" style={{ width: `${Math.max(2, pct)}%`, background: color }} />
        </div>
      </div>
      <div className="bar-value">{formatCount(value)}</div>
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const unreachable = error.code === 'NETWORK_UNREACHABLE';
  return (
    <div className="state state-error" role="alert">
      <div className="state-title">
        {unreachable ? 'Cannot reach the Anvaya server' : 'Request failed'}
      </div>
      <p style={{ margin: '0 0 4px' }}>{error.message}</p>
      <p className="small muted" style={{ margin: 0 }}>
        <code>{error.code}</code>
        {error.requestId && (
          <>
            {' · request '}
            <code>{error.requestId}</code>
          </>
        )}
      </p>
      {unreachable && (
        <pre>{`npm run build:libs\nnpm run seed      # optional demo data\nnpm start`}</pre>
      )}
      {onRetry && (
        <button className="btn" style={{ marginTop: 14 }} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="state">
      <div className="state-title">{title}</div>
      {children}
    </div>
  );
}
