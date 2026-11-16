-- Migration number: 0019
-- Repos waiting for their backfill (ADR 0064): when the App is installed or repos are
-- added, each repo's existing open PRs, branches and recently closed PRs are loaded
-- onto cards. The job is queue-less: a row here is the work, `run_after` (epoch ms) is
-- both the lease while a run holds it and the hold-off after a GitHub rate limit or
-- failure, and the every-minute cron picks up whatever is due. Pointers only, no card data.
CREATE TABLE github_backfill_queue (
  repo_id INTEGER PRIMARY KEY,
  queued_at INTEGER NOT NULL,
  run_after INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
