# foxban

A real-time Kanban board anyone can run on their own Cloudflare account.

## Running foxban

**Instance**:
One deployed copy of foxban on one Cloudflare account, with its own users and boards.
_Avoid_: Deployment, server, site

**Admin**:
A person whose email is listed in the instance's admin list. Admins can sign up without an invite and create invites for others.
_Avoid_: Owner, superuser

## Workspaces

**Workspace**:
A shared space that owns boards and has members. Every board is in exactly one workspace.
_Avoid_: Team, organization, personal workspace; using "workspace" for the app shell or a board page

**Workspace admin**:
A workspace member who manages its members, invites and settings, and can open every board in it. A workspace always has at least one. Not the same as an Admin, which is about the instance.
_Avoid_: Owner, manager

**Workspace member**:
A person who belongs to a workspace. Members can open its Workspace boards and create boards.
_Avoid_: User, collaborator

**Guest**:
A person added to a board in a workspace they are not a member of. They see that board only.
_Avoid_: External member, observer

**Operator**:
An Admin acting through instance-Admin power alone: on a workspace they are not a member of (from the All workspaces page), or on a Private board they were not added to, in a workspace they do belong to.
_Avoid_: Superuser, support access

**Private board**:
A board only its board members and workspace admins can open.
_Avoid_: Restricted board

**Workspace board**:
A board every member of its workspace can open.
_Avoid_: Public board, shared board

**Home**:
The `/` page. It lists all your boards by workspace, with guest boards under their own heading.
_Avoid_: Dashboard, boards page

**App shell**:
The sidebar and header around every signed-in page.
_Avoid_: Workspace, workspace shell

## GitHub

**Task key**:
A card's board key and task number together, like `KR-42`. It is unique in the instance, but changes when the board key is edited or the card moves to another board.
_Avoid_: Ticket id, card number

**GitHub App**:
The one GitHub app an instance uses for everything GitHub: pictures, sign-in and repos. An Admin creates it.
_Avoid_: OAuth App, integration

**Connected repo**:
A GitHub repo the instance's GitHub App is installed on. It belongs to the instance, not to a board.
_Avoid_: Board repo, linked repo

**Development info**:
The branches, commits and pull requests linked to a card, by its task key or by hand.
_Avoid_: Dev status, GitHub status

## Editing

**Authored operation**:
A change a person wrote out, like a title, a comment or a checklist item, whose text is kept until the board confirms it. If the board refuses it or the connection drops, the text is still there to retry. A drag is not one.
_Avoid_: Save, edit, write

**Instant mutation**:
A one-click change, like a move, an assignee, a label or a delete, that shows at once and is not held for retry. If the board refuses it, the change is rolled back. Every one goes out through the board commands module (`apps/web/src/lib/board-commands.ts`), which makes its ids and picks where a card lands.
_Avoid_: Quick edit, fire-and-forget

**Card section core**:
One part of the open card that holds its own drafts and authored operations: the title and description draft, the comment thread, the checklist, and the subtask composer. Each one is plain code (`apps/web/src/lib/card-draft.ts`, `comment-thread.ts`, `checklist.ts`, `subtask-composer.ts`) that can be tested without a browser, with a small React hook on top. The card itself only adds up whether any section still has work before it closes.
_Avoid_: Section state, card store

**Attachment lifecycle**:
Everything that happens to a file on a card after it is picked: the upload, the board taking it in, and its removal. When a removal is confirmed, its image or link is taken out of open descriptions too. It all lives in one module (`apps/web/src/lib/attachments.ts`), which the board socket feeds with what it hears.
_Avoid_: Attachment state, upload flow

**Pending attachment delete**:
A removal this person sent that the board has not answered yet. Until it is answered, that card's description cannot be saved.
_Avoid_: Unresolved delete

**Family-finish gate**:
The check that stops a parent with open subtasks from moving into the completed column on its own. The person is asked to finish the parent alone or the whole family. Every move goes through it, a drag or a status change alike.
_Avoid_: Completion check

**Subtask family rules**:
The server's one home (`apps/api/src/subtask-family.ts`) for how a family behaves: who parents whom, when a card counts as done, where a new subtask starts, which links are allowed, and the board's side of the family-finish gate. It only reads and decides; the board does the writing.
_Avoid_: Hierarchy helpers

## Moving cards

**Card transfer**:
Moving a card to another board. The source board keeps the card locked until the destination either commits it, and the source deletes its copy, or records that the move was aborted, and the source unlocks it.
_Avoid_: Copy, migrate

**Card transfer coordinator**:
The one module (`apps/api/src/card-transfer.ts`) that runs a card transfer step by step and settles a stuck one. It talks to the two boards as the source and the destination participant.
_Avoid_: Saga route, recovery

## Inside the Worker

**BoardClient**:
The Worker's one way to call a board's Durable Object (`boardClient(env, boardId)` in `apps/api/src/board-client.ts`). Each method is one internal route: it builds the request from the route table and hands back the decoded answer. Nothing else builds a request to a board.
_Avoid_: Board stub, board fetch, DO client

**Gate class**:
What a board's internal route owes before its handler runs: `fence`, `settlement`, `cleanup`, `open` or `protected`. The class decides whether a deleted board or one whose access is changing still answers, and whether the caller must be a member. Each route in `apps/api/src/board-api.ts` names its class once, and the board's dispatcher enforces it.
_Avoid_: Guard, middleware, route type
