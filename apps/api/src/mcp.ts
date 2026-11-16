import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appOrigin, mcpOrigin, isAdminEmail, boardMemberSql, boardOpenSql, findAccessibleBoard, findAccessibleBoardByKey, toBoardRow, type BoardRow } from "./auth";
import {
  agentCredentialsRouter,
  authenticateAgentCredential,
  listAuthorizedBoards,
  type AgentPrincipal,
} from "./agent-credentials";
import {
  AddCommentInputSchema,
  AddCommentOutputSchema,
  AssignLabelInputSchema,
  AssignLabelOutputSchema,
  CompleteSubtaskInputSchema,
  CreateLabelInputSchema,
  CreateTaskInputSchema,
  GetBoardInputSchema,
  GetBoardOutputSchema,
  GetTaskInputSchema,
  GetTaskOutputSchema,
  LabelMutationOutputSchema,
  ListBoardsInputSchema,
  ListBoardsOutputSchema,
  ListTasksInputSchema,
  ListTasksOutputSchema,
  MCP_BOARD_READ_PATH,
  MCP_COMMAND_PATH,
  MCP_TASK_LIST_PATH,
  MCP_TASK_READ_PATH,
  McpToolResultSchema,
  MoveTaskInputSchema,
  TaskMutationOutputSchema,
  UnassignLabelInputSchema,
  UnassignLabelOutputSchema,
  UpdateLabelInputSchema,
  UpdateTaskInputSchema,
  decodeCursor,
  encodeCursor,
  stableStringify,
  type AgentScope,
  type McpBoardIdentity,
  type McpCommand,
  type McpToolResult,
} from "./mcp-contract";
import {
  INTERNAL_BOARD_ID_HEADER,
  INTERNAL_CAN_MANAGE_COLUMNS_HEADER,
  INTERNAL_USER_ID_HEADER,
} from "./internal-headers";

const MCP_BODY_LIMIT = 1_048_576;
const BEARER_CHALLENGE = 'Bearer realm="foxban-mcp"';

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": BEARER_CHALLENGE, "Cache-Control": "no-store" },
  });
}

