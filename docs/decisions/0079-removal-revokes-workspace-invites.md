# 0079 — Removing a workspace member revokes the workspace's live invite links

## Status
Accepted — 2026-11-19; amends 0066's membership removal.

## Context
A workspace invite (`workspace_invites`) is a multi-use link, valid until it expires or an admin revokes it. A member an admin removed could open the link they had already used and join again, as the role the link carries (an admin link made them an admin). Removal deleted only their `workspace_members` row.

## Decision
- The `workspace-member-remove` commit batch also runs `UPDATE workspace_invites SET revoked_at=? WHERE workspace_id=? AND revoked_at IS NULL` when the actor is not the person removed. The revoke and the delete commit together or not at all.
- Leaving (the actor removes themselves) revokes nothing: nobody was shut out, and the other links keep working.
- An accept or an add that finds the membership already there answers success without an access change, so it no longer closes every socket of every board of the workspace for a no-op.

## Consequences
After a removal an admin issues a fresh link for anyone who should still join; the old ones answer `400 workspace_invite_unavailable`, the same as an expired link. Other pending invitees lose their link too. Rejected: revoking only the link the removed member used, which a link shared in a channel cannot be tied to one person; and a per-user ban on rejoining by link, which needs a new table and still lets an admin add them back by hand.
