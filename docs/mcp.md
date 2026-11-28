# Foxban MCP access

Foxban exposes an authenticated remote MCP endpoint at `/mcp`. It uses configured Bearer credentials, not interoperable OAuth. A credential is tied to one current Foxban user, an explicit set of board IDs, explicit scopes, an expiry of at most 90 days, and can be revoked at any time.

## Issue and manage credentials

Open **MCP server** (`/mcp-server`) while signed in. It issues, lists and revokes your credentials, and copies the token or a ready-made `mcpServers` / VS Code configuration. Issuing asks for your current password ([ADR 0090](decisions/0090-agent-credentials-need-password-and-no-op-access-changes.md)); an account that signs in only with GitHub and has no password is not asked.

For scripted setup, the repository helper does the same through your session cookie. The cookie is httpOnly, so `document.cookie` cannot read it; copy it from browser developer tooling. Issuing also needs your current password, which the helper sends as `currentPassword` from `FOXBAN_PASSWORD`; list and revoke do not. Keep cookies, passwords and tokens in environment variables, never command arguments, source, tickets, or logs. From the repository root:

```bash
export FOXBAN_ORIGIN='https://foxban.example.com'
export FOXBAN_SESSION_COOKIE='session=<your-own-session-value>'
read -rs FOXBAN_PASSWORD && export FOXBAN_PASSWORD
node apps/api/scripts/mcp-client.mjs credentials issue '{"name":"coding harness","boardIds":["<stable-board-id>"],"scopes":["boards:read","tasks:write","comments:write"],"expiresInDays":30}'
node apps/api/scripts/mcp-client.mjs credentials list
node apps/api/scripts/mcp-client.mjs credentials revoke '<credential-id>'
```

Issuance returns the raw `foxban_mcp_…` token once. Store it in the harness secret store. List and revoke responses never expose it. Browser logout does not revoke agent credentials. Changing your password, setting your first one, or disconnecting GitHub revokes every one of them, so issue new ones afterwards; otherwise revoke them explicitly or let them expire.

## Connect

Configure a compatible MCP client with remote URL `https://foxban.example.com/mcp` and header `Authorization: Bearer <token>`. Clients must accept JSON or SSE responses. The repository helper is tested with `@modelcontextprotocol/client` 2.0.0:

```bash
unset FOXBAN_SESSION_COOKIE FOXBAN_PASSWORD
export FOXBAN_MCP_TOKEN='<one-time-issued-token>'
node apps/api/scripts/mcp-client.mjs tools
node apps/api/scripts/mcp-client.mjs call list_boards '{}'
```

`FOXBAN_ORIGIN` is mandatory. HTTP is accepted only for loopback local development.

## Scopes and tools

| Tool | Required scope | Input |
|---|---|---|
| `list_boards` | `boards:read` | `{limit?:1..50,cursor?:string}` |
| `get_board` | `boards:read` | `{board:{id}|{key},columns?:PageInput,members?:PageInput,labels?:PageInput}` |
| `list_tasks` | `boards:read` | `{board,query?:string,columnId?:string,assigneeId?:string|null,state?:"active"|"archived"|"all",limit?:1..100,cursor?:string}` |
| `get_task` | `boards:read` | `{board,task:{id}|{key},comments?:PageInput,checklist?:PageInput,subtasks?:PageInput,labels?:PageInput}` |
| `create_task` | `tasks:write` | `{board,operationKey:UUID,columnId,title,taskType?,priority?,assigneeId?}` |
| `update_task` | `tasks:write` | `{board,operationKey,task,title?,description?}`; at least one field |
| `move_task` | `tasks:write` | `{board,operationKey,task,columnId,placement?:{before:task}|{after:task}}` |
| `complete_subtask` | `tasks:write` | `{board,operationKey,task,done:boolean}`; the task must be a linked subtask with a live parent, and the board needs a starting and a completed column (two columns or more) |
| `create_label` | `tasks:write` | `{board,operationKey,name,color}`; names trim to 1–200 characters and are not unique |
| `update_label` | `tasks:write` | `{board,operationKey,labelId,name?,color?}`; at least one field |
| `assign_label` | `tasks:write` | `{board,operationKey,task,labelId}` |
| `unassign_label` | `tasks:write` | `{board,operationKey,task,cardLabelId}`; the join id comes from `get_task`'s label page |
| `add_comment` | `comments:write` | `{board,operationKey,task,body}` |

