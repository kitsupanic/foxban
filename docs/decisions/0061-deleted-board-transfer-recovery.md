# 0061 — Preserve transfer outcomes after board deletion

## Status

Accepted — 2026-10-22. Amends ADRs 0038 and 0048 for terminal board deletion.

## Context

A destination can commit an import before its source finishes removing the original card. Deleting the destination with `storage.deleteAll()` erased the only committed receipt. After restart, source recovery then mistook that committed move for an abort and made the source copy writable again.

## Decision

- Board deletion records a durable `meta.deleted` marker and clears board content, pending attachment work, MCP results and outbound transfer bookkeeping in one synchronous SQLite transaction. It keeps the schema, policy boundary, board identity and destination transfer receipts.
- The constructor restores the deleted marker before serving requests. Ordinary reads, upgrades, staging and imports remain terminally refused after deletion and restart.
- Identity-bound transfer settlement remains available so another board can distinguish committed and aborted moves. A deleted destination may record an abort for a transfer that never imported; it must never replace a committed receipt.
- Attachment reconciliation remains available to collect an authorized upload whose R2 write completed after deletion. No card content is recreated.
- The small internal receipt/deletion metadata remains in the deleted board's own SQLite storage. Board content never moves to D1. Existing deleted boards whose receipts were already erased cannot have those historical outcomes reconstructed by this change.

## Consequences

Board deletion removes user content and blobs while retaining enough metadata to finish distributed moves correctly. It no longer empties every byte of Durable Object storage. No D1 migration, new dependency or public protocol change is required.
