# 0021 — URL-backed card view

## Status
Accepted — 2026-09-02

## Context
Cards opened from a `useState` id inside `BoardView`: a card view could not be linked, a reload dropped it, and a fullscreen presentation would have added a second piece of hidden state beside it. "Open tasks fullscreen like in Jira" only pays off if the fullscreen card is a place you can send someone.

## Decision
- The open card and its presentation are search params on the existing board route: `/board/:boardId?card=<BOARD_KEY>-<TASK_NUMBER>` opens the modal, `&view=full` the fullscreen surface. `validateSearch` drops a `view` without a `card`, and a `card` task key the board does not contain or match canonically cleans itself out of the URL (`replace`), so deep links to deleted, foreign, lowercase, or malformed cards land on the board while preserving active filters. Internal identity, BoardDO storage, mutations, and DOM elements (`data-card-id`) remain UUID-only.
- No `/board/:boardId/card/:taskKey` child route: search params keep `BoardView` — and with it the board socket and cache — mounted, and leave exactly one source of truth for "which card is open".
- Opening, closing and stepping card to card push history; expanding and collapsing `replace` it, because a presentation toggle has no business in the Back stack. Every card navigation passes `resetScroll: false` so the board's horizontal scroll survives.
- Fullscreen is the same dialog: the panel keeps `role="dialog"`/`aria-modal` over the still-`inert` board, and only the shell around the shared header, sections and footer changes (two panes on `md+`, stacked below).
## Consequences
Browser Back and Forward bypass the dirty-close guard of ADR 0020: popstate unmounts the modal and an unsaved title/description draft drops. Accepted — it is a browser-owned exit, and a router blocker is out of proportion to a draft that is one Save away. A board click always opens the modal even if the last card was fullscreen (the mode belongs to a viewing session, not to the board), while a row inside the dialog keeps the current mode. Rejected: a fullscreen affordance on the card front, which would make two open verbs out of one; and storing the mode in `localStorage`, which would make the same link render differently for two people.
