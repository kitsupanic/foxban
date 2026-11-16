# 0056 — Independent subtask workflow local trial

## Status
Superseded by 0068 — the trial page was removed once ADR 0067 made independent subtasks the only mode.

## Decision under trial
Every child owns its stored column/status. A child visually nests under its active parent only when they share a column; otherwise it is a standalone draggable card with a parent link. Moving either replaces exactly one card. Grouping is derived presentation, never a placement mutation. Progress counts direct active children across all columns, independently of the parent's status. Completion derives from explicit column metadata, never column names/positions or the legacy `subtaskDone` flag. Checklists remain boolean rows.

## Isolation and compatibility
`apps/web/subtask-trial.html` is an independent Vite development entry and mounts only with `import.meta.env.DEV`. It has disposable in-memory fixture state, no API or WebSocket path, no persistence, and is not a production build entry. Its `independent-subtasks-trial-1` state contract refuses incompatible move inputs; it does not consume production snapshots or reinterpret production frames. ToDo starting and Done completed are explicitly provisional fixture metadata.

## Persisted rollout follow-up
The approved local production integration is now recorded in [ADR 0057](0057-persisted-independent-subtasks.md); live rollout remains held. Its requirements were to persist column completion/start semantics in BoardDO, version the realtime protocol and reject older clients before they can apply inherited placement, update reducers/inverses/snapshot verification and MCP task reads/moves/completion, and coordinate migration with server rollout. No D1 card state. All writes remain BoardDO-owned; fractional moves write one row. Existing `subtaskDone` becomes migration evidence, then stops being independently writable. The `complete_subtask` tool requires explicit version/deprecation semantics rather than silently changing behavior.

`previewIndependentMigration` returns proposals only: completed children map to the sole explicit completion column; incomplete children inherit their currently displayed non-completed column once. Incomplete children under completed parents, detached subtasks, multiple possible completion columns and conflicting status labels need review. Stored child columns and status labels cannot recover historical intent. Persisted migration must initialize order at each destination, preserve ids/content, produce a reviewable preview and be explicitly authorized. No migration is run here.

## Limits
One-level families match the current product contract. The trial exercises movement, grouping, ordering, navigation, filtering, progress and simple checklist state. It does not implement persistent creation, transfers, archives, or collaboration. Absent parents render children as standalone cards; lifecycle rules require a separate rollout decision and integration coverage.
