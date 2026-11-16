# 0015 — Card comments as protocol entities, with client-supplied authorship

## Status
Superseded by 0029 — 2026-09-04

## Context
M10 wanted Jira-style comments on cards: a thread in the card modal, live for
every member, with bodies "the same as the description" — full Markdown parity,
composing affordances included. Comments are card content, so they follow
checklist items (M7) and attachments (M9) rather than growing a D1 table.

## Decision
- Comments are protocol entities: `comment.create` / `comment.update` /
  `comment.delete` messages, a `comments` table in the DO (schema v4), a
  `comments` array in the snapshot, and cascades on `card.delete` and
  `column.delete` mirroring the checklist's.
- `authorId`, `createdAt` and `updatedAt` are client-supplied wire fields. The DO
  is identity-blind (`acceptWebSocket` takes no tags, the WS route forwards the
  raw request) and rebroadcasts an accepted frame byte-for-byte (ADR 0010), so a
  server stamp would be invisible to peers until their next snapshot. They are
  trusted exactly like client-generated ids and positions already are.
- Permissions live in the UI only: edit is author-only, delete is author-or-admin.
- Bodies run through the description's pipeline unchanged — the editor and the
  renderer were extracted into `MarkdownEditor` / `MarkdownContent` and are now
  shared by the description, the composer and the inline comment editor, paste-
  to-upload included. A comment image therefore rides the attachment upload
  (ADR 0014) and also shows up in the card's Attachments panel.

## Consequences
Authorship is forgeable: any member could send a frame naming someone else as
author, and no peer could tell. Accepted for a tiny invited user base, and
cheaper than the alternative. Timestamps are absolute `toLocaleString()` values
from the sender's clock, so a skewed clock shows a skewed time. Rejected:
DO-side identity via socket tags (the first identity plumbing through the WS
route, for marginal gain against a trusted membership), and server-set
timestamps (they break verbatim rebroadcast).
