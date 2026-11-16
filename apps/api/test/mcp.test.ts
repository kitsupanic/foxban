import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SELF, applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  INTERNAL_BOARD_ID_HEADER,
  INTERNAL_CAN_MANAGE_COLUMNS_HEADER,
  INTERNAL_USER_ID_HEADER,
} from "../src/internal-headers";
import {
  AssignLabelOutputSchema,
  GetBoardOutputSchema,
  GetTaskOutputSchema,
  LabelMutationOutputSchema,
  McpFailureSchema,
  TaskMutationOutputSchema,
  UnassignLabelOutputSchema,
  encodeCursor,
} from "../src/mcp-contract";

const ORIGIN = "https://foxban.test";
const PASSWORD = "correct horse battery";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("missing session cookie");
  return header.split(";")[0]!;
}

async function fixture() {
  const signup = await SELF.fetch(`${ORIGIN}/auth/signup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `mcp-${crypto.randomUUID()}@foxban.test`, name: "MCP User", password: PASSWORD }),
  });
  expect(signup.status).toBe(200);
  const cookie = cookieOf(signup);
  const create = await SELF.fetch(`${ORIGIN}/boards`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "MCP board", key: `M${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId: await firstWorkspaceId(cookie) }),
  });
  expect(create.status).toBe(200);
  const board = await create.json<{ id: string; key: string }>();
  const issue = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Test client", boardIds: [board.id], scopes: ["boards:read", "tasks:write", "comments:write"] }),
  });
  expect(issue.status).toBe(201);
  const issued = await issue.json<{ credential: { id: string }; token: string }>();
  const identity = await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie } });
  expect(identity.status).toBe(200);
  const user = await identity.json<{ id: string }>();
  return { board, token: issued.token, credentialId: issued.credential.id, cookie, userId: user.id };
}

function transport(token: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (input, init) => SELF.fetch(new Request(input, init)),
  });
}
/**
 * One board WebSocket driven the way the browser drives it: the snapshot arrives
 * first, and every accepted mutation is echoed back verbatim before the
 * lifecycle frames that follow it.
 */
interface BoardSocket {
  send(message: Record<string, unknown>): void;
  /** The next server frame, in arrival order. */
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

async function openBoardSocket(boardId: string, userId: string): Promise<BoardSocket> {
  const response = await env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId)).fetch("https://board.test/ws", {
    headers: {
      Upgrade: "websocket",
      [INTERNAL_BOARD_ID_HEADER]: boardId,
      // The DO re-resolves access in D1, so seeding needs a real identity.
      [INTERNAL_USER_ID_HEADER]: userId,
      [INTERNAL_CAN_MANAGE_COLUMNS_HEADER]: "true",
    },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("missing test WebSocket");
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });
  socket.accept();
  return {
    send: (message) => socket.send(JSON.stringify(message)),
    next: () => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      // `lib` is ES2022, so `Promise.withResolvers` is not in the type surface yet.
      return new Promise<Record<string, unknown>>((resolve) => {
        waiters.push(resolve);
      });
    },
    close: () => socket.close(1000, "test complete"),
  };
}

/** One browser mutation on its own socket, resolved once the DO echoes it back. */
async function browserMutation(
  boardId: string,
  userId: string,
  message: { mutationId: string } & Record<string, unknown>,
): Promise<void> {
  const socket = await openBoardSocket(boardId, userId);
  try {
    await socket.next();
    socket.send(message);
    for (;;) {
      if ((await socket.next()).mutationId === message.mutationId) return;
    }
  } finally {
    socket.close();
  }
}

/** Durable reads of the board's own SQLite, for the state a retry must not move. */
function boardState<T>(boardId: string, read: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(
    env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId)),
    (_instance, state) => read(state.storage.sql),
  );
}

/** Every counter a refused or replayed call must leave exactly where it was. */
async function boardCounts(boardId: string) {
  return boardState(boardId, (sql) => ({
    receipts: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM mcp_operation_receipts").toArray()[0]!.count,
    activities: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM activities").toArray()[0]!.count,
    labels: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM labels").toArray()[0]!.count,
    joins: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM card_labels").toArray()[0]!.count,
  }));
}

/** Every stored definition name, in name order: duplicates stay visible. */
function labelNames(boardId: string): Promise<string[]> {
  return boardState(boardId, (sql) => sql
    .exec<{ name: string }>("SELECT name FROM labels ORDER BY name")
    .toArray()
    .map((row) => row.name));
}

async function createLabelId(
  client: Client,
  boardId: string,
  name: string,
  color: string,
): Promise<string> {
  const parsed = LabelMutationOutputSchema.parse((await client.callTool({
    name: "create_label",
    arguments: { board: { id: boardId }, operationKey: crypto.randomUUID(), name, color },
  })).structuredContent);
  if (!parsed.ok) throw new Error("label creation failed");
  return parsed.data.label.id;
}

/** Asserts a closed, nonretryable failure with the exact code and message. */
function expectFailure(content: unknown, code: string, message: string): void {
  expect(McpFailureSchema.parse(content)).toEqual({
    ok: false,
    error: { code, message, retryable: false },
  });
}

async function connectClient(name: string, token: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport(token));
  return client;
}

async function seedColumn(boardId: string, columnId: string, userId: string): Promise<void> {
  await browserMutation(boardId, userId, {
    type: "column.create", mutationId: crypto.randomUUID(), id: columnId, title: "Todo", position: "a0",
  });
}

/** One root card, created the way the app creates it. */
/** The board's second column, which takes the completed role. */
async function seedDoneColumn(boardId: string, columnId: string, userId: string): Promise<void> {
  await browserMutation(boardId, userId, {
    type: "column.create", mutationId: crypto.randomUUID(), id: columnId, title: "Done", position: "a1",
  });
}
async function seedCard(
  boardId: string,
  userId: string,
  columnId: string,
  cardId: string,
  title: string,
  position: string,
): Promise<void> {
  await browserMutation(boardId, userId, {
    type: "card.create", mutationId: crypto.randomUUID(), id: cardId, columnId, title, position,
  });
}

/** One linked child, created the way the app creates it. */
async function seedSubtask(
  boardId: string,
  userId: string,
  parentCardId: string,
  childId: string,
  title: string,
  position: string,
): Promise<void> {
  await browserMutation(boardId, userId, {
    type: "subtask.create", mutationId: crypto.randomUUID(), id: childId,
    parentCardId, relationId: crypto.randomUUID(), title, position,
  });
}

