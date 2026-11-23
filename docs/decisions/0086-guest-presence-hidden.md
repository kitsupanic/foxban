# 0086 — A guest row does not show the guest's presence

## Status
Accepted — 2026-11-23; amends 0075.

## Context
0075 shows a viewer the presence (online, last seen, time zone) of every owner and member of a board they can open, and counted any `board_members` row as a member. Anyone who can open a board may add any account to it by exact email, with no consent (ADR 0072). So Mallory made a board, added the victim as a guest, and saw the victim's presence from then on, without the victim agreeing to anything or sharing a workspace with her.

## Decision
- Through a board, a viewer sees the presence of its owner and of members of the board's own workspace who are on it: every workspace member on a Workspace board, only those with a `board_members` row on a Private one. A guest (a `board_members` row without membership of the board's workspace) shows nothing through that board.
- Both reads state this one rule and are mirror images of each other in `presence-do.ts`: the connecting viewer's snapshot (subjects a viewer may see) and the per-change fan-out (viewers who may see a subject).
- What a guest sees is unchanged: they open the board, so they see the presence of its owner and workspace members.
- Instance Admins still see everyone (0075), and a viewer still sees themself.

## Consequences
An outside guest's presence is no longer shown to the board's people through that board: their rail entry has no online dot, last seen or time zone. The same holds for someone who left or was removed from the workspace but kept a board grant. They keep their open right (ADR 0066) and lose only this.

A guest still sees the presence of the board's owner and workspace members. Any board member can already invite an outside account to read the board itself, so this adds little. Rejected: an accept step before a guest is added, which is a new flow for a cosmetic feature. Rejected: hiding the board's people from guests as well, which loses the "who is here" signal for the guest's own work.

This narrows the tracking path but does not close it. A direct workspace add (`workspaces.ts` add-member by exact email) takes no acceptance, so Mallory can still add the victim to a workspace and see their presence as a member. Closing it needs adds to require acceptance: future work.
