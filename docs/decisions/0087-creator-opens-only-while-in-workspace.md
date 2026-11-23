# 0087 — A board's creator opens it only while in its workspace

## Status
Accepted — 2026-11-23; amends 0066.

## Context
0066 let the board's creator (`boards.owner_id`) open it unconditionally and kept the open right of one who was removed from or left the workspace, taking only their manage right. Nothing could take it back: the creator's own `board_members` row, written when they made the board, was the owner's to keep (`DELETE /boards/:id/members/:ownerId` answered `403`), and the removal of a workspace member deleted only their `workspace_members` row. Bob made a Workspace board in W, an admin removed Bob from W, and Bob still read and wrote it over REST, the socket and MCP until the board was deleted.

## Decision
- The creator opens the board (`canOpenBoard` / `boardOpenSql`) only while they are a member of its workspace, the same condition under which they already manage it. A removed creator keeps only what a `board_members` row gives any guest.
- The `workspace-member-remove` commit batch also deletes the removed person's `board_members` rows on the boards they created in that workspace. That row is the creator's seat, not a grant someone chose to give. Rows on boards others made stay (0066: a guest grant survives removal).
- `DELETE /boards/:id/members/:ownerId` is refused (`403 board owner cannot be removed`) only while the owner is a member of the board's workspace. Once they are not, their row (one added by hand) is removed like anyone's, by anyone who can open the board. The route, the reservation and the commit all assert it, so a creator who rejoined in between is not removed. Removing yourself stays refused.
- A board move gives the owner a `board_members` row in the same batch only when they are a member of the destination workspace (they are the creator there as well). A creator who is not in it is not re-granted a seat by the move.
- Migration 0028 deletes every `board_members` row where the user is the board's owner and not a member of the board's workspace: the seat of a creator removed before this rule, and of one a board move left outside.

## Consequences
Removing or leaving a workspace cuts the creator off their Workspace and Private boards in it: the access change already fences every board of the workspace and closes its sockets (4010), and the reconnect runs the shared rule. Joining again restores the board through ownership. The deploy removes the rows of creators already outside their board's workspace, so they lose those boards at once, and an owner left outside by an earlier board move loses the guest row it gave them; an admin can add them back by hand. A Private board's creator who rejoins is not on its member list (no row) until added again.

Rejected: letting an admin delete the creator's seat by hand, which leaves the board open to a removed person until someone remembers. Rejected: ignoring the creator's row in the open rule, which would also cut off a guest added by hand to a board they created. The presence of a removed creator is still shown through the board's owner (0086); this decision does not change it.
