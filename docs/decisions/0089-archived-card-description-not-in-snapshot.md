# 0089 — The snapshot lists archived cards without their description

## Status
Accepted — 2026-11-25; the same cut ADR 0073 and 0078 made, applied to archived cards' text.

## Context
The snapshot carried every archived card in full, description included (up to 100,000 bytes each), on every connect, reconnect and first transfer import. Archived cards are kept 90 days and a column delete archives all of its cards at once, so the archive can hold thousands of descriptions. Nothing on the web shows one: the archive dialog lists title, column and age, and a card's text is read only once it is restored. This is the same unbounded growth ADR 0073 and 0078 removed for activity and comments.

## Decision
- The snapshot's `archivedCards` keep their shape, but every `description` is `''`. The BoardDO reads them with one SELECT (`ARCHIVED_CARD_LIST_SELECT`) that differs from `ARCHIVED_CARD_SELECT` only in that column, so the shared types stay as they are. The stored row is untouched.
- The live `cards.archived` frame (after `card.delete` and `column.delete`) still carries the description: it is one archive's worth, not the board's history, and a client that holds the text restores without waiting.
- A restore needs the text back, and the verbatim `card.restore` broadcast cannot carry it (ADR 0010). After that broadcast the board sends every socket, sender included, a server-only frame `{ type: "card.restored", id, description }`. It carries the description of the row the restore just activated, so it is exact whatever the client held. It has no `mutationId`: the verbatim echo settles the sender, and the frame changes only the restored card's text.
- The web applies it in `applyMutation`, reached through the reconciler's existing path for a frame that is not a client mutation, to the now-active card with that id; a card that is not active is left alone. The sender's optimistic restore, and the echo, show a card from a snapshot with an empty description until this frame, the next one, lands; the sender's pending edits stay on top of its text.
- `REALTIME_PROTOCOL_VERSION` goes from 13 to 14 (ADR 0045): an older client would restore a snapshot-origin card with an empty description and could save that over the real one, and it cannot parse the new frame.

## Consequences
The snapshot's size no longer depends on archived descriptions. Nothing reads an archived card's text from the socket, so a future view of one needs a per-card read like ADR 0073's. A client holding a description from a `cards.archived` frame keeps it until the next snapshot replaces it with `''`; restore then fills it again. MCP reads archived tasks from the BoardDO's own SQL and card transfer reads the row, so neither changes. Rejected: truncating the description in the snapshot, which would still restore a wrong card; and putting the text in the `card.restore` broadcast, which breaks the verbatim rule.
