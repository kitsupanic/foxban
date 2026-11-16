# 0007 — Last-write-wins over CRDTs

## Status
Accepted — 2026-08-30

## Context
Two always-online users editing the same board; conflicts are rare and low-stakes.

## Decision
Last-write-wins, enforced naturally by the single-threaded DO applying mutations in arrival order.

## Consequences
No merge logic, no sync engine. Rejected: offline mode / CRDTs — unjustified complexity for a 2-user, always-online internal tool.
