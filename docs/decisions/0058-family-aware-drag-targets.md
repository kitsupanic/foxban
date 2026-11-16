# 0058 — Body-sized, family-aware board dragging

Date: 2026-10-02
Status: Accepted. Dev deployment explicitly authorized on 2026-10-02; live KRD activation remains a separate reviewed operation.

## Context

Long independent subtask families exposed an oversized drag preview: a 104px task body produced a 2,425px overlay. A flat sortable list measured enclosing parent families and their descendants together, so sortable translations compounded inside the parent's clipped border. Flat column-key neighbours also disagreed with the board's grouped presentation.

## Decision

Measure and activate a card drag on its body. Source families remain stationary; explicit before/after markers or a parent outline show the actual destination. The portaled preview retains the task's badges and subtask progress but collapses its rows and bounds its height. This avoids implying that an independent parent's children change status with it.

Resolve a move among the card's displayed peers: direct siblings when it will nest under its existing same-status parent, otherwise the destination column's roots. A descendant target belongs to its containing peer; dragging never changes parentage. Returning over the source body or a parent's own displayed descendants is a no-op. Keep fractional indexing and one-row BoardDO moves, including the existing non-throwing concurrent equal-key fallback.

Pointer collisions respect the visible canvas. Interior whitespace resolves to the nearest body boundary; only the tail, empty column, or column header appends. Midpoint changes update the marker even while the target ID remains unchanged. Keyboard Up/Down traverses logical peers and the tail slot; Left/Right traverses statuses. Bring offscreen target bodies into view and use the explicit keyboard destination rather than ambiguous overlapping geometry. Space or Enter completes a lift, Escape cancels; ordinary Enter still opens details. Preserve delayed touch activation so quick swipes scroll.

## Consequences

The board no longer animates card families out of the way during a lift. Stable geometry and explicit markers take their place. Hidden filtered peers still participate in key allocation, inherited boards retain root ordering and inherited family movement, and independent statuses retain conditional nesting. No data migration or protocol change is required. Real mobile hardware and deployed hibernation behavior remain separate verification surfaces from local Chromium touch emulation.
