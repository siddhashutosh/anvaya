/**
 * Postgres schema.
 *
 * The SQLite migrations' Postgres counterpart. Statements are listed separately
 * rather than concatenated because the Neon pooled driver executes one statement
 * per round trip.
 *
 * Deliberate dialect choices:
 *   - `jsonb` instead of TEXT for structured columns, so cohort and cost queries
 *     can index and filter inside them rather than parsing in JavaScript.
 *   - `BIGINT` for epoch milliseconds. Postgres returns it as a string; the
 *     mappers coerce (see `num`).
 */

export interface PgMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const PG_MIGRATIONS: readonly PgMigration[] = [
  {
    version: 1,
    name: 'initial',
    statements: [
      `CREATE TABLE IF NOT EXISTS traces (
        trace_id            TEXT PRIMARY KEY,
        session_id          TEXT,
        service             TEXT NOT NULL,
        environment         TEXT NOT NULL,
        root_span_id        TEXT,
        name                TEXT NOT NULL,
        start_time          BIGINT NOT NULL,
        end_time            BIGINT NOT NULL,
        duration_ms         BIGINT NOT NULL,
        status              TEXT NOT NULL,
        span_count          INTEGER NOT NULL DEFAULT 0,
        total_input_tokens  BIGINT NOT NULL DEFAULT 0,
        total_output_tokens BIGINT NOT NULL DEFAULT 0,
        total_cost_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
        finding_count       INTEGER NOT NULL DEFAULT 0,
        worst_severity      TEXT,
        attributes          JSONB NOT NULL DEFAULT '{}'::jsonb,
        attribution         JSONB,
        session_turn        JSONB,
        analyzed_at         BIGINT
      )`,
      `CREATE TABLE IF NOT EXISTS spans (
        span_id        TEXT PRIMARY KEY,
        trace_id       TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
        parent_span_id TEXT,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL,
        start_time     BIGINT NOT NULL,
        end_time       BIGINT NOT NULL,
        duration_ms    BIGINT NOT NULL,
        status         TEXT NOT NULL,
        status_message TEXT,
        attributes     JSONB NOT NULL DEFAULT '{}'::jsonb,
        events         JSONB NOT NULL DEFAULT '[]'::jsonb,
        llm            JSONB,
        retrieval      JSONB,
        tool           JSONB,
        agent          JSONB
      )`,
      `CREATE TABLE IF NOT EXISTS findings (
        finding_id       TEXT PRIMARY KEY,
        trace_id         TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
        span_id          TEXT,
        code             TEXT NOT NULL,
        family           TEXT NOT NULL,
        severity         TEXT NOT NULL,
        confidence       DOUBLE PRECISION NOT NULL,
        detector_id      TEXT NOT NULL,
        tier             TEXT NOT NULL,
        title            TEXT NOT NULL,
        detail           TEXT NOT NULL,
        evidence         JSONB NOT NULL DEFAULT '[]'::jsonb,
        role             TEXT NOT NULL,
        caused_by        TEXT,
        taxonomy_version TEXT NOT NULL,
        created_at       BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS incidents (
        incident_id      TEXT PRIMARY KEY,
        code             TEXT NOT NULL,
        origin_operation TEXT NOT NULL,
        severity         TEXT NOT NULL,
        status           TEXT NOT NULL,
        first_seen       BIGINT NOT NULL,
        last_seen        BIGINT NOT NULL,
        occurrences      INTEGER NOT NULL DEFAULT 1,
        trace_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
        title            TEXT NOT NULL,
        hypothesis       TEXT,
        cohorts          JSONB NOT NULL DEFAULT '[]'::jsonb
      )`,
      `CREATE TABLE IF NOT EXISTS baselines (
        metric     TEXT NOT NULL,
        scope      TEXT NOT NULL,
        stats      JSONB NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (metric, scope)
      )`,
      `CREATE TABLE IF NOT EXISTS detector_runs (
        trace_id      TEXT NOT NULL,
        detector_id   TEXT NOT NULL,
        tier          TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        duration_ms   DOUBLE PRECISION NOT NULL,
        finding_count INTEGER NOT NULL DEFAULT 0,
        created_at    BIGINT NOT NULL,
        PRIMARY KEY (trace_id, detector_id)
      )`,
    ],
  },
  {
    version: 2,
    name: 'indexes',
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_traces_start ON traces(start_time DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_traces_service ON traces(service, start_time DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status, start_time DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_traces_session_time ON traces(session_id, start_time DESC)`,
      // Partial index: the sweep that finds unanalysed traces only ever looks at
      // rows where analyzed_at IS NULL, which is a tiny slice of the table.
      `CREATE INDEX IF NOT EXISTS idx_traces_unanalyzed ON traces(start_time) WHERE analyzed_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id, start_time)`,
      `CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id)`,
      `CREATE INDEX IF NOT EXISTS idx_findings_code ON findings(code, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_findings_trace ON findings(trace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_findings_sev ON findings(severity, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_findings_family ON findings(family, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_incidents_state ON incidents(status, last_seen DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_incidents_code ON incidents(code, status)`,
      `CREATE INDEX IF NOT EXISTS idx_runs_detector ON detector_runs(detector_id, outcome)`,
    ],
  },
];