function forbiddenHttp(): Response {
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (origin === "null" || origin.includes(",")) return false;
  try {
    return new URL(origin).origin === new URL(appOrigin(env, request.url)).origin && origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function hostAllowed(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  const hostHeader = request.headers.get("host");
  if (hostHeader !== null && hostHeader !== url.host) return false;
  // Unset config falls back to the request's own host; fine on Workers, where routing already pins the host.
  const configured = new URL(mcpOrigin(env, request.url));
  if (url.hostname === configured.hostname) return true;
  return (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") && url.protocol === "http:";
}

async function boundedRequest(request: Request): Promise<Request | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MCP_BODY_LIMIT) return null;
  if (request.body === null) return new Request(request);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MCP_BODY_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
}

async function currentPrincipal(env: Env, authorization: string, scope: AgentScope): Promise<AgentPrincipal> {
  const principal = await authenticateAgentCredential(env, authorization);
  if (principal === null) throw new Error("unauthorized");
  if (!principal.scopes.includes(scope)) throw new Error("forbidden");
  return principal;
}

async function authorizedBoard(env: Env, principal: AgentPrincipal, ref: { id: string } | { key: string }): Promise<BoardRow> {
  const board = "id" in ref
    ? await findAccessibleBoard(env, principal.user, ref.id)
    : await findAccessibleBoardByKey(env, principal.user, ref.key);
  if (board === null || !principal.boardIds.includes(board.id)) throw new Error("forbidden");
  return board;
}

function boardIdentity(board: BoardRow, base: string): McpBoardIdentity {
  return { id: board.id, key: board.key, name: board.name, appOrigin: base };
}

async function callBoardDo(
  env: Env,
  principal: AgentPrincipal,
  board: BoardRow,
  path: string,
  body: unknown,
): Promise<McpToolResult> {
  const response = await env.BOARD_DO.get(env.BOARD_DO.idFromName(board.id)).fetch(`https://board.internal${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_BOARD_ID_HEADER]: board.id,
      [INTERNAL_USER_ID_HEADER]: principal.user.id,
      [INTERNAL_CAN_MANAGE_COLUMNS_HEADER]: String(board.ownerId === principal.user.id || isAdminEmail(env, principal.user.email)),
    },
    body: JSON.stringify(body),
  });
  if (response.status === 410) return { ok: false, error: { code: "board_deleted", message: "Board was deleted.", retryable: false } };
  if (!response.ok) return { ok: false, error: { code: "internal_error", message: "Board service failed; retry with the same operationKey.", retryable: true } };
  return McpToolResultSchema.parse(await response.json());
}

function toolResponse(result: McpToolResult) {
  let bounded = result;
  let text = JSON.stringify(bounded);
  if (new TextEncoder().encode(text).byteLength > 1_048_576) {
    bounded = {
      ok: false,
      error: {
        code: "result_too_large",
        message: "Tool result exceeds the response limit.",
        retryable: false,
      },
    };
    text = JSON.stringify(bounded);
  }
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: bounded,
    ...(bounded.ok ? {} : { isError: true }),
  };
}

async function hashInput(value: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failure(error: unknown): McpToolResult {
  if (error instanceof Error && error.message === "unauthorized") {
    return { ok: false, error: { code: "unauthorized", message: "Credential is no longer valid.", retryable: false } };
  }
  if (error instanceof Error && error.message === "forbidden") {
    return { ok: false, error: { code: "forbidden", message: "Operation is not authorized.", retryable: false } };
  }
  if (error instanceof Error && error.message === "invalid_cursor") {
    return { ok: false, error: { code: "invalid_cursor", message: "Cursor does not match this request.", retryable: false } };
  }
  return { ok: false, error: { code: "internal_error", message: "Unexpected failure; retry mutations with the same operationKey.", retryable: true } };
}

function createServer(env: Env, authorization: string, base: string): McpServer {
  const server = new McpServer(
    { name: "foxban", version: "1.0.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  type RegisterBridge = (
    name: string,
    config: {
      description: string;
      inputSchema: z.ZodType;
      outputSchema: z.ZodType;
    },
    callback: (input: unknown) => Promise<ReturnType<typeof toolResponse>>,
  ) => unknown;
  // SDK's generic callback type cannot preserve a helper's concrete Zod schema; runtime parsing remains authoritative.
  const registerToolBridge = server.registerTool.bind(server) as unknown as RegisterBridge;
  const register = <Input extends z.ZodType, Output extends z.ZodType>(
    name: string,
    description: string,
    inputSchema: Input,
    outputSchema: Output,
    callback: (input: z.output<Input>) => Promise<McpToolResult>,
  ) => {
    registerToolBridge(
      name,
      { description, inputSchema, outputSchema },
      async (input) => toolResponse(await callback(inputSchema.parse(input))),
    );
  };

  register("list_boards", "List boards allowed by the credential and current user access.", ListBoardsInputSchema, ListBoardsOutputSchema, async (input) => {
    try {
      const principal = await currentPrincipal(env, authorization, "boards:read");
      const boards = (await listAuthorizedBoards(env, principal)).map(toBoardRow);
      let after = "";
      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        if (
          cursor?.kind !== "boards" ||
          cursor.boardId !== undefined || cursor.taskId !== undefined || cursor.filters !== undefined ||
          typeof cursor.after !== "string"
        ) throw new Error("invalid_cursor");
        after = cursor.after;
      }
      const start = boards.findIndex((board) => board.id > after);
      const page = start < 0 ? [] : boards.slice(start, start + input.limit + 1);
      const items = page.slice(0, input.limit).map((board) => ({
        id: board.id, key: board.key, name: board.name,
        url: new URL(`/board/${encodeURIComponent(board.key)}`, base).toString(),
      }));
      const last = items.at(-1);
      return {
        ok: true,
        data: {
          items,
          nextCursor: page.length > input.limit && last
            ? encodeCursor({ v: 1, kind: "boards", after: last.id })
            : null,
        },
      };
    } catch (error) { return failure(error); }
  });
  register("get_board", "Read board identity, ordered columns, and actual members.", GetBoardInputSchema, GetBoardOutputSchema, async (input) => {
    try {
      const principal = await currentPrincipal(env, authorization, "boards:read");
      const board = await authorizedBoard(env, principal, input.board);
      const result = await callBoardDo(env, principal, board, MCP_BOARD_READ_PATH, { board: boardIdentity(board, base), columns: input.columns, labels: input.labels });
      if (!result.ok) return result;
      const limit = input.members?.limit ?? 50;
      let after = "";
      if (input.members?.cursor) {
        const cursor = decodeCursor(input.members.cursor);
        if (
          cursor?.kind !== "members" || cursor.boardId !== board.id ||
          cursor.taskId !== undefined || cursor.filters !== undefined ||
          typeof cursor.after !== "string"
        ) {
          throw new Error("invalid_cursor");
        }
        after = cursor.after;
      }
      const { results } = await env.DB.prepare(
        `SELECT b.pending_access_operation_id AS pendingAccessOperationId, users.id AS id, users.name AS name
           FROM boards b LEFT JOIN users ON users.id > ? AND ${boardMemberSql("b", "users.id")}
          WHERE b.id = ? AND ${boardOpenSql("b", "?", "?=1")}
          ORDER BY users.id LIMIT ?`,
      ).bind(after, board.id, isAdminEmail(env, principal.user.email) ? 1 : 0,
        principal.user.id, principal.user.id, principal.user.id, limit + 1)
        .all<{ pendingAccessOperationId: string | null; id: string | null; name: string }>();
      if (!results.length) throw new Error("forbidden");
      if (results[0]!.pendingAccessOperationId) {
        return { ok: false, error: { code: "internal_error", message: "Board access is changing. Please retry.", retryable: true } };
      }
      const rows = results.flatMap(({ id, name }) => id === null ? [] : [{ id, name }]);
      const members = rows.slice(0, limit);
      const data = result.data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return failure(new Error("invalid board response"));
      }
      const last = members.at(-1);
      return {
        ok: true,
        data: {
          ...data,
          members: {
            items: members,
            nextCursor: rows.length > limit && last
              ? encodeCursor({ v: 1, kind: "members", boardId: board.id, after: last.id })
              : null,
          },
        },
      };
    } catch (error) { return failure(error); }
  });
  register("list_tasks", "List bounded task summaries with title, column, assignee, and archive filters.", ListTasksInputSchema, ListTasksOutputSchema, async (input) => {
    try {
      const principal = await currentPrincipal(env, authorization, "boards:read");
      const board = await authorizedBoard(env, principal, input.board);
      return await callBoardDo(env, principal, board, MCP_TASK_LIST_PATH, { ...input, board: boardIdentity(board, base), query: input.query?.trim().toLowerCase() ?? "" });
    } catch (error) { return failure(error); }
  });
  register("get_task", "Read one task with paginated comments, checklist, and subtask context.", GetTaskInputSchema, GetTaskOutputSchema, async (input) => {
    try {
      const principal = await currentPrincipal(env, authorization, "boards:read");
      const board = await authorizedBoard(env, principal, input.board);
      return await callBoardDo(env, principal, board, MCP_TASK_READ_PATH, { ...input, board: boardIdentity(board, base) });
    } catch (error) { return failure(error); }
  });

  const write = async (scope: AgentScope, input: { board: { id: string } | { key: string }; operationKey: string }, command: McpCommand): Promise<McpToolResult> => {
    try {
      const principal = await currentPrincipal(env, authorization, scope);
      const board = await authorizedBoard(env, principal, input.board);
      // Assignee eligibility is deliberately not resolved here: this read can be old
      // by the time the board object runs, so the board answers it from the policy in
      // force at admission instead of trusting a verdict that travelled with the call.
      const normalized = { boardId: board.id, ...command };
      return await callBoardDo(env, principal, board, MCP_COMMAND_PATH, {
        credentialId: principal.credentialId,
        inputHash: await hashInput(normalized), board: boardIdentity(board, base), command,
      });
    } catch (error) { return failure(error); }
  };
  register("create_task", "Create one task. Reuse operationKey for every retry.", CreateTaskInputSchema, TaskMutationOutputSchema, async (input) => write("tasks:write", input, { operation: "create_task", operationKey: input.operationKey, columnId: input.columnId, title: input.title, taskType: input.taskType, priority: input.priority, assigneeId: input.assigneeId }));
  register("update_task", "Update title and/or description without overwriting omitted fields.", UpdateTaskInputSchema, TaskMutationOutputSchema, async (input) => write("tasks:write", input, { operation: "update_task", operationKey: input.operationKey, task: input.task, ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}) }));
  register("move_task", "Move an active task, optionally before or after another task in the destination column. Linked subtasks move like any other task. Moves affect only the requested task; completing a parent never automatically completes its children.", MoveTaskInputSchema, TaskMutationOutputSchema, async (input) => write("tasks:write", input, { operation: "move_task", operationKey: input.operationKey, task: input.task, columnId: input.columnId, ...(input.placement ? { placement: input.placement } : {}) }));
  register("add_comment", "Add a top-level comment with server-derived author and time.", AddCommentInputSchema, AddCommentOutputSchema, async (input) => write("comments:write", input, { operation: "add_comment", operationKey: input.operationKey, task: input.task, body: input.body }));
  register("complete_subtask", "Complete or reopen one active linked subtask. Moves it to the completed or starting column; it fails on a board with fewer than two columns. Its parent and siblings remain unchanged.", CompleteSubtaskInputSchema, TaskMutationOutputSchema, async (input) => write("tasks:write", input, { operation: "complete_subtask", operationKey: input.operationKey, task: input.task, done: input.done }));
  register("create_label", "Create a board-wide label definition and return its id. Names are not unique — the returned id, never the name, is the label's identity.", CreateLabelInputSchema, LabelMutationOutputSchema, async (input) => write("tasks:write", input, { operation: "create_label", operationKey: input.operationKey, name: input.name, color: input.color }));
  register("update_label", "Edit a board-wide label definition; every card carrying it shows the change. Omitted fields keep their current value.", UpdateLabelInputSchema, LabelMutationOutputSchema, async (input) => write("tasks:write", input, { operation: "update_label", operationKey: input.operationKey, labelId: input.labelId, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.color !== undefined ? { color: input.color } : {}) }));
  register("assign_label", "Assign one existing board label definition to an active task, and return the card-label association id. Reusing this call for a pair that is already assigned changes nothing.", AssignLabelInputSchema, AssignLabelOutputSchema, async (input) => write("tasks:write", input, { operation: "assign_label", operationKey: input.operationKey, task: input.task, labelId: input.labelId }));
  register("unassign_label", "Remove one task's association with a label by the cardLabelId get_task reported. This removes that association only; the board-wide definition and every other card using it stay.", UnassignLabelInputSchema, UnassignLabelOutputSchema, async (input) => write("tasks:write", input, { operation: "unassign_label", operationKey: input.operationKey, task: input.task, cardLabelId: input.cardLabelId }));
  return server;
}

export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  if (!originAllowed(request, env) || !hostAllowed(request, env)) return forbiddenHttp();
  const authorization = request.headers.get("authorization");
  if (await authenticateAgentCredential(env, authorization) === null) return unauthorized();
  let bounded = request;
  if (request.method === "POST") {
    const captured = await boundedRequest(request);
    if (captured === null) return noStore(new Response(JSON.stringify({ error: "request too large" }), { status: 413, headers: { "Content-Type": "application/json" } }));
    bounded = captured;
  }
  const handler = createMcpHandler(() => createServer(env, authorization!, appOrigin(env, request.url)), {
    legacy: "stateless", responseMode: "json", maxSubscriptions: 0, keepAliveMs: 0,
  });
  return noStore(await handler.fetch(bounded));
}

export { agentCredentialsRouter };
