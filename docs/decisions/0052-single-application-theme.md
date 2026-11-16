# 0052 — Single application theme

## Status
Accepted — 2026-09-06

## Context
Theme switching added runtime state, storage behavior, and duplicated visual verification without serving Foxban's focused operational interface. The existing Quiet appearance already supplies the intended light monochrome grammar.

## Decision
- Use one unconditional light monochrome appearance with no theme control or saved preference.
- Retain source-owned primitives, relative imports, semantic Tailwind styling, and domain-specific status colors.
- ADR 0020 remains authoritative: dialogs, pickers, popups, focus restoration, and Escape ordering stay custom foxban behavior.

## Consequences
ADR 0030's dual-theme decision is superseded. Existing `foxban-theme` storage is inert and ignored; application startup no longer depends on storage access. Visual and behavioral coverage exercises one application style while OS color-scheme checks continue to protect readable content.
