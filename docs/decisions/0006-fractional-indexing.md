# 0006 — Fractional indexing for ordering

## Status
Accepted — 2026-08-30

## Context
Cards and columns need a stable sort order that survives concurrent drag-and-drop.

## Decision
String position keys via fractional indexing (`fractional-indexing` npm package). A move writes exactly one row.

## Consequences
Moves are single-row updates; no write amplification. Rejected: integer positions — every move would renumber siblings.
