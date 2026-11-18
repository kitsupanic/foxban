# 0065 — Log in with GitHub

## Status
Accepted — 2026-11-13. Reverses the "GitHub is never authentication" clause of ADRs 0008, 0024 and 0026.

## Context
Issue #4. The instance now has one GitHub App that can also sign users in (ADR 0064). Signup is gated by invites (ADR 0012) and Admin status comes from configured emails.

## Decision
- GitHub becomes a sign-in method next to email and password, which stays.
- The sign-in key is GitHub's numeric user id, stored on the user. The login name is kept for the picture only. This reverses 0024's choice not to store the id. Existing links are cleared and people link again once with the new App.
- Signing up with GitHub still needs a valid invite.
- GitHub sign-in never makes someone an Admin, even when their GitHub email is in the admin list. Such an account gets GitHub's no-reply address; if that exact address is on the admin list too, the signup is refused and nothing is created.
- No automatic linking by email. If GitHub's email matches an existing account, the user is told to sign in with their password and link GitHub in Profile. Otherwise anyone who controls that email on GitHub could take over the account.
- Accounts created with GitHub have no password. `users.password_hash` holds the marker `*` (`NO_PASSWORD_HASH`), which no password verifies, so password login refuses them with the same generic 401 as any bad login. `/me` says whether a password exists (`hasPassword`).
- Setting a password needs no current password, but only while the account has none. It is `POST /auth/password` without `currentPassword`, with the same rotation and revocation rules (compare-and-set against the marker, every other session revoked in the same batch), so two simultaneous first passwords cannot both win. Once there is a password, a change needs the current one as before.
- Until a password exists, disconnecting GitHub is refused, and so is changing the sign-in email: both would leave the session as the only proof (ADR 0026 makes the current password the proof of ownership). Both answer 403 with `code: "PASSWORD_REQUIRED"`; the email refusal comes before any duplicate or admin check, so it probes nothing.

## Consequences
Rejected: open GitHub signup, which would undo invite gating. Rejected: linking accounts by email, which allows takeover. Rejected: a nullable `password_hash`, which needs a rebuild of the `users` table (D1 cannot drop NOT NULL) and teaches every reader a new case, for no gain over a marker nothing verifies. Accepted: one more sign-in path to keep in step with session revocation (ADR 0026).
