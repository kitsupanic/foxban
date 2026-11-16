-- Migration number: 0016
-- Linking GitHub now goes through the instance GitHub App (ADR 0064) and stores
-- GitHub's numeric user id next to the login name. The id is the key: it survives a
-- rename, and the unique index means one GitHub account links to one foxban account
-- (SQLite treats NULLs as distinct, so unlinked users do not collide).
ALTER TABLE users ADD COLUMN github_user_id INTEGER;
CREATE UNIQUE INDEX users_github_user_id ON users (github_user_id);
-- Every existing link came from the old OAuth App and has no id. Clear them: people link again once.
UPDATE users SET github_login = NULL;
