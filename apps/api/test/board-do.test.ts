import {
  familyCompletionRows,
  CARD_ARCHIVE_RETENTION_MS,
  REALTIME_PROTOCOL_VERSION,
  CommentSchema,
  DESCRIPTION_MAX_BYTES,
  descriptionByteLength,
  ServerMessageSchema,
  type Activity,
  type Card,
  type ClientMessage,
  type ServerMessage,
} from "@foxban/shared";
import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { attachmentObjectKey, attachmentTransferObjectKey } from "../src/attachment-lifecycle";
import {
  INTERNAL_BOARD_ID_HEADER,
  INTERNAL_CAN_MANAGE_COLUMNS_HEADER,
  INTERNAL_USER_ID_HEADER,
} from "../src/internal-headers";
import { reconcileAttachmentObjects } from "../src/index";
import { generateKeyBetween } from "fractional-indexing";
import {
  CARD_TRANSFER_ABORT_PATH,
  CARD_TRANSFER_FINALIZE_PATH,
  CARD_TRANSFER_IMPORT_PATH,
  CARD_TRANSFER_PREPARE_PATH,
  CARD_TRANSFER_RECEIPT_PATH,
  DELETE_BOARD_PATH,
  MCP_COMMAND_PATH,
  RECONCILE_ATTACHMENTS_PATH,
  STAGE_ATTACHMENT_PATH,
  routePath,
} from "../src/board-api";
import { PreparedCardTransferBundleSchema } from "../src/board-do";
import type { z } from "zod";
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
/**
 * BoardDO behaviour driven through real hibernatable WebSockets: every test
 * talks to the DO the way a browser does (upgrade, snapshot, mutations,
 * broadcasts) so the protocol in packages/shared is what gets asserted.
 *
 * Each test uses its own `idFromName` so board state can never leak sideways.
 */

interface Frame {
  /** Exactly the bytes the DO sent — needed to prove broadcasts are verbatim. */
  raw: string;
  message: ServerMessage;
}

interface Client {
  board: string;
  /** Resolves on the next frame from the DO; a missing frame surfaces as the test's own timeout. */
  next(): Promise<Frame>;
  send(message: unknown): void;
  sendRaw(raw: string): void;
  close(): void;
  closed: Promise<CloseEvent>;
}

const open: Client[] = [];

afterEach(() => {
  while (open.length > 0) {
    try {
      open.pop()?.close();
    } catch {
      // The restart test aborts the DO, which tears its sockets down first:
      // closing one of those again throws and must not fail the teardown.
    }
  }
});

/**
 * The DO re-resolves access in D1 before it accepts a socket, so a test identity
 * needs real user, board and grant rows. Idempotent: repeated connects are cheap.
 */
async function seedIdentity(board: string, userId: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`,
    ).bind(userId, `${userId}@board-do.test`, userId, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO boards(id,name,owner_id,icon,color,access_mode,created_at)
       VALUES(?,?,?,'square-kanban','amber','restricted',?)`,
    ).bind(board, board, userId, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO board_members(board_id,user_id,role) VALUES(?,?,'manager')`,
    ).bind(board, userId),
  ]);
}

/** Headers for a direct transfer prepare/import: both admit the actor against D1. */
async function transferHeaders(board: string, userId = "test-user"): Promise<Record<string, string>> {
  await seedIdentity(board, userId);
  return {
    "Content-Type": "application/json",
    [INTERNAL_BOARD_ID_HEADER]: board,
    [INTERNAL_USER_ID_HEADER]: userId,
  };
}

async function connect(
  board: string,
  userId = "test-user",
  canManageColumns = true,
): Promise<Client> {
  await seedIdentity(board, userId);
  const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
  const response = await stub.fetch("https://board.test/ws", {
    headers: {
      Upgrade: "websocket",
      [INTERNAL_BOARD_ID_HEADER]: board,
      [INTERNAL_USER_ID_HEADER]: userId,
      [INTERNAL_CAN_MANAGE_COLUMNS_HEADER]: String(canManageColumns),
    },
  });

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("the DO did not return a WebSocket");

  const queue: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];

  socket.addEventListener("message", (event: MessageEvent) => {
    const raw = event.data as string;
    const frame: Frame = { raw, message: ServerMessageSchema.parse(JSON.parse(raw)) };
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
  socket.accept();

  const client: Client = {
    board,
    closed,
    next() {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<Frame>((resolve) => waiters.push(resolve));
    },
    send(message) {
      socket.send(JSON.stringify(message));
    },
    sendRaw(raw) {
      socket.send(raw);
    },
    close() {
      // Explicit 1000: a codeless close makes the DO's `webSocketClose` handler
      // throw on `ws.close(1005)` (see the note in the yield report).
      socket.close(1000, "test finished");
    },
  };

  open.push(client);
  return client;
}

/**
 * Staging now requires the uploader's identity: the DO resolves that user's current
 * access to the board itself, so the fixture seeds one like any other caller.
 */
async function stageAttachment(board: string, attachmentId: string): Promise<string> {
  await seedIdentity(board, "test-user");
  const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
  const response = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_BOARD_ID_HEADER]: board,
      [INTERNAL_USER_ID_HEADER]: "test-user",
    },
    body: JSON.stringify({ id: attachmentId }),
  });
  expect(response.status).toBe(204);
  const objectKey = attachmentObjectKey(board, attachmentId);
  await env.ATTACHMENTS.put(objectKey, Uint8Array.of(1, 2, 3));
  return objectKey;
}

async function expectObjectDeleted(objectKey: string): Promise<void> {
  await expect
    .poll(async () => (await env.ATTACHMENTS.head(objectKey)) === null)
    .toBe(true);
}

/**
 * The instance surface these tests stub: the admission's authorization read, plus the
 * hook a test uses to put the real read back. Cast once, at a named const.
 */
type StubBoardDO = {
  currentBoardAccess: (boardId: string, userId: string) => Promise<unknown>;
  restoreAccess: () => void;
};

/**
 * Simulates the interleaving the admission window exists for: a prepare lands while a
 * protected path's D1 authorization read is still out, so the verdict that read returns
 * describes a policy that has already moved. One-shot by construction — the stub puts
 * itself back — and the fence it leaves behind is cleared with `releaseSimulatedFence`.
 */
async function raceBoundaryDuringAccessRead(board: string): Promise<void> {
  const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
  await runInDurableObject(stub, (instance, state) => {
    const target = instance as unknown as StubBoardDO;
    const real = target.currentBoardAccess.bind(instance);
    target.currentBoardAccess = async (boardId: string, userId: string) => {
      target.currentBoardAccess = real;
      const verdict = await real(boardId, userId);
      state.storage.sql.exec(
        `UPDATE board_access_state SET generation=generation+1,frozen=1,pending_operation_id='raced-prepare' WHERE id=1`,
      );
      return verdict;
    };
  });
}

/** Clears the fence a simulated prepare left, so the board is live for later requests. */
async function releaseSimulatedFence(board: string): Promise<void> {
  await runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(board)), (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE board_access_state SET frozen=0,pending_operation_id=NULL WHERE id=1`,
    );
  });
}

/** Rows a board object's own storage holds, for asserting a refused write left nothing. */
function countDurableRows(
  board: string,
  sql: string,
  ...params: (string | number)[]
): Promise<number> {
  return runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(board)), (_instance, state) =>
    state.storage.sql.exec<{ n: number }>(sql, ...params).toArray()[0]!.n,
  );
}
type BoardDOWithBucket = {
  attachmentBucket: R2Bucket;
  alarm(): Promise<void>;
  fetch(request: Request): Promise<Response>;
};

function asBoardDOWithBucket(instance: unknown): BoardDOWithBucket {
  if (
    typeof instance !== "object" ||
    instance === null ||
    !("attachmentBucket" in instance)
  ) {
    throw new Error("expected BoardDO with attachmentBucket");
  }
  return instance as unknown as BoardDOWithBucket;
}


/** The snapshot, plus every activity row the board holds: the snapshot itself carries none (ADR 0073), so this reads them from storage. */
async function snapshotOf(client: Client) {
  const frame = await client.next();
  if (frame.message.type !== "snapshot") {
    throw new Error(`expected a snapshot first, got ${frame.message.type}`);
  }
  expect(frame.message).not.toHaveProperty("activities");
  const activities = await runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(client.board)), (_instance, state) =>
    state.storage.sql
      .exec<Omit<Activity, "detail"> & { detailJson: string }>(
        `SELECT id, card_id AS cardId, actor_id AS actorId, sequence, created_at AS createdAt, detail_json AS detailJson
           FROM activities ORDER BY card_id, sequence`,
      )
      .toArray()
      .map(({ detailJson, ...row }): Activity => ({ ...row, detail: JSON.parse(detailJson) })),
  );
  return { ...frame.message, activities };
}

async function awaitMatching<T extends ServerMessage>(
  client: Client,
  predicate: (message: ServerMessage) => message is T,
): Promise<T> {
  for (;;) {
    const { message } = await client.next();
    if (predicate(message)) return message;
  }
}

/** Waits for a specific verbatim client-mutation broadcast, skipping other server frames. */
async function awaitBroadcast(client: Client, mutationId: string): Promise<ClientMessage> {
  return awaitMatching(
    client,
    (message): message is ClientMessage =>
      message.type !== "snapshot" &&
      message.type !== "error" &&
      message.type !== "activity.recorded" &&
      message.type !== "cards.archived" &&
      message.type !== "archive.purged" &&
      message.type !== "card.numbered" &&
      message.type !== "github.invalidated" &&
      message.mutationId === mutationId,
  );
}

async function awaitActivity(client: Client, mutationId: string): Promise<Activity[]> {
  const message = await awaitMatching(
    client,
    (candidate): candidate is Extract<ServerMessage, { type: "activity.recorded" }> =>
      candidate.type === "activity.recorded" && candidate.mutationId === mutationId,
  );
  return message.activities;
}

async function awaitError(
  client: Client,
  mutationId: string | null,
): Promise<Extract<ServerMessage, { type: "error" }>> {
  return awaitMatching(
    client,
    (message): message is Extract<ServerMessage, { type: "error" }> =>
      message.type === "error" && message.mutationId === mutationId,
  );
}

describe("BoardDO", () => {
  it("refuses a non-upgrade request", async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName("board-plain-http"));
    const response = await stub.fetch("https://board.test/ws");
    expect(response.status).toBe(426);
  });

  it.each([undefined, "true"])("requires legacy attachment capability %s to reconnect before retrying", async (capability) => {
    const board = `board-legacy-capability-${String(capability)}`;
    const client = await connect(board);
    const baseline = await snapshotOf(client);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    await runInDurableObject(stub, (_instance, state) => {
      state.getWebSockets()[0]!.serializeAttachment({
        userId: "test-user", boardId: board, protocolVersion: REALTIME_PROTOCOL_VERSION,
        ...(capability === undefined ? {} : { canManageColumns: capability }),
      });
    });
    const mutation = { type: "column.create", mutationId: "legacy-create", id: "col-1", title: "Retry", position: "a0" };
    client.send(mutation);
    expect(await awaitError(client, mutation.mutationId)).toEqual({
      type: "error", mutationId: mutation.mutationId, message: "Reconnect to change board columns.",
    });
    expect((await client.closed).code).toBe(1012);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(alarm);
    const retry = await connect(board);
    expect(await snapshotOf(retry)).toEqual(baseline);
    retry.send(mutation);
    expect(await awaitBroadcast(retry, mutation.mutationId)).toEqual(mutation);
    expect((await snapshotOf(await connect(board))).columns).toEqual([
      { id: "col-1", title: "Retry", position: "a0", starting: false, completed: false },
    ]);
  });

  it.each([undefined, "TRUE", "false"])("does not grant column rights for internal header %s", async (capability) => {
    const board = `board-header-capability-${String(capability)}`;
    await seedIdentity(board, "test-user");
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const response = await stub.fetch("https://board.test/ws", {
      headers: {
        Upgrade: "websocket", [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
        ...(capability === undefined ? {} : { [INTERNAL_CAN_MANAGE_COLUMNS_HEADER]: capability }),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const queue: ServerMessage[] = [];
    const waiters: Array<(message: ServerMessage) => void> = [];
    socket.addEventListener("message", (event: MessageEvent) => {
      const message = ServerMessageSchema.parse(JSON.parse(event.data as string));
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queue.push(message);
    });
    const next = () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<ServerMessage>((resolve) => waiters.push(resolve));
    socket.accept();
    try {
      const baseline = await next();
      const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
      socket.send(JSON.stringify({ type: "column.create", mutationId: "denied", id: "col-1", title: "Denied", position: "a0" }));
      expect(await next()).toEqual({
        type: "error", mutationId: "denied", message: "Only the board owner or an admin can change columns.",
      });
      expect((await (await connect(board)).next()).message).toEqual(baseline);
      expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(alarm);
    } finally {
      socket.close(1000, "test finished");
    }
  });
  it("refuses mutations from sockets that no longer hold the current generation", async () => {
    const board = "board-inbound-generation";
    const client = await connect(board);
    await snapshotOf(client);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const attachment = await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets()[0];
      if (!socket) throw new Error("expected one accepted WebSocket");
      const data = socket.deserializeAttachment() as { generation: number };
      return data;
    });
    expect(attachment.generation).toBe(0);

    // A transition completed and released the board while this socket stayed open,
    // so its generation is spent. A message queued before that must not commit.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE board_access_state SET generation=1 WHERE id=1");
    });
    client.send({
      type: "card.create",
      mutationId: "stale-generation",
      id: "card-stale",
      columnId: "col-1",
      title: "Never written",
      position: "a0",
    });
    expect(await awaitError(client, "stale-generation")).toEqual({
      type: "error",
      mutationId: "stale-generation",
      message: "Board access changed. Reconnect to continue.",
    });
    expect((await client.closed).code).toBe(4010);
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM cards").toArray()[0]!.n,
      ),
    ).toBe(0);
    expect((await snapshotOf(await connect(board))).cards).toEqual([]);
  });

  it("refuses a mutation from a legacy attachment and while the board is frozen", async () => {
    const board = "board-inbound-legacy";
    const client = await connect(board);
    await snapshotOf(client);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const countCards = () =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM cards").toArray()[0]!.n,
      );

    // A socket accepted before this deploy has no generation to compare, so this DO
    // cannot tell which policy its sender last saw.
    await runInDurableObject(stub, (_instance, state) => {
      state.getWebSockets()[0]!.serializeAttachment({ userId: "test-user", boardId: board });
    });
    client.send({
      type: "card.create",
      mutationId: "legacy-attachment",
      id: "card-legacy",
      columnId: "col-1",
      title: "Never written",
      position: "a0",
    });
    expect(await awaitError(client, "legacy-attachment")).toEqual({
      type: "error",
      mutationId: "legacy-attachment",
      message: "Reconnect to continue.",
    });
    expect((await client.closed).code).toBe(1012);
    expect(await countCards()).toBe(0);

    // A frozen board refuses content even when the socket's generation matches.
    const frozen = await connect(board);
    await snapshotOf(frozen);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE board_access_state SET frozen=1,pending_operation_id='frozen-op' WHERE id=1",
      );
    });
    frozen.send({
      type: "card.create",
      mutationId: "frozen-board",
      id: "card-frozen",
      columnId: "col-1",
      title: "Never written",
      position: "a0",
    });
    expect((await frozen.closed).code).toBe(4010);
    expect(await countCards()).toBe(0);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE board_access_state SET frozen=0,pending_operation_id=NULL WHERE id=1",
      );
    });
    expect((await snapshotOf(await connect(board))).cards).toEqual([]);
  });

  it("resolves the caller's capability itself instead of trusting the connection header", async () => {
    const board = "board-capability-reresolved";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`,
      ).bind("owner-user", "owner-user@board-do.test", "Owner", now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`,
      ).bind("plain-member", "plain-member@board-do.test", "Plain member", now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO boards(id,name,owner_id,icon,color,access_mode,created_at)
         VALUES(?,?,?,'square-kanban','amber','restricted',?)`,
      ).bind(board, board, "owner-user", now),
      env.DB.prepare(`INSERT OR IGNORE INTO board_members(board_id,user_id,role) VALUES(?,?,'member')`)
        .bind(board, "plain-member"),
    ]);

    // The header claims management; the DO's own, later read of D1 says otherwise,
    // and the narrower verdict wins.
    const response = await env.BOARD_DO.get(env.BOARD_DO.idFromName(board)).fetch(
      "https://board.test/ws",
      {
        headers: {
          Upgrade: "websocket",
          [INTERNAL_BOARD_ID_HEADER]: board,
          [INTERNAL_USER_ID_HEADER]: "plain-member",
          [INTERNAL_CAN_MANAGE_COLUMNS_HEADER]: "true",
        },
      },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const frames: unknown[] = [];
    const waiters: Array<() => void> = [];
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)));
      waiters.shift()?.();
    });
    const nextFrame = async () => {
      if (frames.length === 0) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      return frames.shift();
    };
    await nextFrame();
    socket.send(
      JSON.stringify({ type: "column.create", mutationId: "member-column", id: "col-1", title: "Denied", position: "a0" }),
    );
    expect(await nextFrame()).toEqual({
      type: "error",
      mutationId: "member-column",
      message: "Only the board owner or an admin can change columns.",
    });
    socket.close(1000, "test finished");
  });

  it("rechecks the caller's current access for internal MCP reads and mutations", async () => {
    const board = "board-mcp-recheck";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`,
      ).bind("mcp-owner", "mcp-owner@board-do.test", "MCP owner", now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`,
      ).bind("mcp-reader", "mcp-reader@board-do.test", "MCP reader", now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO boards(id,name,owner_id,icon,color,access_mode,created_at)
         VALUES(?,?,?,'square-kanban','amber','restricted',?)`,
      ).bind(board, board, "mcp-owner", now),
      env.DB.prepare(`INSERT OR IGNORE INTO board_members(board_id,user_id,role) VALUES(?,?,'member')`)
        .bind(board, "mcp-reader"),
    ]);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const body = JSON.stringify({
      board: { id: board, key: "MCPRECHECK", name: "Recheck", appOrigin: "https://app.example" },
    });
    const call = () =>
      stub.fetch("https://board.internal/internal/mcp/board", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_BOARD_ID_HEADER]: board,
          [INTERNAL_USER_ID_HEADER]: "mcp-reader",
        },
        body,
      });
    expect((await call()).status).toBe(200);

    // Authority revoked with no journal entry and no fence: the DO's own read is
    // the only thing that can notice, and it must.
    await env.DB.prepare("DELETE FROM board_members WHERE board_id=? AND user_id=?")
      .bind(board, "mcp-reader")
      .run();
    expect((await call()).status).toBe(403);

    // A transition in D1 that has not reached this DO yet is a retry, not a denial.
    await env.DB.prepare(`INSERT OR IGNORE INTO board_members(board_id,user_id,role) VALUES(?,?,'member')`)
      .bind(board, "mcp-reader")
      .run();
    await env.DB.prepare("UPDATE boards SET pending_access_operation_id='pending-op' WHERE id=?")
      .bind(board)
      .run();
    const transitioning = await call();
    expect(transitioning.status).toBe(503);
    expect(await transitioning.json()).toMatchObject({ code: "access_change_pending" });
  });

  it("refuses an MCP command whose authorization read outlived the fence it was admitted under", async () => {
    const board = "board-mcp-admission-race";
    const client = await connect(board);
    await snapshotOf(client);
    client.send({
      type: "column.create",
      mutationId: "race-col",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(client, "race-col");
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const command = (mutationTitle: string) =>
      stub.fetch("https://board.internal/internal/mcp/command", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_BOARD_ID_HEADER]: board,
          [INTERNAL_USER_ID_HEADER]: "test-user",
        },
        body: JSON.stringify({
          credentialId: "cred-race",
          inputHash: "a".repeat(64),
          board: { id: board, key: "MCPRACE1", name: "Race", appOrigin: "https://app.example" },
          command: {
            operation: "create_task",
            operationKey: crypto.randomUUID(),
            columnId: "col-1",
            title: mutationTitle,
            taskType: "task",
            priority: "medium",
            assigneeId: null,
          },
        }),
      });
    expect((await command("Admitted before the fence")).status).toBe(200);

    // A prepare lands while the next command's access read is still outstanding: the
    // granted verdict is already stale when it arrives, so nothing may be written
    // under it.
    await raceBoundaryDuringAccessRead(board);
    const refused = await command("Never written");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: "access_change_pending" });
    expect(await countDurableRows(board, "SELECT COUNT(*) AS n FROM cards")).toBe(1);
    await releaseSimulatedFence(board);
    client.close();
  });

  it("resolves an MCP assignee's eligibility itself instead of trusting the caller", async () => {
    const board = "board-mcp-assignee";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`,
      ).bind("mcp-assignee", "mcp-assignee@board-do.test", "Assignee", now),
      env.DB.prepare(`INSERT OR IGNORE INTO board_members(board_id,user_id,role) VALUES(?,?,'member')`)
        .bind(board, "mcp-assignee"),
    ]);
    const client = await connect(board);
    await snapshotOf(client);
    client.send({
      type: "column.create",
      mutationId: "assignee-col",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(client, "assignee-col");
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const createFor = (assigneeId: string | null) =>
      stub.fetch("https://board.internal/internal/mcp/command", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_BOARD_ID_HEADER]: board,
          [INTERNAL_USER_ID_HEADER]: "test-user",
        },
        body: JSON.stringify({
          credentialId: "cred-assignee",
          inputHash: "b".repeat(64),
          board: { id: board, key: "MCPASSIGN", name: "Assignees", appOrigin: "https://app.example" },
          command: {
            operation: "create_task",
            operationKey: crypto.randomUUID(),
            columnId: "col-1",
            title: "Assigned task",
            taskType: "task",
            priority: "medium",
            assigneeId,
          },
        }),
      });

    expect(await (await createFor("mcp-assignee")).json()).toMatchObject({ ok: true });

    // The verdict no longer travels with the call: the assignee is resolved when the
    // command runs, so a grant removed in between is seen instead of inherited.
    await env.DB.prepare("DELETE FROM board_members WHERE board_id=? AND user_id=?")
      .bind(board, "mcp-assignee")
      .run();
    const revoked = await createFor("mcp-assignee");
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      ok: false,
      error: { code: "assignee_not_member" },
    });
    expect(await countDurableRows(board, "SELECT COUNT(*) AS n FROM cards")).toBe(1);
    client.close();
  });

  it("refuses attachment staging whose authorization read outlived the fence it was admitted under", async () => {
    const board = "board-staging-admission-race";
    const refusedId = crypto.randomUUID();
    await stageAttachment(board, crypto.randomUUID());
    await raceBoundaryDuringAccessRead(board);

    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const refused = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({ id: refusedId }),
    });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: "access_change_pending" });
    // The lease the refused staging would have written is not there: a dead event
    // cannot leave durable cleanup work behind a fence it never passed.
    expect(
      await countDurableRows(
        board,
        "SELECT COUNT(*) AS n FROM attachment_cleanup WHERE attachment_id = ?",
        refusedId,
      ),
    ).toBe(0);
    await releaseSimulatedFence(board);
  });

  it("refuses an admission whose authorization read outlives the five-second bound", async () => {
    const board = "board-admission-deadline";
    const client = await connect(board);
    await snapshotOf(client);
    client.send({
      type: "column.create",
      mutationId: "deadline-col",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(client, "deadline-col");
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    // A dependency that never answers: the window must give up on its own rather than
    // hold this object's input gate, and the answer that eventually arrives is dropped.
    // The library is ES2022, so the executor form is the available spelling here.
    const neverSettles = new Promise<unknown>(() => {});
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as StubBoardDO;
      const real = target.currentBoardAccess.bind(instance);
      target.currentBoardAccess = () => neverSettles;
      target.restoreAccess = () => {
        target.currentBoardAccess = real;
      };
    });
    const command = () =>
      stub.fetch("https://board.internal/internal/mcp/command", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_BOARD_ID_HEADER]: board,
          [INTERNAL_USER_ID_HEADER]: "test-user",
        },
        body: JSON.stringify({
          credentialId: "cred-deadline",
          inputHash: "c".repeat(64),
          board: { id: board, key: "MCPDEAD", name: "Deadline", appOrigin: "https://app.example" },
          command: {
            operation: "create_task",
            operationKey: crypto.randomUUID(),
            columnId: "col-1",
            title: "Never written",
            taskType: "task",
            priority: "medium",
            assigneeId: null,
          },
        }),
      });

    const started = Date.now();
    const refused = await command();
    const elapsed = Date.now() - started;
    // A dependency that did not answer is an ordinary retryable failure: it is not the
    // transition signal and not a denial, because neither was established.
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("2");
    expect(await refused.json()).toMatchObject({ code: "internal_error" });
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
    expect(elapsed).toBeLessThan(15_000);
    expect(await countDurableRows(board, "SELECT COUNT(*) AS n FROM cards")).toBe(0);

    // The gate was released by the deadline, not left closed: the same board serves the
    // next request as soon as its dependency answers again.
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as StubBoardDO).restoreAccess();
    });
    expect((await command()).status).toBe(200);
    expect(await countDurableRows(board, "SELECT COUNT(*) AS n FROM cards")).toBe(1);
    await releaseSimulatedFence(board);
    client.close();
  }, 30_000);

  it("answers a failed authorization read as an ordinary retry instead of resetting", async () => {
    const board = "board-admission-rejection";
    const client = await connect(board);
    await snapshotOf(client);
    client.send({
      type: "column.create",
      mutationId: "rejection-col",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(client, "rejection-col");
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    // The dependency throws where the admission reads it: that failure must be caught
    // inside the window and answered, not allowed to reject the callback and take the
    // whole object down with it.
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as StubBoardDO;
      const real = target.currentBoardAccess.bind(instance);
      target.currentBoardAccess = () => Promise.reject(new Error("D1_ERROR: simulated failure"));
      target.restoreAccess = () => {
        target.currentBoardAccess = real;
      };
    });
    const command = () =>
      stub.fetch("https://board.internal/internal/mcp/command", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_BOARD_ID_HEADER]: board,
          [INTERNAL_USER_ID_HEADER]: "test-user",
        },
        body: JSON.stringify({
          credentialId: "cred-rejection",
          inputHash: "d".repeat(64),
          board: { id: board, key: "MCPREJECT", name: "Rejection", appOrigin: "https://app.example" },
          command: {
            operation: "create_task",
            operationKey: crypto.randomUUID(),
            columnId: "col-1",
            title: "Never written",
            taskType: "task",
            priority: "medium",
            assigneeId: null,
          },
        }),
      });

    const refused = await command();
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("2");
    expect(await refused.json()).toMatchObject({ code: "internal_error" });
    expect(await countDurableRows(board, "SELECT COUNT(*) AS n FROM cards")).toBe(0);

    // The object survived the dependency failure: its next request is served normally.
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as StubBoardDO).restoreAccess();
    });
    expect((await command()).status).toBe(200);
    expect(await countDurableRows(board, "SELECT COUNT(*) AS n FROM cards")).toBe(1);
    client.close();
  });

  it("refuses an upgrade without socket identity", async () => {
    const board = "board-missing-identity";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const response = await stub.fetch("https://board.test/ws", {
      headers: { Upgrade: "websocket", [INTERNAL_BOARD_ID_HEADER]: board },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid user id");
  });

  it.each([undefined, "invalid/board"])("rejects an upgrade with invalid board identity %s", async (boardId) => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName("board-invalid-header"));
    const headers: Record<string, string> = {
      Upgrade: "websocket",
      [INTERNAL_USER_ID_HEADER]: "test-user",
    };
    if (boardId !== undefined) headers[INTERNAL_BOARD_ID_HEADER] = boardId;
    const response = await stub.fetch("https://board.test/ws", { headers });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid board id");
  });

  it("rejects a message when the serialized socket identity is malformed", async () => {
    const board = "board-malformed-identity";
    const a = await connect(board);
    await snapshotOf(a);
    await runInDurableObject(
      env.BOARD_DO.get(env.BOARD_DO.idFromName(board)),
      (_instance, state) => {
        const socket = state.getWebSockets()[0];
        if (!socket) throw new Error("expected one accepted WebSocket");
        socket.serializeAttachment({ userId: 7 });
      },
    );

    a.send({
      type: "column.create",
      mutationId: "malformed-identity",
      id: "column-1",
      title: "Never written",
      position: "a0",
    });
    expect(await awaitError(a, "malformed-identity")).toEqual({
      type: "error",
      mutationId: "malformed-identity",
      message: "socket identity is missing",
    });
    expect((await snapshotOf(await connect(board))).columns).toEqual([]);
    expect((await a.closed).code).toBe(4001);
  });

  it("greets a fresh socket with an empty snapshot", async () => {
    const snapshot = await snapshotOf(await connect("board-empty"));
    expect(snapshot.columns).toEqual([]);
    expect(snapshot.cards).toEqual([]);
    expect(snapshot.archivedCards).toEqual([]);
  });

  it("round-trips column and card mutations into a later socket's snapshot", async () => {
    const a = await connect("board-crud");
    await snapshotOf(a);

    a.send({ type: "column.create", mutationId: "m1", id: "col-1", title: "Todo", position: "a0" });
    await awaitBroadcast(a, "m1");
    a.send({
      type: "card.create",
      mutationId: "m2",
      id: "card-1",
      columnId: "col-1",
      title: "Write tests",
      position: "a0",
    });
    await awaitBroadcast(a, "m2");
    a.send({ type: "column.rename", mutationId: "m3", id: "col-1", title: "In progress" });
    await awaitBroadcast(a, "m3");
    a.send({
      type: "card.update",
      mutationId: "m4",
      id: "card-1",
      title: "Write DO tests",
      description: "cover the protocol",
    });
    await awaitBroadcast(a, "m4");

    // A brand-new connection must see the accumulated state, in camelCase.
    const snapshot = await snapshotOf(await connect("board-crud"));
    expect(snapshot.columns).toEqual([{ id: "col-1", title: "In progress", position: "a0", starting: false, completed: false }]);
    expect(snapshot.cards).toHaveLength(1);
    const card = snapshot.cards[0] as Card;
    expect(card).toMatchObject({
      id: "card-1",
      columnId: "col-1",
      title: "Write DO tests",
      description: "cover the protocol",
      position: "a0",
    });
    expect(typeof card.createdAt).toBe("number");
    expect(card.updatedAt).toBeGreaterThanOrEqual(card.createdAt);
  });

  it("applies a partial card.update without clobbering the other field", async () => {
    const a = await connect("board-partial");
    await snapshotOf(a);

    a.send({ type: "column.create", mutationId: "p1", id: "c", title: "C", position: "a0" });
    a.send({
      type: "card.create",
      mutationId: "p2",
      id: "k",
      columnId: "c",
      title: "Title",
      position: "a0",
    });
    a.send({ type: "card.update", mutationId: "p3", id: "k", description: "only the body" });
    await awaitBroadcast(a, "p3");

    const snapshot = await snapshotOf(await connect("board-partial"));
    expect(snapshot.cards[0]).toMatchObject({ title: "Title", description: "only the body" });
  });

  it("archives cards when a column is deleted, broadcasts cards.archived, and restores into a surviving column", async () => {
    const a = await connect("board-cascade");
    const b = await connect("board-cascade");
    await snapshotOf(a);
    await snapshotOf(b);

    a.send({ type: "column.create", mutationId: "d1", id: "col-a", title: "A", position: "a0" });
    await awaitBroadcast(a, "d1");
    await awaitBroadcast(b, "d1");

    a.send({ type: "column.create", mutationId: "d2", id: "col-b", title: "B", position: "a1" });
    await awaitBroadcast(a, "d2");
    await awaitBroadcast(b, "d2");

    a.send({ type: "label.create", mutationId: "d-lbl", id: "lbl-1", name: "Bug", color: "red" });
    await awaitBroadcast(a, "d-lbl");
    await awaitBroadcast(b, "d-lbl");

    a.send({
      type: "card.create",
      mutationId: "d3",
      id: "card-a1",
      columnId: "col-a",
      title: "doomed",
      position: "a0",
    });
    await awaitBroadcast(a, "d3");
    await awaitBroadcast(b, "d3");

    a.send({
      type: "card.create",
      mutationId: "d4",
      id: "card-a2",
      columnId: "col-a",
      title: "also doomed",
      position: "a1",
    });
    await awaitBroadcast(a, "d4");
    await awaitBroadcast(b, "d4");

    a.send({
      type: "card.create",
      mutationId: "d5",
      id: "card-b1",
      columnId: "col-b",
      title: "survivor",
      position: "a0",
    });
    await awaitBroadcast(a, "d5");
    await awaitBroadcast(b, "d5");

    // Seed dependent rows on card-a1 before column deletion.
    a.send({
      type: "checklist.create",
      mutationId: "d-chk",
      id: "item-a1",
      cardId: "card-a1",
      text: "task 1",
      position: "a0",
    });
    await awaitBroadcast(a, "d-chk");
    await awaitBroadcast(b, "d-chk");

    const cascadeAttId = crypto.randomUUID();
    await stageAttachment("board-cascade", cascadeAttId);
    a.send({
      type: "attachment.create",
      mutationId: "d-att",
      id: cascadeAttId,
      cardId: "card-a1",
      fileName: "doc.png",
      contentType: "image/png",
      size: 4,
    });
    await awaitBroadcast(a, "d-att");
    await awaitBroadcast(b, "d-att");

    a.send({
      type: "comment.create",
      mutationId: "d-cmt",
      id: "cmt-a1",
      cardId: "card-a1",
      authorId: "user-1",
      parentCommentId: null,
      body: "important note",
      createdAt: 1_700_000_000_000,
    });
    await awaitBroadcast(a, "d-cmt");
    await awaitBroadcast(b, "d-cmt");

    a.send({
      type: "label.assign",
      mutationId: "d-la",
      id: "join-a1",
      cardId: "card-a1",
      labelId: "lbl-1",
    });
    await awaitBroadcast(a, "d-la");
    await awaitBroadcast(b, "d-la");

    a.send({
      type: "relation.create",
      mutationId: "d-rel",
      id: "rel-a1-b1",
      sourceCardId: "card-a1",
      targetCardId: "card-b1",
      kind: "blocks",
    });
    await awaitBroadcast(a, "d-rel");
    await awaitBroadcast(b, "d-rel");
    await awaitActivity(a, "d-rel");
    await awaitActivity(b, "d-rel");

    // Capture card-a1 full fields from active snapshot before column deletion.
    const preSnapshot = await snapshotOf(await connect("board-cascade"));
    const originalCardA1 = preSnapshot.cards.find((c) => c.id === "card-a1")!;
    // Send column.delete with deliberate key order / formatting to verify verbatim broadcast.
    const deleteFrameRaw = JSON.stringify({
      type: "column.delete",
      mutationId: "d6",
      id: "col-a",
    });
    a.sendRaw(deleteFrameRaw);

    // Peer b receives verbatim broadcast first, followed by authoritative cards.archived frame.
    const bBroadcastFrame = await b.next();
    expect(bBroadcastFrame.raw).toBe(deleteFrameRaw);
    expect(bBroadcastFrame.message).toEqual({
      type: "column.delete",
      mutationId: "d6",
      id: "col-a",
    });

    const bArchivedFrame = await b.next();
    expect(bArchivedFrame.message.type).toBe("cards.archived");
    const archivedMessage = bArchivedFrame.message as Extract<ServerMessage, { type: "cards.archived" }>;
    expect(archivedMessage.mutationId).toBe("d6");
    expect(archivedMessage.cards).toHaveLength(2);

    const archivedA1 = archivedMessage.cards.find((c) => c.id === "card-a1")!;
    expect(archivedA1).toMatchObject({
      id: "card-a1",
      columnId: "col-a",
      title: "doomed",
      position: "a0",
      archivedColumnTitle: "A",
    });
    expect(typeof archivedA1.archivedAt).toBe("number");
    expect(archivedA1.archivedAt).toBeGreaterThan(0);

    const archivedA2 = archivedMessage.cards.find((c) => c.id === "card-a2")!;
    expect(archivedA2).toMatchObject({
      id: "card-a2",
      columnId: "col-a",
      title: "also doomed",
      position: "a1",
      archivedColumnTitle: "A",
      archivedAt: archivedA1.archivedAt,
    });

    // Client a also receives the verbatim broadcast and cards.archived.
    const aBroadcastFrame = await a.next();
    expect(aBroadcastFrame.raw).toBe(deleteFrameRaw);
    const aArchivedFrame = await a.next();
    expect(aArchivedFrame.message.type).toBe("cards.archived");

    // Snapshot after column deletion: col-a and its cards leave active arrays,
    // archivedCards carries the cards, and every dependent row remains.
    let snapshot = await snapshotOf(await connect("board-cascade"));
    expect(snapshot.columns.map((column) => column.id)).toEqual(["col-b"]);
    expect(snapshot.cards.map((card) => card.id)).toEqual(["card-b1"]);
    expect(snapshot.archivedCards.map((card) => card.id).sort()).toEqual(["card-a1", "card-a2"]);
    expect(snapshot.checklistItems.map((item) => item.id)).toEqual(["item-a1"]);
    expect(snapshot.attachments.map((att) => att.id)).toEqual([cascadeAttId]);
    expect(snapshot.comments.map((comment) => comment.id)).toEqual(["cmt-a1"]);
    expect(snapshot.cardLabels.map((join) => join.id)).toEqual(["join-a1"]);
    expect(snapshot.relations.map((relation) => relation.id)).toEqual(["rel-a1-b1"]);

    // Invalid destination restore produces sender-only error.
    a.send({
      type: "card.restore",
      mutationId: "err-dest",
      id: "card-a1",
      columnId: "col-nonexistent",
      position: "a5",
    });
    const errorBadDest = await awaitError(a, "err-dest");
    expect(errorBadDest).toEqual({
      type: "error",
      mutationId: "err-dest",
      message: "archived card or destination column no longer exists",
    });

    // Missing / purged card restore produces sender-only error.
    a.send({
      type: "card.restore",
      mutationId: "err-missing",
      id: "card-missing",
      columnId: "col-b",
      position: "a5",
    });
    const errorMissing = await awaitError(a, "err-missing");
    expect(errorMissing).toEqual({
      type: "error",
      mutationId: "err-missing",
      message: "archived card or destination column no longer exists",
    });

    // Restore card-a1 into surviving col-b.
    a.send({
      type: "card.restore",
      mutationId: "d7",
      id: "card-a1",
      columnId: "col-b",
      position: "a5",
    });

    // Peer b's next frame is the valid card.restore broadcast, proving neither failed restore reached b.
    const bRestoreFrame = await b.next();
    expect(bRestoreFrame.message).toEqual({
      type: "card.restore",
      mutationId: "d7",
      id: "card-a1",
      columnId: "col-b",
      position: "a5",
    });
    await awaitBroadcast(a, "d7");

    // Assert full card fields and every dependent aggregate row are unchanged in a fresh snapshot.
    snapshot = await snapshotOf(await connect("board-cascade"));
    expect(snapshot.columns.map((column) => column.id)).toEqual(["col-b"]);
    expect(snapshot.cards.map((card) => card.id).sort()).toEqual(["card-a1", "card-b1"]);
    const restoredCard = snapshot.cards.find((c) => c.id === "card-a1")!;
    expect(restoredCard).toEqual({
      ...originalCardA1,
      columnId: "col-b",
      position: "a5",
      updatedAt: expect.any(Number),
    });
    expect(restoredCard.updatedAt).toBeGreaterThanOrEqual(originalCardA1.updatedAt);
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-a2"]);
    expect(snapshot.checklistItems.map((item) => item.id)).toEqual(["item-a1"]);
    expect(snapshot.attachments.map((att) => att.id)).toEqual([cascadeAttId]);
    expect(snapshot.comments.map((comment) => comment.id)).toEqual(["cmt-a1"]);
    expect(snapshot.cardLabels.map((join) => join.id)).toEqual(["join-a1"]);
    expect(snapshot.relations.map((relation) => relation.id)).toEqual(["rel-a1-b1"]);

    // Durable Object restart preserves the restored card, remaining archive, and dependent rows.
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName("board-cascade"));
    await expect(
      runInDurableObject(stub, (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();

    const restartSnapshot = await snapshotOf(await connect("board-cascade"));
    expect(restartSnapshot.columns.map((column) => column.id)).toEqual(["col-b"]);
    expect(restartSnapshot.cards.map((card) => card.id).sort()).toEqual(["card-a1", "card-b1"]);
    expect(restartSnapshot.cards.find((c) => c.id === "card-a1")!).toEqual(restoredCard);
    expect(restartSnapshot.archivedCards.map((card) => card.id)).toEqual(["card-a2"]);
    expect(restartSnapshot.checklistItems.map((item) => item.id)).toEqual(["item-a1"]);
    expect(restartSnapshot.attachments.map((att) => att.id)).toEqual([cascadeAttId]);
    expect(restartSnapshot.comments.map((comment) => comment.id)).toEqual(["cmt-a1"]);
    expect(restartSnapshot.cardLabels.map((join) => join.id)).toEqual(["join-a1"]);
    expect(restartSnapshot.relations.map((relation) => relation.id)).toEqual(["rel-a1-b1"]);
  });

  it("archives one populated card, preserves it through restore, and handles missing and orphan ids", async () => {
    const board = "board-card-archive";
    const a = await connect(board, "user-a");
    const b = await connect(board, "user-b");
    await snapshotOf(a);
    await snapshotOf(b);

    const sendToBoth = async (message: ClientMessage) => {
      a.send(message);
      await awaitBroadcast(a, message.mutationId);
      await awaitBroadcast(b, message.mutationId);
    };

    await sendToBoth({
      type: "column.create",
      mutationId: "ica-col",
      id: "col-todo",
      title: "Todo",
      position: "a0",
    });
    await sendToBoth({
      type: "card.create",
      mutationId: "ica-card",
      id: "card-populated",
      columnId: "col-todo",
      title: "Populated",
      position: "a0",
    });
    await sendToBoth({
      type: "card.create",
      mutationId: "ica-other",
      id: "card-other",
      columnId: "col-todo",
      title: "Unaffected",
      position: "a1",
    });
    await sendToBoth({
      type: "card.update",
      mutationId: "ica-update",
      id: "card-populated",
      description: "Saved description",
    });
    await sendToBoth({
      type: "card.assign",
      mutationId: "ica-assign",
      id: "card-populated",
      assigneeId: "user-b",
    });
    await sendToBoth({
      type: "card.prioritize",
      mutationId: "ica-priority",
      id: "card-populated",
      priority: "high",
    });
    await sendToBoth({
      type: "card.schedule",
      mutationId: "ica-due",
      id: "card-populated",
      dueDate: "2099-12-31",
    });
    await sendToBoth({
      type: "checklist.create",
      mutationId: "ica-checklist",
      id: "item-populated",
      cardId: "card-populated",
      text: "Saved item",
      position: "a0",
    });
    const popAttId = crypto.randomUUID();
    await stageAttachment(board, popAttId);
    await sendToBoth({
      type: "attachment.create",
      mutationId: "ica-attachment",
      id: popAttId,
      cardId: "card-populated",
      fileName: "saved.txt",
      contentType: "text/plain",
      size: 12,
    });
    await sendToBoth({
      type: "label.create",
      mutationId: "ica-label",
      id: "label-populated",
      name: "Saved",
      color: "blue",
    });
    await sendToBoth({
      type: "label.assign",
      mutationId: "ica-label-join",
      id: "join-populated",
      cardId: "card-populated",
      labelId: "label-populated",
    });
    await sendToBoth({
      type: "relation.create",
      mutationId: "ica-relation",
      id: "relation-populated",
      sourceCardId: "card-populated",
      targetCardId: "card-other",
      kind: "blocks",
    });
    await sendToBoth({
      type: "comment.create",
      mutationId: "ica-comment",
      id: "comment-populated",
      cardId: "card-populated",
      authorId: "user-a",
      parentCommentId: null,
      body: "Saved comment",
      createdAt: 1_700_000_000_000,
    });

    const before = await snapshotOf(await connect(board));
    const originalCard = before.cards.find((card) => card.id === "card-populated")!;
    const originalActivityIds = before.activities
      .filter((activity) => activity.cardId === "card-populated")
      .map((activity) => activity.id);
    expect(originalActivityIds.length).toBeGreaterThan(0);

    const deleteFrameRaw = JSON.stringify({
      type: "card.delete",
      mutationId: "ica-delete",
      id: "card-populated",
    });
    a.sendRaw(deleteFrameRaw);

    for (const peer of [a, b]) {
      const echo = await peer.next();
      expect(echo.raw).toBe(deleteFrameRaw);
      const archive = await peer.next();
      expect(archive.message).toMatchObject({
        type: "cards.archived",
        mutationId: "ica-delete",
        cards: [
          {
            ...originalCard,
            archivedColumnTitle: "Todo",
            archivedAt: expect.any(Number),
          },
        ],
      });
    }

    let snapshot = await snapshotOf(await connect(board));
    expect(snapshot.columns).toEqual([{ id: "col-todo", title: "Todo", position: "a0", starting: false, completed: false }]);
    expect(snapshot.cards.map((card) => card.id)).toEqual(["card-other"]);
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-populated"]);
    expect(snapshot.checklistItems.map((item) => item.id)).toEqual(["item-populated"]);
    expect(snapshot.attachments.map((attachment) => attachment.id)).toEqual([popAttId]);
    expect(snapshot.comments.map((comment) => comment.id)).toEqual(["comment-populated"]);
    expect(snapshot.cardLabels.map((join) => join.id)).toEqual(["join-populated"]);
    expect(snapshot.relations.map((relation) => relation.id)).toEqual(["relation-populated"]);
    expect(
      snapshot.activities
        .filter((activity) => activity.cardId === "card-populated")
        .map((activity) => activity.id),
    ).toEqual(originalActivityIds);

    const archivedAt = snapshot.archivedCards[0]!.archivedAt;
    a.send({
      type: "card.delete",
      mutationId: "ica-delete-again",
      id: "card-populated",
    });
    expect(await awaitError(a, "ica-delete-again")).toEqual({
      type: "error",
      mutationId: "ica-delete-again",
      message: "archived cards are read-only",
    });
    snapshot = await snapshotOf(await connect(board));
    expect(snapshot.archivedCards[0]!.archivedAt).toBe(archivedAt);

    const missingClient = await connect(board);
    await snapshotOf(missingClient);
    missingClient.send({
      type: "card.delete",
      mutationId: "ica-missing",
      id: "card-missing",
    });
    expect((await missingClient.next()).message).toEqual({
      type: "card.delete",
      mutationId: "ica-missing",
      id: "card-missing",
    });
    missingClient.send({
      type: "column.rename",
      mutationId: "ica-after-missing",
      id: "col-todo",
      title: "Todo",
    });
    expect((await missingClient.next()).message).toEqual({
      type: "column.rename",
      mutationId: "ica-after-missing",
      id: "col-todo",
      title: "Todo",
    });

    missingClient.send({
      type: "card.restore",
      mutationId: "ica-restore",
      id: "card-populated",
      columnId: "col-todo",
      position: "a2",
    });
    await awaitBroadcast(missingClient, "ica-restore");

    snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.find((card) => card.id === "card-populated")).toEqual({
      ...originalCard,
      position: "a2",
      updatedAt: expect.any(Number),
    });
    expect(snapshot.archivedCards).toEqual([]);
    expect(snapshot.checklistItems.map((item) => item.id)).toEqual(["item-populated"]);
    expect(snapshot.attachments.map((attachment) => attachment.id)).toEqual([popAttId]);
    expect(snapshot.comments.map((comment) => comment.id)).toEqual(["comment-populated"]);
    expect(snapshot.cardLabels.map((join) => join.id)).toEqual(["join-populated"]);
    expect(snapshot.relations.map((relation) => relation.id)).toEqual(["relation-populated"]);

    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    await expect(
      runInDurableObject(stub, (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();
    const restartSnapshot = await snapshotOf(await connect(board));
    expect(restartSnapshot.cards.find((card) => card.id === "card-populated")).toEqual(
      snapshot.cards.find((card) => card.id === "card-populated"),
    );
    expect(restartSnapshot.checklistItems.map((item) => item.id)).toEqual(["item-populated"]);
    expect(restartSnapshot.attachments.map((attachment) => attachment.id)).toEqual([popAttId]);
    expect(restartSnapshot.comments.map((comment) => comment.id)).toEqual([
      "comment-populated",
    ]);
    expect(restartSnapshot.cardLabels.map((join) => join.id)).toEqual(["join-populated"]);
    expect(restartSnapshot.relations.map((relation) => relation.id)).toEqual([
      "relation-populated",
    ]);

    await runInDurableObject(
      env.BOARD_DO.get(env.BOARD_DO.idFromName(board)),
      (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO cards(id, column_id, title, description, position, task_number, created_at, updated_at)
         VALUES ('card-orphan', 'col-deleted', 'Orphan', 'Saved orphan', 'a9', 99, ?, ?)`,
        now,
        now,
      );
      },
    );
    const orphanClient = await connect(board);
    await snapshotOf(orphanClient);
    orphanClient.send({
      type: "card.delete",
      mutationId: "ica-orphan-delete",
      id: "card-orphan",
    });
    await awaitBroadcast(orphanClient, "ica-orphan-delete");
    const orphanArchive = await orphanClient.next();
    expect(orphanArchive.message).toMatchObject({
      type: "cards.archived",
      mutationId: "ica-orphan-delete",
      cards: [{ id: "card-orphan", archivedColumnTitle: "(deleted column)" }],
    });

    orphanClient.send({
      type: "card.restore",
      mutationId: "ica-orphan-restore",
      id: "card-orphan",
      columnId: "col-todo",
      position: "a3",
    });
    await awaitBroadcast(orphanClient, "ica-orphan-restore");
    snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.find((card) => card.id === "card-orphan")).toMatchObject({
      id: "card-orphan",
      columnId: "col-todo",
      description: "Saved orphan",
      position: "a3",
    });
  });

  it("permanently purges one archived card and every dependent row without touching active cards", async () => {
    const board = "board-manual-purge";
    const attachmentId = crypto.randomUUID();
    const objectKey = await stageAttachment(board, attachmentId);
    const a = await connect(board, "purge-user-a");
    const b = await connect(board, "purge-user-b");
    await snapshotOf(a);
    await snapshotOf(b);

    const sendToBoth = async (message: ClientMessage) => {
      a.send(message);
      await awaitBroadcast(a, message.mutationId);
      await awaitBroadcast(b, message.mutationId);
    };

    await sendToBoth({
      type: "column.create",
      mutationId: "mp-col",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await sendToBoth({
      type: "card.create",
      mutationId: "mp-card-1",
      id: "card-1",
      columnId: "col-1",
      title: "Purge me",
      position: "a0",
    });
    await sendToBoth({
      type: "card.create",
      mutationId: "mp-card-2",
      id: "card-2",
      columnId: "col-1",
      title: "Keep me",
      position: "a1",
    });
    await sendToBoth({
      type: "checklist.create",
      mutationId: "mp-checklist",
      id: "item-1",
      cardId: "card-1",
      text: "Owned item",
      position: "a0",
    });
    await sendToBoth({
      type: "attachment.create",
      mutationId: "mp-attachment",
      id: attachmentId,
      cardId: "card-1",
      fileName: "owned.txt",
      contentType: "text/plain",
      size: 3,
    });
    await sendToBoth({
      type: "comment.create",
      mutationId: "mp-comment",
      id: "comment-1",
      cardId: "card-1",
      authorId: "purge-user-a",
      parentCommentId: null,
      body: "Owned comment",
      createdAt: 1_700_000_000_000,
    });
    await sendToBoth({
      type: "label.create",
      mutationId: "mp-label",
      id: "label-1",
      name: "Keep definition",
      color: "red",
    });
    await sendToBoth({
      type: "label.assign",
      mutationId: "mp-label-join",
      id: "join-1",
      cardId: "card-1",
      labelId: "label-1",
    });
    await sendToBoth({
      type: "relation.create",
      mutationId: "mp-relation",
      id: "relation-1",
      sourceCardId: "card-1",
      targetCardId: "card-2",
      kind: "blocks",
    });
    // A no-history frame drains any earlier activity frames from both queues.
    await sendToBoth({
      type: "column.rename",
      mutationId: "mp-ready",
      id: "col-1",
      title: "Todo",
    });

    a.send({ type: "card.delete", mutationId: "mp-archive", id: "card-1" });
    await awaitBroadcast(a, "mp-archive");
    await awaitBroadcast(b, "mp-archive");
    expect((await a.next()).message).toMatchObject({
      type: "cards.archived",
      mutationId: "mp-archive",
      cards: [{ id: "card-1" }],
    });
    expect((await b.next()).message).toMatchObject({
      type: "cards.archived",
      mutationId: "mp-archive",
      cards: [{ id: "card-1" }],
    });

    const purgeFrameRaw = JSON.stringify({
      type: "card.purge",
      mutationId: "mp-purge",
      id: "card-1",
    });
    a.sendRaw(purgeFrameRaw);
    for (const peer of [a, b]) {
      const echo = await peer.next();
      expect(echo.raw).toBe(purgeFrameRaw);
      expect(echo.message).toEqual({
        type: "card.purge",
        mutationId: "mp-purge",
        id: "card-1",
      });
      expect((await peer.next()).message).toEqual({
        type: "archive.purged",
        cardIds: ["card-1"],
      });
    }

    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.columns).toEqual([{ id: "col-1", title: "Todo", position: "a0", starting: false, completed: false }]);
    expect(snapshot.cards.map((card) => card.id)).toEqual(["card-2"]);
    expect(snapshot.archivedCards).toEqual([]);
    expect(snapshot.checklistItems).toEqual([]);
    expect(snapshot.attachments).toEqual([]);
    expect(snapshot.comments).toEqual([]);
    expect(snapshot.activities.some((activity) => activity.cardId === "card-1")).toBe(false);
    expect(snapshot.relations).toEqual([]);
    expect(snapshot.cardLabels).toEqual([]);
    expect(snapshot.labels).toEqual([{ id: "label-1", name: "Keep definition", color: "red" }]);
    await expectObjectDeleted(objectKey);

    for (const [id, suffix] of [
      ["card-2", "active"],
      ["missing-card", "missing"],
    ] as const) {
      const mutationId = `mp-purge-${suffix}`;
      a.send({ type: "card.purge", mutationId, id });
      expect(await awaitBroadcast(a, mutationId)).toEqual({ type: "card.purge", mutationId, id });
      expect(await awaitBroadcast(b, mutationId)).toEqual({ type: "card.purge", mutationId, id });

      const afterId = `mp-after-${suffix}`;
      a.send({
        type: "column.rename",
        mutationId: afterId,
        id: "col-1",
        title: "Todo",
      });
      for (const peer of [a, b]) {
        expect((await peer.next()).message).toEqual({
          type: "column.rename",
          mutationId: afterId,
          id: "col-1",
          title: "Todo",
        });
      }
    }

    const finalSnapshot = await snapshotOf(await connect(board));
    expect(finalSnapshot.cards.map((card) => card.id)).toEqual(["card-2"]);
    expect(finalSnapshot.archivedCards).toEqual([]);
  });

  it("rejects non-restore mutations targeting archived cards with sender-only error and allows label.delete", async () => {
    const board = "board-archived-readonly";
    const a = await connect(board);
    const b = await connect(board);
    await seedIdentity(board, "user-9");
    await snapshotOf(a);
    await snapshotOf(b);

    a.send({ type: "column.create", mutationId: "ro-col1", id: "col-1", title: "Col 1", position: "a0" });
    await awaitBroadcast(a, "ro-col1");
    await awaitBroadcast(b, "ro-col1");

    a.send({ type: "column.create", mutationId: "ro-col2", id: "col-2", title: "Col 2", position: "a1" });
    await awaitBroadcast(a, "ro-col2");
    await awaitBroadcast(b, "ro-col2");

    a.send({ type: "label.create", mutationId: "ro-lbl", id: "label-1", name: "Bug", color: "red" });
    await awaitBroadcast(a, "ro-lbl");
    await awaitBroadcast(b, "ro-lbl");

    a.send({
      type: "card.create",
      mutationId: "ro-c1",
      id: "card-archived",
      columnId: "col-1",
      title: "Archived Card",
      position: "a0",
    });
    await awaitBroadcast(a, "ro-c1");
    await awaitBroadcast(b, "ro-c1");

    a.send({
      type: "card.create",
      mutationId: "ro-c2",
      id: "card-active",
      columnId: "col-2",
      title: "Active Card",
      position: "a0",
    });
    await awaitBroadcast(a, "ro-c2");
    await awaitBroadcast(b, "ro-c2");

    a.send({
      type: "checklist.create",
      mutationId: "ro-chk",
      id: "item-ro",
      cardId: "card-archived",
      text: "Item",
      position: "a0",
    });
    await awaitBroadcast(a, "ro-chk");
    await awaitBroadcast(b, "ro-chk");

    const roAttId = crypto.randomUUID();
    await stageAttachment(board, roAttId);
    a.send({
      type: "attachment.create",
      mutationId: "ro-att",
      id: roAttId,
      cardId: "card-archived",
      fileName: "file.png",
      contentType: "image/png",
      size: 4,
    });
    await awaitBroadcast(a, "ro-att");
    await awaitBroadcast(b, "ro-att");
    const archivedDescription = `Before ![keep](/boards/${board}/attachments/${roAttId}) After`;
    a.send({
      type: "card.update",
      mutationId: "ro-description",
      id: "card-archived",
      description: archivedDescription,
    });
    await awaitBroadcast(a, "ro-description");
    await awaitBroadcast(b, "ro-description");

    a.send({
      type: "comment.create",
      mutationId: "ro-cmt",
      id: "note-ro",
      cardId: "card-archived",
      authorId: "user-1",
      parentCommentId: null,
      body: "Comment",
      createdAt: 1_700_000_000_000,
    });
    await awaitBroadcast(a, "ro-cmt");
    await awaitBroadcast(b, "ro-cmt");

    a.send({
      type: "label.assign",
      mutationId: "ro-join",
      id: "join-ro",
      cardId: "card-archived",
      labelId: "label-1",
    });
    await awaitBroadcast(a, "ro-join");
    await awaitBroadcast(b, "ro-join");

    a.send({
      type: "relation.create",
      mutationId: "ro-rel",
      id: "rel-ro",
      sourceCardId: "card-archived",
      targetCardId: "card-active",
      kind: "relates",
    });
    await awaitBroadcast(a, "ro-rel");
    await awaitBroadcast(b, "ro-rel");

    // Archive col-1 and its card.
    a.send({ type: "column.delete", mutationId: "ro-archive", id: "col-1" });
    await awaitBroadcast(a, "ro-archive");
    await awaitBroadcast(b, "ro-archive");

    // Drain cards.archived frames on both sockets.
    const aArchived = await a.next();
    expect(aArchived.message.type).toBe("cards.archived");
    const bArchived = await b.next();
    expect(bArchived.message.type).toBe("cards.archived");

    const readOnlyMutations: ClientMessage[] = [
      // 1. Direct card ids
      { type: "card.update", mutationId: "ro-upd", id: "card-archived", title: "hacked" },
      { type: "card.move", mutationId: "ro-mv", id: "card-archived", columnId: "col-2", position: "a9" },
      { type: "card.delete", mutationId: "ro-del", id: "card-archived" },
      { type: "card.assign", mutationId: "ro-asgn", id: "card-archived", assigneeId: "user-9" },
      { type: "card.prioritize", mutationId: "ro-prio", id: "card-archived", priority: "highest" },
      { type: "card.retype", mutationId: "ro-type", id: "card-archived", taskType: "bug" },
      { type: "card.schedule", mutationId: "ro-sched", id: "card-archived", dueDate: "2099-12-31" },
      // 2. Direct cardId creates
      { type: "checklist.create", mutationId: "ro-chk-c", id: "item-new", cardId: "card-archived", text: "nope", position: "a1" },
      { type: "attachment.create", mutationId: "ro-att-c", id: "att-new", cardId: "card-archived", fileName: "nope.png", contentType: "image/png", size: 4 },
      { type: "comment.create", mutationId: "ro-cmt-c", id: "note-new", cardId: "card-archived", authorId: "u1", parentCommentId: null, body: "nope", createdAt: 1 },
      { type: "label.assign", mutationId: "ro-la-c", id: "join-new", cardId: "card-archived", labelId: "label-1" },

      // 3. Stored parent update/delete/unassign ids
      { type: "checklist.update", mutationId: "ro-chk-u", id: "item-ro", text: "nope" },
      { type: "checklist.delete", mutationId: "ro-chk-d", id: "item-ro" },
      { type: "attachment.delete", mutationId: "ro-att-d", id: roAttId },
      { type: "comment.update", mutationId: "ro-cmt-u", id: "note-ro", body: "nope", updatedAt: 1 },
      { type: "label.unassign", mutationId: "ro-la-d", id: "join-ro" },

      // 4. Relation endpoints / create / delete
      { type: "relation.create", mutationId: "ro-rel-src", id: "rel-src", sourceCardId: "card-archived", targetCardId: "card-active", kind: "relates" },
      { type: "relation.create", mutationId: "ro-rel-tgt", id: "rel-tgt", sourceCardId: "card-active", targetCardId: "card-archived", kind: "relates" },
      { type: "relation.delete", mutationId: "ro-rel-d", id: "rel-ro" },
    ];

    for (const mutation of readOnlyMutations) {
      a.send(mutation);
      const error = await awaitError(a, mutation.mutationId);
      expect(error).toEqual({
        type: "error",
        mutationId: mutation.mutationId,
        message: "archived cards are read-only",
      });
    }

    // Peer b seeing the next accepted mutation proves none of the rejected mutations were broadcast.
    a.send({
      type: "card.update",
      mutationId: "ro-valid-peer-check",
      id: "card-active",
      title: "Active Card Updated",
    });
    const seenByB = await b.next();
    expect(seenByB.message).toMatchObject({
      type: "card.update",
      mutationId: "ro-valid-peer-check",
      id: "card-active",
      title: "Active Card Updated",
    });
    await awaitBroadcast(a, "ro-valid-peer-check");

    // Verify none of the rejected writes applied.
    const preDeleteSnapshot = await snapshotOf(await connect(board));
    expect(preDeleteSnapshot.archivedCards[0]).toMatchObject({
      id: "card-archived",
      title: "Archived Card",
      description: archivedDescription,
      priority: "medium",
      taskType: "task",
      dueDate: null,
      assigneeId: null,
    });
    expect(preDeleteSnapshot.checklistItems.map((i) => i.id)).toEqual(["item-ro"]);
    expect(preDeleteSnapshot.attachments.map((at) => at.id)).toEqual([roAttId]);
    expect(preDeleteSnapshot.comments.map((c) => c.id)).toEqual(["note-ro"]);
    expect(preDeleteSnapshot.relations.map((r) => r.id)).toEqual(["rel-ro"]);

    // label.delete remains allowed and removes the definition and join even on archived cards.
    a.send({ type: "label.delete", mutationId: "ro-lbl-del", id: "label-1" });
    await awaitBroadcast(a, "ro-lbl-del");
    await awaitBroadcast(b, "ro-lbl-del");

    const postDeleteSnapshot = await snapshotOf(await connect(board));
    expect(postDeleteSnapshot.labels).toEqual([]);
    expect(postDeleteSnapshot.cardLabels).toEqual([]);
    expect(postDeleteSnapshot.archivedCards.map((c) => c.id)).toEqual(["card-archived"]);
  });

  it("changes only columnId, position, updatedAt and the derived completion on card.move", async () => {
    const a = await connect("board-move");
    await snapshotOf(a);

    a.send({ type: "column.create", mutationId: "v1", id: "col-a", title: "A", position: "a0" });
    a.send({ type: "column.create", mutationId: "v2", id: "col-b", title: "B", position: "a1" });
    a.send({
      type: "card.create",
      mutationId: "v3",
      id: "card-1",
      columnId: "col-a",
      title: "Movable",
      position: "a0",
    });
    a.send({ type: "card.update", mutationId: "v4", id: "card-1", description: "notes" });
    await awaitBroadcast(a, "v4");

    const before = (await snapshotOf(await connect("board-move"))).cards[0] as Card;
    expect(before).toMatchObject({ columnId: "col-a", position: "a0" });

    a.send({ type: "card.move", mutationId: "v5", id: "card-1", columnId: "col-b", position: "a5" });
    await awaitBroadcast(a, "v5");

    const after = (await snapshotOf(await connect("board-move"))).cards[0] as Card;
    // The second column took the completed role, so the derived flag follows the move.
    expect(after).toEqual({
      ...before,
      columnId: "col-b",
      position: "a5",
      subtaskDone: true,
      updatedAt: after.updatedAt,
    });
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("silently ignores a mutation that matches no row", async () => {
    const a = await connect("board-noop");
    await snapshotOf(a);

    a.send({ type: "card.move", mutationId: "n1", id: "ghost", columnId: "nowhere", position: "a0" });
    const broadcast = await awaitBroadcast(a, "n1");
    expect(broadcast.type).toBe("card.move");

    const snapshot = await snapshotOf(await connect("board-noop"));
    expect(snapshot.cards).toEqual([]);
  });

  it("answers unparseable JSON with a null-mutationId error and writes nothing", async () => {
    const a = await connect("board-badjson");
    const b = await connect("board-badjson");
    await snapshotOf(a);
    await snapshotOf(b);

    a.sendRaw("not json at all");

    const error = await awaitError(a, null);
    expect(error).toEqual({
      type: "error",
      mutationId: null,
      message: expect.any(String),
    });

    // Ordering on the DO is FIFO, so a later valid mutation arriving at B first
    // proves the rejected frame was never broadcast — no sleeping required.
    a.send({ type: "column.create", mutationId: "ok", id: "col-1", title: "Live", position: "a0" });
    const seenByB = await b.next();
    expect(seenByB.message.type).toBe("column.create");

    const snapshot = await snapshotOf(await connect("board-badjson"));
    expect(snapshot.columns).toEqual([{ id: "col-1", title: "Live", position: "a0", starting: false, completed: false }]);
  });

  it("answers a schema-invalid mutation with its mutationId and writes nothing", async () => {
    const a = await connect("board-badschema");
    const b = await connect("board-badschema");
    await snapshotOf(a);
    await snapshotOf(b);

    // Well-formed JSON carrying a mutationId, but `position` is missing.
    a.send({ type: "column.create", mutationId: "bad-1", id: "col-x", title: "Nope" });

    const error = await awaitError(a, "bad-1");
    expect(error).toEqual({
      type: "error",
      mutationId: "bad-1",
      message: expect.any(String),
    });

    a.send({ type: "column.create", mutationId: "ok", id: "col-1", title: "Live", position: "a0" });
    const seenByB = await b.next();
    expect(seenByB.message.type).toBe("column.create");
    expect(seenByB.message).toMatchObject({ mutationId: "ok" });

    const snapshot = await snapshotOf(await connect("board-badschema"));
    expect(snapshot.columns).toEqual([{ id: "col-1", title: "Live", position: "a0", starting: false, completed: false }]);
  });

  it("rejects an unknown message type", async () => {
    const a = await connect("board-unknowntype");
    await snapshotOf(a);

    a.send({ type: "column.explode", mutationId: "u1", id: "col-1" });
    const error = await awaitError(a, "u1");
    expect(error).toMatchObject({ type: "error", mutationId: "u1" });
  });

  it("rejects an unknown key rather than relaying it in the broadcast", async () => {
    const a = await connect("board-strictkeys");
    const b = await connect("board-strictkeys");
    await snapshotOf(a);
    await snapshotOf(b);

    // Every accepted frame is rebroadcast verbatim, so an unknown key would reach
    // the other clients unvalidated. Strict schemas refuse it instead.
    a.send({
      type: "column.create",
      mutationId: "k1",
      id: "col-1",
      title: "Sneaky",
      position: "a0",
      extra: "junk",
    });
    const error = await awaitError(a, "k1");
    expect(error).toMatchObject({ type: "error", mutationId: "k1" });

    a.send({ type: "column.create", mutationId: "ok", id: "col-1", title: "Live", position: "a0" });
    const seenByB = await b.next();
    expect(seenByB.message).toMatchObject({ type: "column.create", mutationId: "ok" });
  });

  it("rejects a title past the protocol's length bound", async () => {
    const a = await connect("board-toolong");
    await snapshotOf(a);

    a.send({
      type: "column.create",
      mutationId: "t1",
      id: "col-1",
      title: "x".repeat(201),
      position: "a0",
    });
    const error = await awaitError(a, "t1");
    expect(error).toMatchObject({ type: "error", mutationId: "t1" });

    const snapshot = await snapshotOf(await connect("board-toolong"));
    expect(snapshot.columns).toEqual([]);
  });

  it("accepts a description at the maximum byte bound and rejects beyond it", async () => {
    const a = await connect("board-description-bound");
    const b = await connect("board-description-bound");
    await snapshotOf(a);
    await snapshotOf(b);
    a.send({
      type: "column.create",
      mutationId: "c1",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(a, "c1");
    await awaitBroadcast(b, "c1");
    a.send({
      type: "card.create",
      mutationId: "cd1",
      id: "card-1",
      columnId: "col-1",
      title: "Card",
      position: "a0",
    });
    await awaitBroadcast(a, "cd1");
    await awaitBroadcast(b, "cd1");
    const exactMaxDescription = "😀".repeat(25_000);
    expect(descriptionByteLength(exactMaxDescription)).toBe(DESCRIPTION_MAX_BYTES);
    a.send({
      type: "card.update",
      mutationId: "u-exact",
      id: "card-1",
      description: exactMaxDescription,
    });
    const aEcho = await awaitBroadcast(a, "u-exact");
    expect(aEcho).toMatchObject({
      type: "card.update",
      mutationId: "u-exact",
      id: "card-1",
      description: exactMaxDescription,
    });
    const bEcho = await awaitBroadcast(b, "u-exact");
    expect(bEcho).toMatchObject({
      type: "card.update",
      mutationId: "u-exact",
      id: "card-1",
      description: exactMaxDescription,
    });

    const persistedSnapshot = await snapshotOf(await connect("board-description-bound"));
    expect(persistedSnapshot.cards.find((card) => card.id === "card-1")?.description).toBe(
      exactMaxDescription,
    );

    a.send({
      type: "card.update",
      mutationId: "u-overflow",
      id: "card-1",
      description: `${exactMaxDescription}a`,
    });
    const error = await awaitError(a, "u-overflow");
    expect(error).toEqual({
      type: "error",
      mutationId: "u-overflow",
      message: "description: Description must be 100,000 bytes or fewer.",
    });

    // FIFO ordering on the DO: a subsequent valid mutation arriving at b first
    // proves the rejected over-limit error was never sent to peer b.
    a.send({
      type: "card.update",
      mutationId: "u-peer-check",
      id: "card-1",
      title: "Card updated",
    });
    let seenByB: Frame | null = null;
    while (true) {
      const frame = await b.next();
      expect(frame.message).not.toMatchObject({
        type: "error",
        mutationId: "u-overflow",
      });
      if (
        typeof frame.message === "object" &&
        frame.message !== null &&
        "mutationId" in frame.message &&
        frame.message.mutationId === "u-peer-check"
      ) {
        seenByB = frame;
        break;
      }
    }
    expect(seenByB.message).toMatchObject({
      type: "card.update",
      mutationId: "u-peer-check",
      id: "card-1",
      title: "Card updated",
    });
    await awaitBroadcast(a, "u-peer-check");
    const unchangedSnapshot = await snapshotOf(await connect("board-description-bound"));
    expect(unchangedSnapshot.cards.find((card) => card.id === "card-1")?.description).toBe(
      exactMaxDescription,
    );
  });

  it("answers a failed write with an error to the sender only", async () => {
    const a = await connect("board-duplicate");
    const b = await connect("board-duplicate");
    await snapshotOf(a);
    await snapshotOf(b);

    a.send({ type: "column.create", mutationId: "w1", id: "col-1", title: "First", position: "a0" });
    await awaitBroadcast(a, "w1");
    await awaitBroadcast(b, "w1");

    // Same primary key: the INSERT throws, so nothing may be broadcast.
    a.send({
      type: "column.create",
      mutationId: "w2",
      id: "col-1",
      title: "Second",
      position: "a1",
    });
    const error = await awaitError(a, "w2");
    expect(error).toMatchObject({ type: "error", mutationId: "w2" });

    const snapshot = await snapshotOf(await connect("board-duplicate"));
    expect(snapshot.columns).toEqual([{ id: "col-1", title: "First", position: "a0", starting: false, completed: false }]);

    // FIFO again: B seeing the next mutation first proves the failed one never came.
    a.send({ type: "column.rename", mutationId: "w3", id: "col-1", title: "Renamed" });
    const seenByB = await b.next();
    expect(seenByB.message).toMatchObject({ type: "column.rename", mutationId: "w3" });
  });

  it("broadcasts applied mutations verbatim to every socket, sender included", async () => {
    const a = await connect("board-broadcast");
    const b = await connect("board-broadcast");
    const c = await connect("board-broadcast");
    await snapshotOf(a);
    await snapshotOf(b);
    await snapshotOf(c);

    // Deliberately odd key order and whitespace: the DO must forward the frame
    // untouched rather than re-serialising it.
    const raw = '{  "mutationId":"w1", "position":"a0","type":"column.create","title":"T","id":"c1" }';
    a.sendRaw(raw);

    for (const client of [a, b, c]) {
      const frame = await client.next();
      expect(frame.raw).toBe(raw);
    }
  });

  it("keeps boards isolated from each other", async () => {
    const one = await connect("board-iso-one");
    await snapshotOf(one);
    one.send({ type: "column.create", mutationId: "i1", id: "col-1", title: "One", position: "a0" });
    await awaitBroadcast(one, "i1");

    const other = await snapshotOf(await connect("board-iso-two"));
    expect(other.columns).toEqual([]);
  });
});

/** Seeds `col-1` with `card-1`, the fixture every card-details test starts from. */
async function seedCard(client: Client, mutationPrefix: string): Promise<void> {
  client.send({
    type: "column.create",
    mutationId: `${mutationPrefix}-col`,
    id: "col-1",
    title: "Todo",
    position: "a0",
  });
  client.send({
    type: "card.create",
    mutationId: `${mutationPrefix}-card`,
    id: "card-1",
    columnId: "col-1",
    title: "Ship M7",
    position: "a0",
  });
  await awaitBroadcast(client, `${mutationPrefix}-card`);
}

async function sendWithActivity(client: Client, message: ClientMessage): Promise<Activity[]> {
  client.send(message);
  expect(await awaitBroadcast(client, message.mutationId)).toEqual(message);
  return awaitActivity(client, message.mutationId);
}

describe("BoardDO activity", () => {
  it("records card and compact-field changes with actor and before/after values", async () => {
    const board = "board-activity-card";
    const actorId = "actor-card";
    const a = await connect(board, actorId);
    await seedIdentity(board, "user-a");
    await seedIdentity(board, "user-b");
    await snapshotOf(a);

    a.send({
      type: "column.create",
      mutationId: "activity-column-1",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    a.send({
      type: "column.create",
      mutationId: "activity-column-2",
      id: "col-2",
      title: "Doing",
      position: "a1",
    });
    await awaitBroadcast(a, "activity-column-2");

    const [created] = await sendWithActivity(a, {
      type: "card.create",
      mutationId: "activity-card-create",
      id: "card-1",
      columnId: "col-1",
      title: "Start",
      position: "a0",
    });
    expect(created).toMatchObject({
      cardId: "card-1",
      actorId,
      detail: { type: "card.created" },
    });
    expect(created?.sequence).toBeGreaterThan(0);
    expect(typeof created?.createdAt).toBe("number");

    const updated = await sendWithActivity(a, {
      type: "card.update",
      mutationId: "activity-card-update",
      id: "card-1",
      title: "Renamed",
      description: "new body",
    });
    expect(updated.map(({ detail }) => detail)).toEqual([
      { type: "card.renamed", before: "Start", after: "Renamed" },
      { type: "description.updated" },
    ]);

    expect(
      (
        await sendWithActivity(a, {
          type: "card.move",
          mutationId: "activity-card-move",
          id: "card-1",
          columnId: "col-2",
          position: "a1",
        })
      )[0]?.detail,
    ).toEqual({ type: "card.moved", fromColumn: "Todo", toColumn: "Doing" });
    expect(
      (
        await sendWithActivity(a, {
          type: "card.move",
          mutationId: "activity-card-reorder",
          id: "card-1",
          columnId: "col-2",
          position: "a2",
        })
      )[0]?.detail,
    ).toEqual({ type: "card.reordered", column: "Doing" });

    expect(
      (
        await sendWithActivity(a, {
          type: "card.assign",
          mutationId: "activity-card-assign",
          id: "card-1",
          assigneeId: "user-a",
        })
      )[0]?.detail,
    ).toEqual({ type: "assignee.changed", beforeId: null, afterId: "user-a" });
    expect(
      (
        await sendWithActivity(a, {
          type: "card.assign",
          mutationId: "activity-card-reassign",
          id: "card-1",
          assigneeId: "user-b",
        })
      )[0]?.detail,
    ).toEqual({ type: "assignee.changed", beforeId: "user-a", afterId: "user-b" });
    expect(
      (
        await sendWithActivity(a, {
          type: "card.assign",
          mutationId: "activity-card-unassign",
          id: "card-1",
          assigneeId: null,
        })
      )[0]?.detail,
    ).toEqual({ type: "assignee.changed", beforeId: "user-b", afterId: null });

    expect(
      (
        await sendWithActivity(a, {
          type: "card.prioritize",
          mutationId: "activity-card-priority",
          id: "card-1",
          priority: "high",
        })
      )[0]?.detail,
    ).toEqual({ type: "priority.changed", before: "medium", after: "high" });

    expect(
      (
        await sendWithActivity(a, {
          type: "card.schedule",
          mutationId: "activity-card-date-set",
          id: "card-1",
          dueDate: "2099-01-01",
        })
      )[0]?.detail,
    ).toEqual({ type: "dueDate.changed", before: null, after: "2099-01-01" });
    expect(
      (
        await sendWithActivity(a, {
          type: "card.schedule",
          mutationId: "activity-card-date-change",
          id: "card-1",
          dueDate: "2099-02-02",
        })
      )[0]?.detail,
    ).toEqual({
      type: "dueDate.changed",
      before: "2099-01-01",
      after: "2099-02-02",
    });
    expect(
      (
        await sendWithActivity(a, {
          type: "card.schedule",
          mutationId: "activity-card-date-remove",
          id: "card-1",
          dueDate: null,
        })
      )[0]?.detail,
    ).toEqual({ type: "dueDate.changed", before: "2099-02-02", after: null });

    const persisted = (await snapshotOf(await connect(board))).activities.filter(
      (activity) => activity.cardId === "card-1",
    );
    const sequences = persisted.map(({ sequence }) => sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(persisted.every((activity) => activity.actorId === actorId)).toBe(true);
  });

  it("records checklist, attachment, and comment changes without duplicating comment creation", async () => {
    const board = "board-activity-children";
    const a = await connect(board, "actor-children");
    await snapshotOf(a);
    await seedCard(a, "activity-children");
    await awaitActivity(a, "activity-children-card");

    expect(
      (
        await sendWithActivity(a, {
          type: "checklist.create",
          mutationId: "activity-checklist-create",
          id: "item-1",
          cardId: "card-1",
          text: "Draft",
          position: "a0",
        })
      )[0]?.detail,
    ).toEqual({ type: "checklist.added", item: "Draft" });

    expect(
      (
        await sendWithActivity(a, {
          type: "checklist.update",
          mutationId: "activity-checklist-update",
          id: "item-1",
          text: "Final",
          done: true,
        })
      ).map(({ detail }) => detail),
    ).toEqual([
      { type: "checklist.renamed", before: "Draft", after: "Final" },
      { type: "checklist.completed", item: "Draft" },
    ]);
    expect(
      (
        await sendWithActivity(a, {
          type: "checklist.update",
          mutationId: "activity-checklist-reopen",
          id: "item-1",
          done: false,
        })
      )[0]?.detail,
    ).toEqual({ type: "checklist.reopened", item: "Final" });
    expect(
      (
        await sendWithActivity(a, {
          type: "checklist.delete",
          mutationId: "activity-checklist-delete",
          id: "item-1",
        })
      )[0]?.detail,
    ).toEqual({ type: "checklist.deleted", item: "Final" });

    const actAttId = crypto.randomUUID();
    await stageAttachment(board, actAttId);
    expect(
      (
        await sendWithActivity(a, {
          type: "attachment.create",
          mutationId: "activity-attachment-create",
          id: actAttId,
          cardId: "card-1",
          fileName: "brief.pdf",
          contentType: "application/pdf",
          size: 42,
        })
      )[0]?.detail,
    ).toEqual({ type: "attachment.added", fileName: "brief.pdf" });
    expect(
      (
        await sendWithActivity(a, {
          type: "attachment.delete",
          mutationId: "activity-attachment-delete",
          id: actAttId,
        })
      )[0]?.detail,
    ).toEqual({ type: "attachment.deleted", fileName: "brief.pdf" });

    const commentCreate: ClientMessage = {
      type: "comment.create",
      mutationId: "activity-comment-create",
      id: "comment-1",
      cardId: "card-1",
      authorId: "legacy-author",
      parentCommentId: null,
      body: "Original",
      createdAt: 1_700_000_000_000,
    };
    a.send(commentCreate);
    expect(await awaitBroadcast(a, commentCreate.mutationId)).toEqual(commentCreate);
    expect(
      (
        await sendWithActivity(a, {
          type: "comment.update",
          mutationId: "activity-comment-update",
          id: "comment-1",
          body: "Edited",
          updatedAt: 1_700_000_000_001,
        })
      )[0]?.detail,
    ).toEqual({ type: "comment.edited" });
    expect(
      (
        await sendWithActivity(a, {
          type: "comment.delete",
          mutationId: "activity-comment-delete",
          id: "comment-1",
        })
      )[0]?.detail,
    ).toEqual({ type: "comment.deleted" });

    const detailTypes = (await snapshotOf(await connect(board))).activities.map(
      ({ detail }) => detail.type,
    );
    expect(detailTypes).not.toContain("comment.created");
    expect(detailTypes).toContain("comment.edited");
    expect(detailTypes).toContain("comment.deleted");
  });
});

describe("BoardDO activity edge cases", () => {
  it("deduplicates label activity and fans definition deletion out per card", async () => {
    const board = "board-activity-labels";
    const a = await connect(board, "actor-labels");
    await snapshotOf(a);
    await seedCard(a, "activity-labels");
    await awaitActivity(a, "activity-labels-card");
    await sendWithActivity(a, {
      type: "card.create",
      mutationId: "activity-label-card-2",
      id: "card-2",
      columnId: "col-1",
      title: "Second",
      position: "a1",
    });

    const createLabel: ClientMessage = {
      type: "label.create",
      mutationId: "activity-label-create",
      id: "label-1",
      name: "Bug",
      color: "red",
    };
    a.send(createLabel);
    await awaitBroadcast(a, createLabel.mutationId);

    expect(
      (
        await sendWithActivity(a, {
          type: "label.assign",
          mutationId: "activity-label-assign-1",
          id: "join-1",
          cardId: "card-1",
          labelId: "label-1",
        })
      )[0]?.detail,
    ).toEqual({ type: "label.added", label: "Bug" });

    a.send({
      type: "label.assign",
      mutationId: "activity-label-duplicate",
      id: "join-2",
      cardId: "card-1",
      labelId: "label-1",
    });
    await awaitBroadcast(a, "activity-label-duplicate");
    a.send({ type: "label.unassign", mutationId: "activity-label-unassign-one", id: "join-1" });
    await awaitBroadcast(a, "activity-label-unassign-one");
    expect(
      (
        await sendWithActivity(a, {
          type: "label.unassign",
          mutationId: "activity-label-unassign-last",
          id: "join-2",
        })
      )[0]?.detail,
    ).toEqual({ type: "label.removed", label: "Bug" });

    await sendWithActivity(a, {
      type: "label.assign",
      mutationId: "activity-label-reassign",
      id: "join-3",
      cardId: "card-1",
      labelId: "label-1",
    });
    a.send({
      type: "label.assign",
      mutationId: "activity-label-reassign-duplicate",
      id: "join-4",
      cardId: "card-1",
      labelId: "label-1",
    });
    await awaitBroadcast(a, "activity-label-reassign-duplicate");
    await sendWithActivity(a, {
      type: "label.assign",
      mutationId: "activity-label-assign-card-2",
      id: "join-5",
      cardId: "card-2",
      labelId: "label-1",
    });

    const removed = await sendWithActivity(a, {
      type: "label.delete",
      mutationId: "activity-label-delete",
      id: "label-1",
    });
    expect(removed.map(({ cardId, detail }) => ({ cardId, detail }))).toEqual([
      { cardId: "card-1", detail: { type: "label.removed", label: "Bug" } },
      { cardId: "card-2", detail: { type: "label.removed", label: "Bug" } },
    ]);

    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cardLabels).toEqual([]);
    const labelHistory = snapshot.activities.filter((activity) =>
      activity.detail.type.startsWith("label."),
    );
    expect(labelHistory).toHaveLength(6);
  });

  it("records both relation sides, every kind, and deleted-card placeholders", async () => {
    const board = "board-activity-relations";
    const a = await connect(board, "actor-relations");
    await snapshotOf(a);
    await seedCard(a, "activity-relations");
    await awaitActivity(a, "activity-relations-card");
    await sendWithActivity(a, {
      type: "card.create",
      mutationId: "activity-relation-card-2",
      id: "card-2",
      columnId: "col-1",
      title: "Other card",
      position: "a1",
    });

    for (const kind of ["relates", "blocks", "subtask"] as const) {
      const id = `relation-${kind}`;
      const added = await sendWithActivity(a, {
        type: "relation.create",
        mutationId: `activity-relation-add-${kind}`,
        id,
        sourceCardId: "card-1",
        targetCardId: "card-2",
        kind,
      });
      expect(added.map(({ cardId, detail }) => ({ cardId, detail }))).toEqual([
        {
          cardId: "card-1",
          detail: {
            type: "relation.added",
            relationKind: kind,
            side: "source",
            otherCardTitle: "Other card",
          },
        },
        {
          cardId: "card-2",
          detail: {
            type: "relation.added",
            relationKind: kind,
            side: "target",
            otherCardTitle: "Ship M7",
          },
        },
      ]);

      const removed = await sendWithActivity(a, {
        type: "relation.delete",
        mutationId: `activity-relation-remove-${kind}`,
        id,
      });
      expect(removed.map(({ cardId, detail }) => ({ cardId, detail }))).toEqual([
        {
          cardId: "card-1",
          detail: {
            type: "relation.removed",
            relationKind: kind,
            side: "source",
            otherCardTitle: "Other card",
          },
        },
        {
          cardId: "card-2",
          detail: {
            type: "relation.removed",
            relationKind: kind,
            side: "target",
            otherCardTitle: "Ship M7",
          },
        },
      ]);
    }

    // A relation to a card that is gone is refused, so it cannot be created; a board written
    // before that rule can still hold one, which the removal below reads as a placeholder.
    a.send({
      type: "relation.create",
      mutationId: "activity-relation-missing-add",
      id: "relation-missing",
      sourceCardId: "card-1",
      targetCardId: "deleted-card",
      kind: "blocks",
    });
    expect((await awaitError(a, "activity-relation-missing-add")).message).toBe("card is unavailable");
    await runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(board)), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO card_relations(id, source_card_id, target_card_id, kind) VALUES ('relation-missing', 'card-1', 'deleted-card', 'blocks')",
      );
    });
    expect(
      (
        await sendWithActivity(a, {
          type: "relation.delete",
          mutationId: "activity-relation-missing-remove",
          id: "relation-missing",
        })
      ).map(({ cardId, detail }) => ({ cardId, detail })),
    ).toEqual([
      {
        cardId: "card-1",
        detail: {
          type: "relation.removed",
          relationKind: "blocks",
          side: "source",
          otherCardTitle: "(deleted card)",
        },
      },
    ]);

    a.send({
      type: "relation.create",
      mutationId: "activity-relation-both-missing",
      id: "relation-orphan",
      sourceCardId: "missing-source",
      targetCardId: "missing-target",
      kind: "relates",
    });
    await awaitError(a, "activity-relation-both-missing");
    const relationHistory = (await snapshotOf(await connect(board))).activities.filter(
      (activity) => activity.detail.type.startsWith("relation."),
    );
    expect(relationHistory).toHaveLength(13);
  });

  it("suppresses same-value, missing-row, and board-definition history", async () => {
    const board = "board-activity-noops";
    const a = await connect(board, "actor-noops");
    await snapshotOf(a);
    await seedCard(a, "activity-noops");
    await awaitActivity(a, "activity-noops-card");
    const noHistory: ClientMessage[] = [
      {
        type: "card.update",
        mutationId: "noop-card-update",
        id: "card-1",
        title: "Ship M7",
        description: "",
      },
      {
        type: "card.move",
        mutationId: "noop-card-move",
        id: "card-1",
        columnId: "col-1",
        position: "a0",
      },
      {
        type: "card.assign",
        mutationId: "noop-card-assign",
        id: "card-1",
        assigneeId: null,
      },
      {
        type: "card.prioritize",
        mutationId: "noop-card-priority",
        id: "card-1",
        priority: "medium",
      },
      {
        type: "card.schedule",
        mutationId: "noop-card-date",
        id: "card-1",
        dueDate: null,
      },
      {
        type: "card.update",
        mutationId: "missing-card-update",
        id: "missing-card",
        title: "Missing",
      },
      {
        type: "card.move",
        mutationId: "missing-card-move",
        id: "missing-card",
        columnId: "missing-column",
        position: "a0",
      },
      {
        type: "checklist.update",
        mutationId: "missing-checklist-update",
        id: "missing-item",
        done: true,
      },
      {
        type: "checklist.delete",
        mutationId: "missing-checklist-delete",
        id: "other-missing-item",
      },
      {
        type: "attachment.delete",
        mutationId: "missing-attachment-delete",
        id: "missing-attachment",
      },
      {
        type: "comment.update",
        mutationId: "missing-comment-update",
        id: "missing-comment",
        body: "Missing",
        updatedAt: 1,
      },
      {
        type: "comment.delete",
        mutationId: "missing-comment-delete",
        id: "other-missing-comment",
      },
      {
        type: "column.create",
        mutationId: "definition-column-create",
        id: "definition-column",
        title: "Definition",
        position: "a9",
      },
      {
        type: "column.rename",
        mutationId: "definition-column-rename",
        id: "definition-column",
        title: "Renamed definition",
      },
      {
        type: "column.delete",
        mutationId: "definition-column-delete",
        id: "definition-column",
      },
      {
        type: "label.create",
        mutationId: "definition-label-create",
        id: "label-noop",
        name: "No history",
        color: "blue",
      },
      {
        type: "label.update",
        mutationId: "definition-label-update",
        id: "label-noop",
        name: "Still no history",
      },
      {
        type: "label.unassign",
        mutationId: "missing-label-unassign",
        id: "missing-join",
      },
      {
        type: "label.delete",
        mutationId: "definition-label-delete",
        id: "label-noop",
      },
      {
        type: "relation.delete",
        mutationId: "missing-relation-delete",
        id: "missing-relation",
      },
      {
        type: "card.delete",
        mutationId: "missing-card-delete",
        id: "other-missing-card",
      },
    ];
    for (const message of noHistory) {
      a.send(message);
      await awaitBroadcast(a, message.mutationId);
    }

    // A child row for a card that is gone is refused outright, never accepted as an orphan.
    const orphans: ClientMessage[] = [
      { type: "checklist.create", mutationId: "missing-checklist-card", id: "orphan-item", cardId: "missing-card", text: "Orphan", position: "a0" },
      { type: "label.assign", mutationId: "missing-label-card", id: "orphan-join", cardId: "missing-card", labelId: "label-noop" },
      { type: "relation.create", mutationId: "missing-relation-cards", id: "orphan-relation", sourceCardId: "missing-source", targetCardId: "missing-target", kind: "relates" },
    ];
    for (const message of orphans) {
      a.send(message);
      expect((await awaitError(a, message.mutationId)).message).toBe("card is unavailable");
    }

    a.send({
      type: "card.create",
      mutationId: "duplicate-card-create",
      id: "card-1",
      columnId: "col-1",
      title: "Duplicate",
      position: "a1",
    });
    await awaitError(a, "duplicate-card-create");

    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.activities.map(({ detail }) => detail)).toEqual([{ type: "card.created" }]);
    expect(snapshot.cards.find((card) => card.id === "card-1")?.title).toBe("Ship M7");
    expect([snapshot.checklistItems, snapshot.cardLabels, snapshot.relations]).toEqual([[], [], []]);
  });

  it("preserves activity when card or column deletion archives a card", async () => {
    const board = "board-activity-cascade";
    const a = await connect(board, "actor-cascade");
    await snapshotOf(a);
    for (const [id, position] of [
      ["col-1", "a0"],
      ["col-2", "a1"],
      ["col-3", "a2"],
    ] as const) {
      a.send({
        type: "column.create",
        mutationId: `activity-cascade-${id}`,
        id,
        title: id,
        position,
      });
      await awaitBroadcast(a, `activity-cascade-${id}`);
    }

    for (const [id, columnId, position] of [
      ["card-1", "col-1", "a0"],
      ["card-2", "col-2", "a0"],
      ["card-3", "col-3", "a0"],
    ] as const) {
      await sendWithActivity(a, {
        type: "card.create",
        mutationId: `activity-cascade-create-${id}`,
        id,
        columnId,
        title: id,
        position,
      });
      await sendWithActivity(a, {
        type: "card.prioritize",
        mutationId: `activity-cascade-priority-${id}`,
        id,
        priority: "high",
      });
    }

    a.send({ type: "card.delete", mutationId: "activity-cascade-card-delete", id: "card-1" });
    await awaitBroadcast(a, "activity-cascade-card-delete");
    let snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.map(({ id }) => id)).toEqual(["card-2", "card-3"]);
    expect(snapshot.archivedCards.map(({ id }) => id)).toEqual(["card-1"]);
    expect(snapshot.activities.map(({ cardId }) => cardId)).toEqual([
      "card-1",
      "card-1",
      "card-2",
      "card-2",
      "card-3",
      "card-3",
    ]);
    a.send({ type: "column.delete", mutationId: "activity-cascade-column-delete", id: "col-2" });
    await awaitBroadcast(a, "activity-cascade-column-delete");
    snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.map(({ id }) => id)).toEqual(["card-3"]);
    expect(snapshot.archivedCards.map(({ id }) => id).sort()).toEqual(["card-1", "card-2"]);
    expect(snapshot.activities.map(({ cardId }) => cardId)).toEqual([
      "card-1",
      "card-1",
      "card-2",
      "card-2",
      "card-3",
      "card-3",
    ]);
  });

  it("migrates v9 boards without synthesizing legacy activity", async () => {
    const board = "board-activity-v9";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const initial = await connect(board);
    await snapshotOf(initial);
    initial.close();

    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE activities");
      sql.exec("DROP INDEX IF EXISTS cards_archived_at");
      sql.exec("ALTER TABLE cards DROP COLUMN archived_at");
      sql.exec("ALTER TABLE cards DROP COLUMN archived_column_title");
      sql.exec("UPDATE meta SET value = 9 WHERE key = 'schema_version'");
      sql.exec("INSERT INTO columns(id, title, position) VALUES ('legacy-column', 'Legacy', 'a0')");
      sql.exec(
        `INSERT INTO cards(
           id, column_id, title, description, position, assignee_id,
           priority, due_date, created_at, updated_at
         ) VALUES ('legacy-card', 'legacy-column', 'Legacy card', '', 'a0', NULL,
                   'medium', NULL, 1, 1)`,
      );
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();

    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.map(({ id }) => id)).toEqual(["legacy-card"]);
    expect(snapshot.archivedCards).toEqual([]);
    expect(snapshot.activities).toEqual([]);
    const version = await runInDurableObject(
      env.BOARD_DO.get(env.BOARD_DO.idFromName(board)),
      (_instance, state) =>
      state.storage.sql
        .exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'")
          .toArray()[0]?.value,
    );
    expect(version).toBe(29);
  });
});

describe("BoardDO card details", () => {
  it("round-trips checklist items and reports `done` as a boolean", async () => {
    const a = await connect("board-checklist");
    await snapshotOf(a);
    await seedCard(a, "cl");

    a.send({
      type: "checklist.create",
      mutationId: "cl-1",
      id: "item-1",
      cardId: "card-1",
      text: "one",
      position: "a0",
    });
    a.send({
      type: "checklist.create",
      mutationId: "cl-2",
      id: "item-2",
      cardId: "card-1",
      text: "two",
      position: "a1",
    });
    a.send({ type: "checklist.update", mutationId: "cl-3", id: "item-1", done: true });
    await awaitBroadcast(a, "cl-3");

    const snapshot = await snapshotOf(await connect("board-checklist"));
    // `done` is an INTEGER in SQLite; the wire type must be a real boolean.
    expect(snapshot.checklistItems).toEqual([
      { id: "item-1", cardId: "card-1", text: "one", done: true, position: "a0" },
      { id: "item-2", cardId: "card-1", text: "two", done: false, position: "a1" },
    ]);
  });

  it("applies a text-only checklist.update without clearing `done`", async () => {
    const a = await connect("board-checklist-text");
    await snapshotOf(a);
    await seedCard(a, "ct");

    a.send({
      type: "checklist.create",
      mutationId: "ct-1",
      id: "item-1",
      cardId: "card-1",
      text: "typo",
      position: "a0",
    });
    a.send({ type: "checklist.update", mutationId: "ct-2", id: "item-1", done: true });
    a.send({ type: "checklist.update", mutationId: "ct-3", id: "item-1", text: "fixed" });
    await awaitBroadcast(a, "ct-3");

    const snapshot = await snapshotOf(await connect("board-checklist-text"));
    expect(snapshot.checklistItems[0]).toMatchObject({ text: "fixed", done: true });
  });

  it("carries the assignee in the snapshot and clears it on null", async () => {
    const a = await connect("board-assign");
    await seedIdentity("board-assign", "user-7");
    await snapshotOf(a);
    await seedCard(a, "as");

    const fresh = await snapshotOf(await connect("board-assign"));
    expect(fresh.cards[0]).toMatchObject({ assigneeId: null });

    a.send({ type: "card.assign", mutationId: "as-1", id: "card-1", assigneeId: "user-7" });
    await awaitBroadcast(a, "as-1");
    const assigned = await snapshotOf(await connect("board-assign"));
    expect(assigned.cards[0]).toMatchObject({ assigneeId: "user-7" });

    a.send({ type: "card.assign", mutationId: "as-2", id: "card-1", assigneeId: null });
    await awaitBroadcast(a, "as-2");
    const cleared = await snapshotOf(await connect("board-assign"));
    expect(cleared.cards[0]).toMatchObject({ assigneeId: null });
  });

  it("refuses a socket assignment to someone who is not a board member, as MCP does", async () => {
    const board = "board-assign-eligibility";
    const a = await connect(board);
    await seedIdentity(board, "assignee-member");
    await snapshotOf(a);
    await seedCard(a, "ae");

    const notMember = "Assignee is not a board member.";
    a.send({ type: "card.assign", mutationId: "ae-out", id: "card-1", assigneeId: "assignee-outsider" });
    expect(await awaitError(a, "ae-out")).toEqual({ type: "error", mutationId: "ae-out", message: notMember });
    a.send({
      type: "card.create", mutationId: "ae-out-create", id: "card-2", columnId: "col-1", title: "Nope", position: "a1",
      assigneeId: "assignee-outsider",
    });
    expect(await awaitError(a, "ae-out-create")).toEqual({ type: "error", mutationId: "ae-out-create", message: notMember });

    // A member is accepted, and the message sent right after the assignment is not overtaken by it.
    a.send({ type: "card.assign", mutationId: "ae-in", id: "card-1", assigneeId: "assignee-member" });
    a.send({ type: "card.prioritize", mutationId: "ae-next", id: "card-1", priority: "high" });
    await awaitBroadcast(a, "ae-in");
    await awaitBroadcast(a, "ae-next");
    // Unassigning needs no eligibility.
    a.send({ type: "card.assign", mutationId: "ae-clear", id: "card-1", assigneeId: null });
    await awaitBroadcast(a, "ae-clear");

    // Eligibility is read when the message arrives, so a grant removed since is seen.
    await env.DB.prepare("DELETE FROM board_members WHERE board_id=? AND user_id=?").bind(board, "assignee-member").run();
    a.send({ type: "card.assign", mutationId: "ae-revoked", id: "card-1", assigneeId: "assignee-member" });
    expect((await awaitError(a, "ae-revoked")).message).toBe(notMember);

    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.map((card) => [card.id, card.assigneeId, card.priority])).toEqual([["card-1", null, "high"]]);
  });

  it("refuses a socket assignment on an archived card by the card's own state, before the assignee is read", async () => {
    const board = "board-assign-archived-first";
    const a = await connect(board);
    await seedIdentity(board, "assignee-member");
    await snapshotOf(a);
    await seedCard(a, "aa");
    a.send({ type: "column.delete", mutationId: "aa-archive", id: "col-1" });
    await awaitBroadcast(a, "aa-archive");

    // Were the assignee read first, an outsider would be refused as "not a board member".
    a.send({ type: "card.assign", mutationId: "aa-out", id: "card-1", assigneeId: "assignee-outsider" });
    expect(await awaitError(a, "aa-out")).toEqual({ type: "error", mutationId: "aa-out", message: "archived cards are read-only" });
  });

  it("refuses child rows for a card that is gone, and keeps no orphan", async () => {
    const board = "board-orphan-children";
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "oc");
    a.send({ type: "card.create", mutationId: "oc-card-2", id: "card-2", columnId: "col-1", title: "Stays", position: "a1" });
    a.send({ type: "label.create", mutationId: "oc-label", id: "label-1", name: "Bug", color: "red" });
    await awaitBroadcast(a, "oc-label");
    // Archived and then purged, the row is gone: nothing the archived/locked gate can see.
    a.send({ type: "card.delete", mutationId: "oc-del", id: "card-1" });
    await awaitBroadcast(a, "oc-del");
    a.send({ type: "card.purge", mutationId: "oc-purge", id: "card-1" });
    await awaitBroadcast(a, "oc-purge");

    const lateWrites: ClientMessage[] = [
      { type: "checklist.create", mutationId: "oc-item", id: "item-1", cardId: "card-1", text: "Late", position: "a0" },
      { type: "comment.create", mutationId: "oc-note", id: "note-1", cardId: "card-1", authorId: "u1", parentCommentId: null, body: "Late", createdAt: 1 },
      { type: "label.assign", mutationId: "oc-join", id: "join-1", cardId: "card-1", labelId: "label-1" },
      { type: "relation.create", mutationId: "oc-rel-source", id: "rel-1", sourceCardId: "card-1", targetCardId: "card-2", kind: "blocks" },
      { type: "relation.create", mutationId: "oc-rel-target", id: "rel-2", sourceCardId: "card-2", targetCardId: "card-1", kind: "blocks" },
    ];
    for (const message of lateWrites) {
      a.send(message);
      expect((await awaitError(a, message.mutationId)).message).toBe("card is unavailable");
    }
    const snapshot = await snapshotOf(await connect(board));
    expect([snapshot.checklistItems, snapshot.comments, snapshot.cardLabels, snapshot.relations]).toEqual([[], [], [], []]);
  });

  it("records the board id and backfills legacy attachment keys once", async () => {
    const board = "board-stamp-once";
    await snapshotOf(await connect(board));
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const read = <T extends string | number | null>(query: string, ...bindings: string[]) =>
      runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ value: T }>(query, ...bindings).toArray()[0]?.value);
    const objectKey = () => read<string | null>("SELECT object_key AS value FROM attachments WHERE id = 'legacy-1'");
    expect(await read("SELECT value FROM meta WHERE key = 'board_id'")).toBe(board);
    expect(await read("SELECT value FROM meta WHERE key = 'attachment_keys_backfilled'")).toBe(1);

    // The backfill is finished: a keyless row that turns up later is left as it is.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO attachments(id, card_id, file_name, content_type, size) VALUES ('legacy-1', 'card-1', 'a.png', 'image/png', 1)");
    });
    await snapshotOf(await connect(board));
    expect(await objectKey()).toBeNull();

    // A board that only has its id on record (an alarm can write that alone) is still backfilled.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'attachment_keys_backfilled'");
    });
    await snapshotOf(await connect(board));
    expect(await objectKey()).toBe(`${board}/legacy-1`);
    expect(await read("SELECT value FROM meta WHERE key = 'attachment_keys_backfilled'")).toBe(1);
  });

  it("serves one card's activity in sequence order through its own route, and none for another card", async () => {
    const board = "board-card-activity-route";
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "ca");
    await sendWithActivity(a, { type: "card.prioritize", mutationId: "ca-priority", id: "card-1", priority: "high" });
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const read = async (cardId: string) => {
      const response = await stub.fetch(`https://board.internal${routePath("cardActivity", { cardId })}`, {
        headers: { [INTERNAL_BOARD_ID_HEADER]: board },
      });
      expect(response.status).toBe(200);
      return (await response.json<{ activities: Activity[] }>()).activities;
    };
    const history = await read("card-1");
    expect(history.map(({ detail }) => detail.type)).toEqual(["card.created", "priority.changed"]);
    expect(history.map(({ sequence }) => sequence)).toEqual([...history.map(({ sequence }) => sequence)].sort((x, y) => x - y));
    expect(await read("card-elsewhere")).toEqual([]);
  });

  it("schedules an alarm for an MCP receipt's expiry, and the alarm prunes it and does not loop", async () => {
    const board = "board-receipt-alarm";
    await snapshotOf(await connect(board));
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    const before = Date.now();
    expect((await mcpCommand(board, { operation: "create_label", name: "bug", color: "red" })).ok).toBe(true);
    const day = 24 * 60 * 60 * 1000;
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(before + 30 * day);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 30 * day);

    // Age the receipt past retention and run the alarm: it prunes the receipt and leaves nothing scheduled.
    const after = await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec("UPDATE mcp_operation_receipts SET created_at = ?", Date.now() - 31 * day);
      await state.storage.deleteAlarm(); // a firing alarm clears itself
      await instance.alarm();
      return {
        receipts: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM mcp_operation_receipts").toArray()[0]!.count,
        alarm: await state.storage.getAlarm(),
      };
    });
    expect(after).toEqual({ receipts: 0, alarm: null });
  });

  it("prunes MCP receipts older than thirty days when the alarm runs, and re-arms it for the oldest one left", async () => {
    const board = "board-receipt-prune";
    await snapshotOf(await connect(board));
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const day = 24 * 60 * 60 * 1000;
    const recentAt = Date.now() - 29 * day;
    const { kept, alarm } = await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      for (const [key, createdAt] of [["old", Date.now() - 31 * day], ["recent", recentAt]] as const) {
        sql.exec(
          `INSERT INTO mcp_operation_receipts(credential_id, operation_key, actor_id, operation, input_hash, result_json, created_at)
           VALUES ('cred', ?, 'u', 'create_task', 'h', '{}', ?)`,
          key,
          createdAt,
        );
      }
      await state.storage.deleteAlarm();
      await instance.alarm();
      return {
        kept: sql.exec<{ key: string }>("SELECT operation_key AS key FROM mcp_operation_receipts").toArray().map((row) => row.key),
        alarm: await state.storage.getAlarm(),
      };
    });
    expect(kept).toEqual(["recent"]);
    expect(alarm).toBe(recentAt + 30 * day);
  });

  it("defaults the priority to medium and carries a card.prioritize in the snapshot", async () => {
    const a = await connect("board-priority");
    await snapshotOf(a);
    await seedCard(a, "pr");

    // The column is `NOT NULL DEFAULT 'medium'`, so `card.create` never names it.
    const fresh = await snapshotOf(await connect("board-priority"));
    expect(fresh.cards[0]).toMatchObject({ priority: "medium" });

    a.send({ type: "card.prioritize", mutationId: "pr-1", id: "card-1", priority: "highest" });
    expect(await awaitBroadcast(a, "pr-1")).toMatchObject({
      type: "card.prioritize",
      id: "card-1",
      priority: "highest",
    });

    const raised = await snapshotOf(await connect("board-priority"));
    expect(raised.cards[0]).toMatchObject({ priority: "highest" });
  });

  it("defaults the task type to task and broadcasts card.retype and taskType.changed activity", async () => {
    const a = await connect("board-task-type");
    const b = await connect("board-task-type");
    await snapshotOf(a);
    await snapshotOf(b);
    await seedCard(a, "tt");

    // The column is NOT NULL DEFAULT 'task', so card.create defaults to 'task'.
    const fresh = await snapshotOf(await connect("board-task-type"));
    expect(fresh.cards[0]).toMatchObject({ taskType: "task" });

    a.send({ type: "card.retype", mutationId: "tt-1", id: "card-1", taskType: "bug" });

    // Broadcasts verbatim card.retype to both sockets
    const aMsg = await awaitBroadcast(a, "tt-1");
    expect(aMsg).toMatchObject({
      type: "card.retype",
      id: "card-1",
      taskType: "bug",
    });
    const bMsg = await awaitBroadcast(b, "tt-1");
    expect(bMsg).toMatchObject({
      type: "card.retype",
      id: "card-1",
      taskType: "bug",
    });

    // Followed by activity.recorded containing exact taskType.changed detail
    const aAct = await a.next();
    expect(aAct.message).toMatchObject({
      type: "activity.recorded",
      mutationId: "tt-1",
      activities: [
        {
          cardId: "card-1",
          detail: {
            type: "taskType.changed",
            before: "task",
            after: "bug",
          },
        },
      ],
    });

    // Snapshot reflects bug type
    const raised = await snapshotOf(await connect("board-task-type"));
    expect(raised.cards[0]).toMatchObject({ taskType: "bug" });

    // Same-value retype is a no-op that does not record activity
    a.send({ type: "card.retype", mutationId: "tt-noop", id: "card-1", taskType: "bug" });
    await awaitBroadcast(a, "tt-noop");
    // Next broadcast on a new mutation proves no activity frame was emitted for tt-noop
    a.send({ type: "card.prioritize", mutationId: "tt-after-noop", id: "card-1", priority: "high" });
    await awaitBroadcast(a, "tt-after-noop");
    const actAfter = await a.next();
    expect(actAfter.message).toMatchObject({
      type: "activity.recorded",
      mutationId: "tt-after-noop",
      activities: [{ detail: { type: "priority.changed" } }],
    });
  });

  it("backfills pre-v15 cards to task on migration and preserves type across restart, archive, restore, and transfer", async () => {
    const board = "board-v15-migration-and-lifecycle";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const initial = await connect(board);
    await snapshotOf(initial);
    initial.close();

    // Roll schema_version back to 14, drop task_type column
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("ALTER TABLE cards DROP COLUMN task_type");
      sql.exec("UPDATE meta SET value = 14 WHERE key = 'schema_version'");
      sql.exec("INSERT INTO columns(id, title, position) VALUES ('col-prev', 'Prev', 'a0')");
      sql.exec(
        `INSERT INTO cards(
           id, column_id, title, description, position, assignee_id,
           priority, due_date, created_at, updated_at, task_number
         ) VALUES ('card-legacy-1', 'col-prev', 'Legacy 1', '', 'a0', NULL, 'high', NULL, 100, 100, 1)`,
      );
    });
    console.log("STEP 2: v14 rolled back");

    // Restart the DO to trigger v15 migration
    await expect(
      runInDurableObject(stub, (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();
    console.log("STEP 3: DO restarted 1");

    const client = await connect(board);
    const snapshot = await snapshotOf(client);
    console.log("STEP 4: snapshot received");
    // Pre-v15 card defaulted to 'task'
    const legacyCard = snapshot.cards.find((c) => c.id === "card-legacy-1");
    expect(legacyCard?.taskType).toBe("task");

    // Retype to spike
    client.send({ type: "card.retype", mutationId: "mig-spike", id: "card-legacy-1", taskType: "spike" });
    await awaitBroadcast(client, "mig-spike");
    client.close();
    console.log("STEP 5: retype broadcasted");

    // Restart DO and verify persistence of non-default type
    await expect(
      runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(board)), (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();
    console.log("STEP 6: DO restarted 2");

    const client2 = await connect(board);
    const snapshot2 = await snapshotOf(client2);
    expect(snapshot2.cards.find((c) => c.id === "card-legacy-1")?.taskType).toBe("spike");
    console.log("STEP 7: snapshot 2 verified");

    // Archive card and verify archivedCards snapshot preserves non-default type
    client2.send({ type: "card.delete", mutationId: "mig-del", id: "card-legacy-1" });
    await awaitBroadcast(client2, "mig-del");
    const archivedFrame = await client2.next();
    expect(archivedFrame.message.type).toBe("cards.archived");
    console.log("STEP 8: card deleted");

    const snapshot3 = await snapshotOf(await connect(board));
    expect(snapshot3.cards).toHaveLength(0);
    expect(snapshot3.archivedCards.find((c) => c.id === "card-legacy-1")?.taskType).toBe("spike");
    console.log("STEP 9: card archived verified");

    // Restore card and verify active card keeps non-default type
    client2.send({ type: "card.restore", mutationId: "mig-rest", id: "card-legacy-1", columnId: "col-prev", position: "a1" });
    await awaitBroadcast(client2, "mig-rest");

    const snapshot4 = await snapshotOf(await connect(board));
    expect(snapshot4.cards.find((c) => c.id === "card-legacy-1")?.taskType).toBe("spike");
    client2.close();
    console.log("STEP 10: done");
  });

  it("carries the due date in the snapshot and clears it on null", async () => {
    const a = await connect("board-due");
    await snapshotOf(a);
    await seedCard(a, "du");

    // The column is nullable and `card.create` never names it: no deadline by default.
    const fresh = await snapshotOf(await connect("board-due"));
    expect(fresh.cards[0]).toMatchObject({ dueDate: null });

    a.send({ type: "card.schedule", mutationId: "du-1", id: "card-1", dueDate: "2099-12-31" });
    expect(await awaitBroadcast(a, "du-1")).toMatchObject({
      type: "card.schedule",
      id: "card-1",
      dueDate: "2099-12-31",
    });

    const scheduled = await snapshotOf(await connect("board-due"));
    expect(scheduled.cards[0]).toMatchObject({ dueDate: "2099-12-31" });

    a.send({ type: "card.schedule", mutationId: "du-2", id: "card-1", dueDate: null });
    await awaitBroadcast(a, "du-2");
    const cleared = await snapshotOf(await connect("board-due"));
    expect(cleared.cards[0]).toMatchObject({ dueDate: null });
  });

  it("preserves a card's checklist items when the card is archived", async () => {
    const a = await connect("board-card-cascade");
    await snapshotOf(a);
    await seedCard(a, "cc");

    a.send({
      type: "card.create",
      mutationId: "cc-other",
      id: "card-2",
      columnId: "col-1",
      title: "Survivor",
      position: "a1",
    });
    a.send({
      type: "checklist.create",
      mutationId: "cc-1",
      id: "item-1",
      cardId: "card-1",
      text: "doomed",
      position: "a0",
    });
    a.send({
      type: "checklist.create",
      mutationId: "cc-2",
      id: "item-2",
      cardId: "card-2",
      text: "kept",
      position: "a0",
    });
    a.send({ type: "card.delete", mutationId: "cc-3", id: "card-1" });
    await awaitBroadcast(a, "cc-3");

    const snapshot = await snapshotOf(await connect("board-card-cascade"));
    expect(snapshot.cards.map((card) => card.id)).toEqual(["card-2"]);
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-1"]);
    expect(snapshot.checklistItems.map((item) => item.id)).toEqual(["item-1", "item-2"]);
  });

  it("preserves checklist items of archived cards when their column is deleted", async () => {
    const a = await connect("board-column-cascade");
    await snapshotOf(a);
    await seedCard(a, "kc");

    a.send({ type: "column.create", mutationId: "kc-col2", id: "col-2", title: "Done", position: "a1" });
    a.send({
      type: "card.create",
      mutationId: "kc-card2",
      id: "card-2",
      columnId: "col-2",
      title: "Elsewhere",
      position: "a0",
    });
    a.send({
      type: "checklist.create",
      mutationId: "kc-1",
      id: "item-1",
      cardId: "card-1",
      text: "preserved",
      position: "a0",
    });
    a.send({
      type: "checklist.create",
      mutationId: "kc-2",
      id: "item-2",
      cardId: "card-2",
      text: "kept",
      position: "a0",
    });
    a.send({ type: "column.delete", mutationId: "kc-3", id: "col-1" });
    await awaitBroadcast(a, "kc-3");

    const snapshot = await snapshotOf(await connect("board-column-cascade"));
    expect(snapshot.cards.map((card) => card.id)).toEqual(["card-2"]);
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-1"]);
    expect(snapshot.checklistItems.map((item) => item.id)).toEqual(["item-1", "item-2"]);
  });

  it("round-trips attachment policy boundaries and rejects invalid metadata sender-only", async () => {
    const a = await connect("board-attach");
    const b = await connect("board-attach");
    await snapshotOf(a);
    await snapshotOf(b);
    await seedCard(a, "at");
    await awaitBroadcast(b, "at-card");

    const imgAttId = crypto.randomUUID();
    const fileAttId = crypto.randomUUID();
    await stageAttachment("board-attach", imgAttId);
    await stageAttachment("board-attach", fileAttId);

    const imageCreate = {
      type: "attachment.create",
      mutationId: "at-image",
      id: imgAttId,
      cardId: "card-1",
      fileName: "photo.png",
      contentType: "image/png",
      size: 10_485_760,
    } as const;
    a.send(imageCreate);
    expect(await awaitBroadcast(a, imageCreate.mutationId)).toEqual(imageCreate);
    expect(await awaitBroadcast(b, imageCreate.mutationId)).toEqual(imageCreate);

    const fileCreate = {
      type: "attachment.create",
      mutationId: "at-file",
      id: fileAttId,
      cardId: "card-1",
      fileName: "scene final.blend",
      contentType: "application/x-blender",
      size: 52_428_800,
    } as const;
    a.send(fileCreate);
    expect(await awaitBroadcast(a, fileCreate.mutationId)).toEqual(fileCreate);
    expect(await awaitBroadcast(b, fileCreate.mutationId)).toEqual(fileCreate);

    a.send({ ...imageCreate, mutationId: "at-image-over", id: "att-image-over", size: 10_485_761 });
    const imageError = await awaitError(a, "at-image-over");
    expect(imageError.message).toContain("attachment exceeds declared-type size limit");

    a.send({ ...fileCreate, mutationId: "at-file-over", id: "att-file-over", size: 52_428_801 });
    const fileError = await awaitError(a, "at-file-over");
    expect(fileError.message).toContain("attachment exceeds declared-type size limit");

    a.send({
      ...imageCreate,
      mutationId: "at-noncanonical",
      id: "att-noncanonical",
      contentType: "IMAGE/PNG",
      size: 1,
    });
    const canonicalError = await awaitError(a, "at-noncanonical");
    expect(canonicalError.message).toContain("attachment content type is not canonical");

    // B's next frame is the accepted marker, proving none of the three errors
    // left the sender.
    a.send({
      type: "card.update",
      mutationId: "at-marker",
      id: "card-1",
      title: "Attachments accepted",
    });
    expect(await awaitBroadcast(b, "at-marker")).toMatchObject({
      type: "card.update",
      mutationId: "at-marker",
    });

    const snapshot = await snapshotOf(await connect("board-attach"));
    expect(snapshot.attachments).toEqual([
      {
        id: imgAttId,
        cardId: "card-1",
        fileName: "photo.png",
        contentType: "image/png",
        size: 10_485_760,
      },
      {
        id: fileAttId,
        cardId: "card-1",
        fileName: "scene final.blend",
        contentType: "application/x-blender",
        size: 52_428_800,
      },
    ]);
  });

  it("ordinary attachment create rejects claimed staging lease before metadata insert", async () => {
    const board = "board-attach-create-claimed";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "acc");
    const attId = crypto.randomUUID();
    const objectKey = attachmentObjectKey(board, attId);
    const now = Date.now();
    const claimToken = "claim-active-token";

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at)
         VALUES (?, ?, 'staged', ?, ?, ?)`,
        objectKey,
        attId,
        now + 60_000,
        claimToken,
        now,
      );
    });

    a.send({
      type: "attachment.create",
      mutationId: "att-c-claimed",
      id: attId,
      cardId: "card-1",
      fileName: "photo.png",
      contentType: "image/png",
      size: 100,
    });

    const error = await awaitError(a, "att-c-claimed");
    expect(error.message).toBe("attachment staging lease is expired, claimed, or missing");

    // Verify transaction rollback: attachments table has NO metadata row
    const counts = await runInDurableObject(stub, (_instance, state) => ({
      attachments: state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM attachments WHERE id = ?", attId)
        .toArray()[0]?.count ?? 0,
      cleanup: state.storage.sql
        .exec<{ claimToken: string | null; deleteAfter: number }>(
          "SELECT claim_token AS claimToken, delete_after AS deleteAfter FROM attachment_cleanup WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0],
    }));

    expect(counts.attachments).toBe(0);
    expect(counts.cleanup?.claimToken).toBe(claimToken);
  });

  it("ordinary attachment create rejects expired staging lease before metadata insert", async () => {
    const board = "board-attach-create-expired";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "ace");
    const attId = crypto.randomUUID();
    const objectKey = attachmentObjectKey(board, attId);
    const now = Date.now();

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at)
         VALUES (?, ?, 'staged', ?, NULL, NULL)`,
        objectKey,
        attId,
        now - 1000,
      );
    });

    a.send({
      type: "attachment.create",
      mutationId: "att-c-expired",
      id: attId,
      cardId: "card-1",
      fileName: "photo.png",
      contentType: "image/png",
      size: 100,
    });

    const error = await awaitError(a, "att-c-expired");
    expect(error.message).toBe("attachment staging lease is expired, claimed, or missing");

    // Verify transaction rollback: attachments table has NO metadata row
    const counts = await runInDurableObject(stub, (_instance, state) => ({
      attachments: state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM attachments WHERE id = ?", attId)
        .toArray()[0]?.count ?? 0,
      cleanup: state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM attachment_cleanup WHERE object_key = ?", objectKey)
        .toArray()[0]?.count ?? 0,
    }));

    expect(counts.attachments).toBe(0);
    expect(counts.cleanup).toBe(1);
  });

  it("ordinary attachment create rejects missing staging lease before metadata insert", async () => {
    const board = "board-attach-create-missing";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "acm");
    const attId = crypto.randomUUID();

    a.send({
      type: "attachment.create",
      mutationId: "att-c-missing",
      id: attId,
      cardId: "card-1",
      fileName: "photo.png",
      contentType: "image/png",
      size: 100,
    });

    const error = await awaitError(a, "att-c-missing");
    expect(error.message).toBe("attachment staging lease is expired, claimed, or missing");

    const count = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM attachments WHERE id = ?", attId)
        .toArray()[0]?.count ?? 0,
    );
    expect(count).toBe(0);
  });

  it("claims a staged object and deletes it on attachment.delete", async () => {
    const board = "board-attach-delete";
    const attachmentId = crypto.randomUUID();
    const objectKey = await stageAttachment(board, attachmentId);
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "ad");

    a.send({
      type: "attachment.create",
      mutationId: "ad-1",
      id: attachmentId,
      cardId: "card-1",
      fileName: "gone.png",
      contentType: "image/png",
      size: 3,
    });
    await awaitBroadcast(a, "ad-1");
    const claimed = await runInDurableObject(
      env.BOARD_DO.get(env.BOARD_DO.idFromName(board)),
      (_instance, state) => ({
        objectKey: state.storage.sql
          .exec<{ objectKey: string | null }>(
            "SELECT object_key AS objectKey FROM attachments WHERE id = ?",
            attachmentId,
          )
          .toArray()[0]?.objectKey,
        cleanupCount: state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM attachment_cleanup")
          .toArray()[0]?.count,
      }),
    );
    expect(claimed).toEqual({ objectKey, cleanupCount: 0 });
    const keptId = crypto.randomUUID();
    const keptKey = await stageAttachment(board, keptId);
    a.send({
      type: "attachment.create", mutationId: "ad-keep", id: keptId,
      cardId: "card-1", fileName: "keep.png", contentType: "image/png", size: 3,
    });
    await awaitBroadcast(a, "ad-keep");
    const url = `/boards/${board}/attachments/${attachmentId}`;
    const keptEmbed = `![keep](/boards/${board}/attachments/${keptId})`;
    a.send({
      type: "card.update", mutationId: "ad-description", id: "card-1",
      description: `Before **keep**\n\n![remove](${url})\n\n[download](${url})\n\n${keptEmbed}\n\nAfter`,
    });
    await awaitBroadcast(a, "ad-description");
    const b = await connect(board, "peer-user");
    const before = await snapshotOf(b);

    const raw = JSON.stringify({ type: "attachment.delete", mutationId: "ad-2", id: attachmentId }, null, 2);
    a.sendRaw(raw);
    await awaitBroadcast(a, "ad-2");
    expect((await b.next()).raw).toBe(raw);
    const activities = await awaitActivity(a, "ad-2");
    expect(activities).toHaveLength(1);
    expect(activities[0]?.detail).toEqual({ type: "attachment.deleted", fileName: "gone.png" });

    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.attachments.map(({ id }) => id)).toEqual([keptId]);
    expect(snapshot.cards[0]?.description).toBe(`Before **keep**\n\n\n\ndownload\n\n${keptEmbed}\n\nAfter`);
    expect(snapshot.cards[0]?.updatedAt).toBe(activities[0]?.createdAt);
    expect(snapshot.activities).toEqual([...before.activities, ...activities]);
    await expectObjectDeleted(objectKey);
    expect(await env.ATTACHMENTS.head(keptKey)).not.toBeNull();
  });

  it("preserves timestamps without references and treats missing attachment ids as no-ops", async () => {
    const board = "board-attach-no-reference";
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "an");
    const description = `Keep ![missing](/boards/${board}/attachments/missing-id)`;
    a.send({ type: "card.update", mutationId: "an-description", id: "card-1", description });
    const unrefAttId = crypto.randomUUID();
    await stageAttachment(board, unrefAttId);
    a.send({
      type: "attachment.create", mutationId: "an-create", id: unrefAttId,
      cardId: "card-1", fileName: "plain.txt", contentType: "text/plain", size: 3,
    });
    await awaitBroadcast(a, "an-create");
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    // A distinct timestamp makes accidental writes observable even within one clock tick.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE cards SET updated_at = 123 WHERE id = 'card-1'");
    });
    const before = await snapshotOf(await connect(board));
    a.send({ type: "attachment.delete", mutationId: "an-delete", id: unrefAttId });
    await awaitBroadcast(a, "an-delete");
    const deleted = await snapshotOf(await connect(board));
    expect(deleted.cards).toEqual(before.cards);
    expect(deleted.attachments).toEqual([]);
    a.send({ type: "attachment.delete", mutationId: "an-missing", id: "missing-id" });
    await awaitBroadcast(a, "an-missing");
    expect(await snapshotOf(await connect(board))).toEqual(deleted);
  });

  it("rolls back description, metadata, cleanup queue and activity when attachment deletion aborts", async () => {
    const board = "board-attach-delete-rollback";
    const attachmentId = crypto.randomUUID();
    const objectKey = await stageAttachment(board, attachmentId);
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "ab");
    a.send({
      type: "attachment.create", mutationId: "ab-create", id: attachmentId,
      cardId: "card-1", fileName: "keep.png", contentType: "image/png", size: 3,
    });
    a.send({
      type: "card.update", mutationId: "ab-description", id: "card-1",
      description: `Before ![keep](/boards/${board}/attachments/${attachmentId}) After`,
    });
    await awaitBroadcast(a, "ab-description");
    const before = await snapshotOf(await connect(board));
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const beforeCleanup = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM attachment_cleanup ORDER BY object_key").toArray(),
    );
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER test_abort_attachment_delete
        AFTER DELETE ON attachments
        WHEN OLD.card_id = 'card-1'
        BEGIN
          SELECT RAISE(ABORT, 'test attachment delete aborted');
        END
      `);
    });
    try {
      a.send({ type: "attachment.delete", mutationId: "ab-delete", id: attachmentId });
      expect((await awaitError(a, "ab-delete")).message).toContain("test attachment delete aborted");
      expect(await snapshotOf(await connect(board))).toEqual(before);
      const after = await runInDurableObject(stub, (_instance, state) => ({
        cleanup: state.storage.sql.exec("SELECT * FROM attachment_cleanup ORDER BY object_key").toArray(),
        objectKey: state.storage.sql
          .exec<{ objectKey: string }>("SELECT object_key AS objectKey FROM attachments WHERE id = ?", attachmentId)
          .toArray()[0]?.objectKey,
      }));
      expect(after).toEqual({ cleanup: beforeCleanup, objectKey });
      expect(await env.ATTACHMENTS.head(objectKey)).not.toBeNull();
    } finally {
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER IF EXISTS test_abort_attachment_delete");
      });
    }
    a.send({ type: "attachment.delete", mutationId: "ab-retry", id: attachmentId });
    await awaitBroadcast(a, "ab-retry");
    expect((await snapshotOf(await connect(board))).cards[0]?.description).toBe("Before  After");
    await expectObjectDeleted(objectKey);
  });

  it("requires legacy sockets to reconnect before deleting an active owner's attachment", async () => {
    const board = "board-attach-legacy-socket";
    const attachmentId = crypto.randomUUID();
    const objectKey = await stageAttachment(board, attachmentId);
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "al");
    a.send({
      type: "attachment.create", mutationId: "al-create", id: attachmentId,
      cardId: "card-1", fileName: "gone.png", contentType: "image/png", size: 3,
    });
    a.send({
      type: "card.update", mutationId: "al-description", id: "card-1",
      description: `Before ![remove](/boards/${board}/attachments/${attachmentId}) After`,
    });
    await awaitBroadcast(a, "al-description");
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets()[0];
      if (!socket) throw new Error("expected one accepted WebSocket");
      socket.serializeAttachment({ userId: "test-user" });
    });
    const before = await snapshotOf(await connect(board));
    const alarmBefore = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    a.send({ type: "attachment.delete", mutationId: "al-delete", id: attachmentId });
    expect(await awaitError(a, "al-delete")).toEqual({
      type: "error", mutationId: "al-delete", message: "Reconnect to delete attachments.",
    });
    expect((await a.closed).code).toBe(1012);
    const reconnected = await connect(board);
    expect(await snapshotOf(reconnected)).toEqual(before);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(alarmBefore);
    expect(await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM attachment_cleanup").toArray(),
    )).toEqual([]);
    expect(await env.ATTACHMENTS.head(objectKey)).not.toBeNull();
    reconnected.send({ type: "attachment.delete", mutationId: "al-retry", id: attachmentId });
    await awaitBroadcast(reconnected, "al-retry");
    const after = await snapshotOf(await connect(board));
    expect(after.cards[0]?.description).toBe("Before  After");
    expect(after.attachments).toEqual([]);
    expect(after.activities.filter(({ detail }) => detail.type === "attachment.deleted")).toHaveLength(1);
    await expectObjectDeleted(objectKey);
  });

  it("preserves individually archived attachments and purges them at retention expiry", async () => {
    const board = "board-attach-card-archive";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const archivedAttachmentId = crypto.randomUUID();
    const activeAttachmentId = crypto.randomUUID();
    const archivedKey = await stageAttachment(board, archivedAttachmentId);
    const activeKey = await stageAttachment(board, activeAttachmentId);
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "ac");

    a.send({
      type: "card.create",
      mutationId: "ac-active",
      id: "card-2",
      columnId: "col-1",
      title: "Survivor",
      position: "a1",
    });
    a.send({
      type: "card.create",
      mutationId: "ac-no-attachment",
      id: "card-3",
      columnId: "col-1",
      title: "No attachment",
      position: "a2",
    });
    a.send({
      type: "attachment.create",
      mutationId: "ac-attachment-archived",
      id: archivedAttachmentId,
      cardId: "card-1",
      fileName: "archived.png",
      contentType: "image/png",
      size: 3,
    });
    a.send({
      type: "attachment.create",
      mutationId: "ac-attachment-active",
      id: activeAttachmentId,
      cardId: "card-2",
      fileName: "active.png",
      contentType: "image/png",
      size: 3,
    });
    a.send({
      type: "checklist.create",
      mutationId: "ac-checklist",
      id: "item-archived",
      cardId: "card-1",
      text: "preserved until expiry",
      position: "a0",
    });
    await awaitBroadcast(a, "ac-checklist");

    a.send({ type: "card.delete", mutationId: "ac-delete-attached", id: "card-1" });
    await awaitBroadcast(a, "ac-delete-attached");
    expect((await a.next()).message).toMatchObject({
      type: "cards.archived",
      mutationId: "ac-delete-attached",
      cards: [{ id: "card-1", archivedColumnTitle: "Todo" }],
    });
    a.send({ type: "card.delete", mutationId: "ac-delete-empty", id: "card-3" });
    await awaitBroadcast(a, "ac-delete-empty");
    expect((await a.next()).message).toMatchObject({
      type: "cards.archived",
      mutationId: "ac-delete-empty",
      cards: [{ id: "card-3", archivedColumnTitle: "Todo" }],
    });

    let snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.map((card) => card.id)).toEqual(["card-2"]);
    expect(snapshot.archivedCards.map((card) => card.id).sort()).toEqual(["card-1", "card-3"]);
    expect(snapshot.attachments.map((attachment) => attachment.id).sort()).toEqual(
      [archivedAttachmentId, activeAttachmentId].sort(),
    );
    expect(snapshot.checklistItems.map((item) => item.id)).toEqual(["item-archived"]);
    const archivedObject = await env.ATTACHMENTS.get(archivedKey);
    expect(archivedObject).not.toBeNull();
    expect(Array.from(new Uint8Array(await archivedObject!.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(await env.ATTACHMENTS.head(activeKey)).not.toBeNull();

    await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "UPDATE cards SET archived_at = ? WHERE id IN ('card-1', 'card-3')",
        now - CARD_ARCHIVE_RETENTION_MS + 60_000,
      );
      await state.storage.deleteAlarm();
      await instance.alarm();
    });

    const scheduled = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(scheduled).toBeGreaterThan(Date.now());
    snapshot = await snapshotOf(await connect(board));
    expect(snapshot.archivedCards.map((card) => card.id).sort()).toEqual(["card-1", "card-3"]);
    expect(snapshot.attachments.map((attachment) => attachment.id).sort()).toEqual(
      [archivedAttachmentId, activeAttachmentId].sort(),
    );
    expect(await env.ATTACHMENTS.head(archivedKey)).not.toBeNull();
    expect(await env.ATTACHMENTS.head(activeKey)).not.toBeNull();

    await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "UPDATE cards SET archived_at = ? WHERE id IN ('card-1', 'card-3')",
        now - CARD_ARCHIVE_RETENTION_MS - 1000,
      );
      await instance.alarm();
    });

    expect((await a.next()).message).toEqual({
      type: "archive.purged",
      cardIds: ["card-1", "card-3"],
    });
    snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.map((card) => card.id)).toEqual(["card-2"]);
    expect(snapshot.archivedCards).toEqual([]);
    expect(snapshot.checklistItems).toEqual([]);
    expect(snapshot.attachments.map((attachment) => attachment.id)).toEqual([
      activeAttachmentId,
    ]);
    await expectObjectDeleted(archivedKey);
    expect(await env.ATTACHMENTS.head(activeKey)).not.toBeNull();

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    const afterIdempotence = await snapshotOf(await connect(board));
    expect(afterIdempotence.cards.map((card) => card.id)).toEqual(["card-2"]);
    expect(afterIdempotence.archivedCards).toEqual([]);
    expect(afterIdempotence.attachments.map((attachment) => attachment.id)).toEqual([
      activeAttachmentId,
    ]);
    expect(await env.ATTACHMENTS.head(activeKey)).not.toBeNull();
  });

  it("preserves archived attachments across column deletion and purges them at retention expiry", async () => {
    const board = "board-attach-column-cascade";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const doomedId = crypto.randomUUID();
    const keptId = crypto.randomUUID();
    const doomedKey = await stageAttachment(board, doomedId);
    const keptKey = await stageAttachment(board, keptId);
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "ak");

    a.send({ type: "column.create", mutationId: "ak-col2", id: "col-2", title: "Done", position: "a1" });
    a.send({
      type: "card.create",
      mutationId: "ak-card2",
      id: "card-2",
      columnId: "col-2",
      title: "Elsewhere",
      position: "a0",
    });
    a.send({
      type: "attachment.create",
      mutationId: "ak-1",
      id: doomedId,
      cardId: "card-1",
      fileName: "doomed.png",
      contentType: "image/png",
      size: 3,
    });
    a.send({
      type: "attachment.create",
      mutationId: "ak-2",
      id: keptId,
      cardId: "card-2",
      fileName: "kept.png",
      contentType: "image/png",
      size: 3,
    });
    a.send({
      type: "checklist.create",
      mutationId: "ak-chk",
      id: "item-doomed",
      cardId: "card-1",
      text: "doomed item",
      position: "a0",
    });
    await awaitBroadcast(a, "ak-chk");
    a.send({ type: "column.delete", mutationId: "ak-3", id: "col-1" });
    await awaitBroadcast(a, "ak-3");

    // Drain cards.archived frame on live socket a.
    const archivedFrame = await a.next();
    expect(archivedFrame.message.type).toBe("cards.archived");

    // Immediately after column.delete, metadata and R2 objects remain.
    let snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.map((card) => card.id)).toEqual(["card-2"]);
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-1"]);
    expect(snapshot.attachments.map((attachment) => attachment.id).sort()).toEqual(
      [doomedId, keptId].sort(),
    );
    expect(snapshot.checklistItems.map((item) => item.id)).toEqual(["item-doomed"]);
    expect(await env.ATTACHMENTS.head(doomedKey)).not.toBeNull();
    expect(await env.ATTACHMENTS.head(keptKey)).not.toBeNull();

    // Force archived_at just before expiry and run alarm to prove preservation and reschedule.
    await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "UPDATE cards SET archived_at = ? WHERE id = 'card-1'",
        now - CARD_ARCHIVE_RETENTION_MS + 60_000,
      );
      await instance.alarm();
    });

    const scheduled = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(scheduled).toBeGreaterThan(Date.now());
    expect(await env.ATTACHMENTS.head(doomedKey)).not.toBeNull();
    expect(await env.ATTACHMENTS.head(keptKey)).not.toBeNull();
    snapshot = await snapshotOf(await connect(board));
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-1"]);
    expect(snapshot.attachments.map((attachment) => attachment.id).sort()).toEqual(
      [doomedId, keptId].sort(),
    );

    // Force due and run alarm.
    await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        "UPDATE cards SET archived_at = ? WHERE id = 'card-1'",
        now - CARD_ARCHIVE_RETENTION_MS - 1000,
      );
      await instance.alarm();
    });

    // Live client receives exact bounded archive.purged frame.
    const purgedFrame = await a.next();
    expect(purgedFrame.message).toEqual({
      type: "archive.purged",
      cardIds: ["card-1"],
    });

    // Archive and dependent rows disappear, due R2 object drains, unrelated active attachment remains.
    snapshot = await snapshotOf(await connect(board));
    expect(snapshot.archivedCards).toEqual([]);
    expect(snapshot.checklistItems).toEqual([]);
    expect(snapshot.attachments.map((attachment) => attachment.id)).toEqual([keptId]);
    await expectObjectDeleted(doomedKey);
    expect(await env.ATTACHMENTS.head(keptKey)).not.toBeNull();

    // Run alarm again for idempotence.
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    expect(await env.ATTACHMENTS.head(keptKey)).not.toBeNull();
    const afterIdempotence = await snapshotOf(await connect(board));
    expect(afterIdempotence.attachments.map((attachment) => attachment.id)).toEqual([keptId]);
    expect(afterIdempotence.archivedCards).toEqual([]);
  });


  it("preserves earlier future attachment cleanup deadline when R2 deletion fails", async () => {
    const board = "board-attach-r2-failure";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const dueId = crypto.randomUUID();
    const futureId = crypto.randomUUID();
    const dueKey = await stageAttachment(board, dueId);
    const futureKey = await stageAttachment(board, futureId);

    const now = Date.now();
    const futureDeleteAfter = now + 20_000;

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = ?, reason = 'deleted' WHERE object_key = ?",
        now - 1000,
        dueKey,
      );
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = ?, reason = 'staged' WHERE object_key = ?",
        futureDeleteAfter,
        futureKey,
      );
    });

    // Simulate R2 outage by wrapping attachmentBucket with a failing proxy test double.
    await runInDurableObject(stub, async (instance) => {
      const testInstance = asBoardDOWithBucket(instance);
      const originalBucket = testInstance.attachmentBucket;
      const failingBucket = new Proxy(originalBucket, {
        get(target, prop, receiver) {
          if (prop === "delete") {
            return async () => {
              throw new Error("simulated R2 failure");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      testInstance.attachmentBucket = failingBucket;
      try {
        await testInstance.alarm();
      } finally {
        testInstance.attachmentBucket = originalBucket;
      }
    });

    // The resulting alarm must preserve the earlier future delete_after rather than overwriting it with the 60s retry.
    const scheduled = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(scheduled).toBe(futureDeleteAfter);

    // Due failed row retains its claim and retry deadline scheduled, future row remains durable.
    const cleanupRows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ objectKey: string; reason: string; deleteAfter: number; claimToken: string | null }>(
          `SELECT object_key AS objectKey, reason, delete_after AS deleteAfter, claim_token AS claimToken
             FROM attachment_cleanup
            ORDER BY object_key`,
        )
        .toArray(),
    );
    expect(cleanupRows.length).toBe(2);
    const dueRow = cleanupRows.find((r) => r.objectKey === dueKey);
    const futureRow = cleanupRows.find((r) => r.objectKey === futureKey);
    expect(dueRow).toBeDefined();
    expect(dueRow?.reason).toBe("deleted");
    expect(dueRow?.claimToken).not.toBeNull();
    expect(dueRow!.deleteAfter).toBeGreaterThanOrEqual(now + 50_000);
    expect(futureRow).toEqual({
      objectKey: futureKey,
      reason: "staged",
      deleteAfter: futureDeleteAfter,
      claimToken: null,
    });

    // Both R2 objects remain durable.
    expect(await env.ATTACHMENTS.head(dueKey)).not.toBeNull();
    expect(await env.ATTACHMENTS.head(futureKey)).not.toBeNull();

    // When the retry deadline arrives (simulated by setting delete_after to due) and R2 succeeds,
    // the due object drains, the future row persists, and the alarm remains scheduled at the future delete_after.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = ? WHERE object_key = ?",
        now - 1,
        dueKey,
      );
    });
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    await expectObjectDeleted(dueKey);
    expect(await env.ATTACHMENTS.head(futureKey)).not.toBeNull();

    const remainingCleanup = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ objectKey: string; reason: string; deleteAfter: number; deletedAt: number | null }>(
          `SELECT object_key AS objectKey, reason, delete_after AS deleteAfter, deleted_at AS deletedAt
             FROM attachment_cleanup
            ORDER BY object_key`,
        )
        .toArray(),
    );
    expect(remainingCleanup).toHaveLength(2);
    const dueTombstone = remainingCleanup.find((r) => r.objectKey === dueKey);
    const futureRemaining = remainingCleanup.find((r) => r.objectKey === futureKey);
    expect(dueTombstone).toEqual({
      objectKey: dueKey,
      reason: "deleted",
      deleteAfter: expect.any(Number),
      deletedAt: expect.any(Number),
    });
    expect(dueTombstone?.deletedAt).not.toBeNull();
    expect(futureRemaining).toEqual({
      objectKey: futureKey,
      reason: "staged",
      deleteAfter: futureDeleteAfter,
      deletedAt: null,
    });

    const alarmAfterDrain = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarmAfterDrain).toBe(futureDeleteAfter);

    await env.ATTACHMENTS.delete(futureKey);
  });

  it("minimizes alarm against earlier archive expiry when R2 deletion fails", async () => {
    const board = "board-attach-r2-fail-archive-wins";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const dueId = crypto.randomUUID();
    const futureId = crypto.randomUUID();
    const dueKey = await stageAttachment(board, dueId);
    const futureKey = await stageAttachment(board, futureId);

    const now = Date.now();
    const futureDeleteAfter = now + 40_000;
    // Archive expiry is 10 seconds away (earlier than future attachment at 40s and retry at 60s).
    const archiveExpireAt = now + 10_000;
    const archivedAt = archiveExpireAt - CARD_ARCHIVE_RETENTION_MS;

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = ?, reason = 'deleted' WHERE object_key = ?",
        now - 1000,
        dueKey,
      );
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = ?, reason = 'staged' WHERE object_key = ?",
        futureDeleteAfter,
        futureKey,
      );
      state.storage.sql.exec(
        `INSERT INTO cards(id, column_id, title, position, task_number, created_at, updated_at, archived_at, archived_column_title)
         VALUES ('card-early-archive', 'col-1', 'Early Archive', 'a0', 1, ?, ?, ?, 'Col 1')`,
        now,
        now,
        archivedAt,
      );
    });

    await runInDurableObject(stub, async (instance) => {
      const testInstance = asBoardDOWithBucket(instance);
      const originalBucket = testInstance.attachmentBucket;
      const failingBucket = new Proxy(originalBucket, {
        get(target, prop, receiver) {
          if (prop === "delete") {
            return async () => {
              throw new Error("simulated R2 failure");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      testInstance.attachmentBucket = failingBucket;
      try {
        await testInstance.alarm();
      } finally {
        testInstance.attachmentBucket = originalBucket;
      }
    });

    // The resulting alarm must be minimized against the earlier archive expiry.
    const scheduled = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(scheduled).toBe(archiveExpireAt);

    // Rows and blobs remain durable.
    expect(await env.ATTACHMENTS.head(dueKey)).not.toBeNull();
    expect(await env.ATTACHMENTS.head(futureKey)).not.toBeNull();
    const archivedCardCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM cards WHERE id = 'card-early-archive'")
        .toArray()[0]?.count,
    );
    expect(archivedCardCount).toBe(1);

    await env.ATTACHMENTS.delete(dueKey);
    await env.ATTACHMENTS.delete(futureKey);
  });
  it("claimed cleanup rejects staging with 409, records durable tombstone on success, and retains claim with retry delay on failure", async () => {
    const board = "board-claimed-cleanup";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const attId = crypto.randomUUID();
    const objectKey = attachmentObjectKey(board, attId);
    await seedIdentity(board, "test-user");

    // Insert an attachment_cleanup row with an active claim_token
    const now = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at)
         VALUES (?, ?, 'deleted', ?, 'claim-token-active', ?)`,
        objectKey,
        attId,
        now - 1000,
        now,
      );
    });

    // 1. STAGE_ATTACHMENT_PATH rejects staging with 409 while claim_token is active
    const stageRes = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({
        id: attId,
        contentType: "text/plain",
        size: 100,
        objectKey,
      }),
    });
    expect(stageRes.status).toBe(409);
    const stageErr = await stageRes.json<{ error: string }>();
    expect(stageErr.error).toBe("attachment object is currently being collected");

    // 2. Failure releases claim with retry delay
    await env.ATTACHMENTS.put(objectKey, Uint8Array.of(1, 2, 3));
    // Clear claim so drainAttachmentCleanup can claim it
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET claim_token = NULL, claimed_at = NULL WHERE object_key = ?",
        objectKey,
      );
    });

    // Trigger failure by simulating R2 outage
    await runInDurableObject(stub, async (instance) => {
      const testInstance = asBoardDOWithBucket(instance);
      const originalBucket = testInstance.attachmentBucket;
      testInstance.attachmentBucket = new Proxy(originalBucket, {
        get(target, prop, receiver) {
          if (prop === "delete") {
            return async () => {
              throw new Error("simulated R2 failure");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      try {
        await testInstance.alarm();
      } finally {
        testInstance.attachmentBucket = originalBucket;
      }
    });

    // Row must retain claim and have delete_after delayed by retry interval
    const postFailRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ claimToken: string | null; deleteAfter: number }>(
        "SELECT claim_token AS claimToken, delete_after AS deleteAfter FROM attachment_cleanup WHERE object_key = ?",
        objectKey,
      ).toArray()[0],
    );
    expect(postFailRow?.claimToken).not.toBeNull();
    expect(postFailRow!.deleteAfter).toBeGreaterThanOrEqual(now + 50_000);

    // Staging remains rejected with 409 because claim is retained
    const stageAfterRelease = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({
        id: attId,
        contentType: "text/plain",
        size: 100,
        objectKey,
      }),
    });
    expect(stageAfterRelease.status).toBe(409);
    const postFailErr = await stageAfterRelease.json<{ error: string }>();
    expect(postFailErr.error).toBe("attachment object is currently being collected");
    // 3. Successful delete removes only matching claims
    const attId1 = crypto.randomUUID();
    const key1 = attachmentObjectKey(board, attId1);
    await env.ATTACHMENTS.put(key1, Uint8Array.of(1));

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at)
         VALUES (?, ?, 'deleted', ?, NULL, NULL)`,
        key1,
        attId1,
        now - 1000,
      );
    });

    const attId2 = crypto.randomUUID();
    const key2 = attachmentObjectKey(board, attId2);
    await env.ATTACHMENTS.put(key2, Uint8Array.of(2));

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at)
         VALUES (?, ?, 'deleted', ?, NULL, NULL)`,
        key2,
        attId2,
        now - 1000,
      );
    });

    await runInDurableObject(stub, async (instance, state) => {
      const testInstance = asBoardDOWithBucket(instance);
      const originalBucket = testInstance.attachmentBucket;
      testInstance.attachmentBucket = new Proxy(originalBucket, {
        get(target, prop, receiver) {
          if (prop === "delete") {
            return async (keys: string[]) => {
              // Concurrently change the claim token of key2 before delete returns
              state.storage.sql.exec(
                "UPDATE attachment_cleanup SET claim_token = 'different-token' WHERE object_key = ?",
                key2,
              );
              return originalBucket.delete(keys);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      try {
        await testInstance.alarm();
      } finally {
        testInstance.attachmentBucket = originalBucket;
      }
    });

    // Both key1 and key2 have R2 deleted, and both retain permanent tombstones in attachment_cleanup
    const remainingRows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ objectKey: string; reason: string; deletedAt: number | null }>(
          "SELECT object_key AS objectKey, reason, deleted_at AS deletedAt FROM attachment_cleanup WHERE object_key IN (?, ?) ORDER BY object_key",
          key1,
          key2,
        )
        .toArray(),
    );
    expect(remainingRows.map((r) => r.objectKey)).toEqual([key1, key2].sort());
    for (const row of remainingRows) {
      expect(row.reason).toBe("deleted");
      expect(row.deletedAt).not.toBeNull();
    }
  });
  it("interrupted cleanup crash recovery retries R2 deletion under same claim token and maintains staging fence", async () => {
    const board = "board-attach-interrupted-claim";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const attId = crypto.randomUUID();
    const objectKey = attachmentObjectKey(board, attId);
    await seedIdentity(board, "test-user");
    await env.ATTACHMENTS.put(objectKey, Uint8Array.of(7, 8, 9));

    const now = Date.now();
    const interruptedClaimToken = "interrupted-claim-token-123";

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at)
         VALUES (?, ?, 'deleted', ?, ?, ?)`,
        objectKey,
        attId,
        now - 5000,
        interruptedClaimToken,
        now - 5000,
      );
    });

    // While claimed, staging is rejected with 409
    const stageRes = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({
        id: attId,
        contentType: "text/plain",
        size: 100,
        objectKey,
      }),
    });
    expect(stageRes.status).toBe(409);
    expect((await stageRes.json<{ error: string }>()).error).toBe("attachment object is currently being collected");

    // Also publication via attachment.create is rejected while claimed
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "aic");
    a.send({
      type: "attachment.create",
      mutationId: "aic-1",
      id: attId,
      cardId: "card-1",
      fileName: "test.png",
      contentType: "image/png",
      size: 100,
    });
    const createErr = await awaitError(a, "aic-1");
    expect(createErr.message).toBe("attachment staging lease is expired, claimed, or missing");
    a.close();

    // Trigger alarm on DO to process crash recovery retry under same claim token
    await runInDurableObject(stub, async (instance) => {
      const testInstance = asBoardDOWithBucket(instance);
      await testInstance.alarm();
    });
    await expectObjectDeleted(objectKey);
    const tombstone = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number; reason: string; deletedAt: number | null }>(
          "SELECT COUNT(*) AS count, reason, deleted_at AS deletedAt FROM attachment_cleanup WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0],
    );
    expect(tombstone?.count).toBe(1);
    expect(tombstone?.reason).toBe("deleted");
    expect(tombstone?.deletedAt).not.toBeNull();
  });

  it("delete failure retains claim and bounded retry while staging stays rejected", async () => {
    const board = "board-attach-failure-fencing";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const attId = crypto.randomUUID();
    const objectKey = attachmentObjectKey(board, attId);
    await seedIdentity(board, "test-user");
    await env.ATTACHMENTS.put(objectKey, Uint8Array.of(1, 2, 3));

    const now = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at)
         VALUES (?, ?, 'deleted', ?, NULL, NULL)`,
        objectKey,
        attId,
        now - 1000,
      );
    });

    // Run alarm with failing R2 bucket
    await runInDurableObject(stub, async (instance) => {
      const testInstance = asBoardDOWithBucket(instance);
      const originalBucket = testInstance.attachmentBucket;
      testInstance.attachmentBucket = new Proxy(originalBucket, {
        get(target, prop, receiver) {
          if (prop === "delete") {
            return async () => {
              throw new Error("simulated R2 failure during delete");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      try {
        await testInstance.alarm();
      } finally {
        testInstance.attachmentBucket = originalBucket;
      }
    });

    // Verify claim_token is retained (non-null) and delete_after delayed
    const failedRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ claimToken: string | null; deleteAfter: number }>(
          "SELECT claim_token AS claimToken, delete_after AS deleteAfter FROM attachment_cleanup WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0],
    );
    expect(failedRow?.claimToken).not.toBeNull();
    expect(failedRow!.deleteAfter).toBeGreaterThanOrEqual(now + 50_000);

    // Staging remains rejected with 409
    const stageRes = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({
        id: attId,
        contentType: "text/plain",
        size: 100,
        objectKey,
      }),
    });
    expect(stageRes.status).toBe(409);
    expect((await stageRes.json<{ error: string }>()).error).toBe("attachment object is currently being collected");

    // Simulate retry deadline arriving and alarm running with healthy R2 bucket
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = ? WHERE object_key = ?",
        Date.now() - 1,
        objectKey,
      );
    });

    await runInDurableObject(stub, async (instance) => {
      const testInstance = asBoardDOWithBucket(instance);
      await testInstance.alarm();
    });

    // Now R2 delete succeeded under same claim token and cleanup row is retained as durable tombstone
    await expectObjectDeleted(objectKey);
    const postRetryTombstone = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number; reason: string; deletedAt: number | null }>(
          "SELECT COUNT(*) AS count, reason, deleted_at AS deletedAt FROM attachment_cleanup WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0],
    );
    expect(postRetryTombstone?.count).toBe(1);
    expect(postRetryTombstone?.reason).toBe("deleted");
    expect(postRetryTombstone?.deletedAt).not.toBeNull();
  });

  it("reconciliation preserves active claim fields without resetting claim token or expiry", async () => {
    const board = "board-attach-reconcile-claim";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const attId = crypto.randomUUID();
    const objectKey = attachmentObjectKey(board, attId);
    await env.ATTACHMENTS.put(objectKey, Uint8Array.of(1, 2, 3));

    const claimToken = "active-reconcile-claim-token";
    const now = Date.now();
    const claimedAt = now - 1000;
    const deleteAfter = now + 3_600_000;

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at)
         VALUES (?, ?, 'deleted', ?, ?, ?)`,
        objectKey,
        attId,
        deleteAfter,
        claimToken,
        claimedAt,
      );
    });

    // Call internal reconcile endpoint with the claimed object key
    const reconcileRes = await stub.fetch(`https://board.internal${RECONCILE_ATTACHMENTS_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
      },
      body: JSON.stringify({
        objects: [{ key: objectKey, attachmentId: attId }],
      }),
    });
    expect(reconcileRes.status).toBe(200);

    // Verify claim_token, claimed_at, and delete_after were NOT overwritten
    const preservedRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ claimToken: string | null; claimedAt: number | null; deleteAfter: number; reason: string }>(
          `SELECT claim_token AS claimToken, claimed_at AS claimedAt, delete_after AS deleteAfter, reason
             FROM attachment_cleanup
            WHERE object_key = ?`,
          objectKey,
        )
        .toArray()[0],
    );

    expect(preservedRow).toEqual({
      claimToken,
      claimedAt,
      deleteAfter,
      reason: "deleted",
    });

    // Also run scheduled global reconciliation; claim fields remain intact
    await reconcileAttachmentObjects(env);

    const afterGlobal = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ claimToken: string | null; claimedAt: number | null; deleteAfter: number }>(
          "SELECT claim_token AS claimToken, claimed_at AS claimedAt, delete_after AS deleteAfter FROM attachment_cleanup WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0],
    );
    expect(afterGlobal).toEqual({
      claimToken,
      claimedAt,
      deleteAfter,
    });

    await env.ATTACHMENTS.delete(objectKey);
  });

  it("collector A/B overlap preserves durable tombstone fence: A pauses, B reuses claim and completes first, restage/publication remains blocked, and A completion preserves tombstone unchanged", async () => {
    const board = "board-collector-ab-overlap";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const client = await connect(board);
    await snapshotOf(client);
    await seedCard(client, "ab");

    const attId = crypto.randomUUID();
    const keyK = attachmentObjectKey(board, attId);
    await env.ATTACHMENTS.put(keyK, Uint8Array.of(10, 20, 30));

    const now = Date.now();
    let tombstoneTimeB: number | null = null;

    await runInDurableObject(stub, async (instance, state) => {
      const testInstance = asBoardDOWithBucket(instance);
      const originalBucket = testInstance.attachmentBucket;

      // Enqueue keyK for deletion
      state.storage.sql.exec(
        `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at, deleted_at)
         VALUES (?, ?, 'deleted', ?, NULL, NULL, NULL)`,
        keyK,
        attId,
        now - 1000,
      );

      let collectorBCompleted = false;
      let restageStatusDuringOverlap: number | null = null;

      // Collector A runs alarm(), claims keyK, and pauses right before R2 deletion in proxy
      testInstance.attachmentBucket = new Proxy(originalBucket, {
        get(target, prop, receiver) {
          if (prop === "delete") {
            return async (keys: string[]) => {
              // 1. Collector A has claimed keyK with an active claim token, but deleted_at is still null
              const stateDuringA = state.storage.sql
                .exec<{ claimToken: string | null; deletedAt: number | null; reason: string }>(
                  "SELECT claim_token AS claimToken, deleted_at AS deletedAt, reason FROM attachment_cleanup WHERE object_key = ?",
                  keyK,
                )
                .toArray()[0];
              expect(stateDuringA?.claimToken).not.toBeNull();
              expect(stateDuringA?.deletedAt).toBeNull();
              expect(stateDuringA?.reason).toBe("deleted");

              // 2. Collector B runs and completes first using originalBucket
              testInstance.attachmentBucket = originalBucket;
              await testInstance.alarm();

              // 3. Collector B completed: check that tombstone was written with non-null deleted_at
              const stateAfterB = state.storage.sql
                .exec<{ claimToken: string | null; deletedAt: number | null; reason: string }>(
                  "SELECT claim_token AS claimToken, deleted_at AS deletedAt, reason FROM attachment_cleanup WHERE object_key = ?",
                  keyK,
                )
                .toArray()[0];
              expect(stateAfterB?.deletedAt).not.toBeNull();
              expect(stateAfterB?.reason).toBe("deleted");
              tombstoneTimeB = stateAfterB!.deletedAt;
              collectorBCompleted = true;

              // 4. Attempted restage remains 409 because tombstone persists
              const restageReq = new Request(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  [INTERNAL_BOARD_ID_HEADER]: board,
                  [INTERNAL_USER_ID_HEADER]: "test-user",
                },
                body: JSON.stringify({ id: attId, objectKey: keyK }),
              });
              const restageRes = await testInstance.fetch(restageReq);
              restageStatusDuringOverlap = restageRes.status;

              // 5. Collector A's delete resumes and completes
              return originalBucket.delete(keys);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      try {
        await testInstance.alarm(); // Collector A runs
      } finally {
        testInstance.attachmentBucket = originalBucket;
      }

      expect(collectorBCompleted).toBe(true);
      expect(restageStatusDuringOverlap).toBe(409);

      // Collector A's completion preserved the tombstone unchanged
      const stateAfterA = state.storage.sql
        .exec<{ claimToken: string | null; deletedAt: number | null; reason: string }>(
          "SELECT claim_token AS claimToken, deleted_at AS deletedAt, reason FROM attachment_cleanup WHERE object_key = ?",
          keyK,
        )
        .toArray()[0];
      expect(stateAfterA?.deletedAt).toBe(tombstoneTimeB);
      expect(stateAfterA?.reason).toBe("deleted");
    });

    // R2 object was deleted
    await expectObjectDeleted(keyK);

    // Attempted restaging via stub.fetch returns 409
    const restageRes = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({ id: attId, objectKey: keyK }),
    });
    expect(restageRes.status).toBe(409);
    const restageErr = await restageRes.json<{ error: string }>();
    expect(restageErr.error).toBe("attachment object is currently being collected");

    // Attempted publication via WebSocket client fails
    client.send({
      type: "attachment.create",
      mutationId: "ab-create-fail",
      id: attId,
      cardId: "card-1",
      fileName: "overlap.png",
      contentType: "image/png",
      size: 10,
    });
    const pubErr = await awaitError(client, "ab-create-fail");
    expect(pubErr.message).toBe("attachment staging lease is expired, claimed, or missing");

    // Card transfer import referencing keyK is rejected with 409
    const transferId = crypto.randomUUID();
    const transferCardId = crypto.randomUUID();
    const importRes = await stub.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
      method: "POST",
      headers: await transferHeaders(board),
      body: JSON.stringify({
        transferId,
        sourceBoardId: "source-ab-board",
        destinationColumnId: "col-1",
        assigneeId: null,
        bundle: {
          card: {
            id: transferCardId,
            columnId: "col-1",
            title: "Imported Card",
            description: "",
            position: "a0",
            taskNumber: 1,
            assigneeId: null,
            priority: "medium",
            taskType: "task",
            dueDate: null,
            subtaskDone: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          checklistItems: [],
          attachments: [
            {
              id: attId,
              cardId: transferCardId,
              fileName: "overlap.png",
              contentType: "image/png",
              size: 10,
              objectKey: keyK,
            },
          ],
          comments: [],
          activities: [],
          labels: [],
          pullRequestAssociation: null,
          developmentPullRequests: [],
          developmentBranches: [],
          developmentUnlinks: [],
        },
      }),
    });
    expect(importRes.status).toBe(409);

    // No writer removes or overwrites the tombstone:
    // 1) Reconciliation preserves tombstone
    await reconcileAttachmentObjects(env);
    const stateAfterReconcile = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ deletedAt: number | null; reason: string }>(
          "SELECT deleted_at AS deletedAt, reason FROM attachment_cleanup WHERE object_key = ?",
          keyK,
        )
        .toArray()[0],
    );
    expect(stateAfterReconcile?.deletedAt).toBe(tombstoneTimeB);
    expect(stateAfterReconcile?.reason).toBe("deleted");

    // 2) Alarm scheduling ignores tombstone
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();

    client.close();
  });

  it("tombstones are ignored by alarm scheduling and due work, and preserved by reconciliation", async () => {
    const board = "board-tombstones-alarm-ignore";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const now = Date.now();
    const tombstoneAttId = crypto.randomUUID();
    const tombstoneKey = attachmentObjectKey(board, tombstoneAttId);
    const deletedAt = now - 15_000;

    // Insert durable tombstone
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at, deleted_at)
         VALUES (?, ?, 'deleted', 0, 'old-claim', ?, ?)`,
        tombstoneKey,
        tombstoneAttId,
        now - 20_000,
        deletedAt,
      );
    });

    // 1. Tombstone does not cause any alarm to be scheduled
    const initialAlarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(initialAlarm).toBeNull();

    // 2. Alarm invocation does not treat tombstone as due work
    let r2DeleteAttempted = false;
    await runInDurableObject(stub, async (instance) => {
      const testInstance = asBoardDOWithBucket(instance);
      const originalBucket = testInstance.attachmentBucket;
      testInstance.attachmentBucket = new Proxy(originalBucket, {
        get(target, prop, receiver) {
          if (prop === "delete") {
            return async () => {
              r2DeleteAttempted = true;
              return originalBucket.delete([]);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      try {
        await testInstance.alarm();
      } finally {
        testInstance.attachmentBucket = originalBucket;
      }
    });
    expect(r2DeleteAttempted).toBe(false);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();

    // 3. Stage a future attachment: alarm schedules ONLY for future attachment, ignoring tombstone
    const futureAttId = crypto.randomUUID();
    const futureKey = await stageAttachment(board, futureAttId);
    const futureDeleteAfter = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ deleteAfter: number }>("SELECT delete_after AS deleteAfter FROM attachment_cleanup WHERE object_key = ?", futureKey)
        .toArray()[0]?.deleteAfter,
    );
    expect(futureDeleteAfter).toBeGreaterThan(now);
    const scheduledAlarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(scheduledAlarm).toBe(futureDeleteAfter);

    // 4. Reconciliation preserves tombstone and live staging
    await reconcileAttachmentObjects(env);
    const afterReconciliation = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ objectKey: string; reason: string; deletedAt: number | null }>(
          "SELECT object_key AS objectKey, reason, deleted_at AS deletedAt FROM attachment_cleanup ORDER BY object_key",
        )
        .toArray(),
    );
    const tombstoneRow = afterReconciliation.find((r) => r.objectKey === tombstoneKey);
    const futureRow = afterReconciliation.find((r) => r.objectKey === futureKey);
    expect(tombstoneRow).toEqual({
      objectKey: tombstoneKey,
      reason: "deleted",
      deletedAt,
    });
    expect(futureRow).toEqual({
      objectKey: futureKey,
      reason: "staged",
      deletedAt: null,
    });

    // 5. Expiring and draining futureKey turns it into a tombstone; alarm returns to null
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec("UPDATE attachment_cleanup SET delete_after = 0 WHERE object_key = ?", futureKey);
      await instance.alarm();
    });
    await expectObjectDeleted(futureKey);
    const finalAlarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(finalAlarm).toBeNull();

    const finalCleanup = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ objectKey: string; reason: string; deletedAt: number | null }>(
          "SELECT object_key AS objectKey, reason, deleted_at AS deletedAt FROM attachment_cleanup ORDER BY object_key",
        )
        .toArray(),
    );
    expect(finalCleanup.length).toBe(2);
    for (const row of finalCleanup) {
      expect(row.reason).toBe("deleted");
      expect(row.deletedAt).not.toBeNull();
    }
  });

  it("late authorized put: global reconciliation redeletes delayed bytes, preserves original tombstone fence, resets delete_after to 0, leaves alarm null, and rejects restage and publication with 409", async () => {
    const board = "board-late-put-reconcile";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const client = await connect(board);
    await snapshotOf(client);
    await seedCard(client, "late-put");

    // 1. Stage K and let cleanup tombstone it
    const attId = crypto.randomUUID();
    const keyK = await stageAttachment(board, attId);

    // Expire staging and drain cleanup to establish an idle tombstone
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec("UPDATE attachment_cleanup SET delete_after = 0 WHERE object_key = ?", keyK);
      await instance.alarm();
    });
    await expectObjectDeleted(keyK);

    const initialTombstone = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          objectKey: string;
          reason: string;
          deleteAfter: number;
          claimToken: string | null;
          deletedAt: number | null;
        }>(
          "SELECT object_key AS objectKey, reason, delete_after AS deleteAfter, claim_token AS claimToken, deleted_at AS deletedAt FROM attachment_cleanup WHERE object_key = ?",
          keyK,
        )
        .toArray()[0],
    );
    expect(initialTombstone).toBeDefined();
    expect(initialTombstone?.reason).toBe("deleted");
    expect(initialTombstone?.deletedAt).not.toBeNull();
    expect(initialTombstone?.deleteAfter).toBe(0);
    expect(initialTombstone?.claimToken).not.toBeNull();
    const originalDeletedAt = initialTombstone!.deletedAt;
    const originalClaimToken = initialTombstone!.claimToken;

    // Verify idle tombstone has null alarm
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();

    // 2. Recreate bytes as a delayed authorized put
    await env.ATTACHMENTS.put(keyK, Uint8Array.of(11, 22, 33));
    expect(await env.ATTACHMENTS.head(keyK)).not.toBeNull();

    // 3. Run global reconciliation
    await reconcileAttachmentObjects(env);

    // 4. Assert bytes deleted again
    await expectObjectDeleted(keyK);
    expect(await env.ATTACHMENTS.head(keyK)).toBeNull();

    // 5. Assert original fence/tombstone preserved and delete_after returns 0
    const preservedTombstone = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          objectKey: string;
          reason: string;
          deleteAfter: number;
          claimToken: string | null;
          deletedAt: number | null;
        }>(
          "SELECT object_key AS objectKey, reason, delete_after AS deleteAfter, claim_token AS claimToken, deleted_at AS deletedAt FROM attachment_cleanup WHERE object_key = ?",
          keyK,
        )
        .toArray()[0],
    );
    expect(preservedTombstone).toEqual({
      objectKey: keyK,
      reason: "deleted",
      deleteAfter: 0,
      claimToken: originalClaimToken,
      deletedAt: originalDeletedAt,
    });

    // 6. Assert alarm null
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();

    // 7. Assert restage returns 409
    const stageRes = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({ id: attId, objectKey: keyK }),
    });
    expect(stageRes.status).toBe(409);
    const stageErr = await stageRes.json<{ error: string }>();
    expect(stageErr.error).toBe("attachment object is currently being collected");

    // 8. Assert publication remains rejected (returns error on create mutation)
    client.send({
      type: "attachment.create",
      mutationId: "late-put-pub-fail",
      id: attId,
      cardId: "card-1",
      fileName: "late-put.png",
      contentType: "image/png",
      size: 33,
    });
    const pubErr = await awaitError(client, "late-put-pub-fail");
    expect(pubErr.message).toBe("attachment staging lease is expired, claimed, or missing");

    client.close();
  });

  it("tombstone redelete failure: reconciliation queues redelete, injected delete failure sets bounded retry and alarm while maintaining 409 fence, and next alarm restores idle tombstone", async () => {
    const board = "board-redel-fail-fencing";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const client = await connect(board);
    await snapshotOf(client);
    await seedCard(client, "redel-fail");

    const attId = crypto.randomUUID();
    const objectKey = await stageAttachment(board, attId);

    // Expire staging and drain cleanup to establish an idle tombstone
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec("UPDATE attachment_cleanup SET delete_after = 0 WHERE object_key = ?", objectKey);
      await instance.alarm();
    });
    await expectObjectDeleted(objectKey);

    const initialTombstone = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          objectKey: string;
          reason: string;
          deleteAfter: number;
          claimToken: string | null;
          deletedAt: number | null;
        }>(
          "SELECT object_key AS objectKey, reason, delete_after AS deleteAfter, claim_token AS claimToken, deleted_at AS deletedAt FROM attachment_cleanup WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0],
    );
    expect(initialTombstone?.reason).toBe("deleted");
    expect(initialTombstone?.deletedAt).not.toBeNull();
    expect(initialTombstone?.deleteAfter).toBe(0);
    expect(initialTombstone?.claimToken).not.toBeNull();
    const originalDeletedAt = initialTombstone!.deletedAt;
    const originalClaimToken = initialTombstone!.claimToken;

    // Put bytes back into R2 as a late authorized put
    await env.ATTACHMENTS.put(objectKey, Uint8Array.of(9, 8, 7));
    expect(await env.ATTACHMENTS.head(objectKey)).not.toBeNull();

    // Inject delete failure on BoardDO's attachmentBucket
    await runInDurableObject(stub, (instance) => {
      const testInstance = asBoardDOWithBucket(instance);
      const originalBucket = testInstance.attachmentBucket;
      testInstance.attachmentBucket = new Proxy(originalBucket, {
        get(target, prop, receiver) {
          if (prop === "delete") {
            return async () => {
              throw new Error("simulated R2 failure during tombstone redelete");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    });

    // Run global reconciliation sweep
    await reconcileAttachmentObjects(env);

    // Assert bounded retry, retained claim token, preserved deleted_at, and alarm scheduled
    const failedRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          objectKey: string;
          reason: string;
          deleteAfter: number;
          claimToken: string | null;
          deletedAt: number | null;
        }>(
          "SELECT object_key AS objectKey, reason, delete_after AS deleteAfter, claim_token AS claimToken, deleted_at AS deletedAt FROM attachment_cleanup WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0],
    );
    expect(failedRow?.claimToken).toBe(originalClaimToken);
    expect(failedRow?.deletedAt).toBe(originalDeletedAt);
    expect(failedRow?.reason).toBe("deleted");
    expect(failedRow!.deleteAfter).toBeGreaterThanOrEqual(Date.now() + 50_000);

    const retryAlarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(retryAlarm).not.toBeNull();
    expect(retryAlarm).toBe(failedRow!.deleteAfter);

    // Assert continuous 409 fence against restaging
    const stageRes = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({ id: attId, objectKey }),
    });
    expect(stageRes.status).toBe(409);
    const stageErr = await stageRes.json<{ error: string }>();
    expect(stageErr.error).toBe("attachment object is currently being collected");

    // Assert continuous 409 fence against publication
    client.send({
      type: "attachment.create",
      mutationId: "redel-fail-pub-fail",
      id: attId,
      cardId: "card-1",
      fileName: "redel-fail.png",
      contentType: "image/png",
      size: 50,
    });
    const pubErr = await awaitError(client, "redel-fail-pub-fail");
    expect(pubErr.message).toBe("attachment staging lease is expired, claimed, or missing");

    // Restore healthy bucket on instance
    await runInDurableObject(stub, (instance) => {
      const testInstance = asBoardDOWithBucket(instance);
      testInstance.attachmentBucket = env.ATTACHMENTS;
    });

    // Simulate retry deadline arriving and execute next alarm
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = ? WHERE object_key = ?",
        Date.now() - 1,
        objectKey,
      );
      const testInstance = asBoardDOWithBucket(instance);
      await testInstance.alarm();
    });

    // Assert bytes gone
    await expectObjectDeleted(objectKey);
    expect(await env.ATTACHMENTS.head(objectKey)).toBeNull();

    // Assert idle tombstone restored: original claimToken, original deletedAt, deleteAfter 0, alarm null
    const restoredTombstone = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          objectKey: string;
          reason: string;
          deleteAfter: number;
          claimToken: string | null;
          deletedAt: number | null;
        }>(
          "SELECT object_key AS objectKey, reason, delete_after AS deleteAfter, claim_token AS claimToken, deleted_at AS deletedAt FROM attachment_cleanup WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0],
    );
    expect(restoredTombstone).toEqual({
      objectKey,
      reason: "deleted",
      deleteAfter: 0,
      claimToken: originalClaimToken,
      deletedAt: originalDeletedAt,
    });

    const finalAlarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(finalAlarm).toBeNull();

    // Restaging still rejected with 409
    const postRestoreStage = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({ id: attId, objectKey }),
    });
    expect(postRestoreStage.status).toBe(409);

    client.close();
  });

  it("bounds archived card purge to 1000 ids and schedules immediate follow-up for remaining due rows", async () => {
    const board = "board-archive-purge-bounds";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const a = await connect(board);
    await snapshotOf(a);

    const now = Date.now();
    const dueArchivedAt = now - CARD_ARCHIVE_RETENTION_MS - 1000;
    const expectedIds: string[] = [];
    for (let i = 0; i < 1001; i++) {
      expectedIds.push(`card-due-${String(i).padStart(4, "0")}`);
    }

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let idx = 0; idx < expectedIds.length; idx++) {
          const id = expectedIds[idx]!;
          state.storage.sql.exec(
            `INSERT INTO cards(id, column_id, title, position, task_number, created_at, updated_at, archived_at, archived_column_title)
             VALUES (?, 'col-archive', ?, 'a0', ?, ?, ?, ?, 'Archived Column')`,
            id,
            id,
            idx + 1,
            now,
            now,
            dueArchivedAt,
          );
        }
      });
    });

    // Invoke alarm to purge the first batch of 1000 cards, observe the scheduled
    // immediate follow-up alarm in the same turn, and delete it so workerd cannot
    // auto-consume the remaining row before the second manual invocation.
    const followUpAlarm = await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      const scheduled = await state.storage.getAlarm();
      if (scheduled !== null) {
        await state.storage.deleteAlarm();
      }
      return scheduled;
    });

    // Assert the first archive.purged frame carries exactly 1000 ids.
    const firstPurged = await a.next();
    if (firstPurged.message.type !== "archive.purged") {
      throw new Error(`expected archive.purged message, got ${firstPurged.message.type}`);
    }
    expect(firstPurged.message).toEqual({
      type: "archive.purged",
      cardIds: expectedIds.slice(0, 1000),
    });
    expect(firstPurged.message.cardIds).toHaveLength(1000);

    // The remaining due row causes immediate follow-up work scheduled in the immediate future.
    expect(followUpAlarm).not.toBeNull();
    expect(followUpAlarm!).toBeGreaterThan(now);
    expect(followUpAlarm!).toBeLessThanOrEqual(Date.now() + 100);
    // Second alarm invocation processes the remaining due row.
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    // Second bounded frame removes the remainder.
    const secondPurged = await a.next();
    expect(secondPurged.message).toEqual({
      type: "archive.purged",
      cardIds: [expectedIds[1000]],
    });

    // All rows are gone.
    const remainingCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM cards WHERE archived_at IS NOT NULL")
        .toArray()[0]?.count,
    );
    expect(remainingCount).toBe(0);
    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.archivedCards).toEqual([]);

    // Another alarm run is idempotent.
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    const finalAlarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(finalAlarm).toBeNull();
    const afterIdempotence = await snapshotOf(await connect(board));
    expect(afterIdempotence.archivedCards).toEqual([]);
  });

  it("reconciles unregistered R2 orphans without deleting active or staged objects", async () => {
    const board = "board-attach-reconcile";
    const activeId = crypto.randomUUID();
    const stagedId = crypto.randomUUID();
    const orphanId = crypto.randomUUID();
    const activeKey = await stageAttachment(board, activeId);
    const stagedKey = await stageAttachment(board, stagedId);
    const orphanKey = attachmentObjectKey(board, orphanId);
    await env.ATTACHMENTS.put(orphanKey, Uint8Array.of(9));

    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "ar");
    a.send({
      type: "attachment.create",
      mutationId: "ar-1",
      id: activeId,
      cardId: "card-1",
      fileName: "active.png",
      contentType: "image/png",
      size: 3,
    });
    await awaitBroadcast(a, "ar-1");

    await reconcileAttachmentObjects(env);
    await expectObjectDeleted(orphanKey);
    expect(await env.ATTACHMENTS.head(activeKey)).not.toBeNull();
    expect(await env.ATTACHMENTS.head(stagedKey)).not.toBeNull();
    const cleanup = await runInDurableObject(
      env.BOARD_DO.get(env.BOARD_DO.idFromName(board)),
      (_instance, state) =>
        state.storage.sql
          .exec<{ attachmentId: string; reason: string; deletedAt: number | null }>(
            `SELECT attachment_id AS attachmentId, reason, deleted_at AS deletedAt
               FROM attachment_cleanup
              ORDER BY attachment_id`,
          )
          .toArray(),
    );
    const stagedRow = cleanup.find((r) => r.attachmentId === stagedId);
    const orphanRow = cleanup.find((r) => r.attachmentId === orphanId);
    expect(stagedRow).toEqual({ attachmentId: stagedId, reason: "staged", deletedAt: null });
    expect(orphanRow).toEqual({ attachmentId: orphanId, reason: "deleted", deletedAt: expect.any(Number) });
    expect(orphanRow?.deletedAt).not.toBeNull();
  });

  it("round-trips a comment and echoes the create verbatim", async () => {
    const a = await connect("board-comment");
    await snapshotOf(a);
    await seedCard(a, "cm");

    a.send({
      type: "comment.create",
      mutationId: "cm-1",
      id: "note-1",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      body: "**looks good**",
      createdAt: 1_700_000_000_000,
    });
    const echo = await awaitBroadcast(a, "cm-1");
    expect(echo).toEqual({
      type: "comment.create",
      mutationId: "cm-1",
      id: "note-1",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      body: "**looks good**",
      createdAt: 1_700_000_000_000,
    });

    // A fresh comment is unedited: both timestamp columns take `createdAt`.
    const snapshot = await snapshotOf(await connect("board-comment"));
    expect(snapshot.comments).toEqual([
      {
        id: "note-1",
        cardId: "card-1",
        authorId: "user-1",
        parentCommentId: null,
        deleted: false,
        body: "**looks good**",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
    ]);
  });

  it("changes only the body and updatedAt on comment.update", async () => {
    const a = await connect("board-comment-update");
    await snapshotOf(a);
    await seedCard(a, "cu");

    a.send({
      type: "comment.create",
      mutationId: "cu-1",
      id: "note-1",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      body: "first pass",
      createdAt: 1_700_000_000_000,
    });
    a.send({
      type: "comment.update",
      mutationId: "cu-2",
      id: "note-1",
      body: "revised",
      updatedAt: 1_700_000_060_000,
    });
    await awaitBroadcast(a, "cu-2");

    const snapshot = await snapshotOf(await connect("board-comment-update"));
    expect(snapshot.comments).toEqual([
      {
        id: "note-1",
        cardId: "card-1",
        authorId: "user-1",
        parentCommentId: null,
        deleted: false,
        body: "revised",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_060_000,
      },
    ]);
  });

  it("removes a comment on comment.delete", async () => {
    const a = await connect("board-comment-delete");
    await snapshotOf(a);
    await seedCard(a, "cd");

    a.send({
      type: "comment.create",
      mutationId: "cd-1",
      id: "note-1",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      body: "gone soon",
      createdAt: 1_700_000_000_000,
    });
    a.send({ type: "comment.delete", mutationId: "cd-2", id: "note-1" });
    await awaitBroadcast(a, "cd-2");

    const snapshot = await snapshotOf(await connect("board-comment-delete"));
    expect(snapshot.comments).toEqual([]);
  });

  it("preserves a card's comments when the card is archived", async () => {
    const a = await connect("board-comment-card-cascade");
    await snapshotOf(a);
    await seedCard(a, "cx");

    a.send({
      type: "card.create",
      mutationId: "cx-other",
      id: "card-2",
      columnId: "col-1",
      title: "Survivor",
      position: "a1",
    });
    a.send({
      type: "comment.create",
      mutationId: "cx-1",
      id: "note-1",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      body: "doomed",
      createdAt: 1_700_000_000_000,
    });
    a.send({
      type: "comment.create",
      mutationId: "cx-2",
      id: "note-2",
      cardId: "card-2",
      authorId: "user-1",
      parentCommentId: null,
      body: "kept",
      createdAt: 1_700_000_000_001,
    });
    a.send({ type: "card.delete", mutationId: "cx-3", id: "card-1" });
    await awaitBroadcast(a, "cx-3");

    const snapshot = await snapshotOf(await connect("board-comment-card-cascade"));
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-1"]);
    expect(snapshot.comments.map((comment) => comment.id)).toEqual(["note-1", "note-2"]);
  });

  it("preserves comments of archived cards when their column is deleted", async () => {
    const a = await connect("board-comment-column-cascade");
    await snapshotOf(a);
    await seedCard(a, "cz");

    a.send({ type: "column.create", mutationId: "cz-col2", id: "col-2", title: "Done", position: "a1" });
    a.send({
      type: "card.create",
      mutationId: "cz-card2",
      id: "card-2",
      columnId: "col-2",
      title: "Elsewhere",
      position: "a0",
    });
    a.send({
      type: "comment.create",
      mutationId: "cz-1",
      id: "note-1",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      body: "preserved",
      createdAt: 1_700_000_000_000,
    });
    a.send({
      type: "comment.create",
      mutationId: "cz-2",
      id: "note-2",
      cardId: "card-2",
      authorId: "user-1",
      parentCommentId: null,
      body: "kept",
      createdAt: 1_700_000_000_001,
    });
    a.send({ type: "column.delete", mutationId: "cz-3", id: "col-1" });
    await awaitBroadcast(a, "cz-3");

    const snapshot = await snapshotOf(await connect("board-comment-column-cascade"));
    expect(snapshot.cards.map((card) => card.id)).toEqual(["card-2"]);
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-1"]);
    expect(snapshot.comments.map((comment) => comment.id)).toEqual(["note-1", "note-2"]);
  });
  it("handles one-level reply threads, tombstoning, pruning, and update prevention", async () => {
    const a = await connect("board-comment-replies");
    await snapshotOf(a);
    await seedCard(a, "cr");

    // 1. Create root comment
    a.send({
      type: "comment.create",
      mutationId: "cr-root",
      id: "root-1",
      cardId: "card-1",
      authorId: "alice",
      parentCommentId: null,
      body: "Root comment",
      createdAt: 1_700_000_000_000,
    });
    await awaitBroadcast(a, "cr-root");

    // 2. Reply to root succeeds
    a.send({
      type: "comment.create",
      mutationId: "cr-reply-1",
      id: "reply-1",
      cardId: "card-1",
      authorId: "bob",
      parentCommentId: "root-1",
      body: "First reply",
      createdAt: 1_700_000_001_000,
    });
    await awaitBroadcast(a, "cr-reply-1");

    // 3. Reject reply targeting a reply (reply-to-reply at protocol level)
    a.send({
      type: "comment.create",
      mutationId: "cr-reply-to-reply",
      id: "reply-invalid",
      cardId: "card-1",
      authorId: "alice",
      parentCommentId: "reply-1",
      body: "Nested reply attempt",
      createdAt: 1_700_000_002_000,
    });
    const errNested = await a.next();
    expect(errNested.message.type).toBe("error");
    if (errNested.message.type === "error") {
      expect(errNested.message.message).toBe("Reply target is unavailable.");
      expect(errNested.message.mutationId).toBe("cr-reply-to-reply");
    }

    // 4. Reject reply targeting non-existent parent
    a.send({
      type: "comment.create",
      mutationId: "cr-reply-missing",
      id: "reply-missing",
      cardId: "card-1",
      authorId: "alice",
      parentCommentId: "does-not-exist",
      body: "Missing parent attempt",
      createdAt: 1_700_000_003_000,
    });
    const errMissing = await a.next();
    expect(errMissing.message.type).toBe("error");
    if (errMissing.message.type === "error") {
      expect(errMissing.message.message).toBe("Reply target is unavailable.");
    }

    // 5. Reject reply targeting cross-card parent
    a.send({
      type: "card.create",
      mutationId: "cr-card2",
      id: "card-2",
      columnId: "col-1",
      title: "Card 2",
      position: "a2",
    });
    await awaitBroadcast(a, "cr-card2");
    await a.next(); // card.numbered
    await a.next(); // activity.recorded
    a.send({
      type: "comment.create",
      mutationId: "cr-cross-card",
      id: "reply-cross",
      cardId: "card-2",
      authorId: "alice",
      parentCommentId: "root-1",
      body: "Cross card reply attempt",
      createdAt: 1_700_000_004_000,
    });
    const errCross = await a.next();
    expect(errCross.message.type).toBe("error");
    expect(errCross.message).toEqual({
      type: "error",
      mutationId: "cr-cross-card",
      message: "Reply target is unavailable.",
    });

    // 6. Delete root when replies exist -> tombstones root
    a.send({ type: "comment.delete", mutationId: "cr-del-root", id: "root-1" });
    await awaitBroadcast(a, "cr-del-root");

    let snapshot = await snapshotOf(await connect("board-comment-replies"));
    const tombstone = snapshot.comments.find((c) => c.id === "root-1");
    expect(tombstone).toEqual({
      id: "root-1",
      cardId: "card-1",
      authorId: "alice",
      parentCommentId: null,
      deleted: true,
      body: "",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    const replyAfterTombstone = snapshot.comments.find((c) => c.id === "reply-1");
    expect(replyAfterTombstone?.deleted).toBe(false);

    // 7. Tombstone cannot be updated
    a.send({
      type: "comment.update",
      mutationId: "cr-upd-tombstone",
      id: "root-1",
      body: "Reviving tombstone",
      updatedAt: 1_700_000_010_000,
    });
    await awaitBroadcast(a, "cr-upd-tombstone");
    snapshot = await snapshotOf(await connect("board-comment-replies"));
    expect(snapshot.comments.find((c) => c.id === "root-1")?.body).toBe("");

    // 8. New reply to tombstoned root is allowed
    a.send({
      type: "comment.create",
      mutationId: "cr-reply-2",
      id: "reply-2",
      cardId: "card-1",
      authorId: "alice",
      parentCommentId: "root-1",
      body: "Second reply to tombstoned root",
      createdAt: 1_700_000_011_000,
    });
    await awaitBroadcast(a, "cr-reply-2");

    // 9. Delete reply-1 -> root remains tombstoned because reply-2 exists
    a.send({ type: "comment.delete", mutationId: "cr-del-r1", id: "reply-1" });
    await awaitBroadcast(a, "cr-del-r1");
    snapshot = await snapshotOf(await connect("board-comment-replies"));
    expect(snapshot.comments.some((c) => c.id === "reply-1")).toBe(false);
    expect(snapshot.comments.some((c) => c.id === "root-1")).toBe(true);

    // 10. Delete final reply-2 -> prunes empty tombstoned root
    a.send({ type: "comment.delete", mutationId: "cr-del-r2", id: "reply-2" });
    await awaitBroadcast(a, "cr-del-r2");
    snapshot = await snapshotOf(await connect("board-comment-replies"));
    expect(snapshot.comments.some((c) => c.id === "reply-2")).toBe(false);
    expect(snapshot.comments.some((c) => c.id === "root-1")).toBe(false);
    expect(snapshot.comments).toHaveLength(0);
  });
  it("enforces bidirectional body and deleted invariants in CommentSchema", () => {
    const validLive = CommentSchema.safeParse({
      id: "cmt-valid-live",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      deleted: false,
      body: "Live comment body",
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });
    expect(validLive.success).toBe(true);

    const validTombstone = CommentSchema.safeParse({
      id: "cmt-valid-tombstone",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      deleted: true,
      body: "",
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });
    expect(validTombstone.success).toBe(true);

    const invalidEmptyLive = CommentSchema.safeParse({
      id: "cmt-invalid-empty-live",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      deleted: false,
      body: "",
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });
    expect(invalidEmptyLive.success).toBe(false);
    if (!invalidEmptyLive.success) {
      expect(invalidEmptyLive.error.issues).toHaveLength(1);
      expect(invalidEmptyLive.error.issues[0].path).toEqual(["body"]);
    }

    const invalidNonemptyTombstone = CommentSchema.safeParse({
      id: "cmt-invalid-tombstone",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      deleted: true,
      body: "supposedly erased body",
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });
    expect(invalidNonemptyTombstone.success).toBe(false);
    if (!invalidNonemptyTombstone.success) {
      expect(invalidNonemptyTombstone.error.issues).toHaveLength(1);
      expect(invalidNonemptyTombstone.error.issues[0].path).toEqual(["body"]);
    }
  });

  it("round-trips a relation and reads it from both cards", async () => {
    const a = await connect("board-relation");
    await snapshotOf(a);
    await seedCard(a, "rl");

    a.send({
      type: "card.create",
      mutationId: "rl-other",
      id: "card-2",
      columnId: "col-1",
      title: "Blocked one",
      position: "a1",
    });
    a.send({
      type: "relation.create",
      mutationId: "rl-1",
      id: "rel-1",
      sourceCardId: "card-1",
      targetCardId: "card-2",
      kind: "blocks",
    });
    const echo = await awaitBroadcast(a, "rl-1");
    expect(echo).toEqual({
      type: "relation.create",
      mutationId: "rl-1",
      id: "rel-1",
      sourceCardId: "card-1",
      targetCardId: "card-2",
      kind: "blocks",
    });

    // One stored row serves both ends: the target reads it as "blocked by".
    const snapshot = await snapshotOf(await connect("board-relation"));
    expect(snapshot.relations).toEqual([
      { id: "rel-1", sourceCardId: "card-1", targetCardId: "card-2", kind: "blocks" },
    ]);

    a.send({ type: "relation.delete", mutationId: "rl-2", id: "rel-1" });
    await awaitBroadcast(a, "rl-2");
    const cleared = await snapshotOf(await connect("board-relation"));
    expect(cleared.relations).toEqual([]);
  });

  // `kind` is passthrough TEXT with no CHECK, so the contract this defends is
  // the bundled `ClientMessageSchema`: the widened enum must parse (M14).
  it("accepts and round-trips a subtask relation kind", async () => {
    const a = await connect("board-subtask-kind");
    await snapshotOf(a);
    await seedCard(a, "st");

    a.send({
      type: "card.create",
      mutationId: "st-child",
      id: "card-2",
      columnId: "col-1",
      title: "Write docs",
      position: "a1",
    });
    a.send({
      type: "relation.create",
      mutationId: "st-1",
      id: "rel-1",
      sourceCardId: "card-1",
      targetCardId: "card-2",
      kind: "subtask",
    });
    const echo = await awaitBroadcast(a, "st-1");
    expect(echo).toEqual({
      type: "relation.create",
      mutationId: "st-1",
      id: "rel-1",
      sourceCardId: "card-1",
      targetCardId: "card-2",
      kind: "subtask",
    });

    const snapshot = await snapshotOf(await connect("board-subtask-kind"));
    expect(snapshot.relations).toEqual([
      { id: "rel-1", sourceCardId: "card-1", targetCardId: "card-2", kind: "subtask" },
    ]);
  });

  it("preserves relations from both sides when a card is archived", async () => {
    const a = await connect("board-relation-cascade");
    await snapshotOf(a);
    await seedCard(a, "rc");

    a.send({
      type: "card.create",
      mutationId: "rc-card2",
      id: "card-2",
      columnId: "col-1",
      title: "Second",
      position: "a1",
    });
    a.send({
      type: "card.create",
      mutationId: "rc-card3",
      id: "card-3",
      columnId: "col-1",
      title: "Third",
      position: "a2",
    });
    // card-1 on the source side, on the target side, and a row that misses it.
    a.send({
      type: "relation.create",
      mutationId: "rc-1",
      id: "rel-a",
      sourceCardId: "card-1",
      targetCardId: "card-2",
      kind: "blocks",
    });
    a.send({
      type: "relation.create",
      mutationId: "rc-2",
      id: "rel-b",
      sourceCardId: "card-3",
      targetCardId: "card-1",
      kind: "relates",
    });
    a.send({
      type: "relation.create",
      mutationId: "rc-3",
      id: "rel-c",
      sourceCardId: "card-2",
      targetCardId: "card-3",
      kind: "relates",
    });
    a.send({ type: "card.delete", mutationId: "rc-4", id: "card-1" });
    await awaitBroadcast(a, "rc-4");

    const snapshot = await snapshotOf(await connect("board-relation-cascade"));
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-1"]);
    expect(snapshot.relations.map((relation) => relation.id)).toEqual(["rel-a", "rel-b", "rel-c"]);
  });

  it("round-trips a label definition through create, update and delete", async () => {
    const a = await connect("board-label");
    await snapshotOf(a);

    a.send({ type: "label.create", mutationId: "lb-1", id: "label-1", name: "Bug", color: "red" });
    const echo = await awaitBroadcast(a, "lb-1");
    expect(echo).toEqual({
      type: "label.create",
      mutationId: "lb-1",
      id: "label-1",
      name: "Bug",
      color: "red",
    });

    const created = await snapshotOf(await connect("board-label"));
    expect(created.labels).toEqual([{ id: "label-1", name: "Bug", color: "red" }]);

    a.send({ type: "label.update", mutationId: "lb-2", id: "label-1", name: "Fix", color: "blue" });
    await awaitBroadcast(a, "lb-2");
    const renamed = await snapshotOf(await connect("board-label"));
    expect(renamed.labels).toEqual([{ id: "label-1", name: "Fix", color: "blue" }]);

    // Partial update: the absent field is COALESCEd back to the stored value.
    a.send({ type: "label.update", mutationId: "lb-3", id: "label-1", name: "Defect" });
    await awaitBroadcast(a, "lb-3");
    const partial = await snapshotOf(await connect("board-label"));
    expect(partial.labels).toEqual([{ id: "label-1", name: "Defect", color: "blue" }]);

    a.send({ type: "label.delete", mutationId: "lb-4", id: "label-1" });
    await awaitBroadcast(a, "lb-4");
    const cleared = await snapshotOf(await connect("board-label"));
    expect(cleared.labels).toEqual([]);
  });

  it("round-trips assigning and unassigning a label on a card", async () => {
    const a = await connect("board-label-assign");
    await snapshotOf(a);
    await seedCard(a, "la");

    a.send({ type: "label.create", mutationId: "la-1", id: "label-1", name: "Bug", color: "red" });
    a.send({
      type: "label.assign",
      mutationId: "la-2",
      id: "join-1",
      cardId: "card-1",
      labelId: "label-1",
    });
    const echo = await awaitBroadcast(a, "la-2");
    expect(echo).toEqual({
      type: "label.assign",
      mutationId: "la-2",
      id: "join-1",
      cardId: "card-1",
      labelId: "label-1",
    });

    const assigned = await snapshotOf(await connect("board-label-assign"));
    expect(assigned.cardLabels).toEqual([
      { id: "join-1", cardId: "card-1", labelId: "label-1" },
    ]);

    a.send({ type: "label.unassign", mutationId: "la-3", id: "join-1" });
    await awaitBroadcast(a, "la-3");
    const removed = await snapshotOf(await connect("board-label-assign"));
    expect(removed.cardLabels).toEqual([]);
    // Unassigning touches the join row only; the definition is board-scoped.
    expect(removed.labels).toEqual([{ id: "label-1", name: "Bug", color: "red" }]);
  });

  it("cascades every assignment when a label definition is deleted", async () => {
    const a = await connect("board-label-cascade");
    await snapshotOf(a);
    await seedCard(a, "ld");

    a.send({
      type: "card.create",
      mutationId: "ld-other",
      id: "card-2",
      columnId: "col-1",
      title: "Also tagged",
      position: "a1",
    });
    a.send({ type: "label.create", mutationId: "ld-1", id: "label-1", name: "Bug", color: "red" });
    a.send({
      type: "label.assign",
      mutationId: "ld-2",
      id: "join-1",
      cardId: "card-1",
      labelId: "label-1",
    });
    a.send({
      type: "label.assign",
      mutationId: "ld-3",
      id: "join-2",
      cardId: "card-2",
      labelId: "label-1",
    });
    a.send({ type: "label.delete", mutationId: "ld-4", id: "label-1" });
    await awaitBroadcast(a, "ld-4");

    const snapshot = await snapshotOf(await connect("board-label-cascade"));
    expect(snapshot.labels).toEqual([]);
    expect(snapshot.cardLabels).toEqual([]);
  });

  it("preserves a card's label joins when the card is archived", async () => {
    const a = await connect("board-label-card-cascade");
    await snapshotOf(a);
    await seedCard(a, "lc");

    a.send({
      type: "card.create",
      mutationId: "lc-other",
      id: "card-2",
      columnId: "col-1",
      title: "Kept",
      position: "a1",
    });
    a.send({ type: "label.create", mutationId: "lc-1", id: "label-1", name: "Bug", color: "red" });
    a.send({
      type: "label.assign",
      mutationId: "lc-2",
      id: "join-1",
      cardId: "card-1",
      labelId: "label-1",
    });
    a.send({
      type: "label.assign",
      mutationId: "lc-3",
      id: "join-2",
      cardId: "card-2",
      labelId: "label-1",
    });
    a.send({ type: "card.delete", mutationId: "lc-4", id: "card-1" });
    await awaitBroadcast(a, "lc-4");

    const snapshot = await snapshotOf(await connect("board-label-card-cascade"));
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-1"]);
    expect(snapshot.cardLabels.map((join) => join.id)).toEqual(["join-1", "join-2"]);
    expect(snapshot.labels).toEqual([{ id: "label-1", name: "Bug", color: "red" }]);
  });

  it("preserves label joins of archived cards when their column is deleted", async () => {
    const a = await connect("board-label-column-cascade");
    await snapshotOf(a);
    await seedCard(a, "lk");

    a.send({
      type: "column.create",
      mutationId: "lk-col2",
      id: "col-2",
      title: "Done",
      position: "a1",
    });
    a.send({
      type: "card.create",
      mutationId: "lk-other",
      id: "card-2",
      columnId: "col-2",
      title: "Kept",
      position: "a0",
    });
    a.send({ type: "label.create", mutationId: "lk-1", id: "label-1", name: "Bug", color: "red" });
    a.send({
      type: "label.assign",
      mutationId: "lk-2",
      id: "join-1",
      cardId: "card-1",
      labelId: "label-1",
    });
    a.send({
      type: "label.assign",
      mutationId: "lk-3",
      id: "join-2",
      cardId: "card-2",
      labelId: "label-1",
    });
    a.send({ type: "column.delete", mutationId: "lk-4", id: "col-1" });
    await awaitBroadcast(a, "lk-4");

    const snapshot = await snapshotOf(await connect("board-label-column-cascade"));
    expect(snapshot.cards.map((card) => card.id)).toEqual(["card-2"]);
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["card-1"]);
    expect(snapshot.cardLabels.map((join) => join.id)).toEqual(["join-1", "join-2"]);
    expect(snapshot.labels).toEqual([{ id: "label-1", name: "Bug", color: "red" }]);
  });

  it("keeps its rows and its schema version across a restart", async () => {
    const a = await connect("board-restart");
    await seedIdentity("board-restart", "user-7");
    await snapshotOf(a);
    await seedCard(a, "rs");
    a.send({
      type: "checklist.create",
      mutationId: "rs-1",
      id: "item-1",
      cardId: "card-1",
      text: "survives",
      position: "a0",
    });
    a.send({
      type: "comment.create",
      mutationId: "rs-1b",
      id: "note-1",
      cardId: "card-1",
      authorId: "user-7",
      parentCommentId: null,
      body: "still here",
      createdAt: 1_700_000_000_000,
    });
    a.send({ type: "card.assign", mutationId: "rs-2", id: "card-1", assigneeId: "user-7" });
    a.send({ type: "card.prioritize", mutationId: "rs-2b", id: "card-1", priority: "high" });
    a.send({ type: "card.schedule", mutationId: "rs-2c", id: "card-1", dueDate: "2099-12-31" });
    a.send({
      type: "card.create",
      mutationId: "rs-4-card",
      id: "card-2",
      columnId: "col-1",
      title: "Blocked one",
      position: "a1",
    });
    a.send({
      type: "relation.create",
      mutationId: "rs-5",
      id: "rel-1",
      sourceCardId: "card-1",
      targetCardId: "card-2",
      kind: "blocks",
    });
    a.send({ type: "label.create", mutationId: "rs-6", id: "label-1", name: "Bug", color: "red" });
    a.send({
      type: "label.assign",
      mutationId: "rs-7",
      id: "join-1",
      cardId: "card-1",
      labelId: "label-1",
    });
    await awaitBroadcast(a, "rs-7");

    // Evicting the instance re-runs the constructor against storage that is
    // already migrated: without the version gate the v2 `ALTER TABLE` would
    // throw here and the next connection would never get a snapshot.
    const id = env.BOARD_DO.idFromName("board-restart");
    await expect(
      runInDurableObject(env.BOARD_DO.get(id), (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();

    const b = await connect("board-restart");
    const snapshot = await snapshotOf(b);
    expect(snapshot.cards[0]).toMatchObject({
      id: "card-1",
      assigneeId: "user-7",
      priority: "high",
      dueDate: "2099-12-31",
    });
    expect(snapshot.checklistItems).toEqual([
      { id: "item-1", cardId: "card-1", text: "survives", done: false, position: "a0" },
    ]);
    expect(snapshot.comments).toEqual([
      {
        id: "note-1",
        cardId: "card-1",
        authorId: "user-7",
        parentCommentId: null,
        deleted: false,
        body: "still here",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
    ]);
    expect(snapshot.relations).toEqual([
      { id: "rel-1", sourceCardId: "card-1", targetCardId: "card-2", kind: "blocks" },
    ]);
    expect(snapshot.labels).toEqual([{ id: "label-1", name: "Bug", color: "red" }]);
    expect(snapshot.cardLabels).toEqual([{ id: "join-1", cardId: "card-1", labelId: "label-1" }]);
    const history = [...snapshot.activities].sort((a, b) => a.sequence - b.sequence);
    expect(history.map(({ cardId, detail }) => [cardId, detail.type])).toEqual([
      ["card-1", "card.created"],
      ["card-1", "checklist.added"],
      ["card-1", "assignee.changed"],
      ["card-1", "priority.changed"],
      ["card-1", "dueDate.changed"],
      ["card-2", "card.created"],
      ["card-1", "relation.added"],
      ["card-2", "relation.added"],
      ["card-1", "label.added"],
    ]);
    expect(history.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(history.every(({ actorId }) => actorId === "test-user")).toBe(true);

    // The migration gate stopped at the newest batch rather than replaying.
    const version = await runInDurableObject(env.BOARD_DO.get(id), (_instance, state) =>
      state.storage.sql
        .exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'")
        .toArray()[0]?.value,
    );
    expect(version).toBe(29);

    // The restarted instance still writes: the tables survived intact.
    b.send({
      type: "checklist.create",
      mutationId: "rs-3",
      id: "item-2",
      cardId: "card-1",
      text: "after the restart",
      position: "a1",
    });
    await awaitBroadcast(b, "rs-3");
    const [postRestart] = await awaitActivity(b, "rs-3");
    expect(postRestart).toMatchObject({
      cardId: "card-1",
      actorId: "test-user",
      sequence: 10,
      detail: { type: "checklist.added", item: "after the restart" },
    });
    const after = await snapshotOf(await connect("board-restart"));
    expect(after.checklistItems.map((item) => item.id)).toEqual(["item-1", "item-2"]);
    b.send({ type: "column.rename", mutationId: "rs-manager", id: after.columns[0]!.id, title: "Managed after restart" });
    await awaitBroadcast(b, "rs-manager");
    const denied = await connect("board-restart", "ordinary-member", false);
    const baseline = await snapshotOf(denied);
    denied.send({ type: "column.delete", mutationId: "rs-denied", id: baseline.columns[0]!.id });
    expect((await awaitError(denied, "rs-denied")).message).toContain("owner or an admin");
    expect(await snapshotOf(await connect("board-restart"))).toEqual(baseline);
  });

  it("recovers from a partial v11 migration when either archive column already exists", async () => {
    const partialStates = [
      {
        board: "board-v11-partial-archived-at",
        dropColumn: "archived_column_title",
      },
      {
        board: "board-v11-partial-column-title",
        dropColumn: "archived_at",
      },
    ] as const;

    for (const { board, dropColumn } of partialStates) {
      const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
      const initial = await connect(board);
      await snapshotOf(initial);
      initial.close();

      await runInDurableObject(stub, (_instance, state) => {
        const sql = state.storage.sql;
        sql.exec("DROP INDEX IF EXISTS cards_archived_at");
        sql.exec(`ALTER TABLE cards DROP COLUMN ${dropColumn}`);
        sql.exec("UPDATE meta SET value = 10 WHERE key = 'schema_version'");
        sql.exec("INSERT INTO columns(id, title, position) VALUES ('col-legacy', 'Legacy', 'a0')");
        sql.exec(
          `INSERT INTO cards(
             id, column_id, title, description, position, assignee_id,
             priority, due_date, created_at, updated_at
           ) VALUES ('card-legacy', 'col-legacy', 'Legacy card', '', 'a0', NULL,
                     'medium', NULL, 1, 1)`,
        );
      });

      await expect(
        runInDurableObject(stub, (_instance, state) => state.abort("restart")),
      ).rejects.toThrow();

      const client = await connect(board);
      const snapshot = await snapshotOf(client);
      client.close();

      expect(snapshot.cards.map(({ id }) => id)).toEqual(["card-legacy"]);
      expect(snapshot.archivedCards).toEqual([]);

      const { version, columnNames, indexNames } = await runInDurableObject(
        env.BOARD_DO.get(env.BOARD_DO.idFromName(board)),
        (_instance, state) => {
          const version = state.storage.sql
            .exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'")
            .toArray()[0]?.value;
          const columnNames = state.storage.sql
            .exec<{ name: string }>("PRAGMA table_info(cards)")
            .toArray()
            .map((row) => row.name);
          const indexNames = state.storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cards'",
            )
            .toArray()
            .map((row) => row.name);
          return { version, columnNames, indexNames };
        },
      );

      expect(version).toBe(29);
      expect(columnNames).toContain("archived_at");
      expect(columnNames).toContain("archived_column_title");
      expect(columnNames).toContain("subtask_done");
      expect(indexNames).toContain("cards_archived_at");
    }
  });

  it("migrates from v11 to v12 deterministically ordering legacy active and archived cards sharing created_at", async () => {
    const board = "board-v11-to-v12-migration";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const initial = await connect(board);
    await snapshotOf(initial);
    initial.close();

    // Roll schema_version back to 11, drop task_number column and index, delete next_task_number
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP INDEX IF EXISTS cards_task_number");
      sql.exec("ALTER TABLE cards DROP COLUMN task_number");
      sql.exec("DELETE FROM meta WHERE key = 'next_task_number'");
      sql.exec("UPDATE meta SET value = 11 WHERE key = 'schema_version'");
      sql.exec("INSERT INTO columns(id, title, position) VALUES ('col-1', 'Column 1', 'a0')");

      // Insert 2 active cards and 2 archived cards with identical created_at = 1000
      sql.exec(
        `INSERT INTO cards(id, column_id, title, description, position, assignee_id, priority, due_date, created_at, updated_at, archived_at, archived_column_title)
         VALUES ('card-z', 'col-1', 'Z Card', '', 'a0', NULL, 'medium', NULL, 1000, 1000, NULL, NULL),
                ('card-a', 'col-1', 'A Card', '', 'a1', NULL, 'medium', NULL, 1000, 1000, NULL, NULL),
                ('card-y', 'col-1', 'Y Archived', '', 'a2', NULL, 'medium', NULL, 1000, 1000, 2000, 'Column 1'),
                ('card-b', 'col-1', 'B Archived', '', 'a3', NULL, 'medium', NULL, 1000, 1000, 2000, 'Column 1')`,
      );
    });

    // Abort/restart the DO to trigger v12 migration
    await expect(
      runInDurableObject(stub, (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();

    const client = await connect(board);
    const snapshot = await snapshotOf(client);
    client.close();

    // Sort order by (created_at, id) ascending:
    // card-a -> 1
    // card-b -> 2
    // card-y -> 3
    // card-z -> 4
    const cardA = snapshot.cards.find((c) => c.id === "card-a");
    const cardB = snapshot.archivedCards.find((c) => c.id === "card-b");
    const cardY = snapshot.archivedCards.find((c) => c.id === "card-y");
    const cardZ = snapshot.cards.find((c) => c.id === "card-z");

    expect(cardA?.taskNumber).toBe(1);
    expect(cardB?.taskNumber).toBe(2);
    expect(cardY?.taskNumber).toBe(3);
    expect(cardZ?.taskNumber).toBe(4);

    // Verify next_task_number in meta is 5 using a fresh stub after abort
    const freshStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const nextTaskNumber = await runInDurableObject(freshStub, (_instance, state) => {
      return state.storage.sql
        .exec<{ value: number }>("SELECT value FROM meta WHERE key = 'next_task_number'")
        .toArray()[0]?.value;
    });
    expect(nextTaskNumber).toBe(5);

    // Also verify creating the next card allocates 5
    const c = await connect(board);
    await snapshotOf(c);
    c.send({
      type: "card.create",
      mutationId: "mut-next-v12",
      id: "card-next",
      columnId: "col-1",
      title: "Next Card",
      position: "a4",
    });
    let cardNumbered: Extract<ServerMessage, { type: "card.numbered" }> | undefined;
    while (!cardNumbered) {
      const msg = (await c.next()).message;
      if (msg.type === "card.numbered" && msg.id === "card-next") {
        cardNumbered = msg;
      }
    }
    expect(cardNumbered.taskNumber).toBe(5);
    c.close();
  });

  it("handles concurrent creates from two sockets, emits card.numbered in commit order, preserves numbers across restart, archive/restore, and purge", async () => {
    const board = "board-card-numbering-lifecycle";
    const a = await connect(board, "user-a");
    const b = await connect(board, "user-b");
    await snapshotOf(a);
    await snapshotOf(b);

    // Setup column
    a.send({ type: "column.create", mutationId: "cn-col", id: "col-1", title: "Todo", position: "a0" });
    await awaitBroadcast(a, "cn-col");
    await awaitBroadcast(b, "cn-col");

    // Both sockets send card.create back-to-back
    a.send({
      type: "card.create",
      mutationId: "mut-c1",
      id: "card-1",
      columnId: "col-1",
      title: "Card 1",
      position: "a0",
    });
    b.send({
      type: "card.create",
      mutationId: "mut-c2",
      id: "card-2",
      columnId: "col-1",
      title: "Card 2",
      position: "a1",
    });

    // Collect frames from both socket a and socket b
    // Each socket must receive: verbatim card.create, card.numbered, activity.recorded for both creations
    const framesA: ServerMessage[] = [];
    const framesB: ServerMessage[] = [];
    while (framesA.filter((f) => f.type === "activity.recorded").length < 2) {
      framesA.push((await a.next()).message);
    }
    while (framesB.filter((f) => f.type === "activity.recorded").length < 2) {
      framesB.push((await b.next()).message);
    }

    const numberedFramesA = framesA.filter(
      (f): f is Extract<ServerMessage, { type: "card.numbered" }> => f.type === "card.numbered",
    );
    const numberedFramesB = framesB.filter(
      (f): f is Extract<ServerMessage, { type: "card.numbered" }> => f.type === "card.numbered",
    );
    expect(numberedFramesA).toEqual(numberedFramesB);
    expect(numberedFramesA).toHaveLength(2);

    // Derive server commit order
    const firstCommitId = numberedFramesA[0]!.id;
    const secondCommitId = numberedFramesA[1]!.id;
    expect(numberedFramesA[0]!.taskNumber).toBe(1);
    expect(numberedFramesA[1]!.taskNumber).toBe(2);
    expect(new Set([firstCommitId, secondCommitId])).toEqual(new Set(["card-1", "card-2"]));

    // For each committed card, verify exact frame sequence on both sockets:
    // verbatim card.create -> card.numbered -> activity.recorded
    for (const cardId of [firstCommitId, secondCommitId]) {
      const mutId = cardId === "card-1" ? "mut-c1" : "mut-c2";
      for (const frames of [framesA, framesB]) {
        const createIdx = frames.findIndex((f) => f.type === "card.create" && f.id === cardId);
        const numIdx = frames.findIndex((f) => f.type === "card.numbered" && f.id === cardId);
        const actIdx = frames.findIndex(
          (f) => f.type === "activity.recorded" && f.mutationId === mutId,
        );
        expect(createIdx).toBeGreaterThanOrEqual(0);
        expect(numIdx).toBeGreaterThan(createIdx);
        expect(actIdx).toBeGreaterThan(numIdx);
      }
    }
    // Verify snapshot after restart retains assigned numbers
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    a.close();
    b.close();
    await expect(
      runInDurableObject(stub, (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();

    const c = await connect(board, "user-c");
    const snapAfterRestart = await snapshotOf(c);
    expect(snapAfterRestart.cards.find((card) => card.id === "card-1")?.taskNumber).toBe(1);
    expect(snapAfterRestart.cards.find((card) => card.id === "card-2")?.taskNumber).toBe(2);

    // Archive card-1 and assert taskNumber is preserved in cards.archived and snapshot
    c.send({ type: "card.delete", mutationId: "del-1", id: "card-1" });
    const delFrames: ServerMessage[] = [];
    while (!delFrames.some((f) => f.type === "cards.archived")) {
      delFrames.push((await c.next()).message);
    }
    const archivedFrame = delFrames.find(
      (f): f is Extract<ServerMessage, { type: "cards.archived" }> => f.type === "cards.archived",
    );
    expect(archivedFrame?.cards.find((card) => card.id === "card-1")?.taskNumber).toBe(1);

    // Restore card-1 and assert taskNumber is preserved
    c.send({
      type: "card.restore",
      mutationId: "rest-1",
      id: "card-1",
      columnId: "col-1",
      position: "a2",
    });
    await awaitBroadcast(c, "rest-1");
    const snapAfterRestore = await snapshotOf(await connect(board));
    expect(snapAfterRestore.cards.find((card) => card.id === "card-1")?.taskNumber).toBe(1);

    // Archive card-2 and permanently purge it
    c.send({ type: "card.delete", mutationId: "del-2", id: "card-2" });
    while ((await c.next()).message.type !== "cards.archived");
    c.send({ type: "card.purge", mutationId: "purge-2", id: "card-2" });
    while ((await c.next()).message.type !== "archive.purged");

    // Next created card MUST get number 3 (never reusing 2)
    c.send({
      type: "card.create",
      mutationId: "mut-c3",
      id: "card-3",
      columnId: "col-1",
      title: "Card 3",
      position: "a3",
    });
    let card3Numbered: Extract<ServerMessage, { type: "card.numbered" }> | undefined;
    while (!card3Numbered) {
      const msg = (await c.next()).message;
      if (msg.type === "card.numbered" && msg.id === "card-3") {
        card3Numbered = msg;
      }
    }
    expect(card3Numbered.taskNumber).toBe(3);
  });
  it("creates a configured card in one accepted frame: selection reaches both clients and a fresh snapshot with one task number and one activity", async () => {
    const board = "board-card-enriched-create";
    const a = await connect(board, "user-a");
    const b = await connect(board, "user-b");
    await seedIdentity(board, "member-1");
    await snapshotOf(a);
    await snapshotOf(b);

    a.send({
      type: "column.create",
      mutationId: "ec-col",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(a, "ec-col");
    await awaitBroadcast(b, "ec-col");

    a.send({
      type: "card.create",
      mutationId: "ec-card",
      id: "card-epic",
      columnId: "col-1",
      title: "Epic card",
      position: "a0",
      taskType: "epic",
      priority: "highest",
      assigneeId: "member-1",
    });

    // The accepted frame is broadcast verbatim to everyone, sender included.
    const broadcastA = await awaitBroadcast(a, "ec-card");
    expect(broadcastA).toMatchObject({
      type: "card.create",
      id: "card-epic",
      taskType: "epic",
      priority: "highest",
      assigneeId: "member-1",
    });
    expect(await awaitBroadcast(b, "ec-card")).toEqual(broadcastA);

    const numbered = await awaitMatching(
      a,
      (message): message is Extract<ServerMessage, { type: "card.numbered" }> =>
        message.type === "card.numbered" && message.id === "card-epic",
    );
    expect(numbered.taskNumber).toBe(1);

    // Creation stays one history entry: nothing synthesises property edits.
    const activities = await awaitActivity(a, "ec-card");
    expect(activities).toHaveLength(1);
    expect(activities[0]?.detail).toEqual({ type: "card.created" });
    await awaitActivity(b, "ec-card");

    // A fresh socket reads every selected value back from storage.
    const fresh = await connect(board, "user-c");
    const snapshot = await snapshotOf(fresh);
    expect(snapshot.cards.find((card) => card.id === "card-epic")).toMatchObject({
      columnId: "col-1",
      title: "Epic card",
      taskType: "epic",
      priority: "highest",
      assigneeId: "member-1",
      taskNumber: 1,
    });
    expect(snapshot.cards).toHaveLength(1);
  });

  it("refuses a subtask or an unknown priority through card.create and writes nothing", async () => {
    const board = "board-card-invalid-create";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const client = await connect(board);
    await snapshotOf(client);

    client.send({
      type: "column.create",
      mutationId: "ic-col",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(client, "ic-col");

    // A subtask is created by its parent, never by card.create.
    client.send({
      type: "card.create",
      mutationId: "ic-subtask",
      id: "card-sub",
      columnId: "col-1",
      title: "Not a root card",
      position: "a0",
      taskType: "subtask",
    });
    const subtaskRejection = await awaitError(client, "ic-subtask");
    expect(subtaskRejection.message).toContain("taskType");

    // Priority is the shared five-level enum.
    client.send({
      type: "card.create",
      mutationId: "ic-priority",
      id: "card-priority",
      columnId: "col-1",
      title: "Impossible priority",
      position: "a1",
      priority: "P0",
    });
    const priorityRejection = await awaitError(client, "ic-priority");
    expect(priorityRejection.message).toContain("priority");

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT id FROM cards").toArray(),
    );
    expect(rows).toHaveLength(0);
  });

  it("rolls back the counter and does not advance next_task_number when card.create fails due to duplicate id", async () => {
    const board = "board-card-duplicate-rollback";
    const client = await connect(board);
    await snapshotOf(client);

    client.send({
      type: "column.create",
      mutationId: "dup-col",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(client, "dup-col");

    // Create initial card-1 -> taskNumber 1
    client.send({
      type: "card.create",
      mutationId: "dup-c1",
      id: "card-1",
      columnId: "col-1",
      title: "First",
      position: "a0",
    });
    while ((await client.next()).message.type !== "card.numbered");

    // Attempt duplicate insert with same id card-1 -> fails and rolls back
    client.send({
      type: "card.create",
      mutationId: "dup-c1-fail",
      id: "card-1",
      columnId: "col-1",
      title: "Duplicate",
      position: "a1",
    });
    const err = await awaitError(client, "dup-c1-fail");
    expect(err).toBeTruthy();

    // Next successful create MUST get taskNumber 2, not 3
    client.send({
      type: "card.create",
      mutationId: "dup-c2",
      id: "card-2",
      columnId: "col-1",
      title: "Second",
      position: "a2",
    });
    let card2Numbered: Extract<ServerMessage, { type: "card.numbered" }> | undefined;
    while (!card2Numbered) {
      const msg = (await client.next()).message;
      if (msg.type === "card.numbered" && msg.id === "card-2") {
        card2Numbered = msg;
      }
    }
    expect(card2Numbered.taskNumber).toBe(2);
  });
});
describe("BoardDO internal card transfer endpoints", () => {
  it("options returns live columns in position order", async () => {
    const board = "board-transfer-options";
    const client = await connect(board);
    await snapshotOf(client);

    client.send({
      type: "column.create",
      mutationId: "opt-c2",
      id: "col-2",
      title: "Doing",
      position: "a1",
    });
    await awaitBroadcast(client, "opt-c2");

    client.send({
      type: "column.create",
      mutationId: "opt-c1",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(client, "opt-c1");

    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const res = await stub.fetch("https://board.internal/internal/card-transfer/options", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json<{ columns: Array<{ id: string; title: string; position: string }> }>();
    expect(data.columns.map((c) => c.id)).toEqual(["col-1", "col-2"]);
  });

  it("prepare exports complete immutable bundle, sets lock, rejects relation conflict or concurrent transfer", async () => {
    const board = "board-transfer-prepare";
    const client = await connect(board);
    await snapshotOf(client);

    client.send({
      type: "column.create",
      mutationId: "prep-col",
      id: "col-1",
      title: "Col 1",
      position: "a0",
    });
    await awaitBroadcast(client, "prep-col");

    client.send({
      type: "card.create",
      mutationId: "prep-card1",
      id: "card-1",
      columnId: "col-1",
      title: "Card 1",
      position: "a0",
    });
    await awaitBroadcast(client, "prep-card1");

    client.send({
      type: "card.update",
      mutationId: "prep-up",
      id: "card-1",
      description: "A full description",
    });
    await awaitBroadcast(client, "prep-up");

    client.send({
      type: "card.prioritize",
      mutationId: "prep-prio",
      id: "card-1",
      priority: "high",
    });
    await awaitBroadcast(client, "prep-prio");

    client.send({
      type: "card.retype",
      mutationId: "prep-type",
      id: "card-1",
      taskType: "epic",
    });
    await awaitBroadcast(client, "prep-type");
    client.send({
      type: "card.schedule",
      mutationId: "prep-sched",
      id: "card-1",
      dueDate: "2026-12-31",
    });
    await awaitBroadcast(client, "prep-sched");

    client.send({
      type: "checklist.create",
      mutationId: "prep-chk",
      id: "chk-1",
      cardId: "card-1",
      text: "Check 1",
      position: "a0",
    });
    await awaitBroadcast(client, "prep-chk");

    client.send({
      type: "comment.create",
      mutationId: "prep-cmt-root",
      id: "cmt-root-1",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      body: "Thread root",
      createdAt: 1700000002000,
    });
    await awaitBroadcast(client, "prep-cmt-root");

    client.send({
      type: "comment.create",
      mutationId: "prep-cmt-rep1",
      id: "cmt-rep-1",
      cardId: "card-1",
      authorId: "user-2",
      parentCommentId: "cmt-root-1",
      body: "Reply one",
      createdAt: 1700000003000,
    });
    await awaitBroadcast(client, "prep-cmt-rep1");

    client.send({
      type: "comment.create",
      mutationId: "prep-cmt-rep2",
      id: "cmt-rep-2",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: "cmt-root-1",
      body: "Reply two",
      createdAt: 1700000004000,
    });
    await awaitBroadcast(client, "prep-cmt-rep2");

    // Tombstone the root while replies remain
    client.send({
      type: "comment.delete",
      mutationId: "prep-cmt-del-root",
      id: "cmt-root-1",
    });
    await awaitBroadcast(client, "prep-cmt-del-root");
    client.send({
      type: "label.create",
      mutationId: "prep-lbl",
      id: "lbl-1",
      name: "Bug",
      color: "red",
    });
    await awaitBroadcast(client, "prep-lbl");

    client.send({
      type: "label.assign",
      mutationId: "prep-lassign",
      id: "cl-1",
      cardId: "card-1",
      labelId: "lbl-1",
    });
    await awaitBroadcast(client, "prep-lassign");

    const attachmentId = crypto.randomUUID();
    const objectKey = await stageAttachment(board, attachmentId);
    client.send({
      type: "attachment.create",
      mutationId: "prep-att",
      id: attachmentId,
      cardId: "card-1",
      fileName: "test.txt",
      contentType: "text/plain",
      size: 3,
    });
    await awaitBroadcast(client, "prep-att");

    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));

    // Prepare returns the complete bundle
    const transferId = "xfer-prep-1";
    const destBoard = "board-transfer-dest";
    const prepRes = await stub.fetch("https://board.internal/internal/card-transfer/prepare", {
      method: "POST",
      headers: await transferHeaders(board),
      body: JSON.stringify({ transferId, cardId: "card-1", destinationBoardId: destBoard }),
    });
    expect(prepRes.status).toBe(200);
    const prepData = await prepRes.json<{
      bundle: {
        card: { id: string; title: string; description: string; priority: string; taskType: string; dueDate: string | null };
        checklistItems: Array<{ id: string; text: string }>;
        comments: Array<{
          id: string;
          authorId: string;
          parentCommentId: string | null;
          deleted: boolean;
          body: string;
          createdAt: number;
          updatedAt: number;
        }>;
        attachments: Array<{ id: string; fileName: string; objectKey: string }>;
        labels: Array<{ id: string; name: string; color: string; joinId: string }>;
        activities: Array<{ id: string }>;
      };
    }>();
    const bundle = prepData.bundle;

    expect(bundle.card.id).toBe("card-1");
    expect(bundle.card.title).toBe("Card 1");
    expect(bundle.card.description).toBe("A full description");
    expect(bundle.card.priority).toBe("high");
    expect(bundle.card.taskType).toBe("epic");
    expect(bundle.card.dueDate).toBe("2026-12-31");
    expect(bundle.checklistItems).toHaveLength(1);
    expect(bundle.checklistItems[0].id).toBe("chk-1");
    expect(bundle.checklistItems[0].text).toBe("Check 1");
    expect(bundle.comments).toHaveLength(3);
    expect(bundle.comments).toEqual([
      {
        id: "cmt-root-1",
        cardId: "card-1",
        authorId: "user-1",
        parentCommentId: null,
        deleted: true,
        body: "",
        createdAt: 1700000002000,
        updatedAt: 1700000002000,
      },
      {
        id: "cmt-rep-1",
        cardId: "card-1",
        authorId: "user-2",
        parentCommentId: "cmt-root-1",
        deleted: false,
        body: "Reply one",
        createdAt: 1700000003000,
        updatedAt: 1700000003000,
      },
      {
        id: "cmt-rep-2",
        cardId: "card-1",
        authorId: "user-1",
        parentCommentId: "cmt-root-1",
        deleted: false,
        body: "Reply two",
        createdAt: 1700000004000,
        updatedAt: 1700000004000,
      },
    ]);
    expect(bundle.attachments).toHaveLength(1);
    expect(bundle.attachments[0].id).toBe(attachmentId);
    expect(bundle.attachments[0].objectKey).toBe(objectKey);
    expect(bundle.labels).toHaveLength(1);
    expect(bundle.labels[0].name).toBe("Bug");
    expect(bundle.activities.length).toBeGreaterThan(0);

    // Concurrent transfer with another transferId is rejected with 409
    const conflictRes = await stub.fetch("https://board.internal/internal/card-transfer/prepare", {
      method: "POST",
      headers: await transferHeaders(board),
      body: JSON.stringify({ transferId: "xfer-prep-2", cardId: "card-1", destinationBoardId: destBoard }),
    });
    expect(conflictRes.status).toBe(409);

    // Mutations on the locked card are rejected by WebSocket
    client.send({
      type: "card.update",
      mutationId: "lock-mut-fail",
      id: "card-1",
      title: "New Title While Locked",
    });
    const err = await awaitError(client, "lock-mut-fail");
    expect(err.message).toBe("card transfer in progress");

    // Child and relation mutations on locked card are also rejected
    client.send({
      type: "card.prioritize",
      mutationId: "lock-prio-fail",
      id: "card-1",
      priority: "low",
    });
    const prioErr = await awaitError(client, "lock-prio-fail");
    expect(prioErr.message).toBe("card transfer in progress");

    // column.delete targeting column containing a locked card is rejected
    client.send({
      type: "column.delete",
      mutationId: "lock-col-del-fail",
      id: "col-1",
    });
    const colErr = await awaitError(client, "lock-col-del-fail");
    expect(colErr.message).toBe("card transfer in progress");

    // label.update and label.delete for label assigned to locked card are rejected
    client.send({
      type: "label.update",
      mutationId: "lock-lbl-up-fail",
      id: "lbl-1",
      name: "Renamed Bug",
    });
    const lblUpErr = await awaitError(client, "lock-lbl-up-fail");
    expect(lblUpErr.message).toBe("card transfer in progress");

    client.send({
      type: "label.delete",
      mutationId: "lock-lbl-del-fail",
      id: "lbl-1",
    });
    const lblDelErr = await awaitError(client, "lock-lbl-del-fail");
    expect(lblDelErr.message).toBe("card transfer in progress");
    // Releasing the lock allows mutation again
    const relRes = await stub.fetch("https://board.internal/internal/card-transfer/release", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
      },
      body: JSON.stringify({ transferId, cardId: "card-1" }),
    });
    expect(relRes.status).toBe(200);

    client.send({
      type: "card.update",
      mutationId: "after-rel-up",
      id: "card-1",
      title: "New Title After Release",
    });
    await awaitBroadcast(client, "after-rel-up");

    // Now create a second card and relate it -> prepare must reject with 409 relation conflict
    client.send({
      type: "card.create",
      mutationId: "prep-card2",
      id: "card-2",
      columnId: "col-1",
      title: "Card 2",
      position: "a1",
    });
    await awaitBroadcast(client, "prep-card2");

    client.send({
      type: "relation.create",
      mutationId: "prep-rel",
      id: "rel-1",
      sourceCardId: "card-1",
      targetCardId: "card-2",
      kind: "blocks",
    });
    await awaitBroadcast(client, "prep-rel");

    const relConflictRes = await stub.fetch("https://board.internal/internal/card-transfer/prepare", {
      method: "POST",
      headers: await transferHeaders(board),
      body: JSON.stringify({ transferId: "xfer-prep-3", cardId: "card-1", destinationBoardId: destBoard }),
    });
    expect(relConflictRes.status).toBe(409);
  });

  it("import preserves card UUID, allocates next task number, places at tail, handles exact label reuse and null assignee", async () => {
    const destBoard = "board-transfer-import-dest";
    const destClient = await connect(destBoard);
    await snapshotOf(destClient);

    // Destination board has one column and existing card-dest-1 (taskNumber 1, position a0)
    destClient.send({
      type: "column.create",
      mutationId: "dst-col",
      id: "col-dest",
      title: "Done",
      position: "a0",
    });
    await awaitBroadcast(destClient, "dst-col");

    destClient.send({
      type: "card.create",
      mutationId: "dst-c1",
      id: "card-dest-1",
      columnId: "col-dest",
      title: "Existing Dest Card",
      position: "a0",
    });
    await awaitBroadcast(destClient, "dst-c1");

    // Pre-create an identical label definition: "Bug" with "red"
    destClient.send({
      type: "label.create",
      mutationId: "dst-lbl-exact",
      id: "lbl-dest-bug",
      name: "Bug",
      color: "red",
    });
    await awaitBroadcast(destClient, "dst-lbl-exact");

    // Prepare bundle to import
    const bundle = {
      card: {
        id: "transferred-card-uuid",
        columnId: "col-src",
        title: "Transferred Card",
        description: "Transferred description",
        position: "a0",
        taskNumber: 99,
        assigneeId: null,
        priority: "medium",
        taskType: "epic",
        dueDate: null,
        subtaskDone: false,
        createdAt: 1700000000000,
        updatedAt: 1700000010000,
      },
      checklistItems: [
        {
          id: "chk-transferred-1",
          cardId: "transferred-card-uuid",
          text: "Sub-item 1",
          done: false,
          position: "a0",
        },
      ],
      comments: [
        {
          id: "cmt-transferred-root",
          cardId: "transferred-card-uuid",
          authorId: "user-1",
          parentCommentId: null,
          deleted: true,
          body: "",
          createdAt: 1700000002000,
          updatedAt: 1700000002000,
        },
        {
          id: "cmt-transferred-rep1",
          cardId: "transferred-card-uuid",
          authorId: "user-2",
          parentCommentId: "cmt-transferred-root",
          deleted: false,
          body: "First transferred reply",
          createdAt: 1700000003000,
          updatedAt: 1700000003000,
        },
        {
          id: "cmt-transferred-rep2",
          cardId: "transferred-card-uuid",
          authorId: "user-1",
          parentCommentId: "cmt-transferred-root",
          deleted: false,
          body: "Second transferred reply",
          createdAt: 1700000004000,
          updatedAt: 1700000004000,
        },
      ],
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          cardId: "transferred-card-uuid",
          fileName: "doc.pdf",
          contentType: "application/pdf",
          size: 1024,
          objectKey: `${destBoard}/00000000-0000-4000-8000-000000000001`,
        },
      ],
      labels: [
        { id: "src-lbl-1", name: "Bug", color: "red", joinId: "src-cl-1" },
        { id: "src-lbl-2", name: "Backend", color: "blue", joinId: "src-cl-2" },
      ],
      pullRequestAssociation: null,
      developmentPullRequests: [],
      developmentBranches: [],
      developmentUnlinks: [],
      activities: [
        {
          id: "act-transferred-1",
          cardId: "transferred-card-uuid",
          actorId: "user-1",
          sequence: 1,
          detail: { type: "card.created" },
          createdAt: 1700000000000,
        },
      ],
    };

    const destStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(destBoard));
    const transferId = "xfer-import-1";
    const importPayload = {
      transferId,
      sourceBoardId: "source-board-123",
      destinationColumnId: "col-dest",
      assigneeId: null,
      bundle,
    };

    for (const att of bundle.attachments) {
      const stageRes = await destStub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_BOARD_ID_HEADER]: destBoard,
          [INTERNAL_USER_ID_HEADER]: "test-user",
        },
        body: JSON.stringify({
          id: att.id,
          contentType: att.contentType,
          size: att.size,
        }),
      });
      expect(stageRes.status).toBe(204);
      await env.ATTACHMENTS.put(attachmentObjectKey(destBoard, att.id), Uint8Array.of(1, 2, 3));
    }

    const importRes = await destStub.fetch("https://board.internal/internal/card-transfer/import", {
      method: "POST",
      headers: await transferHeaders(destBoard),
      body: JSON.stringify(importPayload),
    });
    expect(importRes.status).toBe(200);
    const importData = await importRes.json<{
      receipt: { taskNumber: number; cardId: string; sourceBoardId: string; transferId: string };
      existingReceipt?: boolean;
    }>();
    expect(importData.receipt.taskNumber).toBe(2);
    expect(importData.existingReceipt).toBe(false);
    // WebSocket client receives fresh snapshot
    let receivedSnapshot: Extract<ServerMessage, { type: "snapshot" }> | undefined;
    while (!receivedSnapshot) {
      const frame = await destClient.next();
      if (frame.message.type === "snapshot") {
        receivedSnapshot = frame.message;
      }
    }

    const importedCard = receivedSnapshot.cards.find((c) => c.id === "transferred-card-uuid");
    expect(importedCard).toBeDefined();
    if (!importedCard) throw new Error("importedCard not found");
    expect(importedCard.taskNumber).toBe(2);
    expect(importedCard.columnId).toBe("col-dest");
    expect(importedCard.taskType).toBe("epic");
    expect(importedCard.assigneeId).toBeNull();

    // Verify label handling: exact match "Bug" reused "lbl-dest-bug", non-matching "Backend" got new id
    const bugLabel = receivedSnapshot.labels.find((l) => l.name === "Bug" && l.color === "red");
    expect(bugLabel?.id).toBe("lbl-dest-bug");

    const backendLabel = receivedSnapshot.labels.find((l) => l.name === "Backend");
    expect(backendLabel).toBeDefined();
    expect(backendLabel?.id).not.toBe("src-lbl-2");

    // Verify imported comments: root tombstone and replies preserved exactly with correct relationships and order
    const cardComments = receivedSnapshot.comments
      .filter((c) => c.cardId === "transferred-card-uuid")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    expect(cardComments).toHaveLength(3);
    expect(cardComments).toEqual([
      {
        id: "cmt-transferred-root",
        cardId: "transferred-card-uuid",
        authorId: "user-1",
        parentCommentId: null,
        deleted: true,
        body: "",
        createdAt: 1700000002000,
        updatedAt: 1700000002000,
      },
      {
        id: "cmt-transferred-rep1",
        cardId: "transferred-card-uuid",
        authorId: "user-2",
        parentCommentId: "cmt-transferred-root",
        deleted: false,
        body: "First transferred reply",
        createdAt: 1700000003000,
        updatedAt: 1700000003000,
      },
      {
        id: "cmt-transferred-rep2",
        cardId: "transferred-card-uuid",
        authorId: "user-1",
        parentCommentId: "cmt-transferred-root",
        deleted: false,
        body: "Second transferred reply",
        createdAt: 1700000004000,
        updatedAt: 1700000004000,
      },
    ]);
    const retryRes = await destStub.fetch("https://board.internal/internal/card-transfer/import", {
      method: "POST",
      headers: await transferHeaders(destBoard),
      body: JSON.stringify(importPayload),
    });
    expect(retryRes.status).toBe(200);
    const retryData = await retryRes.json<{
      receipt: { taskNumber: number; cardId: string };
      existingReceipt?: boolean;
    }>();
    expect(retryData.receipt.taskNumber).toBe(2);
    expect(retryData.existingReceipt).toBe(true);

    // Receipt-first check ensures retry succeeds even if destination column is deleted/archived
    destClient.send({
      type: "column.delete",
      mutationId: "dst-col-del-after-import",
      id: "col-dest",
    });
    await awaitBroadcast(destClient, "dst-col-del-after-import");

    const retryAfterColDeleteRes = await destStub.fetch("https://board.internal/internal/card-transfer/import", {
      method: "POST",
      headers: await transferHeaders(destBoard),
      body: JSON.stringify(importPayload),
    });
    expect(retryAfterColDeleteRes.status).toBe(200);
    const retryAfterColDeleteData = await retryAfterColDeleteRes.json<{
      receipt: { taskNumber: number };
      existingReceipt?: boolean;
    }>();
    expect(retryAfterColDeleteData.receipt.taskNumber).toBe(2);
    expect(retryAfterColDeleteData.existingReceipt).toBe(true);

    // Strict validation rejects malformed internal payloads
    const invalidPayloadRes = await destStub.fetch("https://board.internal/internal/card-transfer/import", {
      method: "POST",
      headers: await transferHeaders(destBoard),
      body: JSON.stringify({
        transferId: "xfer-invalid",
        sourceBoardId: "source-board-123",
        destinationColumnId: "col-dest",
        assigneeId: null,
        bundle: {
          ...bundle,
          checklistItems: [
            {
              id: "chk-wrong-card",
              cardId: "mismatched-card-id",
              text: "Invalid owner",
              completed: 0,
              position: "a0",
              createdAt: 1700000001000,
            },
          ],
        },
      }),
    });
    expect(invalidPayloadRes.status).toBe(400);
  });
  it("finalize cascades card aggregate, enqueues source R2 attachment cleanup, treats missing card as idempotent", async () => {
    const sourceBoard = "board-transfer-finalize";
    const client = await connect(sourceBoard);
    await snapshotOf(client);

    client.send({
      type: "column.create",
      mutationId: "fin-col",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(client, "fin-col");

    client.send({
      type: "card.create",
      mutationId: "fin-c1",
      id: "card-fin",
      columnId: "col-1",
      title: "Fin Card",
      position: "a0",
    });
    await awaitBroadcast(client, "fin-c1");

    const attachmentId = crypto.randomUUID();
    await stageAttachment(sourceBoard, attachmentId);
    client.send({
      type: "attachment.create",
      mutationId: "fin-att",
      id: attachmentId,
      cardId: "card-fin",
      fileName: "file.bin",
      contentType: "application/octet-stream",
      size: 3,
    });
    await awaitBroadcast(client, "fin-att");

    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(sourceBoard));
    const transferId = "xfer-fin-1";
    const destBoard = "board-transfer-finalize-dest";

    // Prepare to lock
    const prepRes = await stub.fetch("https://board.internal/internal/card-transfer/prepare", {
      method: "POST",
      headers: await transferHeaders(sourceBoard),
      body: JSON.stringify({ transferId, cardId: "card-fin", destinationBoardId: destBoard }),
    });
    expect(prepRes.status).toBe(200);

    // Finalize
    const finRes = await stub.fetch("https://board.internal/internal/card-transfer/finalize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: sourceBoard,
      },
      body: JSON.stringify({ transferId, cardId: "card-fin" }),
    });
    expect(finRes.status).toBe(200);

    // Socket receives snapshot without the card
    let snapAfterFin: Extract<ServerMessage, { type: "snapshot" }> | undefined;
    while (!snapAfterFin) {
      const frame = await client.next();
      if (frame.message.type === "snapshot") {
        snapAfterFin = frame.message;
      }
    }
    expect(snapAfterFin.cards.find((c) => c.id === "card-fin")).toBeUndefined();
    expect(snapAfterFin.attachments.find((a) => a.id === attachmentId)).toBeUndefined();

    // Attachment cleanup drains source R2 object
    const sourceObjectKey = attachmentObjectKey(sourceBoard, attachmentId);
    await expectObjectDeleted(sourceObjectKey);
    // Idempotent retry of finalize succeeds with 200
    const finRetryRes = await stub.fetch("https://board.internal/internal/card-transfer/finalize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: sourceBoard,
      },
      body: JSON.stringify({ transferId, cardId: "card-fin" }),
    });
    expect(finRetryRes.status).toBe(200);
  });
  it("end-to-end card transfer preserves non-default taskType from source prepare through destination import", async () => {
    const sourceBoard = "board-xfer-e2e-source";
    const destBoard = "board-xfer-e2e-dest";
    const sourceStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(sourceBoard));
    const destStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(destBoard));

    // Setup source board with column and non-default taskType card
    const sourceClient = await connect(sourceBoard);
    await snapshotOf(sourceClient);
    sourceClient.send({ type: "column.create", mutationId: "s-col", id: "col-src", title: "Backlog", position: "a0" });
    await awaitBroadcast(sourceClient, "s-col");

    sourceClient.send({ type: "card.create", mutationId: "s-card", id: "card-e2e-xfer", columnId: "col-src", title: "E2E Spike Card", position: "a0" });
    await awaitBroadcast(sourceClient, "s-card");

    sourceClient.send({ type: "card.retype", mutationId: "s-retype", id: "card-e2e-xfer", taskType: "spike" });
    await awaitBroadcast(sourceClient, "s-retype");

    // Setup destination board with column
    const destClient = await connect(destBoard);
    await snapshotOf(destClient);
    destClient.send({ type: "column.create", mutationId: "d-col", id: "col-dst", title: "Todo", position: "a0" });
    await awaitBroadcast(destClient, "d-col");

    // 1. Prepare on source board: extracts bundle directly from source DO storage
    const transferId = "xfer-e2e-spike-1";
    const prepRes = await sourceStub.fetch("https://board.internal/internal/card-transfer/prepare", {
      method: "POST",
      headers: await transferHeaders(sourceBoard),
      body: JSON.stringify({ transferId, cardId: "card-e2e-xfer", destinationBoardId: destBoard }),
    });
    expect(prepRes.status).toBe(200);
    const { bundle } = await prepRes.json<{ bundle: z.infer<typeof PreparedCardTransferBundleSchema> }>();
    expect(bundle.card.taskType).toBe("spike");

    // 2. Import into destination board: passes the exact prepared bundle from source
    const importRes = await destStub.fetch("https://board.internal/internal/card-transfer/import", {
      method: "POST",
      headers: await transferHeaders(destBoard),
      body: JSON.stringify({
        transferId,
        sourceBoardId: sourceBoard,
        destinationColumnId: "col-dst",
        assigneeId: null,
        bundle,
      }),
    });
    expect(importRes.status).toBe(200);

    // 3. Verify destination snapshot contains the imported card with preserved non-default taskType
    const destSnapshot = await snapshotOf(await connect(destBoard));
    const importedCard = destSnapshot.cards.find((c) => c.id === "card-e2e-xfer");
    expect(importedCard).toBeDefined();
    expect(importedCard?.taskType).toBe("spike");
    expect(importedCard?.title).toBe("E2E Spike Card");
    expect(importedCard?.columnId).toBe("col-dst");

    sourceClient.close();
    destClient.close();
  });
  it("expired lease import returns 409 and leaves card/checklist/attachment rows absent and task counter unchanged", async () => {
    const destBoard = "board-import-expired-lease";
    const destClient = await connect(destBoard);
    await snapshotOf(destClient);

    destClient.send({
      type: "column.create",
      mutationId: "c-dst",
      id: "col-dst",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(destClient, "c-dst");

    destClient.send({
      type: "card.create",
      mutationId: "card-init",
      id: "card-dest-existing",
      columnId: "col-dst",
      title: "Existing Card",
      position: "a0",
    });
    await awaitBroadcast(destClient, "card-init");

    const destStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(destBoard));
    const initialTaskNumber = await runInDurableObject(destStub, (_instance, state) =>
      state.storage.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'next_task_number'").toArray()[0]?.value,
    );
    expect(initialTaskNumber).toBe(2);

    const cardId = "transferred-expired-card";
    const attachmentId = "00000000-0000-4000-8000-0000000000ee";
    const checkId = "chk-expired-1";
    const transferId = "xfer-expired-lease-1";
    const transferKey = attachmentTransferObjectKey(destBoard, transferId, attachmentId);

    const bundle = {
      card: {
        id: cardId,
        columnId: "col-dst",
        title: "Card with expired attachment lease",
        description: "Must be completely rolled back",
        position: "a0",
        taskNumber: 1,
        priority: "high" as const,
        taskType: "task" as const,
        dueDate: null,
        subtaskDone: false,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        assigneeId: null,
      },
      checklistItems: [
        {
          id: checkId,
          cardId,
          text: "Checklist item that must not persist",
          done: false,
          position: "a0",
        },
      ],
      comments: [],
      attachments: [
        {
          id: attachmentId,
          cardId,
          fileName: "expired.pdf",
          contentType: "application/pdf",
          size: 2048,
          objectKey: transferKey,
        },
      ],
      labels: [],
      activities: [],
      pullRequestAssociation: null,
      developmentPullRequests: [],
      developmentBranches: [],
      developmentUnlinks: [],
    };

    // Stage the attachment, but expire its lease immediately in SQLite
    const stageRes = await destStub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: destBoard,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({
        id: attachmentId,
        contentType: "application/pdf",
        size: 2048,
        objectKey: transferKey,
      }),
    });
    expect(stageRes.status).toBe(204);

    // Expire the staging lease
    await runInDurableObject(destStub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = ? WHERE object_key = ?",
        Date.now() - 5000,
        transferKey,
      );
    });

    // Attempt import with expired lease
    const importRes = await destStub.fetch("https://board.internal/internal/card-transfer/import", {
      method: "POST",
      headers: await transferHeaders(destBoard),
      body: JSON.stringify({
        transferId,
        sourceBoardId: "source-board-123",
        destinationColumnId: "col-dst",
        assigneeId: null,
        bundle,
      }),
    });
    expect(importRes.status).toBe(409);
    const errData = await importRes.json<{ error: string }>();
    expect(errData.error).toBe("attachment staging lease expired before import");

    // Assert atomic rollback in SQLite storage: card, checklist, attachment rows are completely absent
    const storageState = await runInDurableObject(destStub, (_instance, state) => {
      const sql = state.storage.sql;
      return {
        cardCount: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM cards WHERE id = ?", cardId).toArray()[0]?.count,
        checklistCount: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM checklist_items WHERE id = ?", checkId).toArray()[0]?.count,
        attachmentCount: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM attachments WHERE id = ?", attachmentId).toArray()[0]?.count,
        receiptCount: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM card_transfer_receipts WHERE transfer_id = ?", transferId).toArray()[0]?.count,
        nextTaskNumber: sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'next_task_number'").toArray()[0]?.value,
      };
    });

    expect(storageState.cardCount).toBe(0);
    expect(storageState.checklistCount).toBe(0);
    expect(storageState.attachmentCount).toBe(0);
    expect(storageState.receiptCount).toBe(0);
    expect(storageState.nextTaskNumber).toBe(2);

    destClient.close();
  });
  it("fresh transfer U import consumes only U's scoped lease and aborted T's exact scoped key remains for eventual cleanup/deletion", async () => {
    const destBoard = "board-transfer-u-consumes-only-u";
    const destStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(destBoard));
    const destClient = await connect(destBoard);
    await snapshotOf(destClient);

    destClient.send({
      type: "column.create",
      mutationId: "dst-col",
      id: "col-dst",
      title: "Dest Column",
      position: "a0",
    });
    await awaitBroadcast(destClient, "dst-col");

    const attId = "00000000-0000-4000-8000-0000000000c7";
    const transferIdT = "00000000-0000-4000-8000-000000000001";
    const transferIdU = "00000000-0000-4000-8000-000000000002";

    const keyT = attachmentTransferObjectKey(destBoard, transferIdT, attId);
    const keyU = attachmentTransferObjectKey(destBoard, transferIdU, attId);

    // Stage both T and U in destination board
    const stageResT = await destStub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: destBoard,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({
        id: attId,
        contentType: "image/png",
        size: 10,
        objectKey: keyT,
      }),
    });
    expect(stageResT.status).toBe(204);
    await env.ATTACHMENTS.put(keyT, Uint8Array.of(10, 20, 30));

    const stageResU = await destStub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: destBoard,
        [INTERNAL_USER_ID_HEADER]: "test-user",
      },
      body: JSON.stringify({
        id: attId,
        contentType: "image/png",
        size: 10,
        objectKey: keyU,
      }),
    });
    expect(stageResU.status).toBe(204);
    await env.ATTACHMENTS.put(keyU, Uint8Array.of(40, 50, 60));

    // Prepare import bundle for transfer U
    const bundle = {
      card: {
        id: "transferred-card-u",
        columnId: "col-dst",
        title: "Card U",
        description: "Transferred card",
        position: "a0",
        taskNumber: 1,
        priority: "medium" as const,
        taskType: "task" as const,
        dueDate: null,
        subtaskDone: false,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        assigneeId: null,
      },
      checklistItems: [],
      comments: [],
      attachments: [
        {
          id: attId,
          cardId: "transferred-card-u",
          fileName: "file.png",
          contentType: "image/png",
          size: 10,
          objectKey: `source-board-u/${attId}`,
        },
      ],
      labels: [],
      activities: [],
      pullRequestAssociation: null,
      developmentPullRequests: [],
      developmentBranches: [],
      developmentUnlinks: [],
    };

    // Import transfer U
    const importRes = await destStub.fetch("https://board.internal/internal/card-transfer/import", {
      method: "POST",
      headers: await transferHeaders(destBoard),
      body: JSON.stringify({
        transferId: transferIdU,
        sourceBoardId: "source-board-u",
        destinationColumnId: "col-dst",
        assigneeId: null,
        bundle,
      }),
    });
    expect(importRes.status).toBe(200);

    // Verify destination storage:
    // 1. attachments table has the card's attachment pointing to keyU
    // 2. attachment_cleanup NO LONGER has keyU (it was consumed)
    // 3. attachment_cleanup STILL HAS keyT (it was preserved and not purged by U's import)
    const cleanupState = await runInDurableObject(destStub, (_instance, state) => {
      const sql = state.storage.sql;
      return {
        attObjectKey: sql
          .exec<{ object_key: string }>("SELECT object_key FROM attachments WHERE id = ?", attId)
          .toArray()[0]?.object_key,
        cleanupRows: sql
          .exec<{ objectKey: string; reason: string }>(
            "SELECT object_key AS objectKey, reason FROM attachment_cleanup ORDER BY object_key",
          )
          .toArray(),
      };
    });

    expect(cleanupState.attObjectKey).toBe(keyU);
    expect(cleanupState.cleanupRows).toEqual([{ objectKey: keyT, reason: "staged" }]);

    // Both R2 objects are still present in storage
    expect(await env.ATTACHMENTS.head(keyT)).not.toBeNull();
    expect(await env.ATTACHMENTS.head(keyU)).not.toBeNull();

    // Now simulate T's staging lease expiring
    await runInDurableObject(destStub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = ? WHERE object_key = ?",
        Date.now() - 1,
        keyT,
      );
    });

    // Run alarm to drain expired cleanup
    await runInDurableObject(destStub, async (instance) => {
      const testInstance = asBoardDOWithBucket(instance);
      await testInstance.alarm();
    });

    // T's exact transfer-scoped key is deleted from R2 and cleanup queue
    await expectObjectDeleted(keyT);
    const finalCleanup = await runInDurableObject(destStub, (_instance, state) =>
      state.storage.sql
        .exec<{ objectKey: string; reason: string; deletedAt: number | null }>(
          "SELECT object_key AS objectKey, reason, deleted_at AS deletedAt FROM attachment_cleanup WHERE object_key = ?",
          keyT,
        )
        .toArray()[0],
    );
    expect(finalCleanup).toEqual({
      objectKey: keyT,
      reason: "deleted",
      deletedAt: expect.any(Number),
    });
    expect(finalCleanup?.deletedAt).not.toBeNull();

    // U's transfer-scoped key is completely intact in R2 and attachments table
    expect(await env.ATTACHMENTS.head(keyU)).not.toBeNull();
    const finalAtt = await runInDurableObject(destStub, (_instance, state) =>
      state.storage.sql
        .exec<{ object_key: string }>("SELECT object_key FROM attachments WHERE id = ?", attId)
        .toArray()[0]?.object_key,
    );
    expect(finalAtt).toBe(keyU);

    await env.ATTACHMENTS.delete(keyU);
    destClient.close();
  });

  it("destination-less legacy release returns 409 and retains lock", async () => {
    const board = "board-legacy-release-test";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const client = await connect(board);
    await snapshotOf(client);

    client.send({ type: "column.create", mutationId: "c-leg", id: "col-leg", title: "Legacy Col", position: "a0" });
    await awaitBroadcast(client, "c-leg");
    client.send({ type: "card.create", mutationId: "card-leg", id: "card-leg-1", columnId: "col-leg", title: "Legacy Card", position: "a0" });
    await awaitBroadcast(client, "card-leg");

    const transferId = "xfer-legacy-rel-1";
    const now = Date.now();

    // Insert legacy lock with empty destination_board_id (as produced by v16 migration)
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO card_transfer_locks(card_id, transfer_id, destination_board_id, phase, expires_at)
         VALUES ('card-leg-1', ?, '', 'prepared', ?)`,
        transferId,
        now + 300_000,
      );
    });

    // Release request WITHOUT destinationBoardId returns 409
    const relRes = await stub.fetch("https://board.internal/internal/card-transfer/release", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
      },
      body: JSON.stringify({
        transferId,
        cardId: "card-leg-1",
      }),
    });
    expect(relRes.status).toBe(409);
    const relData = await relRes.json<{ error: string }>();
    expect(relData.error).toBe("destination board identity unknown; lock retained");

    // Lock remains intact in SQLite storage
    const lockRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ transfer_id: string }>(
        "SELECT transfer_id FROM card_transfer_locks WHERE card_id = 'card-leg-1'",
      ).toArray()[0],
    );
    expect(lockRow?.transfer_id).toBe(transferId);

    // Card remains fenced against mutations
    client.send({
      type: "card.update",
      mutationId: "mut-fenced-update",
      id: "card-leg-1",
      title: "Mutated while fenced",
    });
    const err = await awaitError(client, "mut-fenced-update");
    expect(err.message).toBe("card transfer in progress");

    client.close();
  });

  it("establishing board identity via HTTP wakes expired legacy recovery", async () => {
    const sourceBoard = "board-legacy-rec-src";
    const destBoard = "board-legacy-rec-dst";

    // Ensure both boards and their owner exist in D1 so cross-board candidate
    // queries, and the ownership trigger, both succeed.
    await seedIdentity(sourceBoard, "owner-1");
    await seedIdentity(destBoard, "owner-1");
    const destClient = await connect(destBoard);
    await snapshotOf(destClient);
    destClient.send({ type: "column.create", mutationId: "c-dst", id: "col-dst", title: "Dst Col", position: "a0" });
    await awaitBroadcast(destClient, "c-dst");

    const sourceStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(sourceBoard));
    const sourceClient = await connect(sourceBoard);
    await snapshotOf(sourceClient);
    sourceClient.send({ type: "column.create", mutationId: "c-src", id: "col-src", title: "Src Col", position: "a0" });
    await awaitBroadcast(sourceClient, "c-src");
    sourceClient.send({ type: "card.create", mutationId: "c-card", id: "card-rec-1", columnId: "col-src", title: "Rec Card", position: "a0" });
    await awaitBroadcast(sourceClient, "c-card");

    const transferId = "xfer-legacy-rec-1";
    const now = Date.now();

    // Setup an expired legacy lock without destination_board_id and clear meta.board_id
    await runInDurableObject(sourceStub, (_instance, state) => {
      // Remove board_id from meta to simulate a DO that hasn't established its board identity
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'board_id'");
      // Insert expired legacy lock
      state.storage.sql.exec(
        `INSERT INTO card_transfer_locks(card_id, transfer_id, destination_board_id, phase, expires_at)
         VALUES ('card-rec-1', ?, '', 'prepared', ?)`,
        transferId,
        now - 10_000,
      );
      // Delete any pre-existing alarm
      state.storage.deleteAlarm();
    });

    // Verify initial preconditions: board_id missing, lock is present
    const preCheck = await runInDurableObject(sourceStub, (_instance, state) => ({
      boardId: state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'board_id'").toArray()[0]?.value,
      lockCount: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM card_transfer_locks WHERE card_id = 'card-rec-1'").toArray()[0]?.count,
    }));
    expect(preCheck.boardId).toBeUndefined();
    expect(preCheck.lockCount).toBe(1);

    // Send HTTP request that sets INTERNAL_BOARD_ID_HEADER, establishing board identity
    const reqRes = await sourceStub.fetch("https://board.internal/internal/attachments/key/00000000-0000-4000-8000-000000000000", {
      headers: {
        [INTERNAL_BOARD_ID_HEADER]: sourceBoard,
      },
    });
    expect(reqRes.status).toBe(404);

    // The HTTP request establishes meta.board_id, schedules alarm at Date.now(), and executes recoverExpiredTransferLocks
    // Verify meta.board_id was populated
    const postBoardId = await runInDurableObject(sourceStub, (_instance, state) =>
      state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'board_id'").toArray()[0]?.value,
    );
    expect(postBoardId).toBe(sourceBoard);

    // The HTTP request establishes meta.board_id and immediately wakes recovery for the expired legacy lock
    // If not already settled by waitUntil, running alarm ensures completion
    await runInDurableObject(sourceStub, async (instance) => {
      await instance.alarm();
    });

    const postLockCount = await runInDurableObject(sourceStub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM card_transfer_locks WHERE card_id = 'card-rec-1'").toArray()[0]?.count,
    );
    expect(postLockCount).toBe(0);
    // Card is unfenced: mutations now succeed
    sourceClient.send({
      type: "card.update",
      mutationId: "mut-unfenced",
      id: "card-rec-1",
      title: "Successfully unfenced after recovery",
    });
    await awaitBroadcast(sourceClient, "mut-unfenced");

    sourceClient.close();
    destClient.close();
  });
});

describe("column.move protocol and persistence lifecycle", () => {
  it("broadcasts verbatim to all clients, persists position in D1/SQLite across restart, and works beside transfer-locked and archived cards", async () => {
    const board = "board-col-move-test";
    const a = await connect(board, "user-a");
    const b = await connect(board, "user-b");
    await snapshotOf(a);
    await snapshotOf(b);

    // Create two columns
    a.send({
      type: "column.create",
      mutationId: "cm-c1",
      id: "col-1",
      title: "Column 1",
      position: "a0",
    });
    await awaitBroadcast(a, "cm-c1");
    await awaitBroadcast(b, "cm-c1");

    a.send({
      type: "column.create",
      mutationId: "cm-c2",
      id: "col-2",
      title: "Column 2",
      position: "a1",
    });
    await awaitBroadcast(a, "cm-c2");
    await awaitBroadcast(b, "cm-c2");

    // Add card to col-1
    a.send({
      type: "card.create",
      mutationId: "cm-card1",
      id: "card-1",
      columnId: "col-1",
      title: "Card 1",
      position: "a0",
    });
    await awaitBroadcast(a, "cm-card1");
    await awaitBroadcast(b, "cm-card1");
    // card.create triggers server-authored card.numbered and activity.recorded frames;
    // drain them from both clients' queues so the next frame is column.move
    await a.next(); // card.numbered
    await a.next(); // activity.recorded
    await b.next(); // card.numbered
    await b.next(); // activity.recorded

    // Client sends column.move verbatim
    const moveMsg = {
      type: "column.move" as const,
      mutationId: "cm-move-1",
      id: "col-1",
      position: "a2",
    };
    const rawMove = JSON.stringify(moveMsg);
    a.sendRaw(rawMove);

    // Both a and b receive verbatim broadcast
    const frameA = await a.next();
    expect(frameA.raw).toBe(rawMove);
    expect(frameA.message).toEqual(moveMsg);

    const frameB = await b.next();
    expect(frameB.raw).toBe(rawMove);
    expect(frameB.message).toEqual(moveMsg);

    // Verify SQLite position in DO
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const posAfter = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ id: string; position: string }>("SELECT id, position FROM columns WHERE id = 'col-1'")
        .toArray(),
    );
    expect(posAfter[0]?.position).toBe("a2");

    // Restart DO and verify persistence of new position
    a.close();
    b.close();
    await expect(
      runInDurableObject(stub, (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();

    const c = await connect(board, "user-c");
    const snap = await snapshotOf(c);
    const restoredCol1 = snap.columns.find((col) => col.id === "col-1");
    expect(restoredCol1?.position).toBe("a2");
    const restoredCol2 = snap.columns.find((col) => col.id === "col-2");
    expect(restoredCol2?.position).toBe("a1");
  });
});

describe("F2/F7: card transfer lock and receipt lifecycle regression", () => {
  it("blocks writes while any transfer lock exists, even if expired", async () => {
    const board = "board-f2-expired-lock";
    const client = await connect(board);
    await snapshotOf(client);

    client.send({ type: "column.create", mutationId: "f2-c1", id: "col-1", title: "Col", position: "a0" });
    await awaitBroadcast(client, "f2-c1");
    client.send({ type: "card.create", mutationId: "f2-card1", id: "card-f2-1", columnId: "col-1", title: "Initial Title", position: "a0" });
    await awaitBroadcast(client, "f2-card1");

    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const prepRes = await stub.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
      method: "POST",
      headers: await transferHeaders(board),
      body: JSON.stringify({ transferId: "xfer-f2-test", cardId: "card-f2-1", destinationBoardId: "dest-board" }),
    });
    expect(prepRes.status).toBe(200);

    // Force the lock to be expired in storage
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE card_transfer_locks SET expires_at = ? WHERE card_id = 'card-f2-1'",
        Date.now() - 100_000,
      );
    });

    // Writes must remain blocked while any lock row exists
    client.send({
      type: "card.update",
      mutationId: "mut-f2-up-fail",
      id: "card-f2-1",
      title: "New Title While Lock Expired",
    });
    const upErr = await awaitError(client, "mut-f2-up-fail");
    expect(upErr.message).toBe("card transfer in progress");

    client.send({
      type: "card.move",
      mutationId: "mut-f2-mv-fail",
      id: "card-f2-1",
      columnId: "col-1",
      position: "a99",
    });
    const mvErr = await awaitError(client, "mut-f2-mv-fail");
    expect(mvErr.message).toBe("card transfer in progress");

    client.close();
  });

  it("recovers expired transfer for committed destination by deleting source aggregate", async () => {
    const srcBoard = "board-f2-comm-src";
    const dstBoard = "board-f2-comm-dst";
    const srcStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(srcBoard));
    const dstStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(dstBoard));

    const srcClient = await connect(srcBoard);
    await snapshotOf(srcClient);
    srcClient.send({ type: "column.create", mutationId: "s-c", id: "sc-1", title: "Backlog", position: "a0" });
    await awaitBroadcast(srcClient, "s-c");
    srcClient.send({ type: "card.create", mutationId: "s-k", id: "card-comm-1", columnId: "sc-1", title: "Committed Card", position: "a0" });
    await awaitBroadcast(srcClient, "s-k");

    const dstClient = await connect(dstBoard);
    await snapshotOf(dstClient);
    dstClient.send({ type: "column.create", mutationId: "d-c", id: "dc-1", title: "Todo", position: "a0" });
    await awaitBroadcast(dstClient, "d-c");

    const transferId = "xfer-comm-exp-1";
    const prepRes = await srcStub.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
      method: "POST",
      headers: await transferHeaders(srcBoard),
      body: JSON.stringify({ transferId, cardId: "card-comm-1", destinationBoardId: dstBoard }),
    });
    const { bundle } = await prepRes.json<{ bundle: z.infer<typeof PreparedCardTransferBundleSchema> }>();

    const importRes = await dstStub.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
      method: "POST",
      headers: await transferHeaders(dstBoard),
      body: JSON.stringify({
        transferId,
        sourceBoardId: srcBoard,
        destinationColumnId: "dc-1",
        assigneeId: null,
        bundle,
      }),
    });
    expect(importRes.status).toBe(200);

    // Advance source lock timestamp to the past
    await runInDurableObject(srcStub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE card_transfer_locks SET expires_at = ? WHERE card_id = 'card-comm-1'",
        Date.now() - 100_000,
      );
    });

    // Trigger alarm on source DO to run recoverExpiredTransferLocks
    await runInDurableObject(srcStub, async (instance) => {
      await instance.alarm();
    });

    // Source aggregate and lock are cleaned up
    const srcCards = await runInDurableObject(srcStub, (_instance, state) =>
      state.storage.sql.exec("SELECT id FROM cards WHERE id = 'card-comm-1'").toArray(),
    );
    expect(srcCards).toHaveLength(0);
    const srcLocks = await runInDurableObject(srcStub, (_instance, state) =>
      state.storage.sql.exec("SELECT card_id FROM card_transfer_locks WHERE card_id = 'card-comm-1'").toArray(),
    );
    expect(srcLocks).toHaveLength(0);

    // Destination card survives intact
    const dstCards = await runInDurableObject(dstStub, (_instance, state) =>
      state.storage.sql.exec<{ id: string }>("SELECT id FROM cards WHERE id = 'card-comm-1'").toArray(),
    );
    expect(dstCards).toHaveLength(1);

    srcClient.close();
    dstClient.close();
  });

  it("recovers expired transfer for uncommitted destination by clearing lock and keeping source card intact", async () => {
    const srcBoard = "board-f2-uncomm-src";
    const dstBoard = "board-f2-uncomm-dst";
    const srcStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(srcBoard));

    const srcClient = await connect(srcBoard);
    await snapshotOf(srcClient);
    srcClient.send({ type: "column.create", mutationId: "su-c", id: "suc-1", title: "Backlog", position: "a0" });
    await awaitBroadcast(srcClient, "su-c");
    srcClient.send({ type: "card.create", mutationId: "su-k", id: "card-uncomm-1", columnId: "suc-1", title: "Safe Source Card", position: "a0" });
    await awaitBroadcast(srcClient, "su-k");

    const dstClient = await connect(dstBoard);
    await snapshotOf(dstClient);
    dstClient.send({ type: "column.create", mutationId: "du-c", id: "duc-1", title: "Todo", position: "a0" });
    await awaitBroadcast(dstClient, "du-c");

    // Prepare transfer but NEVER call import on destination
    const transferId = "xfer-uncomm-exp-1";
    await srcStub.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
      method: "POST",
      headers: await transferHeaders(srcBoard),
      body: JSON.stringify({ transferId, cardId: "card-uncomm-1", destinationBoardId: dstBoard }),
    });

    // Advance source lock timestamp to the past
    await runInDurableObject(srcStub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE card_transfer_locks SET expires_at = ? WHERE card_id = 'card-uncomm-1'",
        Date.now() - 100_000,
      );
    });

    // Trigger alarm on source DO
    await runInDurableObject(srcStub, async (instance) => {
      await instance.alarm();
    });

    // Source lock is cleared, but source card is PRESERVED
    const srcLocks = await runInDurableObject(srcStub, (_instance, state) =>
      state.storage.sql.exec("SELECT card_id FROM card_transfer_locks WHERE card_id = 'card-uncomm-1'").toArray(),
    );
    expect(srcLocks).toHaveLength(0);

    const srcCards = await runInDurableObject(srcStub, (_instance, state) =>
      state.storage.sql.exec<{ id: string; title: string }>("SELECT id, title FROM cards WHERE id = 'card-uncomm-1'").toArray(),
    );
    expect(srcCards).toHaveLength(1);
    expect(srcCards[0]?.title).toBe("Safe Source Card");

    // Card can now be edited again
    srcClient.send({
      type: "card.update",
      mutationId: "mut-after-uncomm-recover",
      id: "card-uncomm-1",
      title: "Updated After Uncommitted Recovery",
    });
    await awaitBroadcast(srcClient, "mut-after-uncomm-recover");

    srcClient.close();
    dstClient.close();
  });

  it("supports same transfer retry across prepare, import, and finalize idempotently", async () => {
    const srcBoard = "board-f2-retry-src";
    const dstBoard = "board-f2-retry-dst";
    const srcStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(srcBoard));
    const dstStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(dstBoard));

    const srcClient = await connect(srcBoard);
    await snapshotOf(srcClient);
    srcClient.send({ type: "column.create", mutationId: "sr-c", id: "src-1", title: "Backlog", position: "a0" });
    await awaitBroadcast(srcClient, "sr-c");
    srcClient.send({ type: "card.create", mutationId: "sr-k", id: "card-retry-1", columnId: "src-1", title: "Retry Card", position: "a0" });
    await awaitBroadcast(srcClient, "sr-k");

    const dstClient = await connect(dstBoard);
    await snapshotOf(dstClient);
    dstClient.send({ type: "column.create", mutationId: "dr-c", id: "drc-1", title: "Todo", position: "a0" });
    await awaitBroadcast(dstClient, "dr-c");

    const transferId = "xfer-retry-idempotent-1";
    const prepRes1 = await srcStub.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
      method: "POST",
      headers: await transferHeaders(srcBoard),
      body: JSON.stringify({ transferId, cardId: "card-retry-1", destinationBoardId: dstBoard }),
    });
    expect(prepRes1.status).toBe(200);
    const { bundle } = await prepRes1.json<{ bundle: z.infer<typeof PreparedCardTransferBundleSchema> }>();

    // Retry prepare with same transferId
    const prepRes2 = await srcStub.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
      method: "POST",
      headers: await transferHeaders(srcBoard),
      body: JSON.stringify({ transferId, cardId: "card-retry-1", destinationBoardId: dstBoard }),
    });
    expect(prepRes2.status).toBe(200);

    // Import into destination
    const importPayload = {
      transferId,
      sourceBoardId: srcBoard,
      destinationColumnId: "drc-1",
      assigneeId: null,
      bundle,
    };
    const importRes1 = await dstStub.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
      method: "POST",
      headers: await transferHeaders(dstBoard),
      body: JSON.stringify(importPayload),
    });
    expect(importRes1.status).toBe(200);

    // Retry import with same transferId
    const importRes2 = await dstStub.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
      method: "POST",
      headers: await transferHeaders(dstBoard),
      body: JSON.stringify(importPayload),
    });
    expect(importRes2.status).toBe(200);
    const importBody2 = await importRes2.json<{ existingReceipt?: boolean }>();
    expect(importBody2.existingReceipt).toBe(true);

    // Finalize on source
    const finRes1 = await srcStub.fetch(`https://board.internal${CARD_TRANSFER_FINALIZE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: srcBoard },
      body: JSON.stringify({ transferId, cardId: "card-retry-1" }),
    });
    expect(finRes1.status).toBe(200);

    // Retry finalize on source
    const finRes2 = await srcStub.fetch(`https://board.internal${CARD_TRANSFER_FINALIZE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: srcBoard },
      body: JSON.stringify({ transferId, cardId: "card-retry-1" }),
    });
    expect(finRes2.status).toBe(200);

    srcClient.close();
    dstClient.close();
  });

  it("allows cyclic transfers A→B→A→B with distinct transfer IDs without receipt conflict", async () => {
    const boardA = "board-f7-cycle-a";
    const boardB = "board-f7-cycle-b";
    const stubA = env.BOARD_DO.get(env.BOARD_DO.idFromName(boardA));
    const stubB = env.BOARD_DO.get(env.BOARD_DO.idFromName(boardB));

    const clientA = await connect(boardA);
    await snapshotOf(clientA);
    clientA.send({ type: "column.create", mutationId: "ca-1", id: "col-a", title: "A Col", position: "a0" });
    await awaitBroadcast(clientA, "ca-1");
    clientA.send({ type: "card.create", mutationId: "ca-card", id: "card-cycle", columnId: "col-a", title: "Cyclic Card", position: "a0" });
    await awaitBroadcast(clientA, "ca-card");

    const clientB = await connect(boardB);
    await snapshotOf(clientB);
    clientB.send({ type: "column.create", mutationId: "cb-1", id: "col-b", title: "B Col", position: "a0" });
    await awaitBroadcast(clientB, "cb-1");

    // Transfer 1: A -> B with transferId "cycle-xfer-1"
    const p1 = await stubA.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
      method: "POST",
      headers: await transferHeaders(boardA),
      body: JSON.stringify({ transferId: "cycle-xfer-1", cardId: "card-cycle", destinationBoardId: boardB }),
    });
    const { bundle: b1 } = await p1.json<{ bundle: z.infer<typeof PreparedCardTransferBundleSchema> }>();
    const i1 = await stubB.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
      method: "POST",
      headers: await transferHeaders(boardB),
      body: JSON.stringify({ transferId: "cycle-xfer-1", sourceBoardId: boardA, destinationColumnId: "col-b", assigneeId: null, bundle: b1 }),
    });
    expect(i1.status).toBe(200);
    const f1 = await stubA.fetch(`https://board.internal${CARD_TRANSFER_FINALIZE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: boardA },
      body: JSON.stringify({ transferId: "cycle-xfer-1", cardId: "card-cycle" }),
    });
    expect(f1.status).toBe(200);

    // Transfer 2: B -> A with transferId "cycle-xfer-2"
    const p2 = await stubB.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
      method: "POST",
      headers: await transferHeaders(boardB),
      body: JSON.stringify({ transferId: "cycle-xfer-2", cardId: "card-cycle", destinationBoardId: boardA }),
    });
    const { bundle: b2 } = await p2.json<{ bundle: z.infer<typeof PreparedCardTransferBundleSchema> }>();
    const i2 = await stubA.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
      method: "POST",
      headers: await transferHeaders(boardA),
      body: JSON.stringify({ transferId: "cycle-xfer-2", sourceBoardId: boardB, destinationColumnId: "col-a", assigneeId: null, bundle: b2 }),
    });
    expect(i2.status).toBe(200);
    const f2 = await stubB.fetch(`https://board.internal${CARD_TRANSFER_FINALIZE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: boardB },
      body: JSON.stringify({ transferId: "cycle-xfer-2", cardId: "card-cycle" }),
    });
    expect(f2.status).toBe(200);

    // Transfer 3: A -> B again with transferId "cycle-xfer-3"
    // Under the F7 defect, B would reject this with 409 because of historical receipt for (boardA, card-cycle).
    const p3 = await stubA.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
      method: "POST",
      headers: await transferHeaders(boardA),
      body: JSON.stringify({ transferId: "cycle-xfer-3", cardId: "card-cycle", destinationBoardId: boardB }),
    });
    const { bundle: b3 } = await p3.json<{ bundle: z.infer<typeof PreparedCardTransferBundleSchema> }>();
    const i3 = await stubB.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
      method: "POST",
      headers: await transferHeaders(boardB),
      body: JSON.stringify({ transferId: "cycle-xfer-3", sourceBoardId: boardA, destinationColumnId: "col-b", assigneeId: null, bundle: b3 }),
    });
    expect(i3.status).toBe(200);
    const f3 = await stubA.fetch(`https://board.internal${CARD_TRANSFER_FINALIZE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: boardA },
      body: JSON.stringify({ transferId: "cycle-xfer-3", cardId: "card-cycle" }),
    });
    expect(f3.status).toBe(200);

    // Verify card is on Board B and not on Board A
    const bCards = await runInDurableObject(stubB, (_instance, state) =>
      state.storage.sql.exec<{ id: string }>("SELECT id FROM cards WHERE id = 'card-cycle'").toArray(),
    );
    expect(bCards).toHaveLength(1);

    const aCards = await runInDurableObject(stubA, (_instance, state) =>
      state.storage.sql.exec<{ id: string }>("SELECT id FROM cards WHERE id = 'card-cycle'").toArray(),
    );
    expect(aCards).toHaveLength(0);

    clientA.close();
    clientB.close();
  });
});

describe("F4/F6: explicit imported object keys and deletion queueing", () => {
  it("preserves explicit imported objectKey and queues it on deletion", async () => {
    const board = "board-f6-explicit";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const client = await connect(board);
    await snapshotOf(client);

    client.send({ type: "column.create", mutationId: "f6-c", id: "f6-col", title: "Col", position: "a0" });
    await awaitBroadcast(client, "f6-c");

    const attachmentId = "00000000-0000-4000-8000-0000000000f6";
    const explicitObjectKey = attachmentObjectKey(board, attachmentId);
    const bundle = {
      card: {
        id: "card-f6-att",
        columnId: "source-col",
        title: "Card with Imported Att",
        description: "",
        position: "a0",
        taskNumber: 1,
        assigneeId: null,
        priority: "medium" as const,
        taskType: "task" as const,
        dueDate: null,
        subtaskDone: false,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
      checklistItems: [],
      comments: [],
      attachments: [
        {
          id: attachmentId,
          cardId: "card-f6-att",
          fileName: "photo.png",
          contentType: "image/png",
          size: 2048,
          objectKey: explicitObjectKey,
        },
      ],
      labels: [],
      activities: [],
      pullRequestAssociation: null,
      developmentPullRequests: [],
      developmentBranches: [],
      developmentUnlinks: [],
    };

    for (const att of bundle.attachments) {
      const stageRes = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_BOARD_ID_HEADER]: board,
          [INTERNAL_USER_ID_HEADER]: "test-user",
        },
        body: JSON.stringify({
          id: att.id,
          contentType: att.contentType,
          size: att.size,
        }),
      });
      expect(stageRes.status).toBe(204);
      await env.ATTACHMENTS.put(att.objectKey, Uint8Array.of(1, 2, 3));
    }

    const importRes = await stub.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
      method: "POST",
      headers: await transferHeaders(board),
      body: JSON.stringify({
        transferId: "xfer-f6-import",
        sourceBoardId: "source-f6-board",
        destinationColumnId: "f6-col",
        assigneeId: null,
        bundle,
      }),
    });
    expect(importRes.status).toBe(200);

    // F6 assertion: explicit imported object key is NOT overwritten with NULL
    const attRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ object_key: string | null }>("SELECT object_key FROM attachments WHERE id = ?", attachmentId)
        .toArray()[0],
    );
    expect(attRow?.object_key).toBe(explicitObjectKey);

    // Deletion queues the exact explicit key in attachment_cleanup
    await runInDurableObject(stub, (instance) => {
      const testInstance = instance as unknown as { attachmentBucket: R2Bucket };
      const originalBucket = testInstance.attachmentBucket;
      testInstance.attachmentBucket = new Proxy(originalBucket, {
        get(target, prop, receiver) {
          if (prop === "delete") {
            return async () => {
              throw new Error("simulated R2 failure");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    });
    client.send({
      type: "attachment.delete",
      mutationId: "mut-f6-del-att",
      id: attachmentId,
    });
    await awaitBroadcast(client, "mut-f6-del-att");

    const cleanupRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ object_key: string; reason: string }>(
          "SELECT object_key, reason FROM attachment_cleanup WHERE attachment_id = ?",
          attachmentId,
        )
        .toArray()[0],
    );
    expect(cleanupRow?.object_key).toBe(explicitObjectKey);
    expect(cleanupRow?.reason).toBe("deleted");

    client.close();
  });
});

describe("F8: rejects card create and move targeting nonexistent columns", () => {
  it("rejects card.create targeting a missing column without persisting an invisible card", async () => {
    const board = "board-f8-create-test";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const client = await connect(board);
    await snapshotOf(client);

    client.send({
      type: "card.create",
      mutationId: "mut-f8-create-fail",
      id: "invisible-card-1",
      columnId: "missing-col-uuid",
      title: "Phantom Card",
      position: "a0",
    });

    const err = await awaitError(client, "mut-f8-create-fail");
    expect(err.message).toBe("destination column does not exist");

    // Verify card was not persisted in SQLite storage
    const cardRows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT id FROM cards WHERE id = 'invisible-card-1'").toArray(),
    );
    expect(cardRows).toHaveLength(0);

    // The refused create consumed no task number: the next accepted card is first.
    client.send({
      type: "column.create",
      mutationId: "f8-create-col",
      id: "col-after-failure",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(client, "f8-create-col");
    client.send({
      type: "card.create",
      mutationId: "f8-create-retry",
      id: "visible-card-1",
      columnId: "col-after-failure",
      title: "First real card",
      position: "a0",
    });
    const numbered = await awaitMatching(
      client,
      (message): message is Extract<ServerMessage, { type: "card.numbered" }> =>
        message.type === "card.numbered" && message.id === "visible-card-1",
    );
    expect(numbered.taskNumber).toBe(1);

    client.close();
  });

  it("rejects card.move targeting a missing column without moving the card", async () => {
    const board = "board-f8-move-test";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const client = await connect(board);
    await snapshotOf(client);

    client.send({ type: "column.create", mutationId: "f8-c1", id: "col-valid", title: "Valid Col", position: "a0" });
    await awaitBroadcast(client, "f8-c1");
    client.send({ type: "card.create", mutationId: "f8-card1", id: "card-stay-put", columnId: "col-valid", title: "Stay Put", position: "a0" });
    await awaitBroadcast(client, "f8-card1");

    client.send({
      type: "card.move",
      mutationId: "mut-f8-move-fail",
      id: "card-stay-put",
      columnId: "missing-dest-col",
      position: "a9",
    });

    const err = await awaitError(client, "mut-f8-move-fail");
    expect(err.message).toBe("destination column does not exist");

    // Verify card column was not changed in SQLite storage
    const cardRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ column_id: string }>("SELECT column_id FROM cards WHERE id = 'card-stay-put'").toArray()[0],
    );
    expect(cardRow?.column_id).toBe("col-valid");

    client.close();
  });
});


describe("BoardDO pull request links from the per-board integration", () => {
  // ADR 0064 removed the per-board integration and its writer. Its stored rows stay readable: the
  // Worker adopts them into development info the first time their card is read, and until then
  // they must go wherever the card goes.
  async function seedBoard(board: string): Promise<{ client: Client }> {
    const client = await connect(board);
    await snapshotOf(client);
    client.send({ type: "column.create", mutationId: "col-seed", id: "col-1", title: "Todo", position: "a0" });
    await awaitBroadcast(client, "col-seed");
    const numbered = awaitMatching(
      client,
      (message): message is Extract<ServerMessage, { type: "card.numbered" }> => message.type === "card.numbered" && message.id === "card-1",
    );
    client.send({ type: "card.create", mutationId: "create-card-1", id: "card-1", columnId: "col-1", title: "Linked card", position: "a0" });
    await numbered;
    return { client };
  }

  it("carries a link nobody has adopted yet through a transfer, and drops it from the source on finalize", async () => {
    const source = "board-old-pr-link-transfer-source";
    const destination = "board-old-pr-link-transfer-dest";
    const { client: sourceClient } = await seedBoard(source);
    const sourceStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(source));
    const destStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(destination));
    await runInDurableObject(sourceStub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO card_github_pull_requests(card_id, repository_id, pull_number, revision) VALUES ('card-1', 4242, 105, ?)",
        crypto.randomUUID(),
      );
    });

    const destClient = await connect(destination);
    await snapshotOf(destClient);
    destClient.send({ type: "column.create", mutationId: "dest-col", id: "col-dest", title: "Done", position: "a0" });
    await awaitBroadcast(destClient, "dest-col");

    const transferId = "xfer-old-pr-link-1";
    const prepareRes = await sourceStub.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
      method: "POST",
      headers: await transferHeaders(source),
      body: JSON.stringify({ transferId, cardId: "card-1", destinationBoardId: destination }),
    });
    expect(prepareRes.status).toBe(200);
    const parsedBundle = PreparedCardTransferBundleSchema.parse((await prepareRes.json<{ bundle: unknown }>()).bundle);
    expect(parsedBundle.pullRequestAssociation).toMatchObject({ repositoryId: 4242, number: 105 });

    const importRes = await destStub.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
      method: "POST",
      headers: await transferHeaders(destination),
      body: JSON.stringify({ transferId, sourceBoardId: source, destinationColumnId: "col-dest", assigneeId: null, bundle: parsedBundle }),
    });
    expect(importRes.status).toBe(200);
    expect(await countDurableRows(destination, "SELECT COUNT(*) AS n FROM card_github_pull_requests WHERE pull_number = ?", 105)).toBe(1);

    const finalizeRes = await sourceStub.fetch(`https://board.internal${CARD_TRANSFER_FINALIZE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: source },
      body: JSON.stringify({ transferId, cardId: "card-1", destinationBoardId: destination }),
    });
    expect(finalizeRes.status).toBe(200);
    expect(await countDurableRows(source, "SELECT COUNT(*) AS n FROM card_github_pull_requests")).toBe(0);

    sourceClient.close();
    destClient.close();
  });
});

describe("BoardDO subtasks", () => {
  /** Column A with a parent and a second column B, all through the wire. */
  async function seedParent(client: Client): Promise<void> {
    client.send({ type: "column.create", mutationId: "s-col-a", id: "col-a", title: "Todo", position: "a0" });
    await awaitBroadcast(client, "s-col-a");
    client.send({ type: "column.create", mutationId: "s-col-b", id: "col-b", title: "Doing", position: "a1" });
    await awaitBroadcast(client, "s-col-b");
    client.send({
      type: "card.create",
      mutationId: "s-parent",
      id: "parent-1",
      columnId: "col-a",
      title: "Parent task",
      position: "a0",
    });
    await awaitBroadcast(client, "s-parent");
    await awaitMatching(client, (m): m is Extract<ServerMessage, { type: "card.numbered" }> =>
      m.type === "card.numbered" && m.id === "parent-1",
    );
  }

  function createSubtask(
    client: Client,
    mutationId: string,
    overrides: Partial<Extract<ClientMessage, { type: "subtask.create" }>> = {},
  ): void {
    client.send({
      type: "subtask.create",
      mutationId,
      id: `${mutationId}-child`,
      parentCardId: "parent-1",
      relationId: `${mutationId}-rel`,
      title: "Write docs",
      position: "a1",
      ...overrides,
    });
  }

  it("starts a child in the starting column, completes it by moving it and keeps the family on restart", async () => {
    const board = "board-subtask-complete";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);

    // The second column took the completed role, so moving the parent there completes it.
    a.send({ type: "card.move", mutationId: "m-parent", id: "parent-1", columnId: "col-b", position: "a0" });
    await awaitBroadcast(a, "m-parent");
    createSubtask(a, "sc-1");
    const broadcast = await awaitBroadcast(a, "sc-1");
    expect(broadcast).toMatchObject({ type: "subtask.create", id: "sc-1-child", parentCardId: "parent-1" });
    const numbered = await awaitMatching(a, (m): m is Extract<ServerMessage, { type: "card.numbered" }> =>
      m.type === "card.numbered" && m.id === "sc-1-child",
    );
    expect(numbered.taskNumber).toBeGreaterThan(0);
    const creationActivity = await awaitActivity(a, "sc-1");
    expect(creationActivity.map((activity) => [activity.cardId, activity.detail.type])).toEqual([
      ["sc-1-child", "card.created"],
      ["parent-1", "relation.added"],
      ["sc-1-child", "relation.added"],
    ]);

    // The child starts in the starting column, not in its parent's.
    const afterCreate = await snapshotOf(await connect(board));
    expect(afterCreate.cards.find((card) => card.id === "sc-1-child")).toMatchObject({
      columnId: "col-a",
      subtaskDone: false,
      taskType: "subtask",
    });

    // Subtask is a real immutable type and cannot become a parent itself.
    a.send({
      type: "card.retype",
      mutationId: "retype-child",
      id: "sc-1-child",
      taskType: "bug",
    });
    expect(await awaitError(a, "retype-child")).toMatchObject({
      message: "Subtask type cannot be changed.",
    });
    createSubtask(a, "nested-child", { parentCardId: "sc-1-child" });
    expect(await awaitError(a, "nested-child")).toMatchObject({
      message: "Subtasks cannot have subtasks.",
    });

    // Completion is the child's own move; the parent does not follow.
    a.send({ type: "card.move", mutationId: "cmp-1", id: "sc-1-child", columnId: "col-b", position: "a1" });
    await awaitBroadcast(a, "cmp-1");
    const completed = await snapshotOf(await connect(board));
    expect(completed.cards.map((card) => [card.id, card.columnId, card.subtaskDone])).toEqual([
      ["parent-1", "col-b", true],
      ["sc-1-child", "col-b", true],
    ]);
    a.send({ type: "card.move", mutationId: "reopen-1", id: "sc-1-child", columnId: "col-a", position: "a1" });
    await awaitBroadcast(a, "reopen-1");

    // A restarted DO serves the same family.
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    await expect(
      runInDurableObject(stub, (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();
    const restarted = await snapshotOf(await connect(board));
    expect(restarted.cards.map((card) => [card.id, card.columnId, card.subtaskDone])).toEqual([
      ["parent-1", "col-b", true],
      ["sc-1-child", "col-a", false],
    ]);
    expect(restarted.relations).toEqual([
      { id: "sc-1-rel", sourceCardId: "parent-1", targetCardId: "sc-1-child", kind: "subtask" },
    ]);
  });
  it("converts a checklist item atomically, refusing a changed or missing item without touching either side", async () => {
    const board = "board-subtask-convert";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);

    a.send({
      type: "checklist.create",
      mutationId: "ck-1",
      id: "item-1",
      cardId: "parent-1",
      text: "Write docs",
      position: "a0",
    });
    await awaitBroadcast(a, "ck-1");
    a.send({ type: "checklist.update", mutationId: "ck-done", id: "item-1", done: true });
    await awaitBroadcast(a, "ck-done");

    // The item changed underneath the click: nothing is written and it survives.
    createSubtask(a, "sc-changed", { title: "Write the docs", checklistItemId: "item-1" });
    expect(await awaitError(a, "sc-changed")).toMatchObject({
      message: "Checklist item changed. Try converting it again.",
    });

    // A missing item is its own refusal.
    createSubtask(a, "sc-missing", { checklistItemId: "item-gone" });
    expect(await awaitError(a, "sc-missing")).toMatchObject({
      message: "Checklist item is unavailable.",
    });

    const beforeSuccess = await snapshotOf(await connect(board));
    expect(beforeSuccess.cards.map((card) => card.id)).toEqual(["parent-1"]);
    expect(beforeSuccess.checklistItems.map((item) => item.id)).toEqual(["item-1"]);
    expect(beforeSuccess.relations).toEqual([]);

    // The accepted conversion copies the item's own done value and removes only it.
    createSubtask(a, "sc-ok", { checklistItemId: "item-1" });
    await awaitBroadcast(a, "sc-ok");
    const converted = await snapshotOf(await connect(board));
    expect(converted.checklistItems).toEqual([]);
    expect(converted.cards.find((card) => card.id === "sc-ok-child")).toMatchObject({
      title: "Write docs",
      subtaskDone: true,
      columnId: "col-b",
    });
    expect(converted.relations).toEqual([
      { id: "sc-ok-rel", sourceCardId: "parent-1", targetCardId: "sc-ok-child", kind: "subtask" },
    ]);
    // Conversion keeps its own history on the parent: the item it absorbed.
    expect((await awaitActivity(a, "sc-ok")).map((activity) => [activity.cardId, activity.detail.type])).toEqual([
      ["sc-ok-child", "card.created"],
      ["parent-1", "checklist.deleted"],
      ["parent-1", "relation.added"],
      ["sc-ok-child", "relation.added"],
    ]);
  });

  it("replays a deliberate retry as the same creation and refuses a conflicting identity", async () => {
    const board = "board-subtask-retry";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);

    createSubtask(a, "retry-1");
    await awaitBroadcast(a, "retry-1");
    const firstNumber = await awaitMatching(a, (m): m is Extract<ServerMessage, { type: "card.numbered" }> =>
      m.type === "card.numbered" && m.id === "retry-1-child",
    );
    await awaitActivity(a, "retry-1");

    // The same ids arrive again: the same card, the same number, no second child
    // and no second history record.
    createSubtask(a, "retry-2", { id: "retry-1-child", relationId: "retry-1-rel" });
    await awaitBroadcast(a, "retry-2");
    const replayNumber = await awaitMatching(a, (m): m is Extract<ServerMessage, { type: "card.numbered" }> =>
      m.type === "card.numbered" && m.id === "retry-1-child",
    );
    expect(replayNumber.taskNumber).toBe(firstNumber.taskNumber);
    a.send({ type: "card.prioritize", mutationId: "after-replay", id: "retry-1-child", priority: "low" });
    await awaitBroadcast(a, "after-replay");
    expect((await a.next()).message).toMatchObject({
      type: "activity.recorded",
      mutationId: "after-replay",
      activities: [{ detail: { type: "priority.changed" } }],
    });
    const afterReplay = await snapshotOf(await connect(board));
    expect(afterReplay.cards.filter((card) => card.id === "retry-1-child")).toHaveLength(1);

    // A child id that already exists for another link is somebody else's identity.
    createSubtask(a, "conflict-1", { id: "retry-1-child", relationId: "other-rel" });
    expect(await awaitError(a, "conflict-1")).toMatchObject({
      message: "Subtask identity is already in use.",
    });
    // An unrelated card (no link at all) is never read as a successful creation.
    a.send({
      type: "card.create",
      mutationId: "plain-card",
      id: "plain-1",
      columnId: "col-a",
      title: "Plain",
      position: "a2",
    });
    await awaitBroadcast(a, "plain-card");
    await awaitMatching(a, (m): m is Extract<ServerMessage, { type: "card.numbered" }> =>
      m.type === "card.numbered" && m.id === "plain-1",
    );
    createSubtask(a, "conflict-2", { id: "plain-1", relationId: "plain-rel" });
    expect(await awaitError(a, "conflict-2")).toMatchObject({
      message: "Subtask identity is already in use.",
    });
  });

  it("rejects a replay whose stored title does not match the requested identity", async () => {
    const board = "board-subtask-title-identity";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);

    // A stored child has since been renamed by a peer. A retry that names those
    // ids with a different title is a colliding identity, not this creation.
    createSubtask(a, "title-1");
    await awaitBroadcast(a, "title-1");
    await awaitMatching(a, (m): m is Extract<ServerMessage, { type: "card.numbered" }> =>
      m.type === "card.numbered" && m.id === "title-1-child",
    );
    a.send({
      type: "card.update",
      mutationId: "rename-child",
      id: "title-1-child",
      title: "Renamed by a peer",
    });
    await awaitBroadcast(a, "rename-child");

    createSubtask(a, "title-2", { id: "title-1-child", relationId: "title-1-rel" });
    expect(await awaitError(a, "title-2")).toMatchObject({
      message: "Subtask identity is already in use.",
    });

    // The exact identity still replays: same ids, same stored title, one child.
    createSubtask(a, "title-3", {
      id: "title-1-child",
      relationId: "title-1-rel",
      title: "Renamed by a peer",
    });
    await awaitBroadcast(a, "title-3");
    a.send({ type: "card.prioritize", mutationId: "after-title-replay", id: "title-1-child", priority: "low" });
    await awaitBroadcast(a, "after-title-replay");
    expect((await a.next()).message).toMatchObject({
      type: "activity.recorded",
      mutationId: "after-title-replay",
      activities: [{ detail: { type: "priority.changed" } }],
    });
    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.filter((card) => card.id === "title-1-child")).toHaveLength(1);
  });

  it("converts an item whose stored text carries surrounding whitespace", async () => {
    const board = "board-subtask-whitespace";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);

    a.send({
      type: "checklist.create",
      mutationId: "ws-item",
      id: "item-ws",
      cardId: "parent-1",
      text: " Write docs ",
      position: "a0",
    });
    await awaitBroadcast(a, "ws-item");

    // The conversion sends the exact stored text, so only a real change refuses.
    createSubtask(a, "ws-convert", { title: " Write docs ", checklistItemId: "item-ws" });
    await awaitBroadcast(a, "ws-convert");
    const converted = await snapshotOf(await connect(board));
    expect(converted.checklistItems).toEqual([]);
    expect(converted.cards.find((card) => card.id === "ws-convert-child")).toMatchObject({
      title: " Write docs ",
    });
  });

  it("rejects a cycle that runs through a discarded legacy parent edge", async () => {
    const board = "board-subtask-legacy-cycle";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);
    for (const id of ["card-x", "card-q", "card-r"]) {
      a.send({
        type: "card.create",
        mutationId: `seed-${id}`,
        id,
        columnId: "col-a",
        title: id,
        position: "a1",
      });
      await awaitBroadcast(a, `seed-${id}`);
      await awaitMatching(a, (m): m is Extract<ServerMessage, { type: "card.numbered" }> =>
        m.type === "card.numbered" && m.id === id,
      );
    }

    // Legacy rows predate hierarchy validation: P has TWO stored parents (X and
    // Q), and R is X's stored parent. Collapsing this into one parent per child
    // would drop one of those edges, so a walk that keeps only the last one never
    // reaches R and would accept the cycle below.
    await runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(board)), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO card_relations(id, source_card_id, target_card_id, kind) VALUES ('legacy-x-p', 'card-x', 'parent-1', 'subtask')");
      sql.exec("INSERT INTO card_relations(id, source_card_id, target_card_id, kind) VALUES ('legacy-q-p', 'card-q', 'parent-1', 'subtask')");
      sql.exec("INSERT INTO card_relations(id, source_card_id, target_card_id, kind) VALUES ('legacy-r-x', 'card-r', 'card-x', 'subtask')");
    });

    // parent-1 -> card-r would close card-r -> card-x -> parent-1 -> card-r.
    // Only the full traversal sees it: the target has no stored parent, the pair
    // is new, and neither endpoint is self-linked.
    a.send({
      type: "relation.create",
      mutationId: "close-cycle",
      id: "rel-close",
      sourceCardId: "parent-1",
      targetCardId: "card-r",
      kind: "subtask",
    });
    expect(await awaitError(a, "close-cycle")).toMatchObject({
      message: "Invalid subtask hierarchy.",
    });

    // A target that already owns a child may not itself become a subtask.
    a.send({
      type: "relation.create",
      mutationId: "bad-nested-link",
      id: "rel-nested",
      sourceCardId: "card-q",
      targetCardId: "card-r",
      kind: "subtask",
    });
    expect(await awaitError(a, "bad-nested-link")).toMatchObject({
      message: "Invalid subtask hierarchy.",
    });

    // Retaining that child edge through archive does not reopen the nesting path.
    a.send({ type: "card.delete", mutationId: "archive-x", id: "card-x" });
    await awaitBroadcast(a, "archive-x");
    await awaitMatching(a, (message): message is Extract<ServerMessage, { type: "cards.archived" }> =>
      message.type === "cards.archived",
    );
    a.send({
      type: "relation.create",
      mutationId: "bad-nested-archived",
      id: "rel-nested-archived",
      sourceCardId: "card-q",
      targetCardId: "card-r",
      kind: "subtask",
    });
    expect(await awaitError(a, "bad-nested-archived")).toMatchObject({
      message: "Invalid subtask hierarchy.",
    });
  });

  it("exports a completed, unlinked subtask's completion and lets the destination's columns decide", async () => {
    const source = "board-subtask-transfer-source";
    const destination = "board-subtask-transfer-dest";
    const a = await connect(source);
    await snapshotOf(a);
    await seedParent(a);
    createSubtask(a, "xfer-1");
    await awaitBroadcast(a, "xfer-1");

    // Complete the child by moving it, then unlink it: it keeps its column.
    a.send({ type: "card.move", mutationId: "xfer-done", id: "xfer-1-child", columnId: "col-b", position: "a1" });
    await awaitBroadcast(a, "xfer-done");
    a.send({ type: "relation.delete", mutationId: "xfer-unlink", id: "xfer-1-rel" });
    await awaitBroadcast(a, "xfer-unlink");
    const unlinked = await snapshotOf(await connect(source));
    expect(unlinked.relations).toEqual([]);
    expect(unlinked.cards.find((card) => card.id === "xfer-1-child")).toMatchObject({
      columnId: "col-b",
      subtaskDone: true,
      taskType: "task",
    });

    // The source bundle exports the completion.
    const sourceStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(source));
    const prepared = await sourceStub.fetch(
      `https://board.internal${CARD_TRANSFER_PREPARE_PATH}`,
      {
        method: "POST",
        headers: await transferHeaders(source),
        body: JSON.stringify({
          transferId: "xfer-subtask-1",
          cardId: "xfer-1-child",
          destinationBoardId: destination,
        }),
      },
    );
    expect(prepared.status).toBe(200);
    const preparedBody = await prepared.json<{ bundle: { card: { subtaskDone: boolean } } }>();
    expect(preparedBody.bundle.card.subtaskDone).toBe(true);

    // The destination has one column and so no completed one: nothing there is done.
    const destClient = await connect(destination);
    await snapshotOf(destClient);
    destClient.send({
      type: "column.create",
      mutationId: "dest-col",
      id: "dest-col-1",
      title: "Todo",
      position: "a0",
    });
    await awaitBroadcast(destClient, "dest-col");
    const destStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(destination));
    const imported = await destStub.fetch(
      `https://board.internal${CARD_TRANSFER_IMPORT_PATH}`,
      {
        method: "POST",
        headers: await transferHeaders(destination),
        body: JSON.stringify({
          transferId: "xfer-subtask-1",
          sourceBoardId: source,
          destinationColumnId: "dest-col-1",
          assigneeId: null,
          bundle: preparedBody.bundle,
        }),
      },
    );
    expect(imported.status).toBe(200);
    const afterImport = await snapshotOf(await connect(destination));
    expect(afterImport.cards.find((card) => card.title === "Write docs")?.subtaskDone).toBe(false);
  });
  it("refuses a subtask under an archived parent with its own message and leaves the child where it is", async () => {
    const board = "board-subtask-unavailable";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);
    createSubtask(a, "live-1");
    await awaitBroadcast(a, "live-1");

    // Archive is per card: only the parent goes, and creation under it is refused
    // by name.
    a.send({ type: "card.delete", mutationId: "del-parent", id: "parent-1" });
    await awaitBroadcast(a, "del-parent");
    const archived = await awaitMatching(a, (m): m is Extract<ServerMessage, { type: "cards.archived" }> =>
      m.type === "cards.archived",
    );
    expect(archived.cards.map((card) => card.id)).toEqual(["parent-1"]);
    createSubtask(a, "after-archive");
    expect(await awaitError(a, "after-archive")).toMatchObject({
      message: "Parent task is unavailable.",
    });

    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.map((card) => [card.id, card.columnId])).toEqual([["live-1-child", "col-a"]]);
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["parent-1"]);
  });
  it("archives only the card it names and restores it into the column it is sent to", async () => {
    const board = "board-subtask-archive";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);
    createSubtask(a, "arch-1");
    await awaitBroadcast(a, "arch-1");

    // Deleting the parent archives it alone; the child keeps its own column.
    a.send({ type: "card.delete", mutationId: "arch-parent", id: "parent-1" });
    await awaitBroadcast(a, "arch-parent");
    const frame = await awaitMatching(a, (message): message is Extract<ServerMessage, { type: "cards.archived" }> =>
      message.type === "cards.archived",
    );
    expect(frame.cards.map((card) => [card.id, card.columnId, card.archivedColumnTitle])).toEqual([
      ["parent-1", "col-a", "Todo"],
    ]);
    const afterArchive = await snapshotOf(await connect(board));
    expect(afterArchive.cards.map((card) => card.id)).toEqual(["arch-1-child"]);

    // Restore uses the submitted column, retained link or not.
    a.send({ type: "card.restore", mutationId: "restore-parent", id: "parent-1", columnId: "col-b", position: "a0" });
    await awaitBroadcast(a, "restore-parent");
    const restored = await snapshotOf(await connect(board));
    expect(restored.archivedCards).toEqual([]);
    expect(restored.cards.map((card) => [card.id, card.columnId, card.subtaskDone]).sort()).toEqual([
      ["arch-1-child", "col-a", false],
      ["parent-1", "col-b", true],
    ]);
    expect(restored.relations).toHaveLength(1);
  });

  it("deleting a column archives only the cards stored in it", async () => {
    const board = "board-subtask-column-delete";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);
    createSubtask(a, "col-1");
    await awaitBroadcast(a, "col-1");
    a.send({ type: "card.move", mutationId: "parent-to-b", id: "parent-1", columnId: "col-b", position: "a0" });
    await awaitBroadcast(a, "parent-to-b");
    a.send({ type: "column.delete", mutationId: "del-b", id: "col-b" });
    await awaitBroadcast(a, "del-b");
    const frame = await awaitMatching(a, (m): m is Extract<ServerMessage, { type: "cards.archived" }> =>
      m.type === "cards.archived",
    );
    expect(frame.cards.map((card) => [card.id, card.columnId, card.archivedColumnTitle])).toEqual([
      ["parent-1", "col-b", "Doing"],
    ]);
    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.map((card) => [card.id, card.columnId])).toEqual([["col-1-child", "col-a"]]);
  });
  it("refuses invalid subtask links through relation.create", async () => {
    const board = "board-subtask-invalid-links";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);
    a.send({
      type: "card.create",
      mutationId: "second-card",
      id: "card-2",
      columnId: "col-a",
      title: "Second",
      position: "a1",
    });
    await awaitBroadcast(a, "second-card");
    await awaitMatching(a, (m): m is Extract<ServerMessage, { type: "card.numbered" }> =>
      m.type === "card.numbered" && m.id === "card-2",
    );

    // A self-link is not a hierarchy.
    a.send({
      type: "relation.create",
      mutationId: "bad-self",
      id: "rel-self",
      sourceCardId: "parent-1",
      targetCardId: "parent-1",
      kind: "subtask",
    });
    expect(await awaitError(a, "bad-self")).toMatchObject({ message: "Invalid subtask hierarchy." });

    // A missing endpoint is not a hierarchy either.
    a.send({
      type: "relation.create",
      mutationId: "bad-missing",
      id: "rel-missing",
      sourceCardId: "parent-1",
      targetCardId: "ghost",
      kind: "subtask",
    });
    expect(await awaitError(a, "bad-missing")).toMatchObject({
      message: "Invalid subtask hierarchy.",
    });

    // The first valid link lands.
    a.send({
      type: "relation.create",
      mutationId: "ok-link",
      id: "rel-ok",
      sourceCardId: "parent-1",
      targetCardId: "card-2",
      kind: "subtask",
    });
    await awaitBroadcast(a, "ok-link");

    // A third card may not become a second parent of the same child.
    a.send({
      type: "card.create",
      mutationId: "third-card",
      id: "card-3",
      columnId: "col-a",
      title: "Third",
      position: "a2",
    });
    await awaitBroadcast(a, "third-card");
    await awaitMatching(a, (m): m is Extract<ServerMessage, { type: "card.numbered" }> =>
      m.type === "card.numbered" && m.id === "card-3",
    );
    a.send({
      type: "relation.create",
      mutationId: "bad-second-parent",
      id: "rel-second",
      sourceCardId: "card-3",
      targetCardId: "card-2",
      kind: "subtask",
    });
    expect(await awaitError(a, "bad-second-parent")).toMatchObject({
      message: "Invalid subtask hierarchy.",
    });

    // A cycle back through the child is refused as well: walking up from the new
    // parent reaches it.
    a.send({
      type: "relation.create",
      mutationId: "bad-cycle",
      id: "rel-cycle",
      sourceCardId: "card-2",
      targetCardId: "parent-1",
      kind: "subtask",
    });
    expect(await awaitError(a, "bad-cycle")).toMatchObject({
      message: "Invalid subtask hierarchy.",
    });

    // Related-card links keep their old policy: no hierarchy rules apply.
    a.send({
      type: "relation.create",
      mutationId: "ok-relates",
      id: "rel-relates",
      sourceCardId: "card-2",
      targetCardId: "parent-1",
      kind: "relates",
    });
    await awaitBroadcast(a, "ok-relates");

    // The stored board holds exactly the accepted links.
    const snapshot = await snapshotOf(await connect(board));
    expect(snapshot.relations).toEqual([
      { id: "rel-ok", sourceCardId: "parent-1", targetCardId: "card-2", kind: "subtask" },
      { id: "rel-relates", sourceCardId: "card-2", targetCardId: "parent-1", kind: "relates" },
    ]);
    expect(snapshot.cards.find((card) => card.id === "card-2")?.taskType).toBe("subtask");
  });

  it("migrates existing rows to incomplete without touching anything else", async () => {
    const board = "board-subtask-v21";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const initial = await connect(board);
    await snapshotOf(initial);
    initial.close();

    // Roll the schema back to v20 and drop the completion column, with a card already there.
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("ALTER TABLE cards DROP COLUMN subtask_done");
      sql.exec("UPDATE meta SET value = 20 WHERE key = 'schema_version'");
      sql.exec("INSERT INTO columns(id, title, position) VALUES ('col-legacy', 'Legacy', 'a0')");
      sql.exec(
        `INSERT INTO cards(
           id, column_id, title, description, position, priority, task_type,
           created_at, updated_at, task_number
         ) VALUES ('card-legacy', 'col-legacy', 'Legacy card', 'kept', 'a0', 'high', 'bug', 100, 100, 1)`,
      );
    });

    // The next request runs migrations v21 and v22.
    await expect(
      runInDurableObject(stub, (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();
    const migrated = await snapshotOf(await connect(board));
    expect(migrated.cards).toHaveLength(1);
    expect(migrated.cards[0]).toMatchObject({
      id: "card-legacy",
      title: "Legacy card",
      description: "kept",
      priority: "high",
      taskType: "bug",
      subtaskDone: false,
    });
  });

  it("migrates existing linked children to the immutable subtask type", async () => {
    const board = "board-subtask-v22";
    const a = await connect(board);
    await snapshotOf(a);
    await seedParent(a);
    createSubtask(a, "legacy-type");
    await awaitBroadcast(a, "legacy-type");
    await awaitMatching(a, (message): message is Extract<ServerMessage, { type: "card.numbered" }> =>
      message.type === "card.numbered" && message.id === "legacy-type-child",
    );
    a.send({
      type: "card.create",
      mutationId: "legacy-grandchild-card",
      id: "legacy-grandchild",
      columnId: "col-b",
      title: "Legacy grandchild",
      position: "a2",
    });
    await awaitBroadcast(a, "legacy-grandchild-card");
    await awaitMatching(a, (message): message is Extract<ServerMessage, { type: "card.numbered" }> =>
      message.type === "card.numbered" && message.id === "legacy-grandchild",
    );
    a.close();

    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE cards SET task_type = 'task' WHERE id IN ('legacy-type-child', 'legacy-grandchild')",
      );
      state.storage.sql.exec(
        `INSERT INTO card_relations(id, source_card_id, target_card_id, kind)
         VALUES ('legacy-nested-rel', 'legacy-type-child', 'legacy-grandchild', 'subtask')`,
      );
      state.storage.sql.exec(
        "UPDATE meta SET value = 21 WHERE key = 'schema_version'",
      );
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.abort("restart")),
    ).rejects.toThrow();

    const migrated = await snapshotOf(await connect(board));
    expect(migrated.cards.find((card) => card.id === "legacy-type-child")?.taskType).toBe(
      "subtask",
    );
    expect(migrated.cards.find((card) => card.id === "legacy-grandchild")).toMatchObject({
      taskType: "subtask",
      columnId: "col-a",
    });
    expect(migrated.relations).toEqual([
      {
        id: "legacy-type-rel",
        sourceCardId: "parent-1",
        targetCardId: "legacy-type-child",
        kind: "subtask",
      },
    ]);
  });
});

/** Runs one MCP command against the DO the way the Worker does. */
async function mcpCommand(board: string, command: Record<string, unknown>) {
  await seedIdentity(board, "test-user");
  const response = await env.BOARD_DO.get(env.BOARD_DO.idFromName(board)).fetch(
    `https://board.internal${MCP_COMMAND_PATH}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: board,
        [INTERNAL_USER_ID_HEADER]: "test-user",
        [INTERNAL_CAN_MANAGE_COLUMNS_HEADER]: "true",
      },
      body: JSON.stringify({
        credentialId: "cred-1",
        inputHash: "0".repeat(64),
        board: { id: board, key: "ORD", name: board, appOrigin: "https://foxban.test" },
        command: { operationKey: crypto.randomUUID(), ...command },
      }),
    },
  );
  expect(response.status).toBe(200);
  return response.json<{ ok: boolean; error?: { code: string } }>();
}

function rootPositions(board: string): Promise<{ id: string; position: string }[]> {
  return runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(board)), (_instance, state) =>
    state.storage.sql
      .exec<{ id: string; position: string }>("SELECT id, position FROM cards ORDER BY position, id")
      .toArray(),
  );
}

describe("BoardDO fractional ordering", () => {
  it("places an MCP move before an a0 anchor strictly below it", async () => {
    const board = "board-mcp-order-before";
    const a = await connect(board);
    await snapshotOf(a);
    a.send({ type: "column.create", mutationId: "ord-col", id: "col-1", title: "Todo", position: "a0" });
    a.send({ type: "card.create", mutationId: "ord-a", id: "card-a", columnId: "col-1", title: "Anchor", position: "a0" });
    a.send({ type: "card.create", mutationId: "ord-b", id: "card-b", columnId: "col-1", title: "Mover", position: "a1" });
    await awaitBroadcast(a, "ord-b");

    const moved = await mcpCommand(board, {
      operation: "move_task",
      task: { id: "card-b" },
      columnId: "col-1",
      placement: { before: { id: "card-a" } },
    });
    expect(moved.ok).toBe(true);

    const rows = await rootPositions(board);
    expect(rows.find((row) => row.id === "card-b")!.position < "a0").toBe(true);
    expect(rows.map((row) => row.id)).toEqual(["card-b", "card-a"]);
  });

  // Two writers that raced leave card-a and card-b on one key: the library cannot place between them.
  async function tiedBoard(board: string) {
    const a = await connect(board);
    await snapshotOf(a);
    a.send({ type: "column.create", mutationId: "eq-col", id: "col-1", title: "Todo", position: "a0" });
    for (const [id, position] of [["card-a", "a0"], ["card-b", "a1"], ["card-c", "a2"], ["card-m", "a3"]] as const) {
      a.send({ type: "card.create", mutationId: `eq-${id}`, id, columnId: "col-1", title: id, position });
    }
    await awaitBroadcast(a, "eq-card-m");
    await runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(board)), (_instance, state) => {
      state.storage.sql.exec("UPDATE cards SET position = 'a0' WHERE id = 'card-b'");
    });
  }

  it("places a `before` move ahead of equal neighbour keys instead of refusing it for good", async () => {
    const board = "board-mcp-order-equal-before";
    await tiedBoard(board);

    const moved = await mcpCommand(board, {
      operation: "move_task",
      task: { id: "card-m" },
      columnId: "col-1",
      placement: { before: { id: "card-b" } },
    });
    expect(moved.ok).toBe(true);

    // It stays in front of the tied pair, so it is before card-b.
    const rows = await rootPositions(board);
    expect(rows.map((row) => row.id)).toEqual(["card-m", "card-a", "card-b", "card-c"]);
    expect(rows.find((row) => row.id === "card-m")!.position < "a0").toBe(true);
  });

  it("places an `after` move past equal neighbour keys, below the next distinct key", async () => {
    const board = "board-mcp-order-equal-after";
    await tiedBoard(board);

    const moved = await mcpCommand(board, {
      operation: "move_task",
      task: { id: "card-m" },
      columnId: "col-1",
      placement: { after: { id: "card-a" } },
    });
    expect(moved.ok).toBe(true);

    const rows = await rootPositions(board);
    expect(rows.map((row) => row.id)).toEqual(["card-a", "card-b", "card-m", "card-c"]);
    const position = rows.find((row) => row.id === "card-m")!.position;
    expect(position > "a0" && position < "a2").toBe(true);
  });

  it("appends after a Zz tail with a key that still admits a midpoint", async () => {
    const board = "board-mcp-order-tail";
    const a = await connect(board);
    await snapshotOf(a);
    a.send({ type: "column.create", mutationId: "tail-col", id: "col-1", title: "Todo", position: "a0" });
    a.send({ type: "card.create", mutationId: "tail-z", id: "card-z", columnId: "col-1", title: "Tail", position: "Zz" });
    await awaitBroadcast(a, "tail-z");

    const created = await mcpCommand(board, {
      operation: "create_task",
      columnId: "col-1",
      title: "Appended",
      taskType: "task",
      priority: "medium",
      assigneeId: null,
    });
    expect(created.ok).toBe(true);

    const rows = await rootPositions(board);
    expect(rows[0]!.id).toBe("card-z");
    const tail = rows[1]!.position;
    expect(tail > "Zz").toBe(true);
    const midpoint = generateKeyBetween("Zz", tail);
    expect(midpoint > "Zz" && midpoint < tail).toBe(true);
    expect(generateKeyBetween(tail, "a1") < "a1").toBe(true);
  });
});

describe("BoardDO orphan attachments", () => {
  it("refuses a late publish for a purged card and collects its staged object", async () => {
    const board = "board-orphan-late-publish";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "olp");
    const attId = crypto.randomUUID();
    const objectKey = await stageAttachment(board, attId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM cards WHERE id = 'card-1'");
    });

    a.send({
      type: "attachment.create",
      mutationId: "olp-create",
      id: attId,
      cardId: "card-1",
      fileName: "late.png",
      contentType: "image/png",
      size: 3,
    });
    expect((await awaitError(a, "olp-create")).message).toBe("attachment card is unavailable");

    const state = await runInDurableObject(stub, (_instance, s) => ({
      attachments: s.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM attachments WHERE id = ?", attId)
        .toArray()[0]!.count,
      lease: s.storage.sql
        .exec<{ reason: string }>("SELECT reason FROM attachment_cleanup WHERE object_key = ?", objectKey)
        .toArray()[0]?.reason,
    }));
    expect(state).toEqual({ attachments: 0, lease: "staged" });

    await runInDurableObject(stub, async (instance, s) => {
      await s.storage.deleteAlarm();
      s.storage.sql.exec("UPDATE attachment_cleanup SET delete_after = 0 WHERE object_key = ?", objectKey);
      await instance.alarm();
    });
    await expectObjectDeleted(objectKey);
  });

  it("reclaims orphan metadata and its object while an archived card keeps its attachment", async () => {
    const board = "board-orphan-reclaim";
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const a = await connect(board);
    await snapshotOf(a);
    await seedCard(a, "orc");
    const keptId = crypto.randomUUID();
    const keptKey = await stageAttachment(board, keptId);
    a.send({
      type: "attachment.create",
      mutationId: "orc-kept",
      id: keptId,
      cardId: "card-1",
      fileName: "kept.png",
      contentType: "image/png",
      size: 3,
    });
    await awaitBroadcast(a, "orc-kept");
    const orphanId = crypto.randomUUID();
    const orphanKey = attachmentObjectKey(board, orphanId);
    await env.ATTACHMENTS.put(orphanKey, Uint8Array.of(1, 2, 3));

    await runInDurableObject(stub, async (instance, s) => {
      s.storage.sql.exec("UPDATE cards SET archived_at = ? WHERE id = 'card-1'", Date.now());
      s.storage.sql.exec(
        `INSERT INTO attachments(id, card_id, file_name, content_type, size, object_key)
         VALUES (?, 'purged-card', 'orphan.png', 'image/png', 3, ?)`,
        orphanId,
        orphanKey,
      );
      await s.storage.deleteAlarm();
      await instance.alarm();
    });

    await expectObjectDeleted(orphanKey);
    const remaining = await runInDurableObject(stub, (_instance, s) =>
      s.storage.sql
        .exec<{ id: string }>("SELECT id FROM attachments ORDER BY id")
        .toArray()
        .map((row) => row.id),
    );
    expect(remaining).toEqual([keptId]);
    expect(await env.ATTACHMENTS.head(keptKey)).not.toBeNull();
  });
});

describe("independent workflow", () => {
  /** The roles already sit at the ends; choosing them makes them explicit, like an admin saving the settings. */
  const configuration = { type: "workflow.configure", mutationId: "configure", startingColumnId: "start", completedColumnId: "done", expectedStartingColumnId: "start", expectedCompletedColumnId: "done" } as const;
  async function fixture(board: string) {
    const client = await connect(board);
    await snapshotOf(client);
    for (const [id, title, position] of [["start", "Todo", "a0"], ["work", "Work", "a1"], ["done", "Done", "a2"]]) {
      client.send({ type: "column.create", mutationId: id, id, title, position }); await awaitBroadcast(client, id!);
    }
    client.send(configuration); await awaitBroadcast(client, "configure");
    client.send({ type: "card.create", mutationId: "parent", id: "parent", columnId: "work", title: "Parent", position: "a0" }); await awaitBroadcast(client, "parent");
    client.send({ type: "subtask.create", mutationId: "child", id: "child", parentCardId: "parent", relationId: "link", title: "Child", position: "a1" }); await awaitBroadcast(client, "child");
    client.send({ type: "card.move", mutationId: "child-to-work", id: "child", columnId: "work", position: "a2" }); await awaitBroadcast(client, "child-to-work");
    return client;
  }
  it("refuses stale or indistinct workflow roles and persists a fresh pair", async () => {
    const board = "independent-configure"; const a = await fixture(board);
    a.send({ ...configuration, mutationId: "stale", expectedCompletedColumnId: "work" });
    expect((await awaitError(a, "stale")).message).toContain("Workflow changed");
    a.send({ ...configuration, mutationId: "same", startingColumnId: "work", completedColumnId: "work", expectedStartingColumnId: "start", expectedCompletedColumnId: "done" });
    expect((await awaitError(a, "same")).message).toContain("distinct");
    a.send({ ...configuration, mutationId: "missing", startingColumnId: "work", completedColumnId: "ghost", expectedStartingColumnId: "start", expectedCompletedColumnId: "done" });
    expect((await awaitError(a, "missing")).message).toContain("distinct existing");
    a.send({ ...configuration, mutationId: "swap", startingColumnId: "work", completedColumnId: "done", expectedStartingColumnId: "start", expectedCompletedColumnId: "done" });
    await awaitBroadcast(a, "swap");
    const columns = (await snapshotOf(await connect(board))).columns;
    expect(columns.map(c => [c.id, c.starting, c.completed])).toEqual([["start", false, false], ["work", true, false], ["done", false, true]]);
    // Changing roles moves no card.
    expect((await snapshotOf(await connect(board))).cards.map(c => [c.id, c.columnId])).toEqual([["parent", "work"], ["child", "work"]]);
  });
  it("persists one-card moves and lifecycle semantics", async () => {
    const board = "independent-lifecycle"; const a = await fixture(board);
    a.send({ type: "card.move", mutationId: "complete", id: "child", columnId: "done", position: "a0" }); await awaitBroadcast(a, "complete");
    a.send({ type: "card.move", mutationId: "parent-move", id: "parent", columnId: "start", position: "a0" }); await awaitBroadcast(a, "parent-move");
    let snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.find(c => c.id === "child")).toMatchObject({ columnId: "done", subtaskDone: true });
    expect(snapshot.cards.find(c => c.id === "parent")).toMatchObject({ columnId: "start" });
    a.send({ type: "column.delete", mutationId: "delete-done", id: "done" }); expect((await awaitError(a, "delete-done")).message).toContain("replacement");
    a.send({ type: "card.delete", mutationId: "archive-parent", id: "parent" }); await awaitBroadcast(a, "archive-parent");
    snapshot = await snapshotOf(await connect(board)); expect(snapshot.cards.map(c => c.id)).toEqual(["child"]);
    a.send({ type: "card.restore", mutationId: "restore-parent", id: "parent", columnId: "work", position: "a0" }); await awaitBroadcast(a, "restore-parent");
    a.send({ type: "card.delete", mutationId: "archive-child", id: "child" }); await awaitBroadcast(a, "archive-child");
    snapshot = await snapshotOf(await connect(board)); expect(snapshot.archivedCards.find(c => c.id === "child")?.subtaskDone).toBe(true);
    a.send({ type: "card.restore", mutationId: "restore-child", id: "child", columnId: "start", position: "a0" }); await awaitBroadcast(a, "restore-child");
    snapshot = await snapshotOf(await connect(board)); expect(snapshot.cards.find(c => c.id === "child")).toMatchObject({ columnId: "start", subtaskDone: false });
    a.send({ type: "relation.delete", mutationId: "unlink", id: "link" }); await awaitBroadcast(a, "unlink");
    snapshot = await snapshotOf(await connect(board)); expect(snapshot.cards.find(c => c.id === "child")).toMatchObject({ columnId: "start", taskType: "task" });
  });
  it("uses starting/completed columns for new children, checklist conversion and MCP shortcuts", async () => {
    const board = "independent-creation-mcp"; const a = await fixture(board);
    a.send({ type: "subtask.create", mutationId: "new-child", id: "new-child", parentCardId: "parent", relationId: "new-link", title: "New", position: "a0" }); await awaitBroadcast(a, "new-child");
    a.send({ type: "checklist.create", mutationId: "item", id: "item", cardId: "parent", text: "Converted", position: "a0" }); await awaitBroadcast(a, "item");
    a.send({ type: "checklist.update", mutationId: "item-done", id: "item", done: true }); await awaitBroadcast(a, "item-done");
    a.send({ type: "subtask.create", mutationId: "convert", id: "converted", parentCardId: "parent", relationId: "convert-link", title: "Converted", position: "a0", checklistItemId: "item" }); await awaitBroadcast(a, "convert");
    let snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.find(c => c.id === "new-child")).toMatchObject({ columnId: "start", subtaskDone: false });
    expect(snapshot.cards.find(c => c.id === "converted")).toMatchObject({ columnId: "done", subtaskDone: true });
    expect(snapshot.checklistItems).toHaveLength(0);
    expect((await mcpCommand(board, { operation: "complete_subtask", task: { id: "child" }, done: true })).ok).toBe(true);
    expect((await mcpCommand(board, { operation: "move_task", task: { id: "parent" }, columnId: "done", placement: { before: { id: "child" } } })).ok).toBe(true);
    expect((await mcpCommand(board, { operation: "complete_subtask", task: { id: "child" }, done: false })).ok).toBe(true);
    snapshot = await snapshotOf(await connect(board));
    expect(snapshot.cards.find(c => c.id === "child")).toMatchObject({ columnId: "start", subtaskDone: false });
    expect(snapshot.cards.find(c => c.id === "parent")).toMatchObject({ columnId: "done", subtaskDone: true });
    a.send({ type: "card.move", mutationId: "reopen-converted", id: "converted", columnId: "work", position: "a0" }); await awaitBroadcast(a, "reopen-converted");
    a.send({ type: "column.delete", mutationId: "archive-work", id: "work" }); await awaitBroadcast(a, "archive-work");
    snapshot = await snapshotOf(await connect(board));
    expect(snapshot.archivedCards.find(c => c.id === "converted")).toMatchObject({ subtaskDone: false, archivedColumnTitle: "Work" });
  });
  async function finishFixture(board: string) {
    const a = await fixture(board);
    for (const id of ["second", "already-done"]) {
      a.send({ type: "subtask.create", mutationId: id, id, parentCardId: "parent", relationId: `${id}-link`, title: id, position: id === "second" ? "a3" : "a4" }); await awaitBroadcast(a, id);
    }
    a.send({ type: "card.move", mutationId: "already-finished", id: "already-done", columnId: "done", position: "a0" }); await awaitBroadcast(a, "already-finished");
    const snapshot = await snapshotOf(await connect(board));
    const command = { type: "card.finish" as const, mutationId: "finish", id: "parent", columnId: "done", position: "a1", scope: "family" as "family" | "parent", expectedParentColumnId: "work", expectedParentPosition: "a0", expectedFamily: familyCompletionRows(snapshot.cards, snapshot.relations, "parent"), children: [{ id: "child", position: "a2" }, { id: "second", position: "a3" }] };
    return { a, command, snapshot };
  }
  it("finishes the cross-column family atomically and reopening affects only parent", async () => {
    const board = "finish-family"; const { a, command, snapshot: before } = await finishFixture(board);
    a.send(command); await awaitBroadcast(a, "finish");
    let after = await snapshotOf(await connect(board));
    expect(after.cards.filter(c => c.columnId === "done")).toHaveLength(4);
    expect(after.cards.find(c => c.id === "already-done")).toEqual(before.cards.find(c => c.id === "already-done"));
    expect(after.activities.length).toBe(before.activities.length + 3);
    a.send({ type: "card.move", mutationId: "reopen", id: "parent", columnId: "start", position: "a0" }); await awaitBroadcast(a, "reopen");
    after = await snapshotOf(await connect(board)); expect(after.cards.filter(c => c.id !== "parent").every(c => c.columnId === "done")).toBe(true);
  });
  it("explicit parent-only completion leaves every child unchanged", async () => {
    const board = "finish-parent-only"; const { a, command, snapshot: before } = await finishFixture(board);
    a.send({ ...command, scope: "parent", children: [] }); await awaitBroadcast(a, "finish");
    const after = await snapshotOf(await connect(board));
    expect(after.cards.find(c => c.id === "parent")?.columnId).toBe("done");
    expect(after.cards.filter(c => c.id !== "parent")).toEqual(before.cards.filter(c => c.id !== "parent"));
  });
  for (const change of ["child", "new-child", "parent", "omission", "scope"] as const) {
    it(`refuses stale or incomplete ${change} intent without partial moves or activities`, async () => {
      const board = `finish-refusal-${change}`; const { a, command } = await finishFixture(board);
      if (change === "child" || change === "parent") { a.send({ type: "card.move", mutationId: "peer", id: change, columnId: "start", position: "a5" }); await awaitBroadcast(a, "peer"); }
      if (change === "new-child") { a.send({ type: "subtask.create", mutationId: "peer", id: "new", parentCardId: "parent", relationId: "new-link", title: "New", position: "a6" }); await awaitBroadcast(a, "peer"); }
      const before = await snapshotOf(await connect(board));
      a.send({ ...command, ...(change === "omission" ? { children: command.children.slice(0,1) } : {}), ...(change === "scope" ? { scope: "parent" } : {}) });
      expect((await awaitError(a, "finish")).message).toMatch(/changed|unfinished/);
      const after = await snapshotOf(await connect(board)); expect(after.cards).toEqual(before.cards); expect(after.activities).toEqual(before.activities);
    });
  }
  it("rolls back earlier family rows when a later SQL write fails", async () => {
    const board = "finish-sql-failure"; const { a, command, snapshot: before } = await finishFixture(board);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("CREATE TRIGGER refuse_finish BEFORE UPDATE ON cards WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    });
    a.send(command); expect((await awaitError(a, "finish")).message).toContain("fixture write failure");
    const after = await snapshotOf(await connect(board)); expect(after.cards).toEqual(before.cards); expect(after.activities).toEqual(before.activities);
  });
  it("refuses a transferred child before any family write", async () => {
    const board = "finish-transfer-lock"; const { a, command, snapshot: before } = await finishFixture(board);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("INSERT INTO card_transfer_locks(card_id,transfer_id,destination_board_id,phase,expires_at) VALUES('second','fixture-transfer','other','prepared',?)", Date.now()+60_000); });
    a.send(command); expect((await awaitError(a, "finish")).message).toMatch(/transfer/);
    const after = await snapshotOf(await connect(board)); expect(after.cards).toEqual(before.cards); expect(after.activities).toEqual(before.activities);
  });
  it("refuses an archived child before any family write", async () => {
    const board = "finish-archived-child"; const { a, command } = await finishFixture(board);
    a.send({ type: "card.delete", mutationId: "archive-child", id: "second" }); await awaitBroadcast(a, "archive-child");
    const before = await snapshotOf(await connect(board));
    a.send(command); expect((await awaitError(a, "finish")).message).toBe("archived cards are read-only");
    const after = await snapshotOf(await connect(board)); expect(after.cards).toEqual(before.cards); expect(after.activities).toEqual(before.activities);
  });
  it("denies family completion from a socket whose access generation has expired", async () => {
    const board = "finish-access-changed"; const { a, command, snapshot: before } = await finishFixture(board);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("UPDATE board_access_state SET generation = generation + 1 WHERE id = 1"); });
    a.send(command); expect((await awaitError(a, "finish")).message).toContain("access changed"); expect((await a.closed).code).toBe(4010);
    const after = await snapshotOf(await connect(board)); expect(after.cards).toEqual(before.cards); expect(after.activities).toEqual(before.activities);
  });
  it("closes incompatible hibernating sockets before accepting a mutation", async () => {
    const board = "independent-oldsocket"; const a = await fixture(board);
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    await runInDurableObject(stub, (_instance, state) => { const socket = state.getWebSockets()[0]!; socket.serializeAttachment({ ...socket.deserializeAttachment(), protocolVersion: "7" }); });
    a.send({ type: "card.delete", mutationId: "old-delete", id: "parent" });
    expect((await a.closed).code).toBe(1012);
    expect((await snapshotOf(await connect(board))).cards).toHaveLength(2);
  });
});

describe("workflow roles follow the board's ends until an admin chooses", () => {
  const roles = (snapshot: Awaited<ReturnType<typeof snapshotOf>>) =>
    [...snapshot.columns].sort((x, y) => (x.position < y.position ? -1 : 1)).map((c) => [c.id, c.starting, c.completed]);
  const createColumn = async (client: Client, id: string, position: string) => {
    client.send({ type: "column.create", mutationId: `create-${id}`, id, title: id, position });
    await awaitBroadcast(client, `create-${id}`);
  };

  it("recomputes after every column create, move and delete, and moves no card", async () => {
    const board = "board-auto-roles";
    const a = await connect(board);
    const b = await connect(board);
    await snapshotOf(a);
    await snapshotOf(b);
    await createColumn(a, "col-1", "a1");
    a.send({ type: "card.create", mutationId: "card", id: "card-1", columnId: "col-1", title: "Card", position: "a0" });
    await awaitBroadcast(a, "card");
    let snapshot = await snapshotOf(await connect(board));
    expect(roles(snapshot)).toEqual([["col-1", false, false]]);
    expect(snapshot.workflowRolesExplicit).toBe(false);

    // The second column sorts first: it starts work and the first column finishes it.
    await createColumn(a, "col-2", "a0");
    expect(await awaitBroadcast(b, "create-col-2")).toMatchObject({ type: "column.create", id: "col-2" });
    snapshot = await snapshotOf(await connect(board));
    expect(roles(snapshot)).toEqual([["col-2", true, false], ["col-1", false, true]]);
    // Completion is derived, so the card in the completed column is done.
    expect(snapshot.cards.map((card) => [card.id, card.columnId, card.subtaskDone])).toEqual([["card-1", "col-1", true]]);

    // A third column on the right takes over the completed role; the card stays put and is open again.
    await createColumn(a, "col-3", "a2");
    snapshot = await snapshotOf(await connect(board));
    expect(roles(snapshot)).toEqual([["col-2", true, false], ["col-1", false, false], ["col-3", false, true]]);
    expect(snapshot.cards.map((card) => [card.id, card.columnId, card.subtaskDone])).toEqual([["card-1", "col-1", false]]);

    // Reordering moves the ends.
    a.send({ type: "column.move", mutationId: "move", id: "col-3", position: "Zz" });
    await awaitBroadcast(a, "move");
    snapshot = await snapshotOf(await connect(board));
    expect(roles(snapshot)).toEqual([["col-3", true, false], ["col-2", false, false], ["col-1", false, true]]);

    // Deleting a role column is allowed while the roles are automatic, and they follow the new ends.
    a.send({ type: "column.delete", mutationId: "delete-1", id: "col-1" });
    await awaitBroadcast(a, "delete-1");
    snapshot = await snapshotOf(await connect(board));
    expect(roles(snapshot)).toEqual([["col-3", true, false], ["col-2", false, true]]);
    a.send({ type: "column.delete", mutationId: "delete-3", id: "col-3" });
    await awaitBroadcast(a, "delete-3");
    snapshot = await snapshotOf(await connect(board));
    expect(roles(snapshot)).toEqual([["col-2", false, false]]);
    expect(snapshot.workflowRolesExplicit).toBe(false);
  });

  it("gives a board built To Do, Doing, Done its roles at To Do and Done", async () => {
    const board = "board-auto-roles-three";
    const a = await connect(board);
    await snapshotOf(a);
    for (const [id, position] of [["todo", "a0"], ["doing", "a1"], ["done", "a2"]] as const) await createColumn(a, id, position);
    expect(roles(await snapshotOf(await connect(board)))).toEqual([["todo", true, false], ["doing", false, false], ["done", false, true]]);
  });

  it("keeps explicit roles still, and the delete guard applies to them", async () => {
    const board = "board-explicit-roles";
    const a = await connect(board);
    await snapshotOf(a);
    for (const [id, position] of [["todo", "a0"], ["doing", "a1"], ["done", "a2"]] as const) await createColumn(a, id, position);
    // An admin picks Doing as the completed column.
    a.send({ type: "workflow.configure", mutationId: "choose", startingColumnId: "todo", completedColumnId: "doing", expectedStartingColumnId: "todo", expectedCompletedColumnId: "done" });
    await awaitBroadcast(a, "choose");
    let snapshot = await snapshotOf(await connect(board));
    expect(snapshot.workflowRolesExplicit).toBe(true);
    expect(roles(snapshot)).toEqual([["todo", true, false], ["doing", false, true], ["done", false, false]]);

    // A column on the right, or a reorder, leaves the roles where they are.
    await createColumn(a, "later", "a3");
    a.send({ type: "column.move", mutationId: "move", id: "todo", position: "a4" });
    await awaitBroadcast(a, "move");
    snapshot = await snapshotOf(await connect(board));
    expect(roles(snapshot)).toEqual([["doing", false, true], ["done", false, false], ["later", false, false], ["todo", true, false]]);

    // The guard applies to a role column; any other column can go.
    a.send({ type: "column.delete", mutationId: "delete-role", id: "doing" });
    expect((await awaitError(a, "delete-role")).message).toContain("replacement");
    a.send({ type: "column.delete", mutationId: "delete-other", id: "later" });
    await awaitBroadcast(a, "delete-other");
    snapshot = await snapshotOf(await connect(board));
    expect(roles(snapshot)).toEqual([["doing", false, true], ["done", false, false], ["todo", true, false]]);
    expect(snapshot.workflowRolesExplicit).toBe(true);
  });
});

describe("subtask mode conversion (ADR 0067)", () => {
  type LegacyCard = { id: string; column: string; position: string; type?: "task" | "subtask"; done?: boolean; archived?: boolean };
  type Legacy = {
    columns: Array<[id: string, position: string]>;
    roles?: { starting: string; completed: string };
    cards: LegacyCard[];
    relations: Array<[id: string, source: string, target: string, kind?: string]>;
  };
  const stubOf = (board: string) => env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
  async function restart(board: string): Promise<void> {
    await expect(runInDurableObject(stubOf(board), (_instance, state) => state.abort("restart"))).rejects.toThrow();
  }
  /** Writes a board as schema v28 left it, restarts the DO so the conversion step runs, and reads it back. */
  async function convert(board: string, legacy: Legacy) {
    const initial = await connect(board);
    await snapshotOf(initial);
    initial.close();
    await runInDurableObject(stubOf(board), (_instance, state) => {
      const sql = state.storage.sql;
      for (const [id, position] of legacy.columns) {
        sql.exec(
          "INSERT INTO columns(id, title, position, starting, completed) VALUES (?, ?, ?, ?, ?)",
          id, id, position, legacy.roles?.starting === id ? 1 : 0, legacy.roles?.completed === id ? 1 : 0,
        );
      }
      legacy.cards.forEach((card, index) => {
        sql.exec(
          `INSERT INTO cards(id, column_id, title, description, position, task_number, priority,
                             task_type, subtask_done, created_at, updated_at, archived_at, archived_column_title)
           VALUES (?, ?, ?, '', ?, ?, 'medium', ?, ?, 1, 1, ?, ?)`,
          card.id, card.column, card.id, card.position, index + 1, card.type ?? "task", card.done ? 1 : 0,
          card.archived ? 1 : null, card.archived ? "Old" : null,
        );
      });
      for (const [id, source, target, kind] of legacy.relations) {
        sql.exec(
          "INSERT INTO card_relations(id, source_card_id, target_card_id, kind) VALUES (?, ?, ?, ?)",
          id, source, target, kind ?? "subtask",
        );
      }
      sql.exec("UPDATE meta SET value = 28 WHERE key = 'schema_version'");
    });
    await restart(board);
    return snapshotOf(await connect(board));
  }
  const placement = (snapshot: Awaited<ReturnType<typeof snapshotOf>>, id: string) => {
    const card = snapshot.cards.find((candidate) => candidate.id === id)!;
    return [card.columnId, card.taskType] as const;
  };
  const three: Legacy["columns"] = [["first", "a0"], ["work", "a1"], ["done", "a2"]];

  it("gives the leftmost column the starting role and the rightmost the completed one", async () => {
    const snapshot = await convert("conv-roles", { columns: [["mid", "a1"], ["last", "a2"], ["first", "a0"]], cards: [], relations: [] });
    expect(
      snapshot.columns.map((c) => [c.id, c.starting, c.completed]).sort(),
    ).toEqual([["first", true, false], ["last", false, true], ["mid", false, false]]);
    // No cards: the roles keep following the board's ends.
    expect(snapshot.workflowRolesExplicit).toBe(false);
  });

  it("makes the roles explicit when it assigns them to a board that holds any card, archived or not", async () => {
    const columns: Legacy["columns"] = [["first", "a0"], ["last", "a1"]];
    const active = await convert("conv-explicit-active", { columns, cards: [{ id: "task", column: "first", position: "a0" }], relations: [] });
    expect(active.workflowRolesExplicit).toBe(true);
    const archived = await convert("conv-explicit-archived", { columns, cards: [{ id: "gone", column: "first", position: "a0", archived: true }], relations: [] });
    expect(archived.workflowRolesExplicit).toBe(true);
    // A single column with cards got no roles, so nothing was chosen for it.
    const single = await convert("conv-explicit-single", { columns: [["only", "a0"]], cards: [{ id: "task", column: "only", position: "a0" }], relations: [] });
    expect(single.workflowRolesExplicit).toBe(false);
  });

  it("moves a finished child to the completed column, after that column's own cards", async () => {
    const snapshot = await convert("conv-done", {
      columns: three,
      cards: [
        { id: "parent", column: "work", position: "a0" },
        { id: "finished", column: "done", position: "a3" },
        { id: "child", column: "first", position: "a5", type: "subtask", done: true },
      ],
      relations: [["link", "parent", "child"]],
    });
    expect(placement(snapshot, "child")).toEqual(["done", "subtask"]);
    const child = snapshot.cards.find((card) => card.id === "child")!;
    expect(child.position > "a3").toBe(true);
    expect(child.subtaskDone).toBe(true);
    expect(placement(snapshot, "parent")).toEqual(["work", "task"]);
    expect(snapshot.relations).toEqual([{ id: "link", sourceCardId: "parent", targetCardId: "child", kind: "subtask" }]);
  });

  it("sends an unfinished child under a completed parent to the starting column", async () => {
    const snapshot = await convert("conv-open-under-done", {
      columns: three,
      cards: [
        { id: "first-card", column: "first", position: "a0" },
        { id: "parent", column: "done", position: "a0" },
        { id: "child", column: "work", position: "a1", type: "subtask" },
      ],
      relations: [["link", "parent", "child"]],
    });
    expect(placement(snapshot, "child")).toEqual(["first", "subtask"]);
    expect(snapshot.cards.find((card) => card.id === "child")!.position > "a0").toBe(true);
    expect(snapshot.cards.find((card) => card.id === "child")!.subtaskDone).toBe(false);
  });

  it("keeps an unfinished child in the column it was shown in, appending movers in their position order", async () => {
    const snapshot = await convert("conv-displayed", {
      columns: three,
      cards: [
        { id: "parent", column: "work", position: "a0" },
        { id: "stays", column: "work", position: "a9", type: "subtask" },
        { id: "late", column: "first", position: "a3", type: "subtask" },
        { id: "early", column: "first", position: "a1", type: "subtask" },
      ],
      relations: [["l1", "parent", "stays"], ["l2", "parent", "late"], ["l3", "parent", "early"]],
    });
    // Shown in the parent's column whatever the stale fallback says.
    for (const id of ["stays", "late", "early"]) expect(placement(snapshot, id)).toEqual(["work", "subtask"]);
    const position = (id: string) => snapshot.cards.find((card) => card.id === id)!.position;
    expect(position("stays")).toBe("a9");
    expect(position("early") > "a9" && position("late") > position("early")).toBe(true);
  });

  it("turns children with no parent the forest accepts into tasks and drops only their subtask links", async () => {
    const snapshot = await convert("conv-detached", {
      columns: three,
      cards: [
        { id: "p1", column: "work", position: "a0" },
        { id: "p2", column: "work", position: "a1" },
        { id: "gone-parent", column: "work", position: "a2", archived: true },
        { id: "loose", column: "work", position: "a3", type: "subtask" },
        { id: "cycle-a", column: "work", position: "a4", type: "subtask" },
        { id: "cycle-b", column: "work", position: "a5", type: "subtask" },
        { id: "two-parents", column: "work", position: "a6", type: "subtask" },
        { id: "kept", column: "work", position: "a7", type: "subtask" },
        { id: "ok", column: "work", position: "a8", type: "subtask" },
      ],
      relations: [
        ["cycle-1", "cycle-a", "cycle-b"],
        ["cycle-2", "cycle-b", "cycle-a"],
        ["two-1", "p1", "two-parents"],
        ["two-2", "p2", "two-parents"],
        ["kept-link", "gone-parent", "kept"],
        ["ok-link", "p1", "ok"],
        ["unrelated", "p1", "loose", "blocks"],
      ],
    });
    for (const id of ["loose", "cycle-a", "cycle-b", "two-parents"]) {
      expect(placement(snapshot, id)).toEqual(["work", "task"]);
    }
    // A child of an archived parent keeps its link: restoring the parent reattaches it.
    expect(placement(snapshot, "kept")).toEqual(["work", "subtask"]);
    expect(placement(snapshot, "ok")).toEqual(["work", "subtask"]);
    expect(snapshot.relations.map((relation) => relation.id).sort()).toEqual(["kept-link", "ok-link", "unrelated"]);
  });

  it("places a child of an archived parent by its own data", async () => {
    const snapshot = await convert("conv-archived-parent", {
      columns: three,
      cards: [
        { id: "gone", column: "work", position: "a0", archived: true },
        { id: "first-card", column: "first", position: "a0" },
        { id: "finished", column: "first", position: "a1", type: "subtask", done: true },
        { id: "open-in-done", column: "done", position: "a2", type: "subtask" },
        { id: "open-in-work", column: "work", position: "a3", type: "subtask" },
      ],
      relations: [["l1", "gone", "finished"], ["l2", "gone", "open-in-done"], ["l3", "gone", "open-in-work"]],
    });
    // Done goes to the completed column; an open child stored there stays open in the starting column.
    expect(placement(snapshot, "finished")).toEqual(["done", "subtask"]);
    expect(placement(snapshot, "open-in-done")).toEqual(["first", "subtask"]);
    expect(placement(snapshot, "open-in-work")).toEqual(["work", "subtask"]);
    expect(snapshot.relations.map((relation) => relation.id).sort()).toEqual(["l1", "l2", "l3"]);
    expect(snapshot.archivedCards.map((card) => card.id)).toEqual(["gone"]);
  });

  it("keeps a child under its active parent when a second parent is archived", async () => {
    const snapshot = await convert("conv-active-and-archived-parent", {
      columns: three,
      cards: [
        { id: "active", column: "work", position: "a0" },
        { id: "gone", column: "work", position: "a1", archived: true },
        { id: "child", column: "first", position: "a2", type: "subtask" },
      ],
      relations: [["live", "active", "child"], ["old", "gone", "child"]],
    });
    // Displayed under the active parent in Work, so it stays a subtask there with both links.
    expect(placement(snapshot, "child")).toEqual(["work", "subtask"]);
    expect(snapshot.relations.map((relation) => relation.id).sort()).toEqual(["live", "old"]);
  });

  it("leaves a board that already has a starting column exactly as it is", async () => {
    const legacy: Legacy = {
      columns: three,
      roles: { starting: "work", completed: "done" },
      cards: [
        { id: "parent", column: "done", position: "a0" },
        { id: "child", column: "first", position: "a1", type: "subtask", done: true },
        { id: "loose", column: "first", position: "a2", type: "subtask" },
      ],
      relations: [["link", "parent", "child"]],
    };
    const snapshot = await convert("conv-configured", legacy);
    expect(snapshot.columns.map((c) => [c.id, c.starting, c.completed]).sort()).toEqual([
      ["done", false, true], ["first", false, false], ["work", true, false],
    ]);
    // An admin chose these roles, so they stay.
    expect(snapshot.workflowRolesExplicit).toBe(true);
    expect(snapshot.cards.map((card) => [card.id, card.columnId, card.position, card.taskType])).toEqual([
      ["parent", "done", "a0", "task"], ["child", "first", "a1", "subtask"], ["loose", "first", "a2", "subtask"],
    ]);
    expect(snapshot.relations).toHaveLength(1);
  });

  it("gives a board with fewer than two columns no roles and keeps children in their parent's column", async () => {
    const snapshot = await convert("conv-one-column", {
      columns: [["only", "a0"]],
      cards: [
        { id: "parent", column: "only", position: "a0" },
        { id: "child", column: "only", position: "a1", type: "subtask", done: true },
        { id: "loose", column: "only", position: "a2", type: "subtask" },
      ],
      relations: [["link", "parent", "child"]],
    });
    expect(snapshot.columns.map((c) => [c.id, c.starting, c.completed])).toEqual([["only", false, false]]);
    expect(placement(snapshot, "child")).toEqual(["only", "subtask"]);
    expect(placement(snapshot, "loose")).toEqual(["only", "task"]);
    // With no completed column nothing is done, whatever the old flag said.
    expect(snapshot.cards.some((card) => card.subtaskDone)).toBe(false);

    const empty = await convert("conv-no-columns", { columns: [], cards: [], relations: [] });
    expect(empty.columns).toEqual([]);
    expect(empty.cards).toEqual([]);
  });

  it("does not touch archived cards or the links they keep", async () => {
    const snapshot = await convert("conv-archived", {
      columns: three,
      cards: [
        { id: "parent", column: "work", position: "a0" },
        { id: "archived-child", column: "first", position: "a1", type: "subtask", done: true, archived: true },
        { id: "archived-loose", column: "first", position: "a2", type: "subtask", archived: true },
      ],
      relations: [["link", "parent", "archived-child"]],
    });
    expect(snapshot.archivedCards.map((card) => [card.id, card.columnId, card.position, card.taskType])).toEqual([
      ["archived-child", "first", "a1", "subtask"], ["archived-loose", "first", "a2", "subtask"],
    ]);
    expect(snapshot.relations).toHaveLength(1);
    expect(snapshot.cards.map((card) => card.id)).toEqual(["parent"]);
  });

  it("changes nothing when run a second time", async () => {
    const board = "conv-twice";
    const first = await convert(board, {
      columns: three,
      cards: [
        { id: "parent", column: "work", position: "a0" },
        { id: "child", column: "first", position: "a1", type: "subtask", done: true },
        { id: "open", column: "first", position: "a2", type: "subtask" },
        { id: "loose", column: "first", position: "a3", type: "subtask" },
      ],
      relations: [["l1", "parent", "child"], ["l2", "parent", "open"]],
    });
    // The first pass did convert.
    expect(placement(first, "child")).toEqual(["done", "subtask"]);
    expect(placement(first, "open")).toEqual(["work", "subtask"]);
    expect(placement(first, "loose")).toEqual(["first", "task"]);
    await runInDurableObject(stubOf(board), (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = 28 WHERE key = 'schema_version'");
    });
    await restart(board);
    const second = await snapshotOf(await connect(board));
    expect(second.cards).toEqual(first.cards);
    expect(second.columns).toEqual(first.columns);
    expect(second.relations).toEqual(first.relations);
  });
});

describe("audit transfer regressions", () => {
  for (const committed of [false, true]) {
    for (const restart of [false, true]) {
      it(`settles ${committed ? "committed" : "uncommitted"} transfers after destination deletion${restart ? " and restart" : ""}`, async () => {
        const suffix = `${committed}-${restart}`;
        const source = `audit-delete-source-${suffix}`, destination = `audit-delete-destination-${suffix}`;
        const a = await connect(source); await snapshotOf(a); await seedCard(a, "audit-delete");
        const b = await connect(destination); await snapshotOf(b);
        b.send({ type: "column.create", mutationId: "destination-column", id: "col-1", title: "Todo", position: "a0" });
        await awaitBroadcast(b, "destination-column");
        const sourceStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(source));
        let destinationStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(destination));
        const transferId = "audit-delete-transfer";
        const prepared = await sourceStub.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
          method: "POST", headers: await transferHeaders(source),
          body: JSON.stringify({ transferId, cardId: "card-1", destinationBoardId: destination }),
        });
        expect(prepared.status).toBe(200);
        const { bundle } = await prepared.json<{ bundle: unknown }>();
        if (committed) {
          const imported = await destinationStub.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
            method: "POST", headers: await transferHeaders(destination),
            body: JSON.stringify({ transferId, sourceBoardId: source, destinationColumnId: "col-1", bundle }),
          });
          expect(imported.status).toBe(200);
        }
        expect((await destinationStub.fetch(`https://board.internal${DELETE_BOARD_PATH}`, {
          method: "POST", headers: { [INTERNAL_BOARD_ID_HEADER]: destination },
        })).status).toBe(204);
        if (restart) {
          await expect(runInDurableObject(destinationStub, (_instance, state) => state.abort("restart"))).rejects.toThrow();
          destinationStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(destination));
        }
        expect((await destinationStub.fetch("https://board.internal/ws", {
          headers: { Upgrade: "websocket", [INTERNAL_BOARD_ID_HEADER]: destination, [INTERNAL_USER_ID_HEADER]: "test-user" },
        })).status).toBe(410);
        const settled = await destinationStub.fetch(`https://board.internal${CARD_TRANSFER_ABORT_PATH}`, {
          method: "POST", headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: destination },
          body: JSON.stringify({ transferId, sourceBoardId: source, cardId: "card-1" }),
        });
        expect(settled.status).toBe(200);
        expect(await settled.json()).toMatchObject({ committed, receipt: { taskNumber: committed ? 1 : -1 } });
        await runInDurableObject(sourceStub, async (instance, state) => {
          state.storage.sql.exec("UPDATE card_transfer_locks SET expires_at = 0");
          await instance.alarm();
        });
        const outcome = await runInDurableObject(sourceStub, (_instance, state) => ({
          cards: state.storage.sql.exec("SELECT id FROM cards").toArray(),
          locks: state.storage.sql.exec("SELECT card_id FROM card_transfer_locks").toArray(),
          operations: state.storage.sql.exec("SELECT state FROM card_transfer_operations").toArray(),
        }));
        expect(outcome).toEqual({ cards: committed ? [] : [{ id: "card-1" }], locks: [], operations: [{ state: committed ? "finalized" : "aborted" }] });
        const receipt = await destinationStub.fetch(`https://board.internal${CARD_TRANSFER_RECEIPT_PATH}`, {
          method: "POST", headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: destination },
          body: JSON.stringify({ transferId, sourceBoardId: source, cardId: "card-1" }),
        });
        expect(receipt.status).toBe(committed ? 200 : 410);
        const lateId = crypto.randomUUID();
        const lateKey = attachmentObjectKey(destination, lateId);
        await env.ATTACHMENTS.put(lateKey, "late upload");
        const reconciled = await destinationStub.fetch(`https://board.internal${RECONCILE_ATTACHMENTS_PATH}`, {
          method: "POST", headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: destination },
          body: JSON.stringify({ objects: [{ key: lateKey, attachmentId: lateId }] }),
        });
        expect(reconciled.status).toBe(200);
        await expectObjectDeleted(lateKey);
      });
    }
  }

  it("transfers every checklist item after ordinary editing exceeds 500 items", async () => {
    const source = "audit-large-source", destination = "audit-large-destination";
    const a = await connect(source); await snapshotOf(a); await seedCard(a, "large");
    const b = await connect(destination); await snapshotOf(b);
    b.send({ type: "column.create", mutationId: "large-col", id: "col-1", title: "Todo", position: "a0" });
    await awaitBroadcast(b, "large-col");
    const sourceStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(source));
    const destinationStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(destination));
    await runInDurableObject(sourceStub, (_instance, state) => {
      for (let i = 0; i < 500; i++) state.storage.sql.exec(
        "INSERT INTO checklist_items(id,card_id,text,done,position) VALUES(?, 'card-1', ?, 0, 'a0')", `item-${i}`, `Item ${i}`,
      );
    });
    a.send({ type: "checklist.create", mutationId: "item-501", id: "item-500", cardId: "card-1", text: "Last item", position: "a1" });
    await awaitBroadcast(a, "item-501");
    const transferId = "large-transfer";
    const prepared = await sourceStub.fetch(`https://board.internal${CARD_TRANSFER_PREPARE_PATH}`, {
      method: "POST", headers: await transferHeaders(source),
      body: JSON.stringify({ transferId, cardId: "card-1", destinationBoardId: destination }),
    });
    expect(prepared.status).toBe(200);
    const { bundle } = await prepared.json<{ bundle: unknown }>();
    const imported = await destinationStub.fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
      method: "POST", headers: await transferHeaders(destination),
      body: JSON.stringify({ transferId, sourceBoardId: source, destinationColumnId: "col-1", bundle }),
    });
    expect(imported.status).toBe(200);
    const snapshot = await snapshotOf(await connect(destination));
    expect(snapshot.checklistItems).toHaveLength(501);
    expect(snapshot.checklistItems.find(item => item.id === "item-500")?.text).toBe("Last item");
    const finalized = await sourceStub.fetch(`https://board.internal${CARD_TRANSFER_FINALIZE_PATH}`, {
      method: "POST", headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: source },
      body: JSON.stringify({ transferId, cardId: "card-1", destinationBoardId: destination }),
    });
    expect(finalized.status).toBe(200);
    expect((await snapshotOf(await connect(source))).cards).toHaveLength(0);
  });
});

describe("transfer collection validation", () => {
  it("accepts supported card collections above the former transfer-only limits and still validates each row", async () => {
    const client = await connect("audit-transfer-collections");
    await snapshotOf(client); await seedCard(client, "collections");
    const card = (await snapshotOf(await connect("audit-transfer-collections"))).cards[0]!;
    const bundle = {
      card,
      checklistItems: Array.from({ length: 501 }, (_, i) => ({ id: `item-${i}`, cardId: card.id, text: "Item", done: false, position: "a0" })),
      attachments: Array.from({ length: 101 }, (_, i) => ({ id: `attachment-${i}`, cardId: card.id, fileName: "file.txt", contentType: "text/plain", size: 1, objectKey: `board/attachment-${i}` })),
      comments: Array.from({ length: 1001 }, (_, i) => ({ id: `comment-${i}`, cardId: card.id, authorId: "test-user", parentCommentId: null, deleted: false, body: "Comment", createdAt: 1, updatedAt: 1 })),
      activities: Array.from({ length: 5001 }, (_, i) => ({ id: `activity-${i}`, cardId: card.id, actorId: "test-user", sequence: i + 1, createdAt: 1, detail: { type: "card.created" } })),
      labels: Array.from({ length: 101 }, (_, i) => ({ id: `label-${i}`, name: "Label", color: "red", joinId: `join-${i}` })),
      pullRequestAssociation: null,
      developmentPullRequests: [],
      developmentBranches: [],
      developmentUnlinks: [],
    };
    expect(PreparedCardTransferBundleSchema.safeParse(bundle).success).toBe(true);
    expect(PreparedCardTransferBundleSchema.safeParse({ ...bundle, attachments: [{ ...bundle.attachments[0], size: -1 }] }).success).toBe(false);
    expect(PreparedCardTransferBundleSchema.safeParse({ ...bundle, checklistItems: [{ ...bundle.checklistItems[0], cardId: "another-card" }] }).success).toBe(false);
  });
});

describe("transfer settlement on the source board", () => {
  type LocalSource = { finalize(): Promise<{ status: number }>; release(): Promise<{ status: number }> };
  type WithLocalSource = { localTransferSource(cardId: string, transferId: string, destinationBoardId: string | null, broadcast: boolean): LocalSource };

  /** A source board with one card held by `transferId` toward `destination`. */
  async function lockedCard(board: string, transferId: string, destination: string) {
    const client = await connect(board);
    await snapshotOf(client);
    client.send({ type: "column.create", mutationId: "settle-col", id: `${board}-col`, title: "Col", position: "a0" });
    await awaitBroadcast(client, "settle-col");
    client.send({ type: "card.create", mutationId: "settle-card", id: `${board}-card`, columnId: `${board}-col`, title: "Card", position: "a0" });
    await awaitBroadcast(client, "settle-card");
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(board));
    const now = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO card_transfer_locks(card_id, transfer_id, destination_board_id, phase, expires_at) VALUES (?, ?, ?, 'prepared', ?)`,
        `${board}-card`, transferId, destination, now + 300_000,
      );
      state.storage.sql.exec(
        `INSERT INTO card_transfer_operations(transfer_id, card_id, destination_board_id, generation, state, created_at, updated_at) VALUES (?, ?, ?, 1, 'prepared', ?, ?)`,
        transferId, `${board}-card`, destination, now, now,
      );
    });
    const facts = () =>
      runInDurableObject(stub, (_instance, state) => ({
        card: state.storage.sql.exec("SELECT 1 FROM cards WHERE id = ?", `${board}-card`).toArray().length === 1,
        lock: state.storage.sql.exec("SELECT 1 FROM card_transfer_locks WHERE card_id = ?", `${board}-card`).toArray().length === 1,
        op: state.storage.sql.exec<{ state: string }>("SELECT state FROM card_transfer_operations WHERE transfer_id = ?", transferId).toArray()[0]?.state,
      }));
    const release = () =>
      stub.fetch("https://board.internal/internal/card-transfer/release", {
        method: "POST",
        headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: board },
        body: JSON.stringify({ transferId, cardId: `${board}-card`, destinationBoardId: destination }),
      });
    return { client, stub, cardId: `${board}-card`, facts, release };
  }

  const receiptAt = (destination: string, transferId: string, sourceBoardId: string, cardId: string, taskNumber: number) =>
    runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(destination)), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO card_transfer_receipts(transfer_id, source_board_id, card_id, task_number) VALUES (?, ?, ?, ?)`,
        transferId, sourceBoardId, cardId, taskNumber,
      );
    });

  it("release: an uncommitted destination is fenced and the lock is released", async () => {
    const s = await lockedCard("settle-rel-abort", "x-rel-abort", "settle-rel-abort-dst");
    const res = await s.release();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await s.facts()).toEqual({ card: true, lock: false, op: "aborted" });
    s.client.close();
  });

  it("release: a committed destination finalizes the source instead", async () => {
    const s = await lockedCard("settle-rel-commit", "x-rel-commit", "settle-rel-commit-dst");
    await receiptAt("settle-rel-commit-dst", "x-rel-commit", "settle-rel-commit", s.cardId, 5);
    const res = await s.release();
    expect(await res.json()).toEqual({ ok: true, committed: true });
    expect(await s.facts()).toEqual({ card: false, lock: false, op: "finalized" });
    s.client.close();
  });

  it("release: a destination whose receipt names another operation frees the lock", async () => {
    const s = await lockedCard("settle-rel-refused", "x-rel-refused", "settle-rel-refused-dst");
    // The same transfer id already committed another card there, so this operation can never commit.
    await receiptAt("settle-rel-refused-dst", "x-rel-refused", "some-other-board", "other-card", 3);
    const res = await s.release();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await s.facts()).toEqual({ card: true, lock: false, op: "aborted" });
    s.client.close();
  });

  it("local source acts only while the same operation and destination hold the lock", async () => {
    const s = await lockedCard("settle-local", "x-local", "settle-local-dst");
    const answer = (transferId: string, destination: string | null, step: "finalize" | "release") =>
      runInDurableObject(s.stub, (instance) =>
        (instance as unknown as WithLocalSource).localTransferSource(s.cardId, transferId, destination, false)[step](),
      );
    expect((await answer("x-local", "another-dst", "finalize")).status).toBe(409);
    expect((await answer("x-other", null, "release")).status).toBe(409);
    expect(await s.facts()).toEqual({ card: true, lock: true, op: "prepared" });
    expect((await answer("x-local", "settle-local-dst", "finalize")).status).toBe(200);
    expect(await s.facts()).toEqual({ card: false, lock: false, op: "finalized" });
    expect((await answer("x-local", null, "release")).status).toBe(409);
    s.client.close();
  });
});
