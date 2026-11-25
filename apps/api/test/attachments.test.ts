import { REALTIME_PROTOCOL_VERSION, type ServerMessage } from "@foxban/shared";
import { SELF, applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The attachment routes driven through the real Worker against a miniflare R2
 * simulator: uploads and provisional cleanup, membership gates, declared-type
 * limits, download isolation, and the headers a browser actually receives.
 *
 * D1 bindings in the test pool start empty, so the migrations are applied first.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
import { attachmentTransferObjectKey } from "../src/attachment-lifecycle";
import { INTERNAL_BOARD_ID_HEADER, INTERNAL_USER_ID_HEADER } from "../src/internal-headers";
import { reconcileAttachmentObjects } from "../src/index";
import {
  CARD_TRANSFER_IMPORT_PATH,
  CARD_TRANSFER_PREPARE_PATH,
  CARD_TRANSFER_RECEIPT_PATH,
  STAGE_ATTACHMENT_PATH,
} from "../src/board-api";

const PASSWORD = "correct horse battery";
const ORIGIN = "https://foxban.test";

type UploadResult = { id: string; contentType: string; size: number };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function awaitBroadcast(ws: WebSocket, mutationId: string): Promise<void> {
  const { promise, resolve } = deferred<void>();
  const listener = (event: MessageEvent) => {
    const data = JSON.parse(event.data as string);
    if (data.mutationId === mutationId) {
      ws.removeEventListener("message", listener);
      resolve();
    }
  };
  ws.addEventListener("message", listener);
  return promise;
}

/** A real 1x1 PNG: the routes never decode it, but nothing here is a fake shape. */
const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("response carried no Set-Cookie header");
  return header.split(";")[0]!;
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string, extra?: HeadersInit): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    headers: { ...(cookie ? { cookie } : {}), ...extra },
  });
}

function del(path: string, cookie?: string, extra?: HeadersInit): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "DELETE",
    headers: { ...(cookie ? { cookie } : {}), ...extra },
  });
}

/** Registers a fresh user and returns their session cookie. */
async function signup(email: string, name = "Test User"): Promise<string> {
  const response = await post("/auth/signup", { email, name, password: PASSWORD });
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

async function createBoard(cookie: string, name: string, key?: string): Promise<string> {
  const boardKey =
    key ??
    `B${Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) =>
      b.toString(16).padStart(2, "0"),
    )
      .join("")
      .slice(0, 9)
      .toUpperCase()}`;
  const response = await post("/boards", { name, key: boardKey, workspaceId: await firstWorkspaceId(cookie) }, cookie);
  expect(response.status).toBe(200);
  return (await response.json<{ id: string }>()).id;
}
async function mintInvite(cookie: string): Promise<string> {
  const response = await post("/invites", {}, cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ token: string }>()).token;
}

