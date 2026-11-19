# 0080 — Demoting a workspace admin revokes the workspace's admin invite links

## Status
Accepted — 2026-11-19; amends 0079.

## Context
0079 revokes a workspace's links when an admin removes a member, so the member cannot rejoin through a link they kept. A demotion revoked nothing. A demoted admin who still held a live admin-role link from another admin (often the one they joined with) could leave, which revokes nothing, and accept that link again: they came back as admin, undoing the demotion. `INVITER_IS_ADMIN` only covers a link whose issuer lost the role, not the person accepting it.

## Decision
- The `workspace-member-role` commit batch also runs `UPDATE workspace_invites SET revoked_at=? WHERE workspace_id=? AND role='admin' AND revoked_at IS NULL` when the new role is `member`. The revoke and the role change commit together or not at all.
- The revoke is guarded by `EXISTS(... workspace_members ... role='admin')` for the target and runs before the role change in the batch, so it fires only for a real demotion: setting a member to member (or re-sending the same change) revokes nothing, and another admin's admin link stays usable.
- Member-role links are left alone: they hand back no authority the demotion took away.

## Consequences
A demotion revokes every live admin-role link of the workspace, whoever issued it. Re-promoting the demoted admin revives only member-role links whose issuer is an admin again (`INVITER_IS_ADMIN`); the revoked admin-role links stay revoked. Admins demoted before this change keep any live admin link until it expires, at most 7 days after deploy; there is no backfill migration.

After a demotion, other pending admin invitees lose their link and need a fresh one; the old token answers `400 workspace_invite_unavailable`. Rejected: binding each link to the people who already used it (links are shared in channels, so a use is not tied to one identity), and refusing re-accept for anyone ever demoted (needs a new table and still lets an admin promote them by hand).
