/**
 * Ordered, idempotent, forward-only migrations (FR-5.3).
 *
 * Applied inside a transaction at startup and recorded in schema_migrations. A
 * failed migration aborts startup: the server never runs against an unknown schema.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE IF NOT EXISTS traces (
        trace_id            TEXT PRIMARY KEY,
        session_id          TEXT,
        service             TEXT NOT NULL,
        environment         TEXT NOT NULL,
        root_span_id        TEXT,
        name                TEXT NOT NULL,
        start_time          INTEGER NOT NULL,
        end_time            INTEGER NOT NULL,
        duration_ms         INTEGER NOT NULL,
        status              TEXT NOT NULL,
        span_count          INTEGER NOT NULL DEFAULT 0,
        total_input_tokens  INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd      REAL    NOT NULL DEFAULT 0,
        finding_count       INTEGER NOT NULL DEFAULT 0,
        worst_severity      TEXT,
        attributes          TEXT    NOT NULL DEFAULT '{}',
        attribution         TEXT
      );

      CREATE TABLE IF NOT EXISTS spans (
        span_id        TEXT PRIMARY KEY,
        trace_id       TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
        parent_span_id TEXT,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL,
        start_time     INTEGER NOT NULL,
        end_time       INTEGER NOT NULL,
        duration_ms    INTEGER NOT NULL,
        status         TEXT NOT NULL,
        status_message TEXT,
        attributes     TEXT NOT NULL DEFAULT '{}',
        events         TEXT NOT NULL DEFAULT '[]',
        llm            TEXT,
        retrieval      TEXT,
        tool           TEXT,
        agent          TEXT
      );

      CREATE TABLE IF NOT EXISTS findings (
        finding_id       TEXT PRIMARY KEY,
        trace_id         TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
        span_id          TEXT,
        code             TEXT NOT NULL,
        family           TEXT NOT NULL,
        severity         TEXT NOT NULL,
        confidence       REAL NOT NULL,
        detector_id      TEXT NOT NULL,
        tier             TEXT NOT NULL,
        title            TEXT NOT NULL,
        detail           TEXT NOT NULL,
        evidence         TEXT NOT NULL DEFAULT '[]',
        role             TEXT NOT NULL,
        caused_by        TEXT,
        taxonomy_version TEXT NOT NULL,
        created_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS incidents (
        incident_id       TEXT PRIMARY KEY,
        code              TEXT NOT NULL,
        origin_operation  TEXT NOT NULL,
        severity          TEXT NOT NULL,
        status            TEXT NOT NULL,
        first_seen        INTEGER NOT NULL,
        last_seen         INTEGER NOT NULL,
        occurrences       INTEGER NOT NULL DEFAULT 1,
        trace_ids         TEXT NOT NULL DEFAULT '[]',
        title             TEXT NOT NULL,
        hypothesis        TEXT,
        cohorts           TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS baselines (
        metric     TEXT NOT NULL,
        scope      TEXT NOT NULL,
        stats      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (metric, scope)
      );

      CREATE TABLE IF NOT EXISTS detector_runs (
        trace_id      TEXT NOT NULL,
        detector_id   TEXT NOT NULL,
        tier          TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        duration_ms   REAL NOT NULL,
        finding_count INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (trace_id, detector_id)
      );
    `,
  },
  {
    version: 2,
    name: 'indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_traces_start    ON traces(start_time DESC);
      CREATE INDEX IF NOT EXISTS idx_traces_service  ON traces(service, start_time DESC);
      CREATE INDEX IF NOT EXISTS idx_traces_status   ON traces(status, start_time DESC);
      CREATE INDEX IF NOT EXISTS idx_traces_session  ON traces(session_id);

      CREATE INDEX IF NOT EXISTS idx_spans_trace     ON spans(trace_id, start_time);
      CREATE INDEX IF NOT EXISTS idx_spans_parent    ON spans(parent_span_id);
      CREATE INDEX IF NOT EXISTS idx_spans_kind      ON spans(kind);

      CREATE INDEX IF NOT EXISTS idx_findings_code   ON findings(code, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_findings_trace  ON findings(trace_id);
      CREATE INDEX IF NOT EXISTS idx_findings_sev    ON findings(severity, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_findings_family ON findings(family, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_incidents_state ON incidents(status, last_seen DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_code  ON incidents(code, status);

      CREATE INDEX IF NOT EXISTS idx_runs_detector   ON detector_runs(detector_id, outcome);
    `,
  },
  {
    version: 3,
    name: 'session-turns',
    sql: `
      -- The session-relevant projection of a trace, written at persist time.
      -- Session-scoped detection (MAST FM-1.4 / FM-2.1) compares the newest
      -- adjacent pair of turns, so it needs the previous turn's shape without
      -- re-reading that trace's spans.
      ALTER TABLE traces ADD COLUMN session_turn TEXT;

      CREATE INDEX IF NOT EXISTS idx_traces_session_time
        ON traces(session_id, start_time DESC);
    `,
  },
  {
    version: 4,
    name: 'analysis-marker',
    sql: `
      -- Marks traces the pipeline has processed, so the incremental ingest path
      -- can find ones whose root span never arrived (ADR-0009). Present in both
      -- adapters so inline mode is not Postgres-only.
      ALTER TABLE traces ADD COLUMN analyzed_at INTEGER;

      CREATE INDEX IF NOT EXISTS idx_traces_unanalyzed
        ON traces(start_time) WHERE analyzed_at IS NULL;
    `,
  },
];