/** A second board for the same user, for cross-board cursor and foreign-label checks. */
async function addBoard(cookie: string, name: string): Promise<{ id: string; key: string }> {
  const response = await SELF.fetch(`${ORIGIN}/boards`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name,
      key: `X${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      workspaceId: await firstWorkspaceId(cookie),
    }),
  });
  expect(response.status).toBe(200);
  return response.json<{ id: string; key: string }>();
}

async function issueCredential(
  cookie: string,
  boardIds: string[],
  scopes: string[],
): Promise<{ token: string; credentialId: string }> {
  const response = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Test client", boardIds, scopes }),
  });
  expect(response.status).toBe(201);
  const issued = await response.json<{ credential: { id: string }; token: string }>();
  return { token: issued.token, credentialId: issued.credential.id };
}


describe("MCP transport", () => {
  it("initializes and discovers thirteen tools", async () => {
    const { board, token } = await fixture();
    const client = new Client({ name: "foxban-test", version: "1.0.0" });
    await client.connect(transport(token));
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "add_comment", "assign_label", "complete_subtask", "create_label", "create_task",
        "get_board", "get_task", "list_boards", "list_tasks", "move_task",
        "unassign_label", "update_label", "update_task",
      ]);
      const result = await client.callTool({ name: "list_boards", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        data: { items: [{ id: board.id, key: board.key, name: "MCP board" }], nextCursor: null },
      });
    } finally {
      await client.close();
    }
  });

  it("reads the workflow columns through the advertised MCP schema", async () => {
    const { board, token, userId } = await fixture();
    const columns = [
      { id: "start", title: "Todo", position: "a0" },
      { id: "work", title: "Work", position: "a1" },
      { id: "done", title: "Done", position: "a2" },
    ];
    for (const column of columns) {
      await browserMutation(board.id, userId, {
        type: "column.create", mutationId: crypto.randomUUID(), ...column,
      });
    }
    const client = await connectClient("foxban-workflow-columns-test", token);
    try {
      const read = async (columnsInput?: { limit: number; cursor?: string }) => {
        const result = await client.callTool({
          name: "get_board", arguments: { board: { id: board.id }, ...(columnsInput ? { columns: columnsInput } : {}) },
        });
        expect(result.isError).not.toBe(true);
        const output = GetBoardOutputSchema.parse(result.structuredContent);
        if (!output.ok) throw new Error("board read failed");
        return output.data.columns;
      };
      // Until an admin chooses, the roles sit at the board's ends.
      expect((await read()).items).toEqual([
        { ...columns[0], starting: true, completed: false },
        { ...columns[1], starting: false, completed: false },
        { ...columns[2], starting: false, completed: true },
      ]);

      await browserMutation(board.id, userId, {
        type: "workflow.configure", mutationId: crypto.randomUUID(),
        expectedStartingColumnId: "start", expectedCompletedColumnId: "done",
        startingColumnId: "start", completedColumnId: "work",
      });
      let cursor: string | undefined;
      for (const column of columns) {
        const page = await read({ limit: 1, cursor });
        expect(page.items).toEqual([{
          ...column, starting: column.id === "start", completed: column.id === "work",
        }]);
        cursor = page.nextCursor ?? undefined;
      }
      expect(cursor).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("executes the read and mutation workflow with durable retries", async () => {
    const { board, token, credentialId, cookie, userId } = await fixture();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    const client = new Client({ name: "foxban-workflow-test", version: "1.0.0" });
    await client.connect(transport(token));
    try {
      const boardResult = await client.callTool({ name: "get_board", arguments: { board: { id: board.id } } });
      expect(boardResult.structuredContent).toMatchObject({ ok: true, data: { columns: { items: [{ id: columnId, title: "Todo" }] } } });
      const operationKey = crypto.randomUUID();
      const createArguments = {
        board: { id: board.id }, operationKey, columnId, title: "Implement MCP",
      };
      const [created, concurrentReplay] = await Promise.all([
        client.callTool({ name: "create_task", arguments: createArguments }),
        client.callTool({ name: "create_task", arguments: createArguments }),
      ]);
      expect(created.isError).not.toBe(true);
      expect(concurrentReplay.structuredContent).toEqual(created.structuredContent);
      const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board.id));
      await expect(
        runInDurableObject(stub, (_instance, state) => state.abort("restart")),
      ).rejects.toThrow();
      const replay = await client.callTool({ name: "create_task", arguments: createArguments });
      expect(replay.structuredContent).toEqual(created.structuredContent);
      const conflict = await client.callTool({
        name: "create_task",
        arguments: { ...createArguments, title: "Different input" },
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.structuredContent).toMatchObject({
        ok: false, error: { code: "idempotency_conflict", retryable: false },
      });
      const createdContent = z.strictObject({
        ok: z.literal(true),
        data: z.strictObject({
          operationKey: z.uuid(),
          task: z.object({ id: z.string() }),
        }),
      }).parse(created.structuredContent);
      const task = { id: createdContent.data.task.id };
      const persisted = await runInDurableObject(
        env.BOARD_DO.get(env.BOARD_DO.idFromName(board.id)),
        (_instance, state) => ({
        cards: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM cards").toArray()[0]!.count,
        nextTaskNumber: state.storage.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'next_task_number'").toArray()[0]!.value,
        createdActivities: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM activities WHERE detail_json = '{\"type\":\"card.created\"}'",
        ).toArray()[0]!.count,
        receipts: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM mcp_operation_receipts").toArray()[0]!.count,
        }),
      );
      expect(persisted).toEqual({ cards: 1, nextTaskNumber: 2, createdActivities: 1, receipts: 1 });
      const updated = await client.callTool({ name: "update_task", arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task, description: "Verified description" } });
      expect(updated.isError).not.toBe(true);
      const moved = await client.callTool({ name: "move_task", arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task, columnId } });
      expect(moved.isError).not.toBe(true);
      const commented = await client.callTool({ name: "add_comment", arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task, body: "Tests passed" } });
      expect(commented.isError).not.toBe(true);
      await Promise.all(
        ["Second", "Third", "Fourth", "Fifth"].map((body) =>
          client.callTool({
            name: "add_comment",
            arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task, body },
          }),
        ),
      );
      const firstPage = await client.callTool({
        name: "get_task", arguments: { board: { id: board.id }, task, comments: { limit: 3 } },
      });
      const parsedFirst = z.object({
        ok: z.literal(true),
        data: z.object({
          task: z.object({ description: z.literal("Verified description") }),
          comments: z.object({
            items: z.array(z.object({ body: z.string() })).length(3),
            nextCursor: z.string(),
          }),
        }),
      }).parse(firstPage.structuredContent);
      const secondPage = await client.callTool({
        name: "get_task",
        arguments: {
          board: { id: board.id }, task,
          comments: { limit: 3, cursor: parsedFirst.data.comments.nextCursor },
        },
      });
      const parsedSecond = z.object({
        ok: z.literal(true),
        data: z.object({
          comments: z.object({
            items: z.array(z.object({ body: z.string() })).length(2),
            nextCursor: z.null(),
          }),
        }),
      }).parse(secondPage.structuredContent);
      const bodies = [
        ...parsedFirst.data.comments.items,
        ...parsedSecond.data.comments.items,
      ].map((comment) => comment.body).sort();
      expect(bodies).toEqual(["Fifth", "Fourth", "Second", "Tests passed", "Third"].sort());
      const listedTasks = await client.callTool({
        name: "list_tasks",
        arguments: { board: { id: board.id }, query: "implement", limit: 1 },
      });
      expect(listedTasks.structuredContent).toMatchObject({
        ok: true, data: { items: [{ id: task.id, title: "Implement MCP" }], nextCursor: null },
      });
      const revoke = await SELF.fetch(`${ORIGIN}/me/agent-credentials/${credentialId}`, {
        method: "DELETE", headers: { cookie },
      });
      expect(revoke.status).toBe(204);
      await expect(
        client.callTool({ name: "create_task", arguments: createArguments }),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("enforces scope and admin board allowlists", async () => {
    const { board, cookie } = await fixture();
    const secondBoardResponse = await SELF.fetch(`${ORIGIN}/boards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Outside allowlist", key: `X${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId: await firstWorkspaceId(cookie) }),
    });
    expect(secondBoardResponse.status).toBe(200);
    const secondBoard = await secondBoardResponse.json<{ id: string }>();
    const issue = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Read only", boardIds: [board.id], scopes: ["boards:read"] }),
    });
    const { token } = await issue.json<{ token: string }>();
    const client = new Client({ name: "scope-test", version: "1.0.0" });
    await client.connect(transport(token));
    try {
      const forbiddenBoard = await client.callTool({
        name: "get_board", arguments: { board: { id: secondBoard.id } },
      });
      expect(forbiddenBoard.isError).toBe(true);
      expect(forbiddenBoard.structuredContent).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const forbiddenWrite = await client.callTool({
        name: "create_task",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), columnId: "missing", title: "Denied" },
      });
      expect(forbiddenWrite.isError).toBe(true);
      expect(forbiddenWrite.structuredContent).toMatchObject({ ok: false, error: { code: "forbidden" } });
    } finally {
      await client.close();
    }
  });

  it("rolls back a mutation when receipt insertion fails, then safely retries", async () => {
    const { board, token, userId } = await fixture();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    const client = new Client({ name: "rollback-test", version: "1.0.0" });
    await client.connect(transport(token));
    try {
      const create = await client.callTool({
        name: "create_task",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), columnId, title: "Original" },
      });
      const success = z.object({ ok: z.literal(true), data: z.object({ task: z.object({ id: z.string() }) }) }).parse(create.structuredContent);
      const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board.id));
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TRIGGER fail_mcp_receipt
             BEFORE INSERT ON mcp_operation_receipts
             BEGIN
               SELECT RAISE(ABORT, 'forced receipt failure');
             END`,
        );
      });
      const operationKey = crypto.randomUUID();
      const failed = await client.callTool({
        name: "update_task",
        arguments: { board: { id: board.id }, operationKey, task: { id: success.data.task.id }, title: "Must roll back" },
      });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({
        ok: false, error: { code: "internal_error", retryable: true },
      });
      const afterFailure = await runInDurableObject(stub, (_instance, state) => ({
        title: state.storage.sql.exec<{ title: string }>("SELECT title FROM cards WHERE id = ?", success.data.task.id).toArray()[0]!.title,
        receipt: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM mcp_operation_receipts WHERE operation_key = ?", operationKey).toArray()[0]!.count,
        activities: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM activities").toArray()[0]!.count,
      }));
      expect(afterFailure).toEqual({ title: "Original", receipt: 0, activities: 1 });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER fail_mcp_receipt");
      });
      const retry = await client.callTool({
        name: "update_task",
        arguments: { board: { id: board.id }, operationKey, task: { id: success.data.task.id }, title: "Must roll back" },
      });
      expect(retry.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });


  it("denies reads and receipt replay after ordinary membership removal", async () => {
    const owner = await fixture();
    const inviteResponse = await SELF.fetch(`${ORIGIN}/invites`, {
      method: "POST", headers: { "content-type": "application/json", cookie: owner.cookie }, body: "{}",
    });
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json<{ token: string }>();
    const signup = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `member-${crypto.randomUUID()}@user.test`,
        name: "Ordinary member", password: PASSWORD, invite: invite.token,
      }),
    });
    expect(signup.status).toBe(200);
    const memberCookie = cookieOf(signup);
    const me = await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie: memberCookie } });
    const member = await me.json<{ id: string }>();
    const add = await SELF.fetch(`${ORIGIN}/boards/${owner.board.id}/members`, {
      method: "POST", headers: { "content-type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ userId: member.id }),
    });
    expect(add.status).toBe(200);
    const issue = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
      method: "POST", headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({
        name: "Membership test", boardIds: [owner.board.id],
        scopes: ["boards:read", "tasks:write"],
      }),
    });
    expect(issue.status).toBe(201);
    const { token } = await issue.json<{ token: string }>();
    const columnId = crypto.randomUUID();
    await seedColumn(owner.board.id, columnId, owner.userId);
    const client = new Client({ name: "membership-test", version: "1.0.0" });
    await client.connect(transport(token));
    const operationKey = crypto.randomUUID();
    const createArguments = {
      board: { id: owner.board.id }, operationKey, columnId, title: "Authorized once",
    };
    try {
      expect((await client.callTool({ name: "create_task", arguments: createArguments })).isError).not.toBe(true);
      const remove = await SELF.fetch(`${ORIGIN}/boards/${owner.board.id}/members/${member.id}`, {
        method: "DELETE", headers: { cookie: owner.cookie },
      });
      expect(remove.status).toBe(200);
      const read = await client.callTool({
        name: "list_tasks", arguments: { board: { id: owner.board.id } },
      });
      expect(read.isError).toBe(true);

      expect(read.structuredContent).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const replay = await client.callTool({ name: "create_task", arguments: createArguments });
      expect(replay.isError).toBe(true);
      expect(replay.structuredContent).toMatchObject({ ok: false, error: { code: "forbidden" } });
      // The newer writes sit behind the same current-membership check.
      const labelWrite = await client.callTool({
        name: "create_label",
        arguments: {
          board: { id: owner.board.id }, operationKey: crypto.randomUUID(),
          name: "status:doing", color: "amber",
        },
      });
      expect(labelWrite.isError).toBe(true);
      expect(labelWrite.structuredContent).toMatchObject({ ok: false, error: { code: "forbidden" } });
    } finally {
      await client.close();
    }
  });
  it("treats a workspace-inherited member as a real member for reads and assignment", async () => {
    const json = { "content-type": "application/json" };
    const adminSignup = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: `inherit-admin-${crypto.randomUUID()}@foxban.test`, name: "Inherit Admin", password: PASSWORD }),
    });
    expect(adminSignup.status).toBe(200);
    const adminCookie = cookieOf(adminSignup);
    const minted = await SELF.fetch(`${ORIGIN}/invites`, { method: "POST", headers: { ...json, cookie: adminCookie }, body: "{}" });
    const { token: accountInvite } = await minted.json<{ token: string }>();
    const memberSignup = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: `inherit-member-${crypto.randomUUID()}@example.test`, name: "Inherited Member", password: PASSWORD, invite: accountInvite }),
    });
    expect(memberSignup.status).toBe(200);
    const memberCookie = cookieOf(memberSignup);
    const member = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie: memberCookie } })).json<{ id: string }>();

    const workspaceCreated = await SELF.fetch(`${ORIGIN}/workspaces`, {
      method: "POST", headers: { ...json, cookie: adminCookie }, body: JSON.stringify({ name: "Inherited MCP" }),
    });
    const workspaceId = (await workspaceCreated.json<{ workspace: { id: string } }>()).workspace.id;
    const invite = await SELF.fetch(`${ORIGIN}/workspaces/${workspaceId}/invites`, {
      method: "POST", headers: { ...json, cookie: adminCookie }, body: JSON.stringify({ role: "member" }),
    });
    const { token: workspaceInvite } = await invite.json<{ token: string }>();
    expect(
      (
        await SELF.fetch(`${ORIGIN}/workspaces/${workspaceId}/invites/accept`, {
          method: "POST", headers: { ...json, cookie: memberCookie },
          body: JSON.stringify({ token: workspaceInvite, operationId: crypto.randomUUID() }),
        })
      ).status,
    ).toBe(200);

    const boardCreate = await SELF.fetch(`${ORIGIN}/boards`, {
      method: "POST", headers: { ...json, cookie: adminCookie },
      body: JSON.stringify({
        name: "Inherited MCP board",
        key: `I${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
        workspaceId,
        accessMode: "workspace",
      }),
    });
    const board = await boardCreate.json<{ id: string }>();
    const columnId = crypto.randomUUID();
    const admin = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie: adminCookie } })).json<{ id: string }>();
    await seedColumn(board.id, columnId, admin.id);

    // The member holds no explicit board grant: their access is inherited from the
    // workspace, and MCP must see the same membership the REST member list shows.
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM board_members WHERE board_id=? AND user_id=?")
        .bind(board.id, member.id)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });

    const issue = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
      method: "POST", headers: { ...json, cookie: adminCookie },
      body: JSON.stringify({ name: "Inherited reader", boardIds: [board.id], scopes: ["boards:read", "tasks:write"] }),
    });
    const { token } = await issue.json<{ token: string }>();
    const client = new Client({ name: "inherited-members", version: "1.0.0" });
    await client.connect(transport(token));
    try {
      const boardResult = await client.callTool({ name: "get_board", arguments: { board: { id: board.id } } });
      expect(boardResult.isError).not.toBe(true);
      const parsed = GetBoardOutputSchema.parse(boardResult.structuredContent);
      if (!parsed.ok) throw new Error("board read failed");
      const memberIds = parsed.data.members.items.map((item) => item.id);
      expect(memberIds.sort()).toEqual([admin.id, member.id].sort());
      expect(parsed.data.members.items.find((item) => item.id === member.id)?.name).toBe("Inherited Member");

      // An inherited member is assignable, exactly as the board's own member list
      // already shows them.
      const created = await client.callTool({
        name: "create_task",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), columnId, title: "Assigned to inherited", assigneeId: member.id },
      });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toMatchObject({ ok: true });
    } finally {
      await client.close();
    }
  });

  it("rechecks workspace-inherited access before serving a stored receipt", async () => {
    const json = { "content-type": "application/json" };
    const adminSignup = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: `admin-ws-${crypto.randomUUID()}@foxban.test`, name: "WS Admin", password: PASSWORD }),
    });
    expect(adminSignup.status).toBe(200);
    const adminCookie = cookieOf(adminSignup);
    const minted = await SELF.fetch(`${ORIGIN}/invites`, { method: "POST", headers: { ...json, cookie: adminCookie }, body: "{}" });
    expect(minted.status).toBe(201);
    const { token: accountInvite } = await minted.json<{ token: string }>();
    const memberSignup = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST", headers: json,
      body: JSON.stringify({ email: `ws-member-${crypto.randomUUID()}@example.test`, name: "WS Member", password: PASSWORD, invite: accountInvite }),
    });
    expect(memberSignup.status).toBe(200);
    const memberCookie = cookieOf(memberSignup);
    const member = await (
      await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie: memberCookie } })
    ).json<{ id: string }>();

    const created = await SELF.fetch(`${ORIGIN}/workspaces`, {
      method: "POST", headers: { ...json, cookie: adminCookie }, body: JSON.stringify({ name: "MCP workspace" }),
    });
    expect(created.status).toBe(201);
    const workspaceId = (await created.json<{ workspace: { id: string } }>()).workspace.id;
    const invite = await SELF.fetch(`${ORIGIN}/workspaces/${workspaceId}/invites`, {
      method: "POST", headers: { ...json, cookie: adminCookie }, body: JSON.stringify({ role: "member" }),
    });
    expect(invite.status).toBe(201);
    const { token: workspaceInvite } = await invite.json<{ token: string }>();
    const accepted = await SELF.fetch(`${ORIGIN}/workspaces/${workspaceId}/invites/accept`, {
      method: "POST", headers: { ...json, cookie: memberCookie },
      body: JSON.stringify({ token: workspaceInvite, operationId: crypto.randomUUID() }),
    });
    expect(accepted.status).toBe(200);

    const boardCreate = await SELF.fetch(`${ORIGIN}/boards`, {
      method: "POST", headers: { ...json, cookie: adminCookie },
      body: JSON.stringify({
        name: "Shared MCP board",
        key: `S${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
        workspaceId,
        accessMode: "workspace",
      }),
    });
    expect(boardCreate.status).toBe(200);
    const board = await boardCreate.json<{ id: string }>();

    const issue = await SELF.fetch(`${ORIGIN}/me/agent-credentials`, {
      method: "POST", headers: { ...json, cookie: memberCookie },
      body: JSON.stringify({ name: "Member client", boardIds: [board.id], scopes: ["boards:read", "tasks:write"] }),
    });
    expect(issue.status).toBe(201);
    const { token } = await issue.json<{ token: string }>();
    const adminIdentity = await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie: adminCookie } });
    expect(adminIdentity.status).toBe(200);
    const admin = await adminIdentity.json<{ id: string }>();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, admin.id);

    const client = new Client({ name: "workspace-inheritance", version: "1.0.0" });
    await client.connect(transport(token));
    try {
      const operationKey = crypto.randomUUID();
      const createArguments = { board: { id: board.id }, operationKey, columnId, title: "Inherited once" };
      expect((await client.callTool({ name: "create_task", arguments: createArguments })).isError).not.toBe(true);

      // Revoking the workspace membership that granted this credential also
      // fences the board, so the stored receipt must not be replayed.
      const removed = await SELF.fetch(`${ORIGIN}/workspaces/${workspaceId}/members/${member.id}`, {
        method: "DELETE", headers: { ...json, cookie: adminCookie },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      });
      expect(removed.status).toBe(200);

      const listed = await client.callTool({ name: "list_boards", arguments: {} });
      expect(listed.isError).not.toBe(true);
      const items = (listed.structuredContent as { data: { items: Array<{ id: string }> } }).data.items;
      expect(items.map((item) => item.id)).not.toContain(board.id);

      const replay = await client.callTool({ name: "create_task", arguments: createArguments });
      expect(replay.isError).toBe(true);
      expect(replay.structuredContent).toMatchObject({ ok: false, error: { code: "forbidden" } });
      // Revoked workspace access fences the newer writes too.
      const completion = await client.callTool({
        name: "complete_subtask",
        arguments: {
          board: { id: board.id }, operationKey: crypto.randomUUID(),
          task: { id: crypto.randomUUID() }, done: true,
        },
      });
      expect(completion.isError).toBe(true);
      expect(completion.structuredContent).toMatchObject({ ok: false, error: { code: "forbidden" } });
    } finally {
      await client.close();
    }
  });

  it("keeps filtered task matches and escaped comments across bounded pages", async () => {
    const { board, token, userId } = await fixture();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board.id));
    const bodies = Array.from({ length: 8 }, (_, index) => `${"\\\n".repeat(4_999)}${index}`);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let taskNumber = 1; taskNumber <= 132; taskNumber += 1) {
          const id = `seed-${taskNumber}`;
          state.storage.sql.exec(
            `INSERT INTO cards(
               id, column_id, title, description, position, task_number, subtask_done,
               task_type, priority, assignee_id, due_date, created_at, updated_at
             ) VALUES (?, ?, ?, '', ?, ?, 0, 'task', 'medium', NULL, NULL, ?, ?)`,
            id, columnId, taskNumber > 130 ? `Needle ${taskNumber}` : `Noise ${taskNumber}`,
            `a${String(taskNumber).padStart(3, "0")}`, taskNumber, taskNumber, taskNumber,
          );
        }
        for (let index = 0; index < bodies.length; index += 1) {
          state.storage.sql.exec(
            `INSERT INTO comments(
               id, card_id, author_id, parent_comment_id, deleted, body, created_at, updated_at
             ) VALUES (?, 'seed-131', 'seed-author', NULL, 0, ?, ?, ?)`,
            `comment-${index}`, bodies[index]!, index, index,
          );
        }
      });
    });
    const client = new Client({ name: "bounds-test", version: "1.0.0" });
    await client.connect(transport(token));
    try {
      const listed = await client.callTool({
        name: "list_tasks",
        arguments: { board: { id: board.id }, query: "needle", limit: 10 },
      });
      expect(listed.structuredContent).toMatchObject({
        ok: true,
        data: {
          items: [{ id: "seed-131" }, { id: "seed-132" }],
          nextCursor: null,
        },
      });
      const recovered: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const result = await client.callTool({
          name: "get_task",
          arguments: {
            board: { id: board.id }, task: { id: "seed-131" },
            comments: { limit: 50, ...(cursor ? { cursor } : {}) },
          },
        });
        const parsed = z.object({
          ok: z.literal(true),
          data: z.object({
            comments: z.object({
              items: z.array(z.object({ body: z.string() })),
              nextCursor: z.string().nullable(),
            }),
          }),
        }).parse(result.structuredContent);
        const serializedBytes = new TextEncoder().encode(
          JSON.stringify(parsed.data.comments.items),
        ).byteLength;
        expect(serializedBytes).toBeLessThanOrEqual(131_072);
        recovered.push(...parsed.data.comments.items.map((comment) => comment.body));
        cursor = parsed.data.comments.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(recovered).toEqual(bodies);
    } finally {
      await client.close();
    }
  });

  it("rejects missing credentials, hostile origin, wrong host, and oversized bodies before dispatch", async () => {
    const missing = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="foxban-mcp"');
    const { token } = await fixture();
    const hostile = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: "https://evil.test" }, body: "{}" });
    expect(hostile.status).toBe(403);
    const wrongHost = await SELF.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { host: "evil.test", "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" }));
    expect(wrongHost.status).toBe(403);
    const oversized = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": "1048577" }, body: "{}" });
    expect(oversized.status).toBe(413);
  });
});

describe("MCP subtask completion", () => {
  it("completes and reopens one linked subtask by moving it and leaves the family alone", async () => {
    const { board, token, userId } = await fixture();
    const columnId = crypto.randomUUID();
    const doneId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    await seedDoneColumn(board.id, doneId, userId);
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    await seedCard(board.id, userId, columnId, parentId, "Parent task", "a0");
    await seedSubtask(board.id, userId, parentId, childId, "First child", "a0");
    await seedSubtask(board.id, userId, parentId, siblingId, "Second child", "a1");
    await browserMutation(board.id, userId, {
      type: "checklist.create", mutationId: crypto.randomUUID(), id: crypto.randomUUID(),
      cardId: parentId, text: "Keep me", position: "a0",
    });
    const client = await connectClient("subtask-completion", token);
    try {
      const readFamily = async () => {
        const parsed = GetTaskOutputSchema.parse((await client.callTool({
          name: "get_task", arguments: { board: { id: board.id }, task: { id: parentId } },
        })).structuredContent);
        if (!parsed.ok) throw new Error("family read failed");
        return parsed.data;
      };
      const before = await readFamily();
      expect(before.subtasks.items.map((item) => [item.id, item.subtaskDone])).toEqual([
        [childId, false], [siblingId, false],
      ]);

      const completed = TaskMutationOutputSchema.parse((await client.callTool({
        name: "complete_subtask",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: childId }, done: true },
      })).structuredContent);
      if (!completed.ok) throw new Error("completion failed");
      expect(completed.data.task).toMatchObject({ id: childId, subtaskDone: true, storedColumnId: doneId, effectiveColumnId: doneId });

      // Only the child moves: the parent, the sibling and the checklist read back
      // exactly as they were.
      const afterComplete = await readFamily();
      expect(afterComplete.subtasks.items.map((item) => [item.id, item.subtaskDone, item.position])).toEqual([
        [childId, true, expect.any(String)], [siblingId, false, "a1"],
      ]);
      expect(afterComplete.task).toMatchObject({
        id: parentId, subtaskDone: false, storedColumnId: columnId, effectiveColumnId: columnId,
      });
      expect(afterComplete.checklist.items).toEqual(before.checklist.items);

      // Reopening accepts the task's own key form and moves it back to the starting column.
      const reopened = TaskMutationOutputSchema.parse((await client.callTool({
        name: "complete_subtask",
        arguments: {
          board: { id: board.id }, operationKey: crypto.randomUUID(),
          task: { key: before.subtasks.items[0]!.key }, done: false,
        },
      })).structuredContent);
      if (!reopened.ok) throw new Error("reopen failed");
      expect(reopened.data.task).toMatchObject({ id: childId, subtaskDone: false, storedColumnId: columnId });

      // Two real moves recorded two child activities, in order.
      const moves = await boardState(board.id, (sql) => sql.exec<{ cardId: string; detail: string }>(
        "SELECT card_id AS cardId, detail_json AS detail FROM activities ORDER BY sequence DESC LIMIT 2",
      ).toArray());
      expect(moves.map((row) => [row.cardId, JSON.parse(row.detail)])).toEqual([
        [childId, { type: "card.moved", fromColumn: "Done", toColumn: "Todo" }],
        [childId, { type: "card.moved", fromColumn: "Todo", toColumn: "Done" }],
      ]);

      // Writing the value it already holds is answered and owns its receipt.
      const repeatedCounts = await boardCounts(board.id);
      const repeated = await client.callTool({
        name: "complete_subtask",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: childId }, done: false },
      });
      expect(repeated.isError).not.toBe(true);
      expect(repeated.structuredContent).toMatchObject({ ok: true, data: { task: { subtaskDone: false } } });
      expect((await boardCounts(board.id)).receipts).toBe(repeatedCounts.receipts + 1);
    } finally {
      await client.close();
    }
  });

  it("refuses completion on a board without starting and completed columns and writes nothing", async () => {
    const { board, token, userId } = await fixture();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await seedCard(board.id, userId, columnId, parentId, "Parent task", "a0");
    await seedSubtask(board.id, userId, parentId, childId, "Child", "a0");
    const before = await boardCounts(board.id);
    const client = await connectClient("subtask-no-roles", token);
    try {
      // New subtasks join their parent's column on such a board; nothing is done.
      expect(await boardState(board.id, (sql) => sql.exec<{ columnId: string }>(
        "SELECT column_id AS columnId FROM cards WHERE id = ?", childId,
      ).toArray()[0]?.columnId)).toBe(columnId);
      expectFailure((await client.callTool({
        name: "complete_subtask",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: childId }, done: true },
      })).structuredContent, "column_not_found", "The board has no starting and completed columns yet.");
      expect(await boardCounts(board.id)).toEqual(before);
    } finally {
      await client.close();
    }
  });

  it("refuses completion the board cannot show and writes nothing", async () => {
    const { board, token, userId } = await fixture();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    await seedDoneColumn(board.id, crypto.randomUUID(), userId);
    const rootId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    const orphanId = crypto.randomUUID();
    const orphanRelationId = crypto.randomUUID();
    const archivedId = crypto.randomUUID();
    const lockedId = crypto.randomUUID();
    await seedCard(board.id, userId, columnId, rootId, "Root task", "a0");
    await seedCard(board.id, userId, columnId, parentId, "Parent task", "a1");
    await browserMutation(board.id, userId, {
      type: "subtask.create", mutationId: crypto.randomUUID(), id: orphanId,
      parentCardId: parentId, relationId: orphanRelationId, title: "Orphan", position: "a0",
    });
    // Dropping the link leaves an active subtask with no live parent to show it under.
    await browserMutation(board.id, userId, {
      type: "relation.delete", mutationId: crypto.randomUUID(), id: orphanRelationId,
    });
    await seedSubtask(board.id, userId, parentId, archivedId, "Archived child", "a1");
    await seedSubtask(board.id, userId, parentId, lockedId, "Locked child", "a2");
    await browserMutation(board.id, userId, {
      type: "card.delete", mutationId: crypto.randomUUID(), id: archivedId,
    });
    await boardState(board.id, (sql) => {
      sql.exec(
        `INSERT INTO card_transfer_locks(card_id, transfer_id, destination_board_id, phase, expires_at)
         VALUES (?, ?, '', 'prepared', ?)`,
        lockedId, crypto.randomUUID(), Date.now() + 300_000,
      );
      return null;
    });
    const before = await boardCounts(board.id);
    const client = await connectClient("subtask-refusals", token);
    try {
      const complete = (taskId: string) => client.callTool({
        name: "complete_subtask",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: taskId }, done: true },
      });
      expectFailure((await complete(rootId)).structuredContent, "subtask_unavailable", "Subtask is unavailable.");
      expectFailure((await complete(orphanId)).structuredContent, "subtask_unavailable", "Subtask is unavailable.");
      expectFailure((await complete(archivedId)).structuredContent, "task_archived", "archived cards are read-only");
      expectFailure((await complete(lockedId)).structuredContent, "transfer_conflict", "card transfer in progress");
      expectFailure(
        (await complete(crypto.randomUUID())).structuredContent,
        "task_not_found",
        "Task not found.",
      );
      // No receipt, no activity and no flag moved for any of them.
      expect(await boardCounts(board.id)).toEqual(before);
      expect(await boardState(board.id, (sql) => sql.exec<{ subtaskDone: number }>(
        "SELECT subtask_done AS subtaskDone FROM cards WHERE id IN (?, ?, ?, ?) ORDER BY id",
        rootId, orphanId, archivedId, lockedId,
      ).toArray().map((row) => row.subtaskDone))).toEqual([0, 0, 0, 0]);
    } finally {
      await client.close();
    }
  });
});

describe("MCP label management", () => {
  it("creates, discovers, edits and removes ordinary task labels", async () => {
    const { board, token, userId } = await fixture();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    const taskId = crypto.randomUUID();
    await seedCard(board.id, userId, columnId, taskId, "Labelled task", "a0");
    const client = await connectClient("label-lifecycle", token);
    try {
      const createLabel = (name: string, color: string) => client.callTool({
        name: "create_label",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), name, color },
      });
      const doingKey = crypto.randomUUID();
      const doing = LabelMutationOutputSchema.parse((await client.callTool({
        name: "create_label",
        arguments: { board: { id: board.id }, operationKey: doingKey, name: "status:doing", color: "amber" },
      })).structuredContent);
      if (!doing.ok) throw new Error("label creation failed");
      expect(doing.data.operationKey).toBe(doingKey);
      expect(doing.data.label).toMatchObject({ name: "status:doing", color: "amber" });

      // Names trim on the way in and are never made unique — the id is the identity,
      // so two "status:*" definitions live side by side and duplicates stay distinct.
      const blocked = LabelMutationOutputSchema.parse((await createLabel("  status:blocked  ", "red")).structuredContent);
      const duplicate = LabelMutationOutputSchema.parse((await createLabel("status:doing", "green")).structuredContent);
      if (!blocked.ok || !duplicate.ok) throw new Error("label creation failed");
      expect(blocked.data.label.name).toBe("status:blocked");
      expect(duplicate.data.label).toMatchObject({ name: "status:doing", color: "green" });
      expect(duplicate.data.label.id).not.toBe(doing.data.label.id);
      expect(await labelNames(board.id)).toEqual(["status:blocked", "status:doing", "status:doing"]);

      const assignedDoing = AssignLabelOutputSchema.parse((await client.callTool({
        name: "assign_label",
        arguments: {
          board: { id: board.id }, operationKey: crypto.randomUUID(),
          task: { id: taskId }, labelId: doing.data.label.id,
        },
      })).structuredContent);
      const assignedBlocked = AssignLabelOutputSchema.parse((await client.callTool({
        name: "assign_label",
        arguments: {
          board: { id: board.id }, operationKey: crypto.randomUUID(),
          task: { id: taskId }, labelId: blocked.data.label.id,
        },
      })).structuredContent);
      if (!assignedDoing.ok || !assignedBlocked.ok) throw new Error("label assignment failed");
      expect(assignedDoing.data).toMatchObject({
        task: { id: taskId, boardId: board.id },
        cardLabel: { cardId: taskId, labelId: doing.data.label.id },
      });
      expect(assignedBlocked.data.cardLabel).toMatchObject({ labelId: blocked.data.label.id });

      const readLabels = async () => {
        const parsed = GetTaskOutputSchema.parse((await client.callTool({
          name: "get_task",
          arguments: { board: { id: board.id }, task: { id: taskId }, labels: { limit: 100 } },
        })).structuredContent);
        if (!parsed.ok) throw new Error("task read failed");
        return parsed.data.labels.items;
      };
      const byName = (items: Array<{ name: string; color: string; labelId: string }>) =>
        Object.fromEntries(items.map((item) => [item.name, [item.color, item.labelId]]));
      expect(byName(await readLabels())).toEqual({
        "status:blocked": ["red", blocked.data.label.id],
        "status:doing": ["amber", doing.data.label.id],
      });

      // The definition is board-scoped: editing it rewrites every card that carries
      // it, and leaves the definitions around it exactly as they were.
      const edited = LabelMutationOutputSchema.parse((await client.callTool({
        name: "update_label",
        arguments: {
          board: { id: board.id }, operationKey: crypto.randomUUID(),
          labelId: doing.data.label.id, name: "status:review", color: "blue",
        },
      })).structuredContent);
      if (!edited.ok) throw new Error("label edit failed");
      expect(edited.data.label).toEqual({ id: doing.data.label.id, name: "status:review", color: "blue" });
      expect(byName(await readLabels())).toEqual({
        "status:blocked": ["red", blocked.data.label.id],
        "status:review": ["blue", doing.data.label.id],
      });
      const boardLabels = GetBoardOutputSchema.parse((await client.callTool({
        name: "get_board", arguments: { board: { id: board.id }, labels: { limit: 100 } },
      })).structuredContent);
      if (!boardLabels.ok) throw new Error("board read failed");
      expect(Object.fromEntries(
        boardLabels.data.labels.items.map((item) => [item.id, [item.name, item.color]]),
      )).toEqual({
        [doing.data.label.id]: ["status:review", "blue"],
        [blocked.data.label.id]: ["status:blocked", "red"],
        [duplicate.data.label.id]: ["status:doing", "green"],
      });

      // Removing one association is not deleting a definition: the exact join goes,
      // the other card label survives, and the board still offers the definition.
      const statusJoin = (await readLabels()).find((item) => item.labelId === doing.data.label.id);
      if (!statusJoin) throw new Error("missing join");
      const removed = UnassignLabelOutputSchema.parse((await client.callTool({
        name: "unassign_label",
        arguments: {
          board: { id: board.id }, operationKey: crypto.randomUUID(),
          task: { id: taskId }, cardLabelId: statusJoin.id,
        },
      })).structuredContent);
      if (!removed.ok) throw new Error("unassign failed");
      expect(removed.data).toMatchObject({ task: { id: taskId }, cardLabelId: statusJoin.id });
      expect(byName(await readLabels())).toEqual({ "status:blocked": ["red", blocked.data.label.id] });
      expect(await labelNames(board.id)).toEqual(["status:blocked", "status:doing", "status:review"]);
      expect(await boardState(board.id, (sql) => sql
        .exec<{ name: string }>("SELECT name FROM labels WHERE id = ?", doing.data.label.id)
        .toArray()
        .map((row) => row.name))).toEqual(["status:review"]);
    } finally {
      await client.close();
    }
  });

  it("keeps assignment idempotent and rejects foreign or unavailable targets", async () => {
    const { board, cookie, userId } = await fixture();
    const other = await addBoard(cookie, "Assignment MCP board");
    const { token: twoBoardToken } = await issueCredential(
      cookie, [board.id, other.id], ["boards:read", "tasks:write"],
    );
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await seedCard(board.id, userId, columnId, firstId, "First task", "a0");
    await seedCard(board.id, userId, columnId, secondId, "Second task", "a1");
    const client = await connectClient("label-assignment", twoBoardToken);
    try {
      const labelId = await createLabelId(client, board.id, "status:doing", "amber");
      const foreignLabelId = await createLabelId(client, other.id, "status:doing", "amber");
      const joinCount = (cardId: string, label: string) => boardState(board.id, (sql) => sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM card_labels WHERE card_id = ? AND label_id = ?", cardId, label,
        )
        .toArray()[0]!.count);
      const assign = (taskId: string, label: string) => client.callTool({
        name: "assign_label",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: taskId }, labelId: label },
      });
      const unassign = (taskId: string, cardLabelId: string) => client.callTool({
        name: "unassign_label",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: taskId }, cardLabelId },
      });

      const first = AssignLabelOutputSchema.parse((await assign(firstId, labelId)).structuredContent);
      if (!first.ok) throw new Error("assignment failed");
      // The same pair under a new key is the same association, never a second row.
      const beforeRepeat = await boardCounts(board.id);
      const repeated = AssignLabelOutputSchema.parse((await assign(firstId, labelId)).structuredContent);
      if (!repeated.ok) throw new Error("assignment failed");
      expect(repeated.data.cardLabel).toEqual(first.data.cardLabel);
      expect(await joinCount(firstId, labelId)).toBe(1);
      expect(await boardCounts(board.id)).toEqual({ ...beforeRepeat, receipts: beforeRepeat.receipts + 1 });

      // Removing the association, then asking again: the second answer acknowledges
      // the absence it was asked for and records nothing new.
      const removal = UnassignLabelOutputSchema.parse(
        (await unassign(firstId, first.data.cardLabel.id)).structuredContent,
      );
      if (!removal.ok) throw new Error("unassign failed");
      const beforeAbsent = await boardCounts(board.id);
      const absent = UnassignLabelOutputSchema.parse(
        (await unassign(firstId, first.data.cardLabel.id)).structuredContent,
      );
      if (!absent.ok) throw new Error("absent unassign failed");
      expect(absent.data.cardLabelId).toBe(first.data.cardLabel.id);
      expect(await joinCount(firstId, labelId)).toBe(0);
      expect(await boardCounts(board.id)).toEqual({ ...beforeAbsent, receipts: beforeAbsent.receipts + 1 });

      // A join id that belongs to another task never authorizes a change to it.
      const otherAssigned = AssignLabelOutputSchema.parse((await assign(secondId, labelId)).structuredContent);
      if (!otherAssigned.ok) throw new Error("assignment failed");
      expectFailure(
        (await unassign(firstId, otherAssigned.data.cardLabel.id)).structuredContent,
        "label_assignment_not_found",
        "Label assignment not found.",
      );
      expect(await joinCount(secondId, labelId)).toBe(1);

      // Associations written before this surface existed stay individually readable
      // and individually removable: the page lists both rows unmerged, and one
      // removal takes exactly one of them.
      const duplicateJoins = [crypto.randomUUID(), crypto.randomUUID()];
      await boardState(board.id, (sql) => {
        for (const id of duplicateJoins) {
          sql.exec("INSERT INTO card_labels(id, card_id, label_id) VALUES (?, ?, ?)", id, firstId, labelId);
        }
        return null;
      });
      const readJoins = async () => {
        const parsed = GetTaskOutputSchema.parse((await client.callTool({
          name: "get_task",
          arguments: { board: { id: board.id }, task: { id: firstId }, labels: { limit: 100 } },
        })).structuredContent);
        if (!parsed.ok) throw new Error("task read failed");
        return parsed.data.labels.items.map((item) => item.id).sort();
      };
      expect(await readJoins()).toEqual([...duplicateJoins].sort());
      expect((await unassign(firstId, duplicateJoins[0]!)).isError).not.toBe(true);
      expect(await readJoins()).toEqual([duplicateJoins[1]!]);
      expect((await unassign(firstId, duplicateJoins[1]!)).isError).not.toBe(true);
      expect(await readJoins()).toEqual([]);

      // A missing definition and another board's definition are the same answer here.
      expectFailure((await assign(firstId, crypto.randomUUID())).structuredContent, "label_not_found", "Label not found.");
      expectFailure((await assign(firstId, foreignLabelId)).structuredContent, "label_not_found", "Label not found.");
      expectFailure((await client.callTool({
        name: "update_label",
        arguments: {
          board: { id: board.id }, operationKey: crypto.randomUUID(),
          labelId: crypto.randomUUID(), name: "Renamed",
        },
      })).structuredContent, "label_not_found", "Label not found.");

      // Archived and transfer-locked tasks refuse both directions without a write,
      // including the calls that would otherwise be no-ops.
      const otherLabelId = await createLabelId(client, board.id, "status:other", "red");
      expect((await assign(firstId, labelId)).isError).not.toBe(true);
      await browserMutation(board.id, userId, {
        type: "card.delete", mutationId: crypto.randomUUID(), id: secondId,
      });
      await boardState(board.id, (sql) => {
        sql.exec(
          `INSERT INTO card_transfer_locks(card_id, transfer_id, destination_board_id, phase, expires_at)
           VALUES (?, ?, '', 'prepared', ?)`,
          firstId, crypto.randomUUID(), Date.now() + 300_000,
        );
        return null;
      });
      const beforeRefusals = await boardCounts(board.id);
      expectFailure((await assign(secondId, labelId)).structuredContent, "task_archived", "archived cards are read-only");
      expectFailure(
        (await unassign(secondId, otherAssigned.data.cardLabel.id)).structuredContent,
        "task_archived",
        "archived cards are read-only",
      );
      expectFailure((await assign(secondId, otherLabelId)).structuredContent, "task_archived", "archived cards are read-only");
      expectFailure(
        (await unassign(secondId, crypto.randomUUID())).structuredContent,
        "task_archived",
        "archived cards are read-only",
      );
      // Archiving fences writes, not reads: the retained association stays visible.
      const archivedRead = GetTaskOutputSchema.parse((await client.callTool({
        name: "get_task",
        arguments: { board: { id: board.id }, task: { id: secondId }, labels: { limit: 100 } },
      })).structuredContent);
      if (!archivedRead.ok) throw new Error("archived task read failed");
      expect(archivedRead.data.task.archivedAt).not.toBeNull();
      expect(archivedRead.data.labels.items.map((item) => item.labelId)).toEqual([labelId]);
      expectFailure((await assign(firstId, labelId)).structuredContent, "transfer_conflict", "card transfer in progress");
      expectFailure((await assign(firstId, otherLabelId)).structuredContent, "transfer_conflict", "card transfer in progress");
      expectFailure(
        (await unassign(firstId, crypto.randomUUID())).structuredContent,
        "transfer_conflict",
        "card transfer in progress",
      );
      expect(await boardCounts(board.id)).toEqual(beforeRefusals);
      expect(await joinCount(secondId, labelId)).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("pages label definitions and assignments under bound cursors", async () => {
    const { board, cookie, userId } = await fixture();
    const other = await addBoard(cookie, "Cursor MCP board");
    const { token: twoBoardToken } = await issueCredential(
      cookie, [board.id, other.id], ["boards:read", "tasks:write"],
    );
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await seedCard(board.id, userId, columnId, firstId, "First task", "a0");
    await seedCard(board.id, userId, columnId, secondId, "Second task", "a1");
    const client = await connectClient("label-pages", twoBoardToken);
    try {
      const created: string[] = [];
      for (const name of ["status:one", "status:two", "status:three"]) {
        const labelId = await createLabelId(client, board.id, name, "blue");
        created.push(labelId);
        const assigned = await client.callTool({
          name: "assign_label",
          arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: firstId }, labelId },
        });
        expect(assigned.isError).not.toBe(true);
      }
      await createLabelId(client, other.id, "status:elsewhere", "blue");

      const boardPage = async (cursor: string | undefined) => {
        const parsed = GetBoardOutputSchema.parse((await client.callTool({
          name: "get_board",
          arguments: { board: { id: board.id }, labels: { limit: 1, ...(cursor ? { cursor } : {}) } },
        })).structuredContent);
        if (!parsed.ok) throw new Error("board read failed");
        return parsed.data.labels;
      };
      const definitionIds: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const labels = await boardPage(cursor);
        definitionIds.push(...labels.items.map((item) => item.id));
        if (!labels.nextCursor) break;
        cursor = labels.nextCursor;
      }
      // Every definition exactly once, in id order, and the walk ends by itself.
      expect(definitionIds).toEqual([...created].sort());
      // A cursor past the last row is a valid, empty, final page.
      expect(await boardPage(encodeCursor({ v: 1, kind: "labels", boardId: board.id, after: "zzzz" })))
        .toEqual({ items: [], nextCursor: null });

      const taskPage = async (taskId: string, taskCursor: string | undefined) => {
        const parsed = GetTaskOutputSchema.parse((await client.callTool({
          name: "get_task",
          arguments: {
            board: { id: board.id }, task: { id: taskId },
            labels: { limit: 1, ...(taskCursor ? { cursor: taskCursor } : {}) },
          },
        })).structuredContent);
        if (!parsed.ok) throw new Error("task read failed");
        return parsed.data.labels;
      };
      const joinIds: string[] = [];
      let joinCursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const labels = await taskPage(firstId, joinCursor);
        joinIds.push(...labels.items.map((item) => item.id));
        if (!labels.nextCursor) break;
        joinCursor = labels.nextCursor;
      }
      expect(joinIds).toEqual([...joinIds].sort());
      const unbounded = GetTaskOutputSchema.parse((await client.callTool({
        name: "get_task",
        arguments: { board: { id: board.id }, task: { id: firstId }, labels: { limit: 100 } },
      })).structuredContent);
      if (!unbounded.ok) throw new Error("task read failed");
      expect(joinIds).toEqual(unbounded.data.labels.items.map((item) => item.id).sort());
      // A task that carries no labels ends on its own first page.
      expect(await taskPage(secondId, undefined)).toEqual({ items: [], nextCursor: null });

      // Cursors are bound to their kind, their board, their task and a string id.
      const boardCursor = encodeCursor({ v: 1, kind: "labels", boardId: board.id, after: created[0]! });
      expectFailure((await client.callTool({
        name: "get_task",
        arguments: {
          board: { id: board.id }, task: { id: firstId },
          labels: { limit: 1, cursor: boardCursor },
        },
      })).structuredContent, "invalid_cursor", "Task label cursor is invalid.");
      expectFailure((await client.callTool({
        name: "get_board",
        arguments: { board: { id: board.id }, labels: { limit: 1, cursor: joinCursor } },
      })).structuredContent, "invalid_cursor", "Label cursor is invalid.");
      expectFailure((await client.callTool({
        name: "get_task",
        arguments: {
          board: { id: board.id }, task: { id: secondId },
          labels: { limit: 1, cursor: joinCursor },
        },
      })).structuredContent, "invalid_cursor", "Task label cursor is invalid.");
      expectFailure((await client.callTool({
        name: "get_board",
        arguments: {
          board: { id: board.id },
          labels: { limit: 1, cursor: encodeCursor({ v: 1, kind: "labels", boardId: other.id, after: "" }) },
        },
      })).structuredContent, "invalid_cursor", "Label cursor is invalid.");
      expectFailure((await client.callTool({
        name: "get_board",
        arguments: {
          board: { id: board.id },
          labels: { limit: 1, cursor: encodeCursor({ v: 1, kind: "labels", boardId: board.id, after: 7 }) },
        },
      })).structuredContent, "invalid_cursor", "Label cursor is invalid.");
      expectFailure((await client.callTool({
        name: "get_task",
        arguments: {
          board: { id: board.id }, task: { id: firstId },
          labels: {
            limit: 1,
            cursor: encodeCursor({ v: 1, kind: "task_labels", boardId: board.id, after: "x" }),
          },
        },
      })).structuredContent, "invalid_cursor", "Task label cursor is invalid.");
    } finally {
      await client.close();
    }
  });

  it("replays historical results without rewriting later work", async () => {
    const { board, token, userId } = await fixture();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    await seedDoneColumn(board.id, crypto.randomUUID(), userId);
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    await seedCard(board.id, userId, columnId, parentId, "Parent task", "a0");
    await seedSubtask(board.id, userId, parentId, childId, "Child", "a0");
    await seedCard(board.id, userId, columnId, taskId, "Task", "a1");
    const client = await connectClient("mcp-replay", token);
    try {
      const completeKey = crypto.randomUUID();
      const firstCompletion = TaskMutationOutputSchema.parse((await client.callTool({
        name: "complete_subtask",
        arguments: { board: { id: board.id }, operationKey: completeKey, task: { id: childId }, done: true },
      })).structuredContent);
      if (!firstCompletion.ok) throw new Error("completion failed");
      // A later, opposing completion is its own call under its own key.
      expect((await client.callTool({
        name: "complete_subtask",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: childId }, done: false },
      })).isError).not.toBe(true);
      const replayedCompletion = TaskMutationOutputSchema.parse((await client.callTool({
        name: "complete_subtask",
        arguments: { board: { id: board.id }, operationKey: completeKey, task: { id: childId }, done: true },
      })).structuredContent);
      expect(replayedCompletion).toEqual(firstCompletion);
      const child = GetTaskOutputSchema.parse((await client.callTool({
        name: "get_task", arguments: { board: { id: board.id }, task: { id: childId } },
      })).structuredContent);
      if (!child.ok) throw new Error("task read failed");
      expect(child.data.task.subtaskDone).toBe(false);

      // A label edit after the fact does not rewrite the earlier answer.
      const labelKey = crypto.randomUUID();
      const created = LabelMutationOutputSchema.parse((await client.callTool({
        name: "create_label",
        arguments: { board: { id: board.id }, operationKey: labelKey, name: "status:doing", color: "amber" },
      })).structuredContent);
      if (!created.ok) throw new Error("label creation failed");
      const labelId = created.data.label.id;
      expect((await client.callTool({
        name: "update_label",
        arguments: {
          board: { id: board.id }, operationKey: crypto.randomUUID(),
          labelId, name: "status:review", color: "blue",
        },
      })).isError).not.toBe(true);
      const replayedLabel = LabelMutationOutputSchema.parse((await client.callTool({
        name: "create_label",
        arguments: { board: { id: board.id }, operationKey: labelKey, name: "status:doing", color: "amber" },
      })).structuredContent);
      expect(replayedLabel).toEqual(created);
      expect(await labelNames(board.id)).toEqual(["status:review"]);

      // The same key with different fields is a conflict, never another write.
      expectFailure((await client.callTool({
        name: "create_label",
        arguments: { board: { id: board.id }, operationKey: labelKey, name: "status:blocked", color: "amber" },
      })).structuredContent, "idempotency_conflict", "Operation key was already used for different input.");
      expect(await labelNames(board.id)).toEqual(["status:review"]);

      // A replayed removal restores no association, even after a later assignment.
      const assigned = AssignLabelOutputSchema.parse((await client.callTool({
        name: "assign_label",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: taskId }, labelId },
      })).structuredContent);
      if (!assigned.ok) throw new Error("assignment failed");
      const unassignKey = crypto.randomUUID();
      const removed = UnassignLabelOutputSchema.parse((await client.callTool({
        name: "unassign_label",
        arguments: {
          board: { id: board.id }, operationKey: unassignKey,
          task: { id: taskId }, cardLabelId: assigned.data.cardLabel.id,
        },
      })).structuredContent);
      if (!removed.ok) throw new Error("unassign failed");
      const reassigned = AssignLabelOutputSchema.parse((await client.callTool({
        name: "assign_label",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: taskId }, labelId },
      })).structuredContent);
      if (!reassigned.ok) throw new Error("reassignment failed");
      expect(reassigned.data.cardLabel.id).not.toBe(assigned.data.cardLabel.id);
      const replayedRemoval = UnassignLabelOutputSchema.parse((await client.callTool({
        name: "unassign_label",
        arguments: {
          board: { id: board.id }, operationKey: unassignKey,
          task: { id: taskId }, cardLabelId: assigned.data.cardLabel.id,
        },
      })).structuredContent);
      expect(replayedRemoval).toEqual(removed);
      expect(await boardState(board.id, (sql) => sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM card_labels WHERE id = ?", reassigned.data.cardLabel.id)
        .toArray()[0]!.count)).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("rolls label writes back when the receipt cannot be recorded", async () => {
    const { board, token, userId } = await fixture();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    const taskId = crypto.randomUUID();
    await seedCard(board.id, userId, columnId, taskId, "Task", "a0");
    const client = await connectClient("label-rollback", token);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board.id));
    try {
      const labelId = await createLabelId(client, board.id, "status:doing", "amber");
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TRIGGER fail_mcp_receipt
             BEFORE INSERT ON mcp_operation_receipts
             BEGIN
               SELECT RAISE(ABORT, 'forced receipt failure');
             END`,
        );
      });
      const before = await boardCounts(board.id);
      const creationKey = crypto.randomUUID();
      const failedCreation = await client.callTool({
        name: "create_label",
        arguments: { board: { id: board.id }, operationKey: creationKey, name: "status:blocked", color: "red" },
      });
      expect(failedCreation.isError).toBe(true);
      expect(failedCreation.structuredContent).toMatchObject({
        ok: false, error: { code: "internal_error", retryable: true },
      });
      const assignmentKey = crypto.randomUUID();
      const failedAssignment = await client.callTool({
        name: "assign_label",
        arguments: { board: { id: board.id }, operationKey: assignmentKey, task: { id: taskId }, labelId },
      });
      expect(failedAssignment.isError).toBe(true);
      // The refused definition and the refused `label.added` activity both rolled back.
      expect(await boardCounts(board.id)).toEqual(before);
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER fail_mcp_receipt");
      });
      // The same keys then commit the writes they were refused.
      expect((await client.callTool({
        name: "create_label",
        arguments: { board: { id: board.id }, operationKey: creationKey, name: "status:blocked", color: "red" },
      })).isError).not.toBe(true);
      expect((await client.callTool({
        name: "assign_label",
        arguments: { board: { id: board.id }, operationKey: assignmentKey, task: { id: taskId }, labelId },
      })).isError).not.toBe(true);
      expect(await boardCounts(board.id)).toEqual({
        receipts: before.receipts + 2,
        activities: before.activities + 1,
        labels: before.labels + 1,
        joins: before.joins + 1,
      });
    } finally {
      await client.close();
    }
  });

  it("refuses every new write to credentials without tasks:write", async () => {
    const { board, token, cookie, userId } = await fixture();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await seedCard(board.id, userId, columnId, parentId, "Parent task", "a0");
    await seedSubtask(board.id, userId, parentId, childId, "Child", "a0");
    const owner = await connectClient("new-write-owner", token);
    const reader = await connectClient(
      "new-write-reader", (await issueCredential(cookie, [board.id], ["boards:read"])).token,
    );
    const commenter = await connectClient(
      "new-write-commenter", (await issueCredential(cookie, [board.id], ["comments:write"])).token,
    );
    try {
      const labelId = await createLabelId(owner, board.id, "status:doing", "amber");
      const before = await boardCounts(board.id);
      const attempts: Array<[string, Record<string, unknown>]> = [
        ["complete_subtask", {
          board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: childId }, done: true,
        }],
        ["create_label", {
          board: { id: board.id }, operationKey: crypto.randomUUID(), name: "status:blocked", color: "red",
        }],
        ["update_label", {
          board: { id: board.id }, operationKey: crypto.randomUUID(), labelId, color: "green",
        }],
        ["assign_label", {
          board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: parentId }, labelId,
        }],
        ["unassign_label", {
          board: { id: board.id }, operationKey: crypto.randomUUID(),
          task: { id: parentId }, cardLabelId: crypto.randomUUID(),
        }],
      ];
      for (const client of [reader, commenter]) {
        for (const [name, args] of attempts) {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError).toBe(true);
          expectFailure(result.structuredContent, "forbidden", "Operation is not authorized.");
        }
      }
      // No refused call left a receipt or any board state behind.
      expect(await boardCounts(board.id)).toEqual(before);
      // The read half of the surface stays open to a boards:read credential.
      const read = await reader.callTool({
        name: "get_board", arguments: { board: { id: board.id }, labels: { limit: 100 } },
      });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ ok: true, data: { labels: { items: [{ id: labelId }] } } });
    } finally {
      await owner.close();
      await reader.close();
      await commenter.close();
    }
  });
});

