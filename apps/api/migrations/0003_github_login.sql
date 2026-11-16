-- Migration number: 0003 	 2026-09-02T00:00:00.000Z
-- The GitHub username a user has claimed, or NULL. Nothing is verified: it is
-- only the key for `github.com/<login>.png`, and every avatar surface falls
-- back to the initials circle when it is unset or the image fails to load.
ALTER TABLE users ADD COLUMN github_login TEXT;