Thirteen tools are mounted. `complete_subtask` moves one linked subtask to the board's completed column (`done: true`) or its starting column (`done: false`): it never touches the parent, the siblings or the checklist. The four label tools manage ordinary board labels; `create_label` and `update_label` write the board-wide definition every card shows, `assign_label` adds one association to an active task, and `unassign_label` removes one association — it never deletes the definition. A board-wide delete stays in the UI.

`status:*` is a naming convention, not a rule Foxban enforces: several `status:*` labels coexist, assigning one removes nothing, and a definition's `id` — never its name — is its identity. `get_board` and `get_task` return the definitions and a task's assignments as `PageInput` pages, so read the page to find the exact `cardLabelId` before removing an association.

`PageInput` is `{limit?:number,cursor?:string}`. References are explicit objects; Foxban never guesses whether a bare string is an ID or key. Board keys normalize to uppercase. Task keys use the current board key and a positive safe integer, for example `FOX-42`.

All objects are strict. Create/update titles trim to 1–200 characters. Descriptions preserve bytes exactly and allow at most 100,000 UTF-8 bytes. Comment bodies preserve whitespace and allow 1–10,000 characters. `create_task` defaults to task/medium/unassigned and intentionally has no description field; call `update_task` next.

Every result is `{ok:true,data}` or `{ok:false,error:{code,message,retryable}}`. Reads are live keyset pages, not snapshot-isolated exports. Archived task URLs retain canonical board/card identity; open archived content through the existing Archive UI.

## Example workflow

```bash
node apps/api/scripts/mcp-client.mjs call get_board '{"board":{"key":"FOX"}}'
node apps/api/scripts/mcp-client.mjs call list_tasks '{"board":{"key":"FOX"},"state":"active","query":"mcp"}'
node apps/api/scripts/mcp-client.mjs call create_task '{"board":{"key":"FOX"},"operationKey":"11111111-1111-4111-8111-111111111111","columnId":"<column-id>","title":"Document harness setup"}'
node apps/api/scripts/mcp-client.mjs call update_task '{"board":{"key":"FOX"},"operationKey":"22222222-2222-4222-8222-222222222222","task":{"key":"FOX-42"},"description":"Connection guide and verified examples."}'
node apps/api/scripts/mcp-client.mjs call move_task '{"board":{"key":"FOX"},"operationKey":"33333333-3333-4333-8333-333333333333","task":{"key":"FOX-42"},"columnId":"<review-column-id>"}'
node apps/api/scripts/mcp-client.mjs call add_comment '{"board":{"key":"FOX"},"operationKey":"44444444-4444-4444-8444-444444444444","task":{"key":"FOX-42"},"body":"Typecheck and focused integration tests passed; PR: <url>."}'
```

Reuse the exact same operation key and arguments after an ambiguous mutation failure. Foxban returns the original committed result and does not replay the write, even if later edits changed the task. Receipts are kept for at least 30 days; the board's lifecycle alarm may prune older ones. Retry support lasts only while the original credential remains valid and currently authorized; never move an uncertain operation to a new credential/key without reading current state first. The helper deliberately does not auto-retry or replace operation keys.

## Harness instruction

> Discover the authorized board and its current columns before acting. Read the task context. Move a task only when work actually starts. Create newly discovered work deliberately. Comment only with real test, deployment, or pull-request evidence. Move to the board's discovered review stage only after the work is complete. Preserve each mutation operationKey unchanged on every retry.

MCP access does not run agents, track development automatically, reserve tasks, or make moves/assignments exclusive claims. Column names are board-specific. No scheduler, destructive task tools, board/column administration, attachment operations, cross-board transfer, GitHub action, or production deployment is included.
