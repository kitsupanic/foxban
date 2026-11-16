-- Migration number: 0020
-- The per-board GitHub repository (ADR 0041, migration 0008) is replaced by the
-- instance GitHub App and its connected repos (ADR 0064). Boards no longer own a
-- repo, so the four binding columns and the table that held an unfinished connect
-- go. Boards themselves are untouched; an Admin sets the new App up with the button.
ALTER TABLE boards DROP COLUMN github_installation_id;
ALTER TABLE boards DROP COLUMN github_repository_id;
ALTER TABLE boards DROP COLUMN github_repository_owner;
ALTER TABLE boards DROP COLUMN github_repository_name;
DROP TABLE github_connection_states;
