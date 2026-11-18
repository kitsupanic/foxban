# 0075 — Presence is scoped to the boards a viewer can open

## Status
Accepted — 2026-11-19; amends 0039.

## Context
ADR 0039 sent every account's presence (id, online, last seen, time zone) to every signed-in socket. It came before workspaces (ADR 0066). After ADR 0072 stopped member pickers from listing the whole instance, presence was the one list left: a Guest on one board learned how many accounts exist, when each is active, and their time zones.

## Decision
- A viewer sees their own presence and that of each owner and member of every board they can open (`boardOpenSql`, `boardMemberSql`). Presence is shown only on a board's member rail, so this is everyone the UI needs.
- An instance Admin opens every board, so sees everyone. The Worker tells the PresenceDO at connect (`x-foxban-is-admin`, always overwritten).
- The PresenceDO reads D1: one query for a connecting viewer's snapshot, one per online/offline change for which connected viewers may receive it. A failed read sends nothing (presence is cosmetic, so it fails closed). The frame is built after the read, so when two changes race, the last one sent carries the current state.

## Consequences
Someone added to a board sees its people's presence from their next presence connect (the next page load), and its people see theirs from the next change. Each change now costs one D1 read, which is fine at the expected load (a small team).
