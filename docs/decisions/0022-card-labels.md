# 0022 — Card labels as board-scoped definitions plus join rows

## Status
Accepted — 2026-09-02

## Context
This ADR adds Trello-style labels: a small named, coloured tag reused across a board's cards. A label is the first board-level entity with a cardinality no card column can hold — one label belongs to many cards, and renaming or recolouring it must move every card that carries it at once.

## Decision
- Two tables rather than one, the codebase's first: `labels` holds the board-scoped definitions `{ id, name, color }`, and `card_labels` holds the assignments `{ id, cardId, labelId }`. A join row carries its own id, so unassigning stays `DELETE ... WHERE id = ?` like every other child entity and never needs a composite key.
- `color` is a protocol enum of eight names (`red`, `orange`, `amber`, `green`, `teal`, `blue`, `purple`, `pink`); the Tailwind classes it maps to stay client-side, exactly as priority's glyphs and colours do. The DO stores it as passthrough TEXT with no CHECK — zod is the enforcement point, per the `kind` precedent of ADR 0018.
- Full CRUD in one place, the card's own picker: `label.create`, `label.update` (partial — an absent field is COALESCEd back), `label.delete`, `label.assign`, `label.unassign`. Creating a label from a card is two ordinary mutations, create then assign, with no server transaction (ADR 0019).
- `label.delete` deletes the definition *and* every join row that names it, on the server, in the client reducer, and in the rollback inverse. Card and column deletion cascade join rows only: the definition is the board's, not the card's.
- A label name reuses the wire's shared 200-char title bound. The empty-name guard lives in the UI, which treats an emptied field as a slip and keeps the old name — the same rule the card title has.
- No UNIQUE constraint on `(card_id, label_id)`, matching the validation-free child-entity posture. Two clients assigning the same label concurrently leaves two rows; the client's `cardLabelViews` selector dedupes by `labelId` so the pill renders once.
- Removing that pill or toggling the selected picker entry unassigns every matching join id already present in the client snapshot, so one action clears concurrent duplicate assignments.

## Consequences
Board-level filtering by label is deliberately not part of this change: the entity and its UI land first, and the board view keeps rendering every card. Because definitions outlive assignments, unassigning the last card from a label leaves it in the picker rather than deleting it — removing a label from the board is the explicit, confirmed Delete in its edit pane.
