# 0027 — Arbitrary file attachments with download isolation

## Status
Superseded by 0028 — 2026-09-04

## Context
ADR 0014 limited attachments to four raster image MIME types so uploaded bytes could be rendered safely on the application origin. foxban needs arbitrary project files without moving card metadata into D1 or exposing active uploaded content.

## Decision
- Keep membership-checked private R2 routes, `boardId/uuid` keys, BoardDO-only metadata, client-side raster compression, and deliberately orphaned blobs from ADR 0014.
- Accept arbitrary bytes. Canonicalize bounded declared MIME metadata on upload, return the stored content type and authoritative buffered size, and apply 10 MB to declared PNG/JPEG/GIF/WebP or 50 MB to every other declaration.
- MIME is an unverified presentation and limit declaration, not byte verification. Only the four exact canonical image types render inline; every other stored or missing type is served as `application/octet-stream` with `Content-Disposition: attachment` and `nosniff`.

## Consequences
Non-images download through the authenticated card row without executing on the application origin. Parameterized images are download-only. Rejected: sniffing bytes, extension rules, public or presigned objects, R2 filenames/custom metadata, D1 card metadata, and blob deletion on metadata removal.