async function signupWithInvite(
  email: string,
  invite: string,
  name = "Test User",
): Promise<string> {
  const response = await post("/auth/signup", { email, name, password: PASSWORD, invite });
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

/** Raw-bytes upload: the body is binary, so this cannot go through `post`. */
function upload(
  boardId: string,
  body: BodyInit,
  contentType?: string,
  cookie?: string,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/boards/${boardId}/attachments`, {
    method: "POST",
    headers: {
      ...(contentType === undefined ? {} : { "content-type": contentType }),
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
}

describe("attachment uploads", () => {
  it("rejects an upload without a session", async () => {
    const owner = await signup("att-owner@foxban.test");
    const boardId = await createBoard(owner, "Uploads");

    const response = await upload(boardId, PNG_1X1, "image/png");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects an upload from a signed-up non-member", async () => {
    const owner = await signup("att-owner2@foxban.test");
    const boardId = await createBoard(owner, "Uploads");
    const invite = await mintInvite(owner);
    const stranger = await signupWithInvite("att-stranger@user.test", invite);

    const response = await upload(boardId, PNG_1X1, "image/png", stranger);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("canonicalizes arbitrary declared types and serves them only as downloads", async () => {
    const owner = await signup("att-type@foxban.test");
    const boardId = await createBoard(owner, "Uploads");
    const htmlBody = new TextEncoder().encode("<script>alert(1)</script>");

    const htmlResponse = await upload(boardId, htmlBody, "TEXT/HTML", owner);
    expect(htmlResponse.status).toBe(201);
    const htmlUpload = await htmlResponse.json<UploadResult>();
    expect(htmlUpload).toEqual({
      id: expect.any(String),
      contentType: "text/html",
      size: htmlBody.byteLength,
    });
    const htmlObject = await env.ATTACHMENTS.get(`${boardId}/${htmlUpload.id}`);
    if (htmlObject === null) throw new Error("the HTML upload stored nothing");
    expect(htmlObject.httpMetadata?.contentType).toBe("text/html");
    expect(htmlObject.size).toBe(htmlBody.byteLength);
    expect(new Uint8Array(await htmlObject.arrayBuffer())).toEqual(htmlBody);

    const htmlServe = await get(`/boards/${boardId}/attachments/${htmlUpload.id}`, owner);
    expect(htmlServe.status).toBe(200);
    expect(htmlServe.headers.get("content-type")).toBe("application/octet-stream");
    expect(htmlServe.headers.get("content-disposition")).toBe("attachment");
    expect(htmlServe.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await htmlServe.arrayBuffer())).toEqual(htmlBody);

    const omittedBody = Uint8Array.of(1, 2, 3);
    const omittedResponse = await upload(boardId, omittedBody, undefined, owner);
    expect(omittedResponse.status).toBe(201);
    expect(await omittedResponse.json<UploadResult>()).toEqual({
      id: expect.any(String),
      contentType: "application/octet-stream",
      size: omittedBody.byteLength,
    });

    const overlongBody = Uint8Array.of(4);
    const overlongResponse = await upload(boardId, overlongBody, "x".repeat(101), owner);
    expect(overlongResponse.status).toBe(201);
    expect(await overlongResponse.json<UploadResult>()).toEqual({
      id: expect.any(String),
      contentType: "application/octet-stream",
      size: overlongBody.byteLength,
    });

    const parameterizedBody = Uint8Array.of(5, 6);
    const parameterizedResponse = await upload(
      boardId,
      parameterizedBody,
      "image/png; charset=binary",
      owner,
    );
    expect(parameterizedResponse.status).toBe(201);
    const parameterizedUpload = await parameterizedResponse.json<UploadResult>();
    expect(parameterizedUpload).toEqual({
      id: expect.any(String),
      contentType: "image/png; charset=binary",
      size: parameterizedBody.byteLength,
    });
    const parameterizedServe = await get(
      `/boards/${boardId}/attachments/${parameterizedUpload.id}`,
      owner,
    );
    expect(parameterizedServe.headers.get("content-type")).toBe("application/octet-stream");
    expect(parameterizedServe.headers.get("content-disposition")).toBe("attachment");
    expect(new Uint8Array(await parameterizedServe.arrayBuffer())).toEqual(parameterizedBody);
  });

  it.each([
    {
      name: "accepts image/png at exactly 10 MB",
      slug: "image-exact",
      contentType: "image/png",
      size: 10_485_760,
      status: 201,
    },
    {
      name: "rejects image/png above 10 MB",
      slug: "image-over",
      contentType: "image/png",
      size: 10_485_761,
      status: 413,
    },
    {
      name: "accepts application/octet-stream at exactly 50 MB",
      slug: "file-exact",
      contentType: "application/octet-stream",
      size: 52_428_800,
      status: 201,
    },
    {
      name: "rejects application/octet-stream above 50 MB",
      slug: "file-over",
      contentType: "application/octet-stream",
      size: 52_428_801,
      status: 413,
    },
  ] as const)("$name", async ({ slug, contentType, size, status }) => {
    const owner = await signup(`att-boundary-${slug}@foxban.test`);
    const boardId = await createBoard(owner, `Boundary ${slug}`);

    const response = await upload(boardId, new Uint8Array(size), contentType, owner);
    expect(response.status).toBe(status);
    if (status === 201) {
      expect(await response.json<UploadResult>()).toEqual({
        id: expect.any(String),
        contentType,
        size,
      });
    } else {
      expect(await response.json()).toEqual({ error: "too large" });
    }
  });

  it("stores the object under `boardId/uuid` with its content type", async () => {
    const owner = await signup("att-store@foxban.test");
    const boardId = await createBoard(owner, "Uploads");

    const response = await upload(boardId, PNG_1X1, "image/png", owner);
    expect(response.status).toBe(201);
    const result = await response.json<UploadResult>();
    expect(result).toEqual({
      id: expect.any(String),
      contentType: "image/png",
      size: PNG_1X1.byteLength,
    });

    const object = await env.ATTACHMENTS.get(`${boardId}/${result.id}`);
    if (object === null) throw new Error("the upload stored nothing");
    expect(object.httpMetadata?.contentType).toBe("image/png");
    expect(object.size).toBe(PNG_1X1.byteLength);
  });

  it("expires an uploaded object that never becomes attachment metadata", async () => {
    const owner = await signup("att-expire@foxban.test");
    const boardId = await createBoard(owner, "Expiring upload");
    const result = await (
      await upload(boardId, PNG_1X1, "image/png", owner)
    ).json<UploadResult>();
    const objectKey = `${boardId}/${result.id}`;
    expect(await env.ATTACHMENTS.head(objectKey)).not.toBeNull();

    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));
    const staged = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          objectKey: string;
          attachmentId: string;
          reason: string;
          deleteAfter: number;
        }>(
          `SELECT object_key AS objectKey, attachment_id AS attachmentId,
                  reason, delete_after AS deleteAfter
             FROM attachment_cleanup`,
        )
        .toArray(),
    );
    expect(staged).toEqual([
      {
        objectKey,
        attachmentId: result.id,
        reason: "staged",
        deleteAfter: expect.any(Number),
      },
    ]);

    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = 0 WHERE object_key = ?",
        objectKey,
      );
      await instance.alarm();
    });
    expect(await env.ATTACHMENTS.head(objectKey)).toBeNull();
    const remaining = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ objectKey: string; reason: string; deletedAt: number | null }>(
          "SELECT object_key AS objectKey, reason, deleted_at AS deletedAt FROM attachment_cleanup WHERE object_key = ?",
          objectKey,
        )
        .toArray()[0],
    );
    expect(remaining).toEqual({
      objectKey,
      reason: "deleted",
      deletedAt: expect.any(Number),
    });
    expect(remaining?.deletedAt).not.toBeNull();
  });
});

describe("attachment serving", () => {
  it("serves the stored bytes to a member with inert-content headers", async () => {
    const owner = await signup("att-serve@foxban.test");
    const boardId = await createBoard(owner, "Uploads");
    const { id } = await (
      await upload(boardId, PNG_1X1, "image/png", owner)
    ).json<UploadResult>();

    const response = await get(`/boards/${boardId}/attachments/${id}`, owner);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_1X1);
  });

  it("refuses to serve an object to a non-member", async () => {
    const owner = await signup("att-serve2@foxban.test");
    const boardId = await createBoard(owner, "Uploads");
    const { id } = await (
      await upload(boardId, PNG_1X1, "image/png", owner)
    ).json<UploadResult>();
    const invite = await mintInvite(owner);
    const stranger = await signupWithInvite("att-stranger2@user.test", invite);

    const response = await get(`/boards/${boardId}/attachments/${id}`, stranger);
    expect(response.status).toBe(403);
  });

  it("allows an admin outside board_members to upload and download attachments on another owner's board", async () => {
    const owner = await signup("att-admin-owner@foxban.test");
    const boardId = await createBoard(owner, "Admin Attachment Board");
    const admin = await signup("att-admin-nonmember@foxban.test");

    // Admin uploads to another owner's board without membership.
    const uploadResponse = await upload(boardId, PNG_1X1, "image/png", admin);
    expect(uploadResponse.status).toBe(201);
    const uploadResult = await uploadResponse.json<UploadResult>();
    expect(uploadResult).toEqual({
      id: expect.any(String),
      contentType: "image/png",
      size: PNG_1X1.byteLength,
    });

    // Admin downloads the attachment from another owner's board without membership.
    const downloadResponse = await get(`/boards/${boardId}/attachments/${uploadResult.id}`, admin);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(PNG_1X1);
  });

  it("answers 404 for a uuid that was never uploaded", async () => {
    const owner = await signup("att-missing@foxban.test");
    const boardId = await createBoard(owner, "Uploads");

    const response = await get(`/boards/${boardId}/attachments/${crypto.randomUUID()}`, owner);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("answers 404 for a key that is not a uuid, before touching R2", async () => {
    const owner = await signup("att-traversal@foxban.test");
    const boardId = await createBoard(owner, "Uploads");

    const response = await get(`/boards/${boardId}/attachments/..%2F..%2Fetc`, owner);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});
describe("board deletion teardown", () => {
  it("closes live sockets, deletes R2 objects and content, clears alarms, and durably refuses subsequent access", async () => {
    const owner = await signup("del-lifecycle-owner@foxban.test", "Lifecycle Owner");
    const boardId = await createBoard(owner, "Lifecycle Board");

    // 1. Open a live WebSocket to the board
    const wsResponse = await get(
      `/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      owner,
      {
        Upgrade: "websocket",
      },
    );
    expect(wsResponse.status).toBe(101);
    const socket = wsResponse.webSocket;
    if (!socket) throw new Error("expected websocket");

    let socketClosed = false;
    let closeCode: number | null = null;
    let closeReason: string | null = null;
    const receivedFrames: ServerMessage[] = [];
    socket.addEventListener("message", (event: MessageEvent) => {
      receivedFrames.push(JSON.parse(event.data as string));
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      socketClosed = true;
      closeCode = event.code;
      closeReason = event.reason;
    });
    socket.accept();

    // 2. Upload one provisional R2 object (not yet claimed into metadata)
    const provRes = await upload(boardId, PNG_1X1, "image/png", owner);
    expect(provRes.status).toBe(201);
    const provisional = await provRes.json<UploadResult>();

    // 3. Upload and commit a second attachment via normal protocol
    const commitRes = await upload(boardId, PNG_1X1, "image/png", owner);
    expect(commitRes.status).toBe(201);
    const committed = await commitRes.json<UploadResult>();

    const doStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));

    // Create column, card, and attachment through normal WS protocol
    socket.send(
      JSON.stringify({
        type: "column.create",
        mutationId: "lc-col",
        id: "col-1",
        title: "Column 1",
        position: "a0",
      }),
    );
    socket.send(
      JSON.stringify({
        type: "card.create",
        mutationId: "lc-card",
        id: "card-1",
        columnId: "col-1",
        title: "Card 1",
        position: "a0",
      }),
    );
    socket.send(
      JSON.stringify({
        type: "attachment.create",
        mutationId: "lc-att",
        id: committed.id,
        cardId: "card-1",
        fileName: "image.png",
        contentType: "image/png",
        size: PNG_1X1.byteLength,
      }),
    );

    // Wait for the attachment.create broadcast to ensure persistence
    await expect
      .poll(() =>
        receivedFrames.some(
          (frame) => frame.type === "attachment.create" && frame.mutationId === "lc-att",
        ),
      )
      .toBe(true);

    // Verify both R2 objects exist before deletion
    const beforeList = await env.ATTACHMENTS.list({ prefix: `${boardId}/` });
    expect(beforeList.objects.map((o) => o.key).sort()).toEqual([
      `${boardId}/${provisional.id}`,
      `${boardId}/${committed.id}`,
    ].sort());

    // 4. DELETE the board
    const delResponse = await del(`/boards/${boardId}`, owner);
    expect(delResponse.status).toBe(200);
    expect(await delResponse.json()).toEqual({ ok: true });

    // The fenced deletion prepares the board first, so the live socket gets the
    // temporary transition close (4010) rather than the terminal delete close.
    await expect.poll(() => socketClosed).toBe(true);
    expect(closeCode).toBe(4010);
    expect(closeReason).toBe("Board access is changing");

    // Assert R2 objects under `${boardId}/` are absent
    const afterList = await env.ATTACHMENTS.list({ prefix: `${boardId}/` });
    expect(afterList.objects).toEqual([]);

    // Assert DO storage and alarm teardown:
    const alarm = await runInDurableObject(doStub, async (_instance, state) => {
      return await state.storage.getAlarm();
    });
    expect(alarm).toBeNull();

    // No legacy KV data is retained.
    const storageKeys = await runInDurableObject(doStub, async (_instance, state) => {
      const listed = await state.storage.list();
      return Array.from(listed.keys());
    });
    expect(storageKeys).toEqual([]);
    const retained = await runInDurableObject(doStub, (_instance, state) => ({
      cards: state.storage.sql.exec("SELECT id FROM cards").toArray(),
      attachments: state.storage.sql.exec("SELECT id FROM attachments").toArray(),
      deleted: state.storage.sql.exec("SELECT value FROM meta WHERE key='deleted'").one().value,
    }));
    expect(retained).toEqual({ cards: [], attachments: [], deleted: 1 });
    // 5. Upload or socket handshake after D1 deletion is refused
    const uploadAfter = await upload(boardId, PNG_1X1, "image/png", owner);
    expect(uploadAfter.status).toBe(403);

    const wsAfter = await get(`/boards/${boardId}/ws`, owner, {
      Upgrade: "websocket",
    });
    expect(wsAfter.status).toBe(403);
  });
});
describe("card transfer route and R2 lifecycle", () => {
  it("reaches a workspace-inherited destination and preserves an inherited assignee", async () => {
    const adminCookie = await signup("inherit-xfer-admin@foxban.test");
    const moverCookie = await signupWithInvite(
      "inherit-xfer-mover@regular-user.test",
      await mintInvite(adminCookie),
    );
    const mover = await (await get("/me", moverCookie)).json<{ id: string }>();

    const workspaceResponse = await post("/workspaces", { name: "Inherited transfer" }, adminCookie);
    const workspaceId = (await workspaceResponse.json<{ workspace: { id: string } }>()).workspace.id;
    const inviteResponse = await post(`/workspaces/${workspaceId}/invites`, { role: "member" }, adminCookie);
    const invite = await inviteResponse.json<{ token: string }>();
    expect(
      (
        await post(
          `/workspaces/${workspaceId}/invites/accept`,
          { token: invite.token, operationId: crypto.randomUUID() },
          moverCookie,
        )
      ).status,
    ).toBe(200);

    const destinationResponse = await post(
      "/boards",
      {
        name: "Inherited destination",
        key: `IX${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
        workspaceId,
        accessMode: "workspace",
      },
      adminCookie,
    );
    const destination = (await destinationResponse.json<{ id: string }>()).id;
    // The mover reaches this board only through the workspace membership it holds.
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM board_members WHERE board_id=? AND user_id=?")
        .bind(destination, mover.id)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });

    const source = await createBoard(moverCookie, "Inherited source");
    const destinationSocket = (
      await get(`/boards/${destination}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, adminCookie, {
        Upgrade: "websocket",
      })
    ).webSocket!;
    destinationSocket.accept();
    const destinationColumn = awaitBroadcast(destinationSocket, "inherit-col");
    destinationSocket.send(
      JSON.stringify({ type: "column.create", mutationId: "inherit-col", id: "col-inherit", title: "Done", position: "a0" }),
    );
    await destinationColumn;

    const sourceSocket = (
      await get(`/boards/${source}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, moverCookie, {
        Upgrade: "websocket",
      })
    ).webSocket!;
    sourceSocket.accept();
    const sourceColumn = awaitBroadcast(sourceSocket, "inherit-src-col");
    sourceSocket.send(
      JSON.stringify({ type: "column.create", mutationId: "inherit-src-col", id: "col-src-inherit", title: "Todo", position: "a0" }),
    );
    await sourceColumn;
    const sourceCard = awaitBroadcast(sourceSocket, "inherit-src-card");
    sourceSocket.send(
      JSON.stringify({
        type: "card.create",
        mutationId: "inherit-src-card",
        id: "card-inherit",
        columnId: "col-src-inherit",
        title: "Inherited assignee",
        position: "a0",
        assigneeId: mover.id,
      }),
    );
    await sourceCard;

    // A destination the caller can only inherit is a real destination.
    const options = await get(`/boards/${source}/transfer-options`, moverCookie);
    expect(options.status).toBe(200);
    const optionBody = await options.json<{ boards: Array<{ id: string }> }>();
    expect(optionBody.boards.map((board) => board.id)).toContain(destination);

    const transferred = await post(
      `/boards/${source}/cards/card-inherit/transfer`,
      {
        transferId: crypto.randomUUID(),
        destinationBoardId: destination,
        destinationColumnId: "col-inherit",
      },
      moverCookie,
    );
    expect(transferred.status).toBe(200);

    // The assignee survives because the destination admits them through the
    // workspace, not only through an explicit board grant.
    const importedSocket = (
      await get(`/boards/${destination}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, adminCookie, {
        Upgrade: "websocket",
      })
    ).webSocket!;
    importedSocket.accept();
    const snapshot = await new Promise<{ cards: Array<{ id: string; assigneeId: string | null }> }>(
      (resolve) => {
        importedSocket.addEventListener(
          "message",
          (event) => resolve(JSON.parse(event.data as string)),
          { once: true },
        );
      },
    );
    importedSocket.close(1000, "test finished");
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0]).toMatchObject({ id: "card-inherit", assigneeId: mover.id });
  });

  it("GET /boards/:id/transfer-options lists accessible boards without columns, excluding source board; the per-destination route returns columns", async () => {
    const userCookie = await signup("opt-user@foxban.test");
    const sourceBoard = await createBoard(userCookie, "Source Board", "SRCOPT");
    const destBoard1 = await createBoard(userCookie, "Dest Board 1", "DSTOPT1");
    const destBoard2 = await createBoard(userCookie, "Dest Board 2", "DSTOPT2");

    // Add columns to destBoard1 via DO internal or websocket
    const ws1 = await get(
      `/boards/${destBoard1}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      userCookie,
      { Upgrade: "websocket" },
    );
    const socket1 = ws1.webSocket!;
    socket1.accept();
    const { promise: colCreated, resolve: resolveCol } = deferred<void>();
    socket1.addEventListener("message", (event) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "column.create" && data.mutationId === "c1") {
        resolveCol();
      }
    });
    socket1.send(
      JSON.stringify({
        type: "column.create",
        mutationId: "c1",
        id: "col-dst-1",
        title: "Todo",
        position: "a0",
      }),
    );
    await colCreated;
    socket1.close(1000);
    const res = await get(`/boards/${sourceBoard}/transfer-options`, userCookie);
    expect(res.status).toBe(200);
    const body = await res.json<{ boards: Array<{ id: string; name: string; key: string }> }>();

    // Excludes source board
    expect(body.boards.some((b) => b.id === sourceBoard)).toBe(false);
    // Includes destBoard1 and destBoard2
    expect(body.boards.some((b) => b.id === destBoard1)).toBe(true);
    expect(body.boards.some((b) => b.id === destBoard2)).toBe(true);
    expect(body.boards.every((b) => !("columns" in b))).toBe(true);

    const columns = await get(`/boards/${sourceBoard}/transfer-options/${destBoard1}`, userCookie);
    expect(columns.status).toBe(200);
    expect(await columns.json()).toEqual({ columns: [{ id: "col-dst-1", title: "Todo", position: "a0" }] });

    // The source itself and a board the caller cannot open are refused.
    const strangerCookie = await signup("opt-stranger@foxban.test");
    const strangerBoard = await createBoard(strangerCookie, "Stranger Board", "STROPT");
    expect((await get(`/boards/${sourceBoard}/transfer-options/${sourceBoard}`, userCookie)).status).toBe(403);
    expect((await get(`/boards/${sourceBoard}/transfer-options/${strangerBoard}`, userCookie)).status).toBe(403);
  });

  it("POST /boards/:id/cards/:cardId/transfer orchestrates dual-board auth, R2 copy, column check, compensation, and retry", async () => {
    const adminCookie = await signup("admin-mint@foxban.test");
    const invite1 = await mintInvite(adminCookie);
    const invite2 = await mintInvite(adminCookie);
    const ownerCookie = await signupWithInvite("xfer-owner@regular-user.test", invite1);
    const strangerCookie = await signupWithInvite("xfer-stranger@regular-user.test", invite2);
    const sourceBoard = await createBoard(ownerCookie, "Source Xfer", "SRCXFR");
    const destBoard = await createBoard(ownerCookie, "Dest Xfer", "DSTXFR");
    const inaccessibleBoard = await createBoard(strangerCookie, "Private Dest", "PRIVDST");

    // Connect sockets to setup columns and cards
    const wsSrc = await get(
      `/boards/${sourceBoard}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      ownerCookie,
      { Upgrade: "websocket" },
    );
    const sockSrc = wsSrc.webSocket!;
    sockSrc.accept();
    const { promise: attCreated, resolve: resolveAtt } = deferred<void>();
    sockSrc.addEventListener("message", (event) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "attachment.create" && data.mutationId === "att-mut") {
        resolveAtt();
      }
    });
    sockSrc.send(
      JSON.stringify({
        type: "column.create",
        mutationId: "sc-1",
        id: "col-src",
        title: "Todo",
        position: "a0",
      }),
    );
    sockSrc.send(
      JSON.stringify({
        type: "card.create",
        mutationId: "sc-2",
        id: "card-xfer-1",
        columnId: "col-src",
        title: "Transfer Me",
        position: "a0",
      }),
    );

    const wsDst = await get(
      `/boards/${destBoard}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      ownerCookie,
      { Upgrade: "websocket" },
    );
    const sockDst = wsDst.webSocket!;
    sockDst.accept();
    const { promise: dstColCreated, resolve: resolveDstCol } = deferred<void>();
    sockDst.addEventListener("message", (event) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "column.create" && data.mutationId === "dc-1") {
        resolveDstCol();
      }
    });
    sockDst.send(
      JSON.stringify({
        type: "column.create",
        mutationId: "dc-1",
        id: "col-dst",
        title: "Done",
        position: "a0",
      }),
    );
    await dstColCreated;

    // Upload an attachment to source card with custom metadata and explicit HTTP metadata
    const fileBytes = new Uint8Array([10, 20, 30, 40]);
    const uploadRes = await upload(sourceBoard, fileBytes, "application/octet-stream", ownerCookie);
    expect(uploadRes.status).toBe(201);
    const uploadData = await uploadRes.json<UploadResult>();

    // Ensure source R2 object has rich HTTP and custom metadata
    const sourceKey = `${sourceBoard}/${uploadData.id}`;
    await env.ATTACHMENTS.put(sourceKey, fileBytes, {
      httpMetadata: {
        contentType: "application/octet-stream",
        contentDisposition: "attachment; filename=\"custom-name.bin\"",
        cacheControl: "public, max-age=3600",
        contentLanguage: "en-US",
      },
      customMetadata: {
        originalUploader: "tester-1",
        traceId: "trace-abc-123",
      },
    });
    sockSrc.send(
      JSON.stringify({
        type: "attachment.create",
        mutationId: "att-mut",
        id: uploadData.id,
        cardId: "card-xfer-1",
        fileName: "test.bin",
        contentType: "application/octet-stream",
        size: fileBytes.byteLength,
      }),
    );

    await attCreated;

    // 1. Same-board destination rejected with 400
    const sameBoardRes = await post(
      `/boards/${sourceBoard}/cards/card-xfer-1/transfer`,
      {
        transferId: "xfer-same",
        destinationBoardId: sourceBoard,
        destinationColumnId: "col-src",
      },
      ownerCookie,
    );
    expect(sameBoardRes.status).toBe(400);
    expect(await sameBoardRes.json()).toEqual({ error: "destination must be another board" });

    // 2. Inaccessible destination rejected with 403
    const forbidRes = await post(
      `/boards/${sourceBoard}/cards/card-xfer-1/transfer`,
      {
        transferId: "xfer-forbid",
        destinationBoardId: inaccessibleBoard,
        destinationColumnId: "col-fake",
      },
      ownerCookie,
    );
    expect(forbidRes.status).toBe(403);

    // 3. Missing destination column returns 400 and cleans copied R2 objects
    const badColTransferId = "xfer-bad-col";
    const badColRes = await post(
      `/boards/${sourceBoard}/cards/card-xfer-1/transfer`,
      {
        transferId: badColTransferId,
        destinationBoardId: destBoard,
        destinationColumnId: "nonexistent-column",
      },
      ownerCookie,
    );
    expect(badColRes.status).toBe(400);

    // Aborted transfer performs no foreground R2 deletion; destination key was transfer-scoped
    const badColDestKey = attachmentTransferObjectKey(destBoard, badColTransferId, uploadData.id);
    const abortedObj = await env.ATTACHMENTS.get(badColDestKey);
    expect(abortedObj).not.toBeNull();
    expect(await env.ATTACHMENTS.get(`${destBoard}/${uploadData.id}`)).toBeNull();

    // 4. Successful transfer copies byte-identical object and assigns destination task number
    const transferId = "xfer-success-1";
    const successRes = await post(
      `/boards/${sourceBoard}/cards/card-xfer-1/transfer`,
      {
        transferId,
        destinationBoardId: destBoard,
        destinationColumnId: "col-dst",
      },
      ownerCookie,
    );
    expect(successRes.status).toBe(200);
    const successBody = await successRes.json<{
      boardId: string;
      boardKey: string;
      cardId: string;
      taskNumber: number;
    }>();
    expect(successBody.boardId).toBe(destBoard);
    expect(successBody.boardKey).toBe("DSTXFR");
    expect(successBody.cardId).toBe("card-xfer-1");
    expect(successBody.taskNumber).toBe(1);

    // R2 destination object preserves byte-identical content and all HTTP / custom metadata via transfer-scoped key
    const destKey = attachmentTransferObjectKey(destBoard, transferId, uploadData.id);
    const copiedObj = await env.ATTACHMENTS.get(destKey);
    expect(copiedObj).not.toBeNull();
    const copiedBytes = new Uint8Array(await copiedObj!.arrayBuffer());
    expect(copiedBytes).toEqual(fileBytes);
    expect(copiedObj!.httpMetadata?.contentType).toBe("application/octet-stream");
    expect(copiedObj!.httpMetadata?.contentDisposition).toBe("attachment; filename=\"custom-name.bin\"");
    expect(copiedObj!.httpMetadata?.cacheControl).toBe("public, max-age=3600");
    expect(copiedObj!.httpMetadata?.contentLanguage).toBe("en-US");
    expect(copiedObj!.customMetadata).toEqual({
      originalUploader: "tester-1",
      traceId: "trace-abc-123",
    });
    // Serving via GET on the destination board resolves the transfer-scoped key
    const getAttRes = await get(`/boards/${destBoard}/attachments/${uploadData.id}`, ownerCookie);
    expect(getAttRes.status).toBe(200);
    expect(new Uint8Array(await getAttRes.arrayBuffer())).toEqual(fileBytes);

    // Aborted transfer object was not deleted by subsequent transfer
    expect(await env.ATTACHMENTS.get(badColDestKey)).not.toBeNull();
    // Idempotent retry with the same transferId succeeds
    const retryRes = await post(
      `/boards/${sourceBoard}/cards/card-xfer-1/transfer`,
      {
        transferId,
        destinationBoardId: destBoard,
        destinationColumnId: "col-dst",
      },
      ownerCookie,
    );
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json<{ cardId: string; taskNumber: number }>();
    expect(retryBody.cardId).toBe("card-xfer-1");
    expect(retryBody.taskNumber).toBe(1);

    // D1 has zero card or column rows (cards and columns are BoardDO state, not D1)
    const d1CardCount = await env.DB.prepare(
      "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='cards'",
    ).first<{ count: number }>();
    expect(d1CardCount?.count).toBe(0);

    // 5. Compensation and release failure handling:
    // Verify that when a transfer fails and compensation/release fails, API reports retry required
    // We simulate release failure by corrupting the source board release or mocking an invalid lock
    const failedCompRes = await post(
      `/boards/${sourceBoard}/cards/nonexistent-card/transfer`,
      {
        transferId: "xfer-not-found",
        destinationBoardId: destBoard,
        destinationColumnId: "col-dst",
      },
      ownerCookie,
    );
    expect(failedCompRes.status).toBe(404);

    sockSrc.close(1000);
    sockDst.close(1000);
  });

  it("rejects a transfer id the R2 key parser would refuse, at the route", async () => {
    const ownerCookie = await signup("xfer-bad-id@foxban.test");
    const sourceBoard = await createBoard(ownerCookie, "Bad Id Src", "BADSRC");
    const destBoard = await createBoard(ownerCookie, "Bad Id Dst", "BADDST");
    for (const transferId of ["a/b", "has space", "x".repeat(65), ""]) {
      const res = await post(
        `/boards/${sourceBoard}/cards/card-1/transfer`,
        { transferId, destinationBoardId: destBoard, destinationColumnId: "col-dst" },
        ownerCookie,
      );
      expect(res.status, JSON.stringify(transferId)).toBe(400);
    }
  });

  it("refuses an upload whose content-length is over the limit before reading the body", async () => {
    const owner = await signup("att-declared-length@foxban.test");
    const boardId = await createBoard(owner, "Declared length");
    // A one-byte body: only the declared length can trigger the 413.
    const response = await SELF.fetch(`${ORIGIN}/boards/${boardId}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", "content-length": "10485761", cookie: owner },
      body: new Uint8Array(1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too large" });
  });

  it("exact-receipt retry never compensates destination objects if destination column is subsequently removed", async () => {
    const ownerCookie = await signup("xfer-retry-safe@foxban.test");
    const sourceBoard = await createBoard(ownerCookie, "Retry Src", "RTSRC");
    const destBoard = await createBoard(ownerCookie, "Retry Dst", "RTDST");

    const wsSrc = await get(
      `/boards/${sourceBoard}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      ownerCookie,
      { Upgrade: "websocket" },
    );
    const sockSrc = wsSrc.webSocket!;
    sockSrc.accept();
    const wsDst = await get(
      `/boards/${destBoard}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      ownerCookie,
      { Upgrade: "websocket" },
    );
    const sockDst = wsDst.webSocket!;
    sockDst.accept();

    // Setup columns and cards
    const { promise: srcSetupDone, resolve: resolveSrc } = deferred<void>();
    sockSrc.addEventListener("message", (e) => {
      const data = JSON.parse(e.data as string);
      if (data.type === "attachment.create" && data.mutationId === "att-safe") {
        resolveSrc();
      }
    });

    sockSrc.send(JSON.stringify({ type: "column.create", mutationId: "sc-safe", id: "col-src-s", title: "Todo", position: "a0" }));
    sockSrc.send(JSON.stringify({ type: "card.create", mutationId: "c-safe", id: "card-safe-1", columnId: "col-src-s", title: "Safe Retry", position: "a0" }));

    const fileBytes = new Uint8Array([1, 2, 3]);
    const uploadRes = await upload(sourceBoard, fileBytes, "application/octet-stream", ownerCookie);
    const uploadData = await uploadRes.json<UploadResult>();

    sockSrc.send(JSON.stringify({
      type: "attachment.create",
      mutationId: "att-safe",
      id: uploadData.id,
      cardId: "card-safe-1",
      fileName: "safe.bin",
      contentType: "application/octet-stream",
      size: fileBytes.byteLength,
    }));
    await srcSetupDone;

    const { promise: dstColDone, resolve: resolveDstCol } = deferred<void>();
    sockDst.addEventListener("message", (e) => {
      const data = JSON.parse(e.data as string);
      if (data.type === "column.create" && data.mutationId === "dc-safe") {
        resolveDstCol();
      }
    });
    sockDst.send(JSON.stringify({ type: "column.create", mutationId: "dc-safe", id: "col-dst-s", title: "Done", position: "a0" }));
    await dstColDone;

    // First attempt succeeds
    const transferId = "xfer-safe-1";
    const firstRes = await post(
      `/boards/${sourceBoard}/cards/card-safe-1/transfer`,
      {
        transferId,
        destinationBoardId: destBoard,
        destinationColumnId: "col-dst-s",
      },
      ownerCookie,
    );
    expect(firstRes.status).toBe(200);

    const destKey = attachmentTransferObjectKey(destBoard, transferId, uploadData.id);
    expect(await env.ATTACHMENTS.get(destKey)).not.toBeNull();

    // Delete destination column afterwards
    sockDst.send(JSON.stringify({ type: "column.delete", mutationId: "del-col-s", id: "col-dst-s" }));

    // Retry transfer with exact same transferId must succeed without deleting destination R2 objects
    const retryRes = await post(
      `/boards/${sourceBoard}/cards/card-safe-1/transfer`,
      {
        transferId,
        destinationBoardId: destBoard,
        destinationColumnId: "col-dst-s",
      },
      ownerCookie,
    );
    expect(retryRes.status).toBe(200);
    expect(await env.ATTACHMENTS.get(destKey)).not.toBeNull();

    sockSrc.close(1000);
    sockDst.close(1000);
  });
  it("aborted transfer T performs no foreground R2 deletion and fresh transfer U uses distinct transfer-scoped key that survives", async () => {
    const ownerCookie = await signup("xfer-isolated-keys@foxban.test");
    const sourceBoard = await createBoard(ownerCookie, "Iso Src", "ISOSRC");
    const destBoard = await createBoard(ownerCookie, "Iso Dst", "ISODST");

    const wsSrc = await get(
      `/boards/${sourceBoard}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      ownerCookie,
      { Upgrade: "websocket" },
    );
    const sockSrc = wsSrc.webSocket!;
    sockSrc.accept();

    const wsDst = await get(
      `/boards/${destBoard}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      ownerCookie,
      { Upgrade: "websocket" },
    );
    const sockDst = wsDst.webSocket!;
    sockDst.accept();

    // Setup source column and card
    sockSrc.send(JSON.stringify({ type: "column.create", mutationId: "c-src", id: "col-src", title: "Source Col", position: "a0" }));
    await awaitBroadcast(sockSrc, "c-src");
    sockSrc.send(JSON.stringify({ type: "card.create", mutationId: "card-src", id: "card-iso-1", columnId: "col-src", title: "Iso Card", position: "a0" }));
    await awaitBroadcast(sockSrc, "card-src");

    // Setup destination valid column
    sockDst.send(JSON.stringify({ type: "column.create", mutationId: "c-dst", id: "col-dst-valid", title: "Dest Col", position: "a0" }));
    await awaitBroadcast(sockDst, "c-dst");

    // Upload attachment on source card
    const fileBytes = Uint8Array.of(10, 20, 30, 40, 50);
    const uploadRes = await upload(sourceBoard, fileBytes, "application/octet-stream", ownerCookie);
    expect(uploadRes.status).toBe(201);
    const uploadData = await uploadRes.json<UploadResult>();

    sockSrc.send(JSON.stringify({
      type: "attachment.create",
      mutationId: "att-create",
      id: uploadData.id,
      cardId: "card-iso-1",
      fileName: "iso.bin",
      contentType: "application/octet-stream",
      size: fileBytes.byteLength,
    }));
    await awaitBroadcast(sockSrc, "att-create");

    // Transfer T: target nonexistent column to trigger abort
    const transferIdT = "00000000-0000-4000-8000-000000000001";
    const keyT = attachmentTransferObjectKey(destBoard, transferIdT, uploadData.id);
    const resT = await post(
      `/boards/${sourceBoard}/cards/card-iso-1/transfer`,
      {
        transferId: transferIdT,
        destinationBoardId: destBoard,
        destinationColumnId: "col-nonexistent",
      },
      ownerCookie,
    );
    expect(resT.status).toBe(400);

    // Foreground compensation NEVER deletes R2 bytes for aborted transfer T
    const tObj = await env.ATTACHMENTS.get(keyT);
    expect(tObj).not.toBeNull();
    expect(new Uint8Array(await tObj!.arrayBuffer())).toEqual(fileBytes);

    // Transfer U: with fresh transfer ID to valid column
    const transferIdU = "00000000-0000-4000-8000-000000000002";
    const keyU = attachmentTransferObjectKey(destBoard, transferIdU, uploadData.id);
    expect(keyU).not.toBe(keyT);

    const resU = await post(
      `/boards/${sourceBoard}/cards/card-iso-1/transfer`,
      {
        transferId: transferIdU,
        destinationBoardId: destBoard,
        destinationColumnId: "col-dst-valid",
      },
      ownerCookie,
    );
    expect(resU.status).toBe(200);

    // Transfer U survives with its transfer-scoped key and correct data
    const uObj = await env.ATTACHMENTS.get(keyU);
    expect(uObj).not.toBeNull();
    expect(new Uint8Array(await uObj!.arrayBuffer())).toEqual(fileBytes);

    // T's bytes in R2 were completely unaffected and remain distinct
    const tObjAfter = await env.ATTACHMENTS.get(keyT);
    expect(tObjAfter).not.toBeNull();
    expect(new Uint8Array(await tObjAfter!.arrayBuffer())).toEqual(fileBytes);

    // Serving via GET resolves to U's key
    const serveRes = await get(`/boards/${destBoard}/attachments/${uploadData.id}`, ownerCookie);
    expect(serveRes.status).toBe(200);
    expect(new Uint8Array(await serveRes.arrayBuffer())).toEqual(fileBytes);

    sockSrc.close(1000);
    sockDst.close(1000);
  });
  it("aborted transfer T cleanup survives fresh transfer U import and eventual orphan sweep deletes T's exact key", async () => {
    const ownerCookie = await signup("xfer-t-cleanup-sweep@foxban.test");
    const sourceBoard = await createBoard(ownerCookie, "Sweep Src", "SWPSRC");
    const destBoard = await createBoard(ownerCookie, "Sweep Dst", "SWPDST");

    const wsSrc = await get(
      `/boards/${sourceBoard}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      ownerCookie,
      { Upgrade: "websocket" },
    );
    const sockSrc = wsSrc.webSocket!;
    sockSrc.accept();

    const wsDst = await get(
      `/boards/${destBoard}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      ownerCookie,
      { Upgrade: "websocket" },
    );
    const sockDst = wsDst.webSocket!;
    sockDst.accept();

    // Setup source column and card
    sockSrc.send(JSON.stringify({ type: "column.create", mutationId: "c-src", id: "col-src", title: "Source Col", position: "a0" }));
    await awaitBroadcast(sockSrc, "c-src");
    sockSrc.send(JSON.stringify({ type: "card.create", mutationId: "card-src", id: "card-swp-1", columnId: "col-src", title: "Sweep Card", position: "a0" }));
    await awaitBroadcast(sockSrc, "card-src");

    // Setup destination column
    sockDst.send(JSON.stringify({ type: "column.create", mutationId: "c-dst", id: "col-dst-valid", title: "Dest Col", position: "a0" }));
    await awaitBroadcast(sockDst, "c-dst");

    // Upload attachment on source card
    const fileBytes = Uint8Array.of(1, 3, 5, 7, 9);
    const uploadRes = await upload(sourceBoard, fileBytes, "application/octet-stream", ownerCookie);
    expect(uploadRes.status).toBe(201);
    const uploadData = await uploadRes.json<UploadResult>();

    sockSrc.send(JSON.stringify({
      type: "attachment.create",
      mutationId: "att-create",
      id: uploadData.id,
      cardId: "card-swp-1",
      fileName: "data.bin",
      contentType: "application/octet-stream",
      size: fileBytes.byteLength,
    }));
    await awaitBroadcast(sockSrc, "att-create");

    // Transfer T: aborted by targeting nonexistent column
    const transferIdT = "00000000-0000-4000-8000-000000000001";
    const keyT = attachmentTransferObjectKey(destBoard, transferIdT, uploadData.id);
    const resT = await post(
      `/boards/${sourceBoard}/cards/card-swp-1/transfer`,
      {
        transferId: transferIdT,
        destinationBoardId: destBoard,
        destinationColumnId: "col-nonexistent",
      },
      ownerCookie,
    );
    expect(resT.status).toBe(400);

    // Transfer U: fresh transfer ID to valid column
    const transferIdU = "00000000-0000-4000-8000-000000000002";
    const keyU = attachmentTransferObjectKey(destBoard, transferIdU, uploadData.id);

    const resU = await post(
      `/boards/${sourceBoard}/cards/card-swp-1/transfer`,
      {
        transferId: transferIdU,
        destinationBoardId: destBoard,
        destinationColumnId: "col-dst-valid",
      },
      ownerCookie,
    );
    expect(resU.status).toBe(200);

    // Destination Board DO storage check:
    // U was imported and its staging lease consumed.
    // T's staging lease survived untouched in attachment_cleanup!
    const destStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(destBoard));
    const cleanupState = await runInDurableObject(destStub, (_instance, state) => ({
      attObjectKey: state.storage.sql
        .exec<{ object_key: string }>("SELECT object_key FROM attachments WHERE id = ?", uploadData.id)
        .toArray()[0]?.object_key,
      cleanupKeys: state.storage.sql
        .exec<{ objectKey: string }>("SELECT object_key AS objectKey FROM attachment_cleanup")
        .toArray()
        .map((r) => r.objectKey),
    }));

    expect(cleanupState.attObjectKey).toBe(keyU);
    expect(cleanupState.cleanupKeys).toEqual([keyT]);

    // Both keys exist in R2
    expect(await env.ATTACHMENTS.head(keyT)).not.toBeNull();
    expect(await env.ATTACHMENTS.head(keyU)).not.toBeNull();

    // Simulate T's staging lease expiration in destination BoardDO
    await runInDurableObject(destStub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachment_cleanup SET delete_after = ? WHERE object_key = ?",
        Date.now() - 1,
        keyT,
      );
    });

    // Run reconciliation sweep
    await reconcileAttachmentObjects(env);

    // T is eventually collected and deleted from R2, while U is preserved
    await expect
      .poll(async () => (await env.ATTACHMENTS.head(keyT)) === null)
      .toBe(true);
    expect(await env.ATTACHMENTS.head(keyU)).not.toBeNull();

    // Serving via GET returns U's content
    const serveRes = await get(`/boards/${destBoard}/attachments/${uploadData.id}`, ownerCookie);
    expect(serveRes.status).toBe(200);
    expect(new Uint8Array(await serveRes.arrayBuffer())).toEqual(fileBytes);

    sockSrc.close(1000);
    sockDst.close(1000);
  });
});

