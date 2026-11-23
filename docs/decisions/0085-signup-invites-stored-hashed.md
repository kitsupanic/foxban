# 0085 — Signup invites are stored hashed and need their creator to still be an admin

## Status
Accepted — 2026-11-23; amends 0012.

## Context
0012 stored each signup invite's token in plain text so pending links stayed copyable from the admin page. A signup link is a bearer secret: whoever holds an unspent one can make an account. ADR 0084 took the raw session cookie out of D1, which left these tokens as the secret a read of D1 (a backup, a Time Travel restore, an exported copy) still handed over.

Claiming a token also never asked who had made it. An address removed from `ADMIN_EMAILS` left its unspent links working for up to 7 days. Workspace invites already check this: they need their issuer to still be a workspace admin (`INVITER_IS_ADMIN`, ADR 0080).

## Decision
- `invites.token_hash` (the old `token` column, renamed) holds `sha256Hex(token)`. A token is 256 random bits, so a plain SHA-256 needs no salt. The raw token and its link exist only in the `POST /invites` response: `{ id, token, createdAt, expiresAt }`, where `id` is the hash.
- `GET /invites` lists `{ id, createdAt, expiresAt, usedBy, usedAt }` and `DELETE /invites/:id` takes the hash. Neither can return or accept a link. Signup, by email and by GitHub (`createUserWithInvite`), hashes the presented token before it looks the row up.
- The claim's `UPDATE` also requires that the invite's creator is still a configured admin: `EXISTS` a user with that id whose email is in `adminEmails(env)`, bound as one JSON array (`json_each`) as the operator SQL does (ADR 0071). `ADMIN_EMAILS` is an env secret, not a D1 row, so this is the only way to test it in the same statement. The claim stays one atomic batch, and a refusal looks like any other invalid invite (the same generic 403 or `unlinked`). It spends nothing: if the creator is listed again, the same token works.
- `createUserWithInvite` takes `env` instead of the D1 binding, since it now reads `ADMIN_EMAILS`.
- The Account invites page keeps a link only in the tab that made it, until the page is left or reloaded, and says so. Other unspent rows show their created and expiry dates and a Revoke button.
- Migration 0027 renames the column and deletes every unspent row. Their values are raw tokens that match no lookup now, and D1 has no SHA-256 to rehash them with. Spent rows stay as the audit trail of who used what: nothing reads their value, and a spent token cannot be claimed again.

## Consequences
A read of D1 yields no usable signup link. The deploy invalidates every unspent invite, so admins mint new ones. A link the admin did not copy cannot be shown again: they revoke it and generate another.

The list still shows an unspent invite whose creator was removed from `ADMIN_EMAILS`. It cannot be used, and revoking it, or the 7 days, clears it. Rejected: encrypting tokens so links stay copyable, which moves the secret to a key instead of removing it. Rejected: deleting a demoted admin's invites when the list changes, since nothing runs when an env secret changes.
