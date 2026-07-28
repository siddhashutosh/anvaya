import { ConfidenceBar, SeverityBadge } from './primitives';
import type { FailureMode, Finding } from '../lib/types';

export function FindingCard({
  finding,
  mode,
  spanName,
  causedByCode,
}: {
  finding: Finding;
  mode?: FailureMode;
  spanName?: string;
  causedByCode?: string;
}) {
  return (
    <article className={`finding ${finding.role}`}>
      <div className="finding-head">
        <span className="finding-code">{finding.code}</span>
        <span className="finding-title">{mode?.name ?? finding.title}</span>
        {finding.role === 'origin' && <span className="role-chip role-origin">origin</span>}
        {finding.role === 'symptom' && (
          <span className="role-chip role-symptom">
            symptom{causedByCode ? ` of ${causedByCode}` : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <SeverityBadge severity={finding.severity} />
        <ConfidenceBar confidence={finding.confidence} />
      </div>

      <div className="small muted">
        {spanName && (
          <>
            span <code className="mono">{spanName}</code> ·{' '}
          </>
        )}
        detector <code className="mono">{finding.detectorId}</code> · tier {finding.tier}
        {mode?.source && <> · source: {mode.source.ref}</>}
      </div>

      <p className="finding-detail">{finding.detail}</p>

      <div className="evidence">
        {finding.evidence.map((e, i) => (
          <span className="evidence-item" key={`${e.label}-${i}`}>
            {e.label}: {String(e.value)}
            {e.comparison && (
              <> (baseline {e.comparison.baseline}, n={e.comparison.samples})</>
            )}
          </span>
        ))}
      </div>

      {/* Remediation always travels with the finding (NFR-6.3). */}
      {mode?.remediation && <div className="remediation">{mode.remediation}</div>}
    </article>
  );
}
