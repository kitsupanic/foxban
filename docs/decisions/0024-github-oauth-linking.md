# 0024 — GitHub identity by OAuth linking

## Status
Superseded by 0026 — 2026-09-03. Its "GitHub is not a sign-in method" clause is reversed by ADR 0065.

## Context
ADR 0023 stored `users.github_login` as a self-asserted string: anyone could type any account's name and wear that person's picture. For a decoration that seemed acceptable; on inspection it is not — the field names a real third party, so it should require proving you are them. The question is how to verify it without reopening ADR 0008, which rejected third-party identity for *authentication*.

## Decision
- The GitHub account is proven by the standard OAuth web flow: `GET /auth/github/start` redirects to `/login/oauth/authorize`, and `GET /auth/github/callback` exchanges the code for a token server-side, reads `login` from `GET /user`, and writes it to the user's row. No `scope` is requested — an empty scope already grants the public profile, which is all `login` needs.
- Both routes sit behind `requireAuth`: this links an account to an *existing* session, so the session cookie's `SameSite=Lax` still travels on the top-level redirect back from GitHub. GitHub is not a sign-in method, and signup remains email/password behind an invite (ADRs 0011, 0012) — 0008 stands.
- CSRF is a `state` value mirrored into an httpOnly cookie and compared on the way back; the cookie is deleted on every callback, success or failure, so a state can never be replayed. Any mismatch, any failed exchange, any malformed response redirects to `/?github=error`, which the Boards page reads as "GitHub connection failed."
- The callback is now the only writer of `users.github_login`; `PATCH /me` narrows to `{ githubLogin: null }` and exists solely to disconnect. Migration 0004 clears the column, because every value in it predates verification. Storage and rendering are unchanged from 0023 — same column, same hotlinked `github.com/<login>.png?size=48`, same initials fallback — so 0023 is superseded only in how the value is obtained.
- The GitHub endpoints are `GITHUB_OAUTH_BASE` / `GITHUB_API_BASE` vars rather than constants. That is the test seam: `@cloudflare/vitest-pool-workers` 0.22 exports no outbound-fetch mock, so the exchange is proven end-to-end against a local stub server (`apps/web/e2e/github-stub.mjs`, also used by `wrangler dev`) instead of being mocked. The client secret is a Worker secret, never a var.

## Consequences
Rejected: keeping manual usernames — the unverifiable input is the whole complaint that opened this. Rejected: sign-in with GitHub — the auth stack is locked and this milestone touches no session, invite or signup path. Rejected: storing GitHub's numeric account id so a rename keeps the avatar — it would buy one extra column and a second lookup to avoid a fallback-to-initials until the user reconnects, which at this user count is not a trade. The costs accepted: the feature needs a registered OAuth App per environment (an empty `GITHUB_CLIENT_ID` makes `/auth/github/start` answer 503 rather than fail obscurely), the flow leaves the SPA for a full-page redirect, and a GitHub rename silently falls back to initials until the user reconnects.
