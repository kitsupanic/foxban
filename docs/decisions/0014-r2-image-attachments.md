# 0014 — Image attachments in R2, metadata in the BoardDO

## Status
Superseded by 0027 — 2026-09-03

## Context
M9 wanted Jira-style image attachments: an upload both embedded in the Markdown
description and listed on the card. Blobs need object storage; their metadata is
board content, and board content never lives in D1.

## Decision
- Blobs go to an R2 bucket (`ATTACHMENTS`) keyed `boardId/uuid`, written and read
  only through `POST /boards/:id/attachments` and
  `GET /boards/:id/attachments/:key`. Both run `requireAuth` + `requireMember`,
  and the serve route rebuilds the key from *its own* validated board, so a
  leaked uuid still cannot cross a board boundary.
- Metadata is a protocol entity like a checklist item: `attachment.create` /
  `attachment.delete` messages, an `attachments` table in the DO (schema v3), and
  an `attachments` array in the snapshot. Cascades on `card.delete` and
  `column.delete` mirror the checklist's.
- The client compresses before upload: longest side ≤2048px, re-encoded webp at
  q0.8, kept only if smaller than the original; GIF passes through so animation
  survives. Best-effort — any failure uploads the original bytes.
- Serving is locked to png/jpeg/gif/webp with `X-Content-Type-Options: nosniff`,
  so nothing uploaded can execute on our origin. No SVG, no HTML.

## Consequences
R2 objects are never deleted: removing an attachment (or its card, or its
column) drops the metadata only, so a deleted attachment's URL keeps serving to
board members and an embedded `![…]` survives a panel delete instead of
breaking. Blob GC is deferred storage debt, bought so the DO stays env-free and
its `apply()` stays synchronous. Rejected: presigned URLs (S3 keys to manage),
a public bucket (boards are private), metadata in D1 (card data never in D1),
and R2 I/O inside the DO (the first `this.env`/`waitUntil`/async apply, for
marginal gain).
