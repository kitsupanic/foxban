-- sessions.id now holds the SHA-256 of the session cookie, not the cookie itself (ADR 0084).
-- Every existing row holds a raw cookie value that no longer matches any lookup, so clear them:
-- everyone signs in once. Migrations run before the deploy, so a sign-in in that gap can still leave one raw
-- row; the new Worker never matches it, and it expires within 30 days.
DELETE FROM sessions;
