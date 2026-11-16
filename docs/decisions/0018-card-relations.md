# 0018 — Card relations as directional rows with reverse reads

## Status
Accepted — 2026-09-01

## Context
This ADR adds Jira-style links between cards without crossing the one-BoardDO snapshot boundary. A relation must describe either a symmetric association or which card blocks the other without storing two rows that can drift apart.

## Decision
- One link is `{ id, sourceCardId, targetCardId, kind }`, where `kind` is `relates` or `blocks`; `relates` is symmetric, while “blocked by” is always the reverse read of one `blocks` row and is never stored as a kind.
- Dedicated `relation.create` and `relation.delete` messages carry links; there is no update message, so changing kind is delete then create.
- Relations are same-board only because one BoardDO owns one complete snapshot. The server follows the existing validation-free child-entity precedent: it does not check existence, self-links, or duplicate pairs; the client picker prevents self-links and duplicate pairs, with hardening deferred.
- Card and column deletion cascade rows matching either `sourceCardId` or `targetCardId`.

## Consequences
A `blocks` link has no workflow enforcement because cards have no done state; the red ⛔ badge is informational. Client-generated ids and verbatim rebroadcast retain the ADR 0007 last-write-wins model, including the accepted possibility of duplicate rows from a concurrent create race.
