-- Migration number: 0004 	 2026-09-02T12:00:00.000Z
-- From here the column means "verified by the GitHub OAuth web flow": it is
-- written only by /auth/github/callback and cleared by PATCH /me. The values
-- already in it were self-asserted under 0003 and nobody proved them, so they go.
UPDATE users SET github_login = NULL;
