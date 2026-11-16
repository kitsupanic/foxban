# Requirements

## Product

Real-time Kanban board for small teams, run on your own Cloudflare account. Real-time collaboration is the core feature. Optimize for simplicity and low cost, not scale.

## Users & load

A small team per instance. Low traffic. Authenticated, invite-only.

## Functional requirements

- Boards: create and list; each board has an owner and members. Public board URLs use human-readable board keys (`/board/:boardKey`). Configured account admins act as global board operators with unrestricted access to list and operate on every board without creating board_members rows; ordinary users remain strictly scoped to boards they belong to.
- Columns: only the specific board's owner or a configured account admin may create, rename, reorder or delete columns, enforced in both the UI and the authoritative WebSocket mutation path. Owners retain accessible semantic renaming and dedicated column drag handles; admins retain these operations without joining the board.
- Cards: ordinary board members retain card creation, editing and deletion, card reordering and movement between columns. Column restrictions do not change membership management, labels, board creation, or established board-deletion and GitHub permission rules. Board name/key editing remains owner/admin-only in the Boards UI and REST API.
- Live sync: changes appear immediately for all connected users.
- Card details: title, description, and contributors section showing card creator and assignment history.
- Relations: link cards with task identifier search (`<KEY>-<NUMBER>` and positive integer).
- Auth: simple sign-in — email+password or a shared invite code.
- Profile: a signed-in user manages their custom avatar upload (with fallback to GitHub or initials), display name, sign-in email, password, linked GitHub identity, and timezone preference.
- Member presence: boards show a member rail with live online/offline presence, last seen relative time, local time in each member's effective timezone, and role badges (Owner, Admin). Responsive layout adapts with an accessible drawer on narrow screens.
- GitHub development info (ADR 0064): an instance has one GitHub App, made by an Admin with a button, and its connected repositories belong to the instance, not to a board. Any branch or pull request in a connected repository that names a task key shows on that card for the board's members, live, from signed webhooks. Members can link a pull request by hand, unlink one, and create a git branch named after the canonical lower-case task key and a pull request targeting the repository's default branch directly from the card modal, in a repository they pick.
## Constraints

- Cost model requires idle boards to hibernate.
- Workers runtime limits: no Node APIs.
- Server is the source of truth: no local persistence of board data.

Mechanics for all of the above: [architecture.md](architecture.md).

## Non-goals (do not build unless asked)

- Multi-tenant orgs, billing, public signup, roles beyond member/owner.
- Offline mode / CRDTs — last-write-wins through the single-threaded DO is sufficient.
- Mobile apps. Responsive web is enough.
- SSR, SEO, analytics.
