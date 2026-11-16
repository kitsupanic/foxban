# 0054 — Atomic configured card creation and its settlement

## Status
Accepted — 2026-09-14

## Context
The redesigned Create a card dialog collects a title, destination column, type, priority and assignee before anything is sent. The original board could only create a card with its title: everything else was a follow-up instant mutation. Sending a create and then three independent edits means a partial card whenever one of them is rejected, dropped or interrupted, and each intermediate state is visible to peers on a live board. The dialog also needs an honest answer to "did my card get created?" — a send is not an acceptance.

## Decision
- One strict `card.create` frame carries the whole first draft: `taskType` (epic/spike/task/bug), `priority` and `assigneeId` are optional alongside the existing title, destination and position. Omission keeps the defaults every card has always been created with (task, medium, unassigned); `subtask` is deliberately not accepted, because a subtask is created by its parent through `subtask.create`.
- The server keeps one creation path: the enriched frame is validated, the destination column is checked, and a single INSERT writes the row — including priority and assignee — inside the same transaction that allocates the task number and records exactly one `card.created` activity. No follow-up edit history is synthesized.
- The wire version moves to `REALTIME_PROTOCOL_VERSION = "6"`. Broadcast frames are relayed verbatim and clients parse them strictly, so a client that does not know the new fields cannot safely consume them.
- The optimistic client applies the same defaults from the same message, so the cache never shows a card the server would not have written.
- A creation settles against authority, never against the optimistic row: the dialog subscribes before sending, allocates one entity id and one mutation id per attempt, and closes only on `accepted`. A rejection keeps the draft editable, a dropped send keeps the values and says nothing was sent, and a timeout or uncertain outcome keeps the submitted values locked while the reconnect snapshot settles it — by identity, in either the active or the archived cards. Only the snapshot's absence of the card unlocks the draft for an explicit retry; there is no automatic resend.

## Consequences
A card arrives configured or not at all, and a peer never sees a half-built card. The dialog's transport **Retry** stays usable while a creation is pending, because reconnecting and re-reading the snapshot is what settles an uncertain attempt; the submitted fields stay locked so retrying can never change what was sent. Adding a field to the first draft now requires a shared-contract, BoardDO, optimistic-apply and protocol-version change rather than a new mutation, and an older client bundle is rejected at the WebSocket handshake until it updates.
