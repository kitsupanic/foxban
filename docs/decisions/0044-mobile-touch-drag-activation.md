# 0044. Mobile touch drag activation

Date: 2026-09-09

## Status

Superseded by 0046

## Context

Cards remain inside a horizontally scrolling Kanban viewport. The prior dnd-kit `PointerSensor` activated after 4px of movement for every pointer type, so an ordinary phone swipe could lift a card instead of scrolling the board. Applying `touch-action: none` to the whole card would prevent the scrolling the change is intended to preserve. Mouse dragging and the existing Space/arrow keyboard drag contract must remain unchanged.

## Decision

1. Register separate dnd-kit sensors in `BoardView`: `MouseSensor` with the existing 4px distance constraint, `TouchSensor` with a 250ms delay and 5px movement tolerance, and the existing `KeyboardSensor` coordinate getter.
2. Keep dnd-kit's attributes and listeners on the sortable card `<li>`. This preserves whole-card mouse dragging, Space/arrow keyboard dragging, and the single focusable card interaction surface.
3. Render a non-focusable, `aria-hidden` grip inside the card as the explicit touch-drag affordance. The grip has a coarse-pointer hit area of at least 44px and `touch-action: none`; a touch starting there bubbles to the card's TouchSensor listener without the browser claiming the gesture for scrolling.
4. Leave the rest of the card free of `touch-action: none`. A normal swipe over card content can scroll; movement beyond the tolerance before the delay cancels touch drag activation. A 250ms hold elsewhere on the card remains sensor-eligible, but browser gesture handling may cancel it, so the grip is the reliable advertised start surface.
5. A custom handle-gated TouchSensor was attempted and rejected. Its sensor class identity and activator-node routing conflicted with stable mouse/keyboard activation and made the touch path more fragile than the stock sensor plus CSS touch-action boundary.

## Consequences

- Touch users get an explicit reliable drag target without sacrificing card-body scrolling.
- Mouse users keep whole-card drag, and keyboard users keep Space/arrow drag on the focused card.
- Chromium mobile emulation verifies fast-touch cancellation, held-grip preview, reorder, and persistence. Real-device iOS Safari behavior remains unverified; the `touch-action: none` grip follows dnd-kit's documented scrollable-list guidance and confines that browser-specific requirement to the drag affordance.
