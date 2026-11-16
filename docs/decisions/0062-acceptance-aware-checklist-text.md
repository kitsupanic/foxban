# 0062 — Acceptance-aware checklist text

## Status

Accepted — 2026-10-22. Supersedes ADR 0020 only for closing checklist text drafts.

## Context

Checklist creation cleared its draft when a frame was sent, and inline editing closed before checking delivery. A rejected or disconnected save could therefore discard the only copy of the text.

## Decision

- Validate checklist text with the existing shared title limit before sending. Keep the exact raw draft when validation fails.
- Use the existing mutation settlement subscription for checklist creation and text edits. Keep each submitted lane read-only until acceptance or authoritative snapshot verification; unrelated lanes remain editable.
- Acceptance clears or closes only the submitted lane. Rejection, a dropped send or verified absence preserves the draft with an inline error and explicit retry. Never resend automatically.
- Pending inline submissions cannot be cancelled with Escape or replaced by another item editor. Checklist text participates in the existing modal close guard, including its explicit whole-card discard choice; an editable inline draft can still be cancelled with Escape.
- If a peer deletes an edited item, retain its text with explicit save-as-new and discard actions.

## Consequences

Checklist text receives the same delivery guarantees as other authored text. Checkbox toggles and deletion remain ordinary instant mutations. No persistence, offline queue, protocol change or dependency is added.