describe("MCP broadcast semantics", () => {
  it("broadcasts accepted label writes and stays silent for no-ops and replays", async () => {
    const { board, token, userId } = await fixture();
    const columnId = crypto.randomUUID();
    await seedColumn(board.id, columnId, userId);
    const taskId = crypto.randomUUID();
    await seedCard(board.id, userId, columnId, taskId, "Task", "a0");
    const client = await connectClient("mcp-fanout", token);
    const peer = await openBoardSocket(board.id, userId);
    try {
      await peer.next();

      const assignKey = crypto.randomUUID();
      const created = LabelMutationOutputSchema.parse((await client.callTool({
        name: "create_label",
        arguments: {
          board: { id: board.id }, operationKey: crypto.randomUUID(), name: "status:doing", color: "amber",
        },
      })).structuredContent);
      if (!created.ok) throw new Error("label creation failed");
      const labelId = created.data.label.id;
      expect(await peer.next()).toMatchObject({ type: "label.create", id: labelId });

      // An accepted assignment reaches the peer with its own history behind it.
      const assigned = AssignLabelOutputSchema.parse((await client.callTool({
        name: "assign_label",
        arguments: { board: { id: board.id }, operationKey: assignKey, task: { id: taskId }, labelId },
      })).structuredContent);
      if (!assigned.ok) throw new Error("assignment failed");
      expect(await peer.next()).toMatchObject({ type: "label.assign", cardId: taskId, labelId });
      expect(await peer.next()).toMatchObject({
        type: "activity.recorded",
        activities: [{ cardId: taskId, detail: { type: "label.added", label: "status:doing" } }],
      });

      // The same pair under a new key, and the original key replayed, write nothing
      // and say nothing: the peer's next frame is the browser mutation sent after them.
      expect((await client.callTool({
        name: "assign_label",
        arguments: { board: { id: board.id }, operationKey: crypto.randomUUID(), task: { id: taskId }, labelId },
      })).isError).not.toBe(true);
      expect((await client.callTool({
        name: "assign_label",
        arguments: { board: { id: board.id }, operationKey: assignKey, task: { id: taskId }, labelId },
      })).isError).not.toBe(true);
      const assignmentMarker = crypto.randomUUID();
      await browserMutation(board.id, userId, {
        type: "card.update", mutationId: assignmentMarker, id: taskId, title: "Renamed after a quiet no-op",
      });
      expect(await peer.next()).toMatchObject({ type: "card.update", mutationId: assignmentMarker });
      await peer.next();

      // A real removal broadcasts; asking again for the absence it produced does not.
      const unassignKey = crypto.randomUUID();
      const removed = UnassignLabelOutputSchema.parse((await client.callTool({
        name: "unassign_label",
        arguments: {
          board: { id: board.id }, operationKey: unassignKey,
          task: { id: taskId }, cardLabelId: assigned.data.cardLabel.id,
        },
      })).structuredContent);
      if (!removed.ok) throw new Error("unassign failed");
      expect(await peer.next()).toMatchObject({ type: "label.unassign", id: assigned.data.cardLabel.id });
      await peer.next();
      expect((await client.callTool({
        name: "unassign_label",
        arguments: {
          board: { id: board.id }, operationKey: crypto.randomUUID(),
          task: { id: taskId }, cardLabelId: assigned.data.cardLabel.id,
        },
      })).isError).not.toBe(true);
      expect((await client.callTool({
        name: "unassign_label",
        arguments: {
          board: { id: board.id }, operationKey: unassignKey,
          task: { id: taskId }, cardLabelId: assigned.data.cardLabel.id,
        },
      })).isError).not.toBe(true);
      const unassignMarker = crypto.randomUUID();
      await browserMutation(board.id, userId, {
        type: "card.update", mutationId: unassignMarker, id: taskId, title: "Renamed after a quiet absence",
      });
      expect(await peer.next()).toMatchObject({ type: "card.update", mutationId: unassignMarker });
      await peer.next();
    } finally {
      peer.close();
      await client.close();
    }
  });
});

