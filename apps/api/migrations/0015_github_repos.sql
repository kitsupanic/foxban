-- Migration number: 0015
-- The instance's connected repos (ADR 0064): repos the instance's GitHub App is
-- installed on. They belong to the instance, not to a board. Kept current by the
-- webhook endpoint and re-read from GitHub whenever the Admin page opens.
CREATE TABLE github_repos (
  repo_id INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  connected_at INTEGER NOT NULL
);
CREATE INDEX github_repos_installation ON github_repos (installation_id);
