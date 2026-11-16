# 0020 — Modal integrity without a dialog library

## Status
Accepted — 2026-09-01

Amended by ADR 0047 for topmost cross-portal update-prompt modality and Escape ownership.

## Context
The card modal claimed `aria-modal="true"` without earning it: Tab reached the board behind it, closing dropped focus on `<body>`, and Escape in the description editor threw the whole draft away — as did a relation row, which remounts the modal on another card.

## Decision
- Modality comes from `inert` on the board content while a card is open, plus a focus restore to `[data-card-id]` on close. The custom overlay stays: it carries the press-origin backdrop guard and the three-layer Escape model where descendants `stopPropagation` before the modal's window listener.
- Closing is a ladder, extending the house "first Escape cancels the innermost state" pattern: Escape in an editor backs out to a preview, Escape in a dirty modal raises an inline discard strip, a further Escape (or `Discard`) confirms. Every exit — Escape, backdrop, the header ×, a row that navigates — goes through one `requestClose(action)`.
- "Dirty" means only what Save would write (the title/description diff) plus a non-empty comment being composed. The instant-send sections stay instant: no autosave, no modal-wide draft (ADR 0007/0010).

## Consequences

ADR 0060 supersedes the comment-edit close behavior below: changed or pending comment edits now use the existing discard/settlement guards.

Rejected: native `<dialog>`, whose `cancel` event fires on Escape regardless of React `stopPropagation` (only `preventDefault` stops it), so every descendant layer would need auditing and the `::backdrop` click discrimination rebuilding; and a focus-trap dependency, against the no-library posture. No hand-rolled Tab trap either — with the board inert, Tab cycles between the panel and browser chrome, exactly as a native dialog does. Drafts in the smaller editors (relation query, checklist text, comment edit) still close without a prompt: each already cancels on its own Escape and is a keystroke from being retyped. If the card is deleted while the modal is open, the focus restore simply misses and focus stays on `<body>`.
