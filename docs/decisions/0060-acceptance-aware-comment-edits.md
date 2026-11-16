# 0060 — Acceptance-aware comment edits

## Status

Accepted — 2026-10-21. Supersedes ADR 0020 only for closing an edited comment draft.

## Context

Saving an existing comment closed its editor after sending the WebSocket frame. A rejected or interrupted update could restore the old comment and overwrite the submitted draft when editing reopened.

## Decision

- Use the existing mutation settlement subscription for `comment.update`. Keep the exact raw text visible and read-only until server acceptance or authoritative snapshot verification.
- Acceptance closes only the comment editor. Rejection or verified absence unlocks the retained draft with an inline error and explicit Save comment retry; timeout or uncertain delivery stays locked while reconnect verifies the outcome. Never resend automatically.
- Changed comment text and pending edits participate in the existing modal close guard. Merely opening an unchanged editor does not prompt. Cancel and editor Escape discard only an editable draft; they cannot dismiss a pending submission or upload.
- Keep the current shared protocol, BoardDO authority and scoped title/description Save action.

## Consequences

An edited comment now receives the same delivery guarantees as other authored text. Switching editors or leaving a card with changed text requires the existing discard choice. No persistence, offline queue, dependency or new server endpoint is added.
