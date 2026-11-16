# 0046. Full-card touch drag surface

Date: 2026-09-09

## Status

Accepted; supersedes 0044

## Context

ADR 0044 made a 44 px `touch-action: none` grip the reliable advertised touch start surface, but that decorative leading rail consumed substantial card width on phones. The sortable `<li>` already owns dnd-kit's touch listeners and retains a 250 ms delay with 5 px movement tolerance.

## Decision

Use the whole card as the delayed touch drag surface. Keep the top-right grip compact, non-focusable, and `aria-hidden` as a discovery cue only; do not apply `touch-action: none` or a dedicated hit box to it. Short card swipes remain available to the horizontal scroller, while a hold beyond 250 ms followed by movement activates sorting.

## Consequences

Card content reclaims the leading width and mouse/keyboard behavior remains unchanged. Chromium touch emulation verifies short-swipe scrolling, held full-card preview/reorder, and persistence. Without a `touch-action: none` start region, browser gesture arbitration can still differ on real-device iOS Safari; that platform remains explicitly unverified and must be tested before claiming universal mobile reliability.
