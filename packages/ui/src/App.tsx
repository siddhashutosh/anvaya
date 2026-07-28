import { useMemo, useState } from 'react';
import { api } from './lib/api';
import { RANGES } from './lib/format';
import { useHashRoute, useTheme } from './lib/hooks';
import { Findings } from './views/Findings';
import { Incidents } from './views/Incidents';
import { Overview } from './views/Overview';
import { SessionDetail, Sessions } from './views/Sessions';
import { TraceDetail } from './views/TraceDetail';
import { Traces } from './views/Traces';
import { Taxonomy } from './views/Taxonomy';

const NAV = [
  { path: '/', label: 'Overview' },
  { path: '/traces', label: 'Traces' },
  { path: '/sessions', label: 'Sessions' },
  { path: '/findings', label: 'Findings' },
  { path: '/incidents', label: 'Incidents' },
  { path: '/taxonomy', label: 'Taxonomy' },
] as const;

export function App() {
  const [route, navigate] = useHashRoute();
  const [theme, toggleTheme] = useTheme();
  // Default to 7 days so a freshly seeded dataset is visible immediately.
  const [rangeMs, setRangeMs] = useState(RANGES[2]?.ms ?? 7 * 86_400_000);

  const [path, queryString] = route.split('?');
  const query = useMemo(() => new URLSearchParams(queryString ?? ''), [queryString]);

  // Re-anchored only when the window length changes, so a re-render does not
  // shift the range under the user mid-investigation.
  const range = useMemo(() => {
    const to = Date.now();
    return { from: to - rangeMs, to };
  }, [rangeMs]);

  const segments = (path ?? '/').split('/').filter(Boolean);
  const section = segments[0] ?? '';

  const { title, subtitle, body } = renderRoute();

  function renderRoute(): { title: string; subtitle: string; body: JSX.Element } {
    if (section === 'traces' && segments[1]) {
      return {
        title: 'Trace detail',
        subtitle:
          'The waterfall shows what happened; the diagnosis shows which finding caused the others.',
        body: <TraceDetail traceId={segments[1]} navigate={navigate} />,
      };
    }
    if (section === 'sessions' && segments[1]) {
      return {
        title: 'Session',
        subtitle:
          'A conversation across many traces. Cross-turn failures live here — no single trace can show them.',
        body: <SessionDetail sessionId={decodeURIComponent(segments[1])} navigate={navigate} />,
      };
    }

    switch (section) {
      case '':
        return {
          title: 'Overview',
          subtitle: 'Failure rate, spend, and the most frequent named failure modes.',
          body: <Overview range={range} navigate={navigate} />,
        };
      case 'traces':
        return {
          title: 'Traces',
          subtitle: 'Every recorded request. A green trace with findings is the interesting case.',
          body: <Traces range={range} navigate={navigate} />,
        };
      case 'sessions':
        return {
          title: 'Sessions',
          subtitle:
            'Multi-turn conversations. MAST FM-1.4 and FM-2.1 are defined across turns, so they are only detectable here.',
          body: <Sessions range={range} navigate={navigate} />,
        };
      case 'findings':
        return {
          title: 'Findings',
          subtitle:
            'Individual detections, each with evidence and a confidence band. Filter by role to see only root causes.',
          body: (
            <Findings
              range={range}
              navigate={navigate}
              initialCode={query.get('code') ?? undefined}
              initialSeverity={query.get('severity') ?? undefined}
            />
          ),
        };
      case 'incidents':
        return {
          title: 'Incidents',
          subtitle:
            'Findings clustered by root cause, so many affected traces are one entry — not many.',
          body: <Incidents navigate={navigate} />,
        };
      case 'taxonomy':
        return {
          title: 'Failure taxonomy',
          subtitle:
            'The 56 named failure modes Anvaya can detect, each with its research source and remediation.',
          body: <Taxonomy />,
        };
      default:
        return {
          title: 'Not found',
          subtitle: '',
          body: (
            <div className="state">
              <div className="state-title">No such page</div>
              <button className="btn" style={{ marginTop: 12 }} onClick={() => navigate('/')}>
                Back to overview
              </button>
            </div>
          ),
        };
    }
  }

  const showRange = section !== 'taxonomy' && section !== 'incidents' && !segments[1];

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-name">Anvaya</div>
          <div className="brand-tag">why your AI product fails</div>
        </div>

        {NAV.map((item) => (
          <button
            key={item.path}
            className="nav-item"
            aria-current={
              (item.path === '/' ? section === '' : `/${section}` === item.path) ? 'page' : undefined
            }
            onClick={() => navigate(item.path)}
          >
            {item.label}
          </button>
        ))}

        <div className="nav-spacer" />

        <button className="nav-item" onClick={toggleTheme}>
          {theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </button>
        <div className="brand-tag" style={{ padding: '8px 10px 0' }}>
          {api.baseUrl.replace(/^https?:\/\//, '')}
        </div>
      </nav>

      <main className="main">
        <header className="page-head">
          <div>
            <h1 className="page-title">{title}</h1>
            {subtitle && <p className="page-sub">{subtitle}</p>}
          </div>

          {showRange && (
            <select
              value={rangeMs}
              onChange={(e) => setRangeMs(Number(e.target.value))}
              aria-label="Time range"
            >
              {RANGES.map((r) => (
                <option key={r.ms} value={r.ms}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </header>

        {body}
      </main>
    </div>
  );
}