describe("MCP and workspace admins of Private boards", () => {
  async function signedUp(email: string, invite?: string) {
    const response = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name: email.split("@")[0], password: PASSWORD, ...(invite ? { invite } : {}) }),
    });
    expect(response.status).toBe(200);
    return cookieOf(response);
  }
  const send = (path: string, method: string, body: unknown, cookie: string) =>
    SELF.fetch(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });

  it("reads a Private board for the admin of its workspace, and issues no credential to a plain member", async () => {
    const operator = await signedUp(`mcp-operator-${crypto.randomUUID()}@foxban.test`);
    const person = async () => {
      const { token } = await (await send("/invites", "POST", {}, operator)).json<{ token: string }>();
      const cookie = await signedUp(`mcp-person-${crypto.randomUUID()}@example.test`, token);
      const { id } = await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie } })).json<{ id: string }>();
      return { cookie, id };
    };
    const founder = await person();
    const admin = await person();
    const member = await person();
    const { workspace } = await (await send("/workspaces", "POST", { name: "MCP team" }, founder.cookie)).json<{ workspace: { id: string } }>();
    for (const [who, role] of [[admin, "admin"], [member, "member"]] as const) {
      expect((await send(`/workspaces/${workspace.id}/members`, "POST", { userId: who.id, role, operationId: crypto.randomUUID() }, founder.cookie)).status).toBe(200);
    }
    const created = await send(
      "/boards", "POST",
      { name: "Private MCP board", key: `V${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId: workspace.id, accessMode: "restricted" },
      founder.cookie,
    );
    const board = await created.json<{ id: string }>();
    const credential = (who: { cookie: string }) =>
      send("/me/agent-credentials", "POST", { name: "Test client", boardIds: [board.id], scopes: ["boards:read"] }, who.cookie);

    expect((await credential(member)).status).toBe(403);
    const issued = await credential(admin);
    expect(issued.status).toBe(201);
    const client = await connectClient("foxban-workspace-admin-test", (await issued.json<{ token: string }>()).token);
    try {
      const read = await client.callTool({ name: "get_board", arguments: { board: { id: board.id } } });
      expect(read.isError).not.toBe(true);
      expect(GetBoardOutputSchema.parse(read.structuredContent)).toMatchObject({ ok: true });
    } finally {
      await client.close();
    }
  });
});
