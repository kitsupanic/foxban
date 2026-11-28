# 0090 — Agent credentials need the current password and end with it; a board move takes the creator's seat; a no-op membership write changes nothing

## Status
Accepted — 2026-11-28; amends 0055, 0081 (resolves its first follow-up) and 0087.

## Context
0081 left one gap open on purpose: an MCP agent credential (0055, valid up to 90 days) was issued on the session alone and survived a password change. Someone holding a stolen session cookie minted one, and when the owner changed the password, which ends the other sessions, the thief kept reading and writing the owner's boards over `/mcp` until the credential expired. The credential routes also ran their own origin check (`originAllowed`, which accepts only `APP_ORIGIN`) next to the app-wide one (0083, which also accepts the request's own origin), so the two disagreed.

0087 made the creator's `board_members` row a seat that is good only while the creator is in the board's workspace, and the `workspace-member-remove` commit takes it. A board move did not: it added a seat for a creator in the destination but never removed the one they had. Alice made board B in W1; Bob, an admin of W1 and W2, moved B to W2, where Alice is not a member; Alice still opened B through her old row.

A board member add for someone who already has a row, a remove for someone who has none, and a workspace role change to the role the person already holds each ran a full access change: the workspace scope is locked, the board (or every board of the workspace) is fenced, and every socket on it is closed (4010). Anyone who can open a board may add members, so any guest could loop the add and keep dropping everyone's connection.

## Decision
- `POST /me/agent-credentials` takes `currentPassword` in its body and verifies it the way `POST /auth/github/link` does: behind `rateLimitAuth` and the per-account limit, a missing or wrong password is `401 { error: "invalid credentials" }` with nothing stored, and the check runs before any board is looked at. An account with no password (GitHub only, 0065) sends none, as for a link; setting its first password revokes what it issued (below).
- The insert is guarded by the caller's `sessions` row still existing. A password change or GitHub disconnect from another session deletes it in the batch that revokes the credentials, so a credential cannot be written after that batch from a session it ended; such a request answers `401 unauthorized`.
- The batch that changes a password (or sets a first one) also runs `UPDATE agent_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?`, guarded like its session delete by the new hash being in place, so a refused change revokes nothing. The GitHub disconnect batch (`PATCH /me` with `githubLogin: null`) runs the same update. A sign-out still does not revoke credentials.
- The credential router drops its own origin check and relies on the app-wide one (0083). Its `GET` reads only metadata and the API sends no CORS headers, so another origin cannot read it.
- The web form asks for the current password when the account has one, and clears it once the token is issued or the dialog closes.
- The board-move commit also deletes the owner's `board_members` row when the owner is a member of the source workspace and not of the destination. Both scopes are reserved for the move, so neither membership can change under it. It deletes whatever role the row holds, as the `workspace-member-remove` commit and migration 0028 do: an owner never holds a `manager` row (a move grants it only to a mover who is not the owner, and an add writes `member`), and a manager grant gives a person outside the workspace no manage right anyway. An owner already outside the source keeps their row: their seat went with their membership, so the row is a guest grant someone added by hand, and a move keeps every guest's row.
- `POST /boards/:id/members` for someone with a `board_members` row, and `DELETE /boards/:id/members/:userId` for someone without one, answer `{ ok: true }` without an access change, only while the board has no pending access change and no access change holds its workspace (one in flight may still change the answer, so the request meets its conflict instead). An add for a member of a Workspace board who has no row still runs: it writes the row, which keeps them on the board if it becomes Private. The route's refusals (the owner while in the workspace, yourself, a manager without manage rights) still come first.
- `PATCH /workspaces/:id/members/:userId` to the role the person already holds answers `{ operationId, state: "completed", outcome: "committed", result: { ok: true } }` without an access change, under the same condition, after the admin and last-admin checks. Such a change was never a demotion, so it revoked no admin links (0080) and changes nothing.
- In every case an attempt id already in the journal is answered from it first, as before.

## Consequences
A stolen session can no longer leave behind a sign-in that a password change does not end: changing the password, setting a first one, or disconnecting GitHub ends every agent credential of the account, the owner's own included, and they issue new ones. Issuing a credential is limited like a login. Two follow-ups of 0081 remain: the session a password is changed from keeps working, and `PATCH /me` can disconnect GitHub on the session alone when a password exists.

A creator outside the board's new workspace loses the board with the move, and its fence closes their sockets; joining the new workspace gives it back through ownership. A creator who wants to keep a board they moved away from them can be added by hand.

A no-op answers success without a journal row, so a replay of that attempt id later runs as a new attempt; the outcome it asks for is the same.

Rejected: revoking credentials on sign-out (a credential is meant to outlive the browser, 0055). Rejected: asking for the password on every credential list or revoke (they reveal no secret, and revoking is what a person who lost control wants to do quickly). Rejected: short-circuiting a Workspace board member's add (it writes a row that matters once the board turns Private).
