-- ADR 0088: where the nightly attachment sweep stops when its subrequest budget runs out, so the next run resumes there
-- instead of starting the bucket over. One row per job; no row means the next run starts at the beginning.
CREATE TABLE IF NOT EXISTS maintenance_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
