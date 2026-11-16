# 0025 — Board label filter in the URL

## Status
Accepted — 2026-09-02

## Context
ADR 0022 deferred exactly this: labels landed as an entity and a card-level UI, and "the board view keeps rendering every card". A board of any size then reads as one undifferentiated wall. Every client already holds the whole board — `labels` and `card_labels` arrive in the same WS snapshot as the cards — so filtering is a rendering question, not a data one.

## Decision
- The board header gains a **filter** popover, cloned from the `?` shortcuts popover (toggle button, Escape closes, no click-outside handling): one name-sorted row per label with a colour swatch and a `✓`, plus an always-present **No label** row for cards carrying none, and **Clear filter** once anything is checked. The button reads `filter · N` in dark type while a filter is on, so it stays legible with the popover closed.
- Selections are **any-of**, not all-of: a card shows when it carries *any* checked label, or when it carries none and `No label` is checked. Filtering is one pass over `card_labels` in `visibleCardIds`, beside the other plain derivations in `apply-mutation.ts` — no memo, matching the file's convention.
- The selection lives in the board route's search params as `?labels=<id>,<id>`, with the reserved token `none` for unlabeled (label ids are generated UUIDs, so nothing can collide with it). This follows the `card`/`view`/`attachment` precedent of ADR 0021: the filter survives a reload and a filtered board is a link you can send. Toggling `replace`s rather than pushes — a view-mode change has no business in the Back stack, the same rule expand/collapse follows. `labels` is independent of `card`, so `validateSearch` keeps it whether or not a card is open, and the three navigations that build search from scratch carry it through.
- Tokens naming labels that no longer exist are ignored by both the predicate and the count, and are never rewritten out of the URL: a peer deleting a label must not trigger a navigation under the user's hands.
- Drag-and-drop deliberately keeps computing positions from the **full** column list. `over` is always a visible card, so the drop places the dragged card immediately adjacent to it in full order — which is exactly the slot the user saw — and a drop on the column body appends after any hidden tail. Hidden ordering stays well-defined when the filter clears, and `handleDragEnd` needs no filter awareness.

## Consequences
A filtered column can render empty; its droppable body still exists, so a card can be dragged into it. The filter is per-viewer and per-tab, not board state — two members can look at the same board through different filters. Rejected: server-side filtering, which would buy nothing when every client already holds every card and would put a view preference in the DO; a transient `useState`, which loses the filter on reload and cannot be shared; and all-of semantics, which is the rarer intent and hides everything the moment two labels are checked.
