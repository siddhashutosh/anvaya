/**
 * Trace volume over time: a stacked column chart, successful vs failed.
 *
 * Deliberately NOT a dual-axis chart. Volume and failure rate are different
 * scales, so the rate lives in a stat tile and this chart shows counts only.
 *
 * Palette validated (light #2a78d6/#d03b3b, dark #3987e5/#d03b3b): adjacent CVD
 * ΔE 23.8/25.7, normal-vision 31.6/31.9, both ≥3:1 on their surface.
 */

import { useState } from 'react';
import { formatCount, formatTime } from '../lib/format';
import type { TimeBucket } from '../lib/types';

const HEIGHT = 168;
/** 2px surface gap between stacked segments, per the mark spec. */
const SEGMENT_GAP = 2;

export function TimeseriesChart({ buckets }: { buckets: TimeBucket[] }) {
  const [hover, setHover] = useState<number | undefined>(undefined);

  const max = Math.max(1, ...buckets.map((b) => b.traces));
  const count = Math.max(1, buckets.length);
  const slot = 100 / count;
  const barWidth = Math.max(0.6, slot * 0.72);
  const hovered = hover !== undefined ? buckets[hover] : undefined;

  return (
    <div>
      <div className="legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--series-1)' }} />
          Succeeded
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--status-critical)' }} />
          Failed
        </span>
      </div>

      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 100 ${HEIGHT}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: HEIGHT, display: 'block', overflow: 'visible' }}
          role="img"
          aria-label={`Trace volume across ${buckets.length} time buckets`}
        >
          {/* recessive gridlines at quarter steps */}
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line
              key={f}
              x1="0"
              x2="100"
              y1={HEIGHT - f * HEIGHT}
              y2={HEIGHT - f * HEIGHT}
              stroke="var(--gridline)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {buckets.map((bucket, i) => {
            const x = i * slot + (slot - barWidth) / 2;
            const total = bucket.traces;
            if (total === 0) return null;

            const totalH = (total / max) * (HEIGHT - 8);
            const errH = total === 0 ? 0 : (bucket.errors / total) * totalH;
            const okH = Math.max(0, totalH - errH - (errH > 0 ? SEGMENT_GAP : 0));

            return (
              <g
                key={bucket.start}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(undefined)}
              >
                {/* generous hit target, wider than the mark */}
                <rect x={i * slot} y={0} width={slot} height={HEIGHT} fill="transparent" />
                {okH > 0 && (
                  <rect
                    x={x}
                    y={HEIGHT - totalH}
                    width={barWidth}
                    height={okH}
                    fill="var(--series-1)"
                    rx="0.6"
                    opacity={hover === undefined || hover === i ? 1 : 0.45}
                  />
                )}
                {errH > 0 && (
                  <rect
                    x={x}
                    y={HEIGHT - errH}
                    width={barWidth}
                    height={errH}
                    fill="var(--status-critical)"
                    rx="0.6"
                    opacity={hover === undefined || hover === i ? 1 : 0.45}
                  />
                )}
              </g>
            );
          })}

          <line
            x1="0"
            x2="100"
            y1={HEIGHT}
            y2={HEIGHT}
            stroke="var(--baseline)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {hovered && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: `${Math.min(72, (hover ?? 0) * slot)}%`,
              background: 'var(--surface-1)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 12,
              pointerEvents: 'none',
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
              whiteSpace: 'nowrap',
              zIndex: 2,
            }}
          >
            <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
              {formatTime(hovered.start)}
            </div>
            <div className="num">{formatCount(hovered.traces)} traces</div>
            <div className="num" style={{ color: 'var(--status-critical)' }}>
              {formatCount(hovered.errors)} failed
            </div>
            <div className="num muted">{formatCount(hovered.findings)} findings</div>
          </div>
        )}
      </div>

      <div
        className="row small muted"
        style={{ justifyContent: 'space-between', marginTop: 6 }}
      >
        <span>{buckets[0] ? formatTime(buckets[0].start) : ''}</span>
        <span>{buckets.length > 0 ? formatTime(buckets[buckets.length - 1]!.start) : ''}</span>
      </div>
    </div>
  );
}
