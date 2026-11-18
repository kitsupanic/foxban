# 0074 — The board enforces comment authorship

## Status
Accepted — 2026-11-19; amends 0015's authorship clause.

## Context
ADR 0015 let the client name a comment's author and let any member edit or delete any comment. It accepted that because the BoardDO did not know who sent a frame. It does now: every socket carries its `userId` (ADR 0029 already attributes activity with it). Boards also hold Guests from outside the workspace (ADR 0066, 0072), so "a tiny trusted user base" no longer holds. Any member could post as an Admin, or rewrite an Admin's comment so it still showed the Admin's name.

## Decision
- The mutation gate (`checkMutation` in `apps/api/src/mutation-gate.ts`) refuses `comment.create` whose `authorId` is not the socket's user, and `comment.update` or `comment.delete` on a comment someone else wrote.
- An instance Admin may delete any comment, as the UI already offered, but not edit one. The socket learns this once, at connect (`isAdmin` in its attachment, from the same D1 read as its access).
- Frames are still refused, never rewritten, so a committed frame is rebroadcast verbatim (ADR 0010).

## Consequences
The wire format does not change: `authorId` still travels, and must match. A socket opened before this change has no `isAdmin` and cannot delete others' comments until it reconnects. Timestamps stay client-supplied, as in 0015.