describe("scheduled attachment and avatar reconciliation", () => {
  it("keeps live board attachments and live referenced user avatars while deleting orphan avatars and stale avatar versions", async () => {
    const cookie = await signup("reconcile-test@foxban.test", "Reconcile User");
    const userId = await (await get("/me", cookie)).json<{ id: string }>().then((u) => u.id);
    const boardId = await createBoard(cookie, "Reconcile Board");

    // 1. Put active board attachment in R2 and register on board
    const activeAttId = crypto.randomUUID();
    const activeAttKey = `${boardId}/${activeAttId}`;
    await env.ATTACHMENTS.put(activeAttKey, Uint8Array.of(1, 2, 3), {
      httpMetadata: { contentType: "image/png" },
    });

    // Stage attachment in BoardDO so it is recognized as active/staged
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));
    const stageRes = await stub.fetch("https://board.internal/internal/attachments/stage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-foxban-board-id": boardId,
        "x-foxban-user-id": userId,
      },
      body: JSON.stringify({ id: activeAttId }),
    });
    expect(stageRes.status).toBe(204);

    // 2. Put live referenced user avatar in R2
    const liveVersion = crypto.randomUUID();
    const liveAvatarKey = `avatars/${userId}/${liveVersion}`;
    await env.ATTACHMENTS.put(liveAvatarKey, Uint8Array.of(4, 5, 6), {
      httpMetadata: { contentType: "image/png" },
    });
    await env.DB.prepare("UPDATE users SET avatar_version = ? WHERE id = ?")
      .bind(liveVersion, userId)
      .run();

    // 3. Put stale/unreferenced avatar version for the same user in R2
    const staleVersion = crypto.randomUUID();
    const staleAvatarKey = `avatars/${userId}/${staleVersion}`;
    await env.ATTACHMENTS.put(staleAvatarKey, Uint8Array.of(7, 8, 9), {
      httpMetadata: { contentType: "image/png" },
    });

    // 4. Put orphan avatar for completely nonexistent user in R2
    const orphanUserId = crypto.randomUUID();
    const orphanVersion = crypto.randomUUID();
    const orphanAvatarKey = `avatars/${orphanUserId}/${orphanVersion}`;
    await env.ATTACHMENTS.put(orphanAvatarKey, Uint8Array.of(10, 11, 12), {
      httpMetadata: { contentType: "image/png" },
    });

    // Run scheduled reconciliation
    await reconcileAttachmentObjects(env);

    // Active board attachment survives
    expect(await env.ATTACHMENTS.head(activeAttKey)).not.toBeNull();

    // Live referenced avatar survives
    expect(await env.ATTACHMENTS.head(liveAvatarKey)).not.toBeNull();

    // Stale avatar version is deleted
    expect(await env.ATTACHMENTS.head(staleAvatarKey)).toBeNull();

    // Orphan avatar for nonexistent user is deleted
    expect(await env.ATTACHMENTS.head(orphanAvatarKey)).toBeNull();
  });

  it.each(["refuses", "throws"])("keeps reconciling later pages when a board %s on an earlier one, then fails once at the end", async (how) => {
    const [refusing, serving] = ["board-sweep-refusing", "board-sweep-serving"];
    const keys = [refusing, serving].map((board) => `${board}/${crypto.randomUUID()}`);
    let pages = 0;
    const listed = [
      { objects: [{ key: keys[0] }], truncated: true, cursor: "page-2" },
      { objects: [{ key: keys[1] }], truncated: false },
    ];
    const reached: string[] = [];
    const sweep = {
      ...env,
      ATTACHMENTS: { list: async () => listed[pages++] },
      BOARD_DO: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          fetch: async (...args: Parameters<DurableObjectStub["fetch"]>) => {
            reached.push(name);
            if (name === refusing && how === "throws") throw new Error("board unreachable");
            return name === refusing
              ? new Response("access is changing", { status: 503 })
              : env.BOARD_DO.get(env.BOARD_DO.idFromName(name)).fetch(...args);
          },
        }),
      },
    } as unknown as typeof env;

    await expect(reconcileAttachmentObjects(sweep)).rejects.toThrow(refusing);
    expect(pages).toBe(2);
    expect(reached).toEqual([refusing, serving]);
  });

  it("stops at its subrequest ceiling, saves where it stopped, resumes there next run and clears the mark at the end", async () => {
    const keys = ["board-budget-a", "board-budget-b", "board-budget-c"].map((board) => `${board}/${crypto.randomUUID()}`).sort();
    const listedWith: unknown[] = [];
    const reached: string[] = [];
    const sweepOf = (objects: string[]) =>
      ({
        ...env,
        ATTACHMENTS: {
          list: async (options?: unknown) => {
            listedWith.push(options);
            return { objects: objects.map((key) => ({ key })), truncated: false };
          },
        },
        BOARD_DO: {
          idFromName: (name: string) => name,
          get: (name: string) => ({
            fetch: async (...args: Parameters<DurableObjectStub["fetch"]>) => {
              reached.push(name);
              return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)).fetch(...args);
            },
          }),
        },
      }) as unknown as typeof env;
    const mark = () => env.DB.prepare("SELECT value FROM maintenance_state WHERE key = 'attachment_reconcile_after'").first<{ value: string }>();
    await env.DB.exec("DELETE FROM maintenance_state");

    // The run counts its own reads (the mark, the list) and one board call per board: a ceiling of 4 fits two boards.
    await reconcileAttachmentObjects(sweepOf(keys), 4);
    expect(reached).toEqual([keys[0]!.split("/")[0], keys[1]!.split("/")[0]]);
    expect(await mark()).toEqual({ value: keys[1] });

    // The next run lists from after the mark, finishes the rest and clears the mark.
    reached.length = 0;
    await reconcileAttachmentObjects(sweepOf([keys[2]!]), 4);
    expect(listedWith.at(-1)).toEqual({ startAfter: keys[1] });
    expect(reached).toEqual([keys[2]!.split("/")[0]]);
    expect(await mark()).toBeNull();
  });

  it("protects in-flight destination transfer staging from being deleted by the sweep", async () => {
    const cookie = await signup("stage-protect@foxban.test", "Stage Protect User");
    const boardId = await createBoard(cookie, "Transfer Destination Board");
    const userId = await (await get("/me", cookie)).json<{ id: string }>().then((u) => u.id);

    const stagingAttId = crypto.randomUUID();
    const stagingKey = `${boardId}/${stagingAttId}`;
    await env.ATTACHMENTS.put(stagingKey, Uint8Array.of(10, 20, 30), {
      httpMetadata: { contentType: "image/png" },
    });

    // Stage attachment in destination BoardDO (as done during transfer in-flight staging)
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));
    const stageRes = await stub.fetch("https://board.internal/internal/attachments/stage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-foxban-board-id": boardId,
        "x-foxban-user-id": userId,
      },
      body: JSON.stringify({ id: stagingAttId, contentType: "image/png", size: 3 }),
    });
    expect(stageRes.status).toBe(204);

    // Sweep runs while transfer is in flight
    await reconcileAttachmentObjects(env);

    // Staged destination attachment is protected and survives the sweep
    expect(await env.ATTACHMENTS.head(stagingKey)).not.toBeNull();
  });

  it("protects in-flight avatar uploads with active leases from being deleted by the sweep", async () => {
    const cookie = await signup("avatar-lease@foxban.test", "Avatar Lease User");
    const userId = await (await get("/me", cookie)).json<{ id: string }>().then((u) => u.id);

    const inFlightVersion = crypto.randomUUID();
    const inFlightAvatarKey = `avatars/${userId}/${inFlightVersion}`;
    await env.ATTACHMENTS.put(inFlightAvatarKey, Uint8Array.of(50, 60, 70), {
      httpMetadata: { contentType: "image/png" },
    });

    // Active lease in avatar_leases table protects in-flight upload before D1 update
    const leaseExpiresAt = Date.now() + 5 * 60 * 1000;
    await env.DB.prepare(
      "INSERT INTO avatar_leases (user_id, version, expires_at) VALUES (?, ?, ?)",
    )
      .bind(userId, inFlightVersion, leaseExpiresAt)
      .run();

    // Sweep runs
    await reconcileAttachmentObjects(env);

    // In-flight leased avatar survives
    expect(await env.ATTACHMENTS.head(inFlightAvatarKey)).not.toBeNull();
  });

  it("rechecks current ownership before deleting avatar objects classified as unreferenced", async () => {
    const cookie = await signup("recheck-owner@foxban.test", "Recheck User");
    const userId = await (await get("/me", cookie)).json<{ id: string }>().then((u) => u.id);

    const committedVersion = crypto.randomUUID();
    const avatarKey = `avatars/${userId}/${committedVersion}`;
    await env.ATTACHMENTS.put(avatarKey, Uint8Array.of(80, 90, 100), {
      httpMetadata: { contentType: "image/png" },
    });

    // Set user avatar_version directly, proving that re-check catches active ownership
    await env.DB.prepare("UPDATE users SET avatar_version = ? WHERE id = ?")
      .bind(committedVersion, userId)
      .run();

    await reconcileAttachmentObjects(env);

    // Avatar survives because second-look check verifies current authoritative ownership
    expect(await env.ATTACHMENTS.head(avatarKey)).not.toBeNull();
  });
  it("preserves active cleanup claim fields when sweeping orphaned attachment keys", async () => {
    const cookie = await signup("claim-sweep-preservation@foxban.test", "Claim Sweep User");
    const boardId = await createBoard(cookie, "Claim Sweep Board");
    const orphanAttId = crypto.randomUUID();
    const orphanKey = `${boardId}/${orphanAttId}`;

    await env.ATTACHMENTS.put(orphanKey, Uint8Array.of(1, 2, 3), {
      httpMetadata: { contentType: "image/png" },
    });

    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));
    const now = Date.now();
    const activeClaimToken = "active-claim-token-preserve-777";
    const deleteAfter = now + 120_000;
    const claimedAt = now - 5000;

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at)
         VALUES (?, ?, 'deleted', ?, ?, ?)`,
        orphanKey,
        orphanAttId,
        deleteAfter,
        activeClaimToken,
        claimedAt,
      );
    });

    // Run global reconciliation sweep
    await reconcileAttachmentObjects(env);

    // Verify claim fields were NOT overwritten or reset to NULL
    const claimRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ claimToken: string | null; claimedAt: number | null; deleteAfter: number; reason: string }>(
          `SELECT claim_token AS claimToken, claimed_at AS claimedAt, delete_after AS deleteAfter, reason
             FROM attachment_cleanup
            WHERE object_key = ?`,
          orphanKey,
        )
        .toArray()[0],
    );

    expect(claimRow).toEqual({
      claimToken: activeClaimToken,
      claimedAt,
      deleteAfter,
      reason: "deleted",
    });

    expect(await env.ATTACHMENTS.head(orphanKey)).not.toBeNull();
    await env.ATTACHMENTS.delete(orphanKey);
  });

  it("preserves durable cleanup tombstones during reconciliation without re-enqueuing or overwriting them", async () => {
    const cookie = await signup("tombstone-reconcile@foxban.test", "Tombstone Reconcile User");
    const boardId = await createBoard(cookie, "Tombstone Reconcile Board");
    const userId = await (await get("/me", cookie)).json<{ id: string }>().then((u) => u.id);
    const tombstoneAttId = crypto.randomUUID();
    const tombstoneKey = `${boardId}/${tombstoneAttId}`;

    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));
    const now = Date.now();
    const originalDeletedAt = now - 5000;
    const originalClaimToken = "tombstone-claim-token-999";

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO attachment_cleanup(object_key, attachment_id, reason, delete_after, claim_token, claimed_at, deleted_at)
         VALUES (?, ?, 'deleted', 0, ?, ?, ?)`,
        tombstoneKey,
        tombstoneAttId,
        originalClaimToken,
        now - 10_000,
        originalDeletedAt,
      );
    });

    // Run global reconciliation sweep
    await reconcileAttachmentObjects(env);

    // Verify tombstone was preserved untouched
    const tombstoneRow = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{
          objectKey: string;
          reason: string;
          deleteAfter: number;
          claimToken: string | null;
          deletedAt: number | null;
        }>(
          `SELECT object_key AS objectKey, reason, delete_after AS deleteAfter,
                  claim_token AS claimToken, deleted_at AS deletedAt
             FROM attachment_cleanup
            WHERE object_key = ?`,
          tombstoneKey,
        )
        .toArray()[0],
    );

    expect(tombstoneRow).toEqual({
      objectKey: tombstoneKey,
      reason: "deleted",
      deleteAfter: 0,
      claimToken: originalClaimToken,
      deletedAt: originalDeletedAt,
    });
    expect(tombstoneRow?.deletedAt).toBe(originalDeletedAt);

    // Tombstone does not trigger alarm scheduling
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();

    // Restaging attempt remains rejected with 409 because tombstone persists
    const stageRes = await stub.fetch(`https://board.internal${STAGE_ATTACHMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: boardId,
        [INTERNAL_USER_ID_HEADER]: userId,
      },
      body: JSON.stringify({ id: tombstoneAttId, objectKey: tombstoneKey }),
    });
    expect(stageRes.status).toBe(409);
    const stageErr = await stageRes.json<{ error: string }>();
    expect(stageErr.error).toBe("attachment object is currently being collected");
  });
});

describe("card transfers under access changes", () => {
  const boardStub = (boardId: string) => env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));

  async function openSocket(boardId: string, cookie: string): Promise<WebSocket> {
    const response = await get(
      `/boards/${boardId}/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`,
      cookie,
      { Upgrade: "websocket" },
    );
    const socket = response.webSocket!;
    socket.accept();
    return socket;
  }

  async function sendAndAwait(socket: WebSocket, message: Record<string, unknown> & { mutationId: string }) {
    const done = awaitBroadcast(socket, message.mutationId);
    socket.send(JSON.stringify(message));
    await done;
  }

  /** Source board with `card-1` in `col-src`, destination with `col-dst`, both owned by a regular user. */
  async function transferFixture(tag: string) {
    const admin = await signup(`xfer-fence-admin-${tag}@foxban.test`);
    const owner = await signupWithInvite(`xfer-fence-owner-${tag}@regular-user.test`, await mintInvite(admin));
    const mover = await signupWithInvite(`xfer-fence-mover-${tag}@regular-user.test`, await mintInvite(admin));
    const ownerId = (await (await get("/me", owner)).json<{ id: string }>()).id;
    const moverId = (await (await get("/me", mover)).json<{ id: string }>()).id;
    const source = await createBoard(owner, `Fence Src ${tag}`);
    const destination = await createBoard(owner, `Fence Dst ${tag}`);
    const src = await openSocket(source, owner);
    await sendAndAwait(src, { type: "column.create", mutationId: "fc-1", id: "col-src", title: "Todo", position: "a0" });
    await sendAndAwait(src, {
      type: "card.create", mutationId: "fc-2", id: "card-1", columnId: "col-src", title: "Move me", position: "a0",
    });
    const dst = await openSocket(destination, owner);
    await sendAndAwait(dst, { type: "column.create", mutationId: "fc-3", id: "col-dst", title: "Done", position: "a0" });
    src.close(1000);
    dst.close(1000);
    return { owner, mover, ownerId, moverId, source, destination };
  }

  function internalPost(boardId: string, path: string, userId: string, body: unknown) {
    return boardStub(boardId).fetch(`https://board.internal${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: boardId,
        [INTERNAL_USER_ID_HEADER]: userId,
      },
      body: JSON.stringify(body),
    });
  }

  function readSource(boardId: string, transferId: string) {
    return runInDurableObject(boardStub(boardId), (_instance, state) => ({
      card: state.storage.sql.exec("SELECT id FROM cards WHERE id = 'card-1'").toArray().length,
      locks: state.storage.sql.exec("SELECT card_id FROM card_transfer_locks").toArray().length,
      operation: state.storage.sql
        .exec<{ state: string }>("SELECT state FROM card_transfer_operations WHERE transfer_id = ?", transferId)
        .toArray()[0]?.state,
    }));
  }

  function readReceipt(boardId: string, transferId: string) {
    return runInDurableObject(boardStub(boardId), (_instance, state) => ({
      cards: state.storage.sql.exec("SELECT id FROM cards WHERE id = 'card-1'").toArray().length,
      taskNumber: state.storage.sql
        .exec<{ taskNumber: number }>(
          "SELECT task_number AS taskNumber FROM card_transfer_receipts WHERE transfer_id = ?",
          transferId,
        )
        .toArray()[0]?.taskNumber,
    }));
  }

  /** A real access change on `boardId`: its prepare fences the board and settles transfers. */
  async function changeAccess(boardId: string, owner: string, userId: string) {
    const response = await post(`/boards/${boardId}/members`, { userId, operationId: crypto.randomUUID() }, owner);
    expect(response.status).toBe(200);
  }

  /** An internal POST whose body is held open until `release` runs. */
  function delayedPost(boardId: string, path: string, userId: string, body: unknown) {
    const gate = deferred<void>();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate.promise;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      },
    });
    const response = boardStub(boardId).fetch(`https://board.internal${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_BOARD_ID_HEADER]: boardId,
        [INTERNAL_USER_ID_HEADER]: userId,
      },
      body: stream,
    });
    return { response, release: () => gate.resolve() };
  }

  async function revokeMember(boardId: string, owner: string, userId: string) {
    const removed = await del(`/boards/${boardId}/members/${userId}`, owner);
    expect(removed.status).toBe(200);
  }

  it("refuses a prepare whose body arrives after the actor's access was revoked", async () => {
    const { owner, moverId, source, destination } = await transferFixture("late-prepare");
    expect((await post(`/boards/${source}/members`, { userId: moverId }, owner)).status).toBe(200);
    const transferId = crypto.randomUUID();
    const pending = delayedPost(source, CARD_TRANSFER_PREPARE_PATH, moverId, {
      transferId, cardId: "card-1", destinationBoardId: destination,
    });

    await revokeMember(source, owner, moverId);
    pending.release();

    expect((await pending.response).status).toBe(403);
    expect(await readSource(source, transferId)).toEqual({ card: 1, locks: 0, operation: undefined });
  });

  it("refuses an import whose body arrives after the actor's destination access was revoked", async () => {
    const { owner, ownerId, moverId, source, destination } = await transferFixture("late-import");
    expect((await post(`/boards/${destination}/members`, { userId: moverId }, owner)).status).toBe(200);
    const transferId = crypto.randomUUID();
    const prepared = await internalPost(source, CARD_TRANSFER_PREPARE_PATH, ownerId, {
      transferId, cardId: "card-1", destinationBoardId: destination,
    });
    expect(prepared.status).toBe(200);
    const { bundle } = await prepared.json<{ bundle: unknown }>();
    const pending = delayedPost(destination, CARD_TRANSFER_IMPORT_PATH, moverId, {
      transferId, sourceBoardId: source, destinationColumnId: "col-dst", bundle,
    });

    await revokeMember(destination, owner, moverId);
    pending.release();

    expect((await pending.response).status).toBe(403);
    expect(await readReceipt(destination, transferId)).toEqual({ cards: 0, taskNumber: undefined });
  });

  it("refuses a transfer whose mover lost source access after the destination receipt probe", async () => {
    const { owner, mover, moverId, source, destination } = await transferFixture("revoke");
    for (const boardId of [source, destination]) {
      expect((await post(`/boards/${boardId}/members`, { userId: moverId }, owner)).status).toBe(200);
    }

    const originalGet = env.BOARD_DO.get;
    let revoked = false;
    env.BOARD_DO.get = ((id: DurableObjectId) => {
      const stub = originalGet.call(env.BOARD_DO, id);
      return new Proxy(stub, {
        get(target, property) {
          if (property !== "fetch") {
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === CARD_TRANSFER_RECEIPT_PATH && !revoked) {
              revoked = true;
              await env.DB.prepare("DELETE FROM board_members WHERE board_id = ? AND user_id = ?")
                .bind(source, moverId)
                .run();
            }
            return target.fetch(input, init);
          };
        },
      });
    }) as typeof env.BOARD_DO.get;
    let status: number;
    try {
      status = (
        await post(
          `/boards/${source}/cards/card-1/transfer`,
          { transferId: crypto.randomUUID(), destinationBoardId: destination, destinationColumnId: "col-dst" },
          mover,
        )
      ).status;
    } finally {
      env.BOARD_DO.get = originalGet;
    }

    expect(revoked).toBe(true);
    expect(status).toBeGreaterThanOrEqual(400);
    expect((await readSource(source, "unused")).card).toBe(1);
    expect((await readReceipt(destination, "unused")).cards).toBe(0);
  });

  it("aborts a prepared outbound transfer while fencing the source for an access change", async () => {
    const { owner, ownerId, moverId, source, destination } = await transferFixture("abort");
    const transferId = crypto.randomUUID();
    const prepared = await internalPost(source, CARD_TRANSFER_PREPARE_PATH, ownerId, {
      transferId, cardId: "card-1", destinationBoardId: destination,
    });
    expect(prepared.status).toBe(200);
    const { bundle } = await prepared.json<{ bundle: unknown }>();

    await changeAccess(source, owner, moverId);

    expect(await readSource(source, transferId)).toEqual({ card: 1, locks: 0, operation: "aborted" });
    expect(await readReceipt(destination, transferId)).toEqual({ cards: 0, taskNumber: -1 });
    const lateImport = await internalPost(destination, CARD_TRANSFER_IMPORT_PATH, ownerId, {
      transferId, sourceBoardId: source, destinationColumnId: "col-dst", bundle,
    });
    expect(lateImport.status).toBe(409);
    expect((await readReceipt(destination, transferId)).cards).toBe(0);
  });

  it("finalizes a transfer the destination already committed while fencing the source", async () => {
    const { owner, ownerId, moverId, source, destination } = await transferFixture("final");
    const transferId = crypto.randomUUID();
    const prepared = await internalPost(source, CARD_TRANSFER_PREPARE_PATH, ownerId, {
      transferId, cardId: "card-1", destinationBoardId: destination,
    });
    expect(prepared.status).toBe(200);
    const { bundle } = await prepared.json<{ bundle: unknown }>();
    const imported = await internalPost(destination, CARD_TRANSFER_IMPORT_PATH, ownerId, {
      transferId, sourceBoardId: source, destinationColumnId: "col-dst", bundle,
    });
    expect(imported.status).toBe(200);

    await changeAccess(source, owner, moverId);

    expect(await readSource(source, transferId)).toEqual({ card: 0, locks: 0, operation: "finalized" });
    const receipt = await readReceipt(destination, transferId);
    expect(receipt.cards).toBe(1);
    expect(receipt.taskNumber).toBeGreaterThan(0);
  });
});
