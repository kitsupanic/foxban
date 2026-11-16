# 0067 — One subtask mode: independent statuses everywhere

## Status
Accepted — 2026-11-16. Supersedes ADR 0051 (inherited subtask placement). Supersedes the activation, per-child review and before-change export parts of ADR 0057. ADR 0059's "legacy unconfigured boards retain inherited behavior" no longer applies.

## Context
ADR 0057 kept two modes: legacy boards, where a subtask inherits its parent's column and completion is a stored boolean, and configured boards, where each subtask has its own column. A board switched over only when an owner/admin reviewed every subtask, downloaded a JSON backup and ticked a box. That ceremony was built for converting one busy board by hand, and it was never run. Meanwhile every board, even an empty one, showed the full migration panel, and both modes were kept alive across the BoardDO, the reducer and the board view.

The reference model is Jira: each subtask has its own status, a parent can be done while subtasks stay open, and new subtasks start in the workflow's first status.

## Decision
There is one mode. Every subtask has its own stored column. Completion is derived from being in the completed column.

**Automatic conversion.** A BoardDO schema step converts every board once, inside the schema transaction, when the BoardDO next wakes:
- Boards that already have a starting column are left alone.
- With 2 or more columns, the leftmost column (by position) becomes starting and the rightmost becomes completed. Names carry no meaning, as in ADR 0057.
- Each active subtask is placed by the rule the reviewed panel used to propose. A child marked done goes to the completed column. An unfinished child keeps the column it was displayed in, unless that is the completed column. In that case it goes to the starting column: it stays open, as in Jira, instead of being finished silently. A subtask with no resolvable parent (detached, or part of a cycle the hierarchy drops) becomes an ordinary task and loses its incoming subtask relation. Moved cards append to the destination column's tail in their existing position order.
- Archived cards are not touched. Restore already asks for a destination.

**Roles follow the board's ends until an admin chooses.** Boards with fewer than 2 columns have no roles: new subtasks go to their parent's column and nothing counts as complete. While the roles are automatic, every column create, move and delete recomputes them in the same transaction: leftmost starting, rightmost completed, none below 2 columns. No card moves, completion stays derived from the column, and the delete guard on role columns does not apply. Saving the workflow settings makes the roles explicit, and from then on they never drift: columns added or reordered later leave them alone, and a role column needs a replacement before it can be deleted. The conversion makes the roles explicit when it assigns them to a board that holds any card, archived or not (a board that already had a starting column keeps the roles its admin chose); a board with no cards stays automatic. The snapshot carries `workflowRolesExplicit` so clients mirror the rule. In the conversion a subtask whose parent is archived keeps its link, as ADR 0057 retains links while an endpoint is archived, and is placed by its own data: done goes to the completed column, otherwise it keeps its stored column, or goes to the starting column when that is the completed one.

**Settings** are two choices (starting, completed) and Save, with the existing completion/reopen preview. Changing roles moves no cards. The JSON export, review checkbox and per-subtask list are removed. `workflow.configure` loses its `migration` field, `subtask.complete` is removed, and the realtime protocol version is bumped so old clients reload.

## Consequences
- About 60 two-mode branches go away. Legacy-only tests are deleted, and conversion tests replace them.
- The conversion is a one-way data change. The BoardDO's point-in-time recovery is the rollback, as in ADR 0057: restore data first, then the old binary. Before deploying to an instance whose boards hold real subtasks, take a recoverable point.
- First/last can pick the wrong columns on some boards (for example a board whose first column is Backlog but whose work starts in To Do). An admin fixes it in settings with one change, which moves no cards and makes the roles explicit. On a board that was not converted with data in it, the roles simply follow the ends, so a board built To Do, Doing, Done ends with To Do starting and Done completed. Unfinished children that were sent to the starting column during conversion stay where they are, so they may need moving by hand.
- `subtaskDone` stays on the wire, always derived, so card payloads keep their shape.
