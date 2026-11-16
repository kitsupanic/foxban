# 0066 — Workspace model

## Status
Accepted — 2026-11-14. Changes the model shipped in "add shared workspaces" (migration `0012_workspaces.sql`), which had no ADR.

## Context
Workspaces shipped without the idea being written down, and felt wrong in use. The word meant three things (the space that owns boards, the app shell, a board page). Every user had a hidden personal workspace with the id `personal_<userId>`. `/` redirected to the last workspace kept in `localStorage`. Guests and Operators appeared in the workspace switcher next to members. A workspace had one owner who could never change. Terms are in `GLOSSARY.md`.

## Decision
The reference is Trello's flat model: workspace → boards, no teams layer.

- One instance serves one group of people who know each other. The instance is the trust boundary; workspaces divide the work inside it.
- "Workspace" means only the space that owns boards and has members. The sidebar and header are the app shell.
- `/` is Home: all your boards grouped by workspace, guest boards under their own heading, and a "New board" button per workspace. No redirect and no remembered last workspace.
- `/w/<id>` stays as one workspace's boards page, with Members and Settings under it. The id stays opaque. Boards stay at `/board/KEY`, not nested, so a link survives a move between workspaces.
- The sidebar lists every workspace you are a member of as a section holding Boards, Members and Settings (by role). Only the workspace you are in is expanded; nothing is saved. Individual boards are not listed. There is no switcher dropdown.
- On board pages the 64px rail shows Home and one initials tile per workspace, and expands to the full sidebar. On narrow screens the top bar shows Home and a menu button that opens the same sidebar as a drawer.
- "Create workspace" is a plus beside the Workspaces heading and a button on Home.
- A bottom Account group holds Profile and MCP server, and for Admins: Invites, GitHub and All workspaces. Their breadcrumbs lose "Workspace ›".
- The personal workspace becomes an ordinary first workspace. New signups get "<name>'s workspace". Existing ones keep their name and id and gain rename, Members and invites. Nothing reads the `personal_` prefix any more.
- Roles are workspace admin and workspace member. Several admins are allowed and at least one is required: the last admin cannot leave or be demoted. Existing owners become admins. This replaces the permanent owner.
- A workspace admin can delete a workspace only when it has no boards and no access change in flight. An Operator who is not an admin of it cannot: operating a workspace is not owning it.
- Guests see their boards on Home only. Their workspace is not in the sidebar.
- Operator access moves to an Admin-only All workspaces page, out of the sidebar and Home.
- Boards are Private or Workspace (stored today as `restricted` and `workspace`). Workspace admins have full access to Private boards and the board says they are there as an admin. The setting reads "Private: only board members and workspace admins". No public boards.
- Unchanged: members can create boards, only admins manage members, invites and settings, board moves between workspaces, invite links.

Build order: (1) glossary, this ADR, and the shell rename; (2) Home, the sidebar with rail and drawer, the Account group, the guest heading, All workspaces; (3) ordinary first workspace and the new labels; (4) admin and member roles with the last-admin rule, then workspace deletion and admin access to Private boards. Deletion comes after roles because the owner triggers block deleting an owner's membership row.

## Consequences
Rejected: a workspace dropdown, alone or with Home. It hides what else you have and keeps a "current workspace" that Home makes unnecessary. Rejected: a fixed private Personal space, which keeps a special case in every access check. Rejected: Private meaning private from workspace admins, which leaves abandoned boards reachable only by an Operator. Rejected: readable workspace short-names in URLs, which need uniqueness, rename handling and redirects for a cosmetic gain. Rejected: public boards, which need unauthenticated access to the BoardDO.

Accepted: the sidebar grows with the number of workspaces. Accepted: step 4 changes who can open a board, so it touches the owner triggers in `0012_workspaces.sql`, the access-change operations and the BoardDO's connect-time checks (ADR 0050), and needs the most care. Accepted: a user can end up with no workspaces; Home then shows "Create workspace".

Accepted: a rollout window. A role change reserved by the previous Worker fences only Workspace boards, so a Private-board socket opened in that window could survive one demotion until it reconnects. The window is narrow, so nothing is done about it.
