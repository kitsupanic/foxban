ALTER TABLE boards ADD COLUMN github_installation_id INTEGER;
ALTER TABLE boards ADD COLUMN github_repository_id INTEGER;
ALTER TABLE boards ADD COLUMN github_repository_owner TEXT;
ALTER TABLE boards ADD COLUMN github_repository_name TEXT;

CREATE TABLE IF NOT EXISTS github_connection_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  installation_id INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_connection_states_expires_at
  ON github_connection_states(expires_at);
