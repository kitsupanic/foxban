# 0030 — Source-owned shadcn dual themes

## Status
Superseded by 0052

## Context
Foxban needs two complete light visual treatments without replacing its tested interaction semantics or introducing a competing component system.

## Decision
- Own a small set of new-york-v4-inspired primitives in source, styled through semantic Tailwind v4 CSS variables for the Quiet and Signal themes.
- Keep relative imports. Do not add daisyUI, the shadcn CLI/runtime package, `components.json`, import aliases, or Radix interactive primitives.
- ADR 0020 remains authoritative: card dialogs, pickers, popups, focus restoration, and Escape ordering stay custom foxban behavior.

## Consequences
Copied primitive styling is maintained locally. Theme changes stay centralized in semantic tokens, while labels, priority, due-date, connection, success, warning, and destructive colors retain their domain meaning rather than inheriting the brand accent.
