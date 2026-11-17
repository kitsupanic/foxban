import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BOARD_DEVELOPMENT_PATH,
  CARD_TRANSFER_IMPORT_PATH,
  CARD_TRANSFER_RECEIPT_PATH,
  DELETE_BOARD_PATH,
  MCP_BOARD_READ_PATH,
  PULL_REQUEST_WRITE_PATH,
  RECONCILE_ATTACHMENTS_PATH,
  STAGE_ATTACHMENT_PATH,
  boardRoutes,
  type Gate,
} from "../src/board-api";
import { INTERNAL_BOARD_ID_HEADER, INTERNAL_USER_ID_HEADER } from "../src/internal-headers";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/**
 * What each gate class of the BoardDO's internal API promises (`board-api.ts`), proved
 * once per class through one representative route: whether a deleted board or a frozen
 * one still answers it, what identity it asks for, and whether the actor is admitted.
 * The routes' own behaviour is the business of board-do.test.ts.
 */

const OWNER = "gate-owner";
const STRANGER = "gate-stranger";
const ATTACHMENT = "00000000-0000-4000-8000-0000000000a1";
let boards = 0;
const freshBoard = () => `gate-board-${++boards}`;

/** The DO re-resolves access in D1, so the owner needs real user, board and grant rows. The stranger gets none. */
async function seed(board: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`).bind(OWNER, `${OWNER}@gates.test`, OWNER, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO boards(id,name,owner_id,icon,color,access_mode,created_at) VALUES(?,?,?,'square-kanban','amber','restricted',?)`,
    ).bind(board, board, OWNER, now),
    env.DB.prepare(`INSERT OR IGNORE INTO board_members(board_id,user_id,role) VALUES(?,?,'manager')`).bind(board, OWNER),
  ]);
}

type Who = { board?: string | null; user?: string | null };

/** One internal request to a board, naming the board and user in the headers unless told otherwise. */
function call(board: string, method: string, path: string, body?: unknown, who: Who = {}): Promise<Response> {
  const headers = new Headers();
  const boardHeader = who.board === undefined ? board : who.board;
  const userHeader = who.user === undefined ? OWNER : who.user;
  if (boardHeader !== null) headers.set(INTERNAL_BOARD_ID_HEADER, boardHeader);
  if (userHeader !== null) headers.set(INTERNAL_USER_ID_HEADER, userHeader);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(board)).fetch(`https://board.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Deletes the board's content the way the access journal does; the fence class itself. */
async function deleteBoard(board: string): Promise<void> {
  expect((await call(board, "POST", DELETE_BOARD_PATH, undefined, { user: null })).status).toBe(204);
}

/** Leaves the board as an access fence does: frozen, owned by an operation that has not finished. */
async function freeze(board: string): Promise<void> {
  await runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(board)), (_instance, state) => {
    state.storage.sql.exec(`UPDATE board_access_state SET generation=generation+1,frozen=1,pending_operation_id='gate-test' WHERE id=1`);
  });
}

async function expectChanging(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "access_change_pending" });
}

/** One representative route per gate class, and the request that answers on a live board. */
const classes: Record<
  Gate,
  { route: keyof typeof boardRoutes; ok: number; send: (board: string, who?: Who) => Promise<Response> }
> = {
  fence: {
    route: "boardDelete",
    ok: 204,
    send: (board, who) => call(board, "POST", DELETE_BOARD_PATH, undefined, who),
  },
  settlement: {
    route: "transferReceipt",
    ok: 404,
    send: (board, who) => call(board, "POST", CARD_TRANSFER_RECEIPT_PATH, { transferId: "t-1", sourceBoardId: "src", cardId: "c-1" }, who),
  },
  cleanup: {
    route: "attachmentsReconcile",
    ok: 200,
    send: (board, who) => call(board, "POST", RECONCILE_ATTACHMENTS_PATH, {}, who),
  },
  open: {
    route: "boardDevelopment",
    ok: 200,
    send: (board, who) => call(board, "GET", BOARD_DEVELOPMENT_PATH, undefined, who),
  },
  protected: {
    route: "attachmentStage",
    ok: 204,
    send: (board, who) => call(board, "POST", STAGE_ATTACHMENT_PATH, { id: ATTACHMENT }, who),
  },
};

describe("gate classes", () => {
  it("names a representative for every class and every class is in use", () => {
    expect(new Set(Object.values(boardRoutes).map((spec) => spec.gate))).toEqual(new Set(Object.keys(classes)));
    for (const [gate, { route }] of Object.entries(classes)) expect(boardRoutes[route].gate).toBe(gate);
  });

  describe.each(Object.entries(classes) as Array<[Gate, (typeof classes)[Gate]]>)("%s", (gate, { ok, send }) => {
    it("answers on a live board", async () => {
      const board = freshBoard();
      await seed(board);
      expect((await send(board)).status).toBe(ok);
    });

    // Deletion: a fence, settlement and cleanup route still answers a deleted board; the others are refused with 410.
    it(["fence", "settlement", "cleanup"].includes(gate) ? "still answers a deleted board" : "refuses a deleted board with 410", async () => {
      const board = freshBoard();
      await seed(board);
      await deleteBoard(board);
      const response = await send(board);
      if (["fence", "settlement", "cleanup"].includes(gate)) {
        expect(response.status).toBe(ok);
      } else {
        expect(response.status).toBe(410);
        expect(await response.text()).toBe("board deleted");
      }
    });

    // Freeze: only a fence and a settlement route get through an access fence.
    it(["fence", "settlement"].includes(gate) ? "still answers a frozen board" : "answers a frozen board that is not deleted with the access-changing retry", async () => {
      const board = freshBoard();
      await seed(board);
      await freeze(board);
      const response = await send(board);
      if (["fence", "settlement"].includes(gate)) expect(response.status).toBe(ok);
      else await expectChanging(response);
    });

    it("asks for a well-formed board id", async () => {
      const board = freshBoard();
      await seed(board);
      for (const bad of [null, "", "not a board id!", "x".repeat(65)]) {
        const response = await send(board, { board: bad });
        expect(response.status, String(bad)).toBe(400);
        expect(await response.text()).toBe("invalid board id");
      }
    });
  });

  it("lets a deleted board still collect its objects, but not a frozen one that is alive", async () => {
    const board = freshBoard();
    await seed(board);
    await freeze(board);
    await expectChanging(await classes.cleanup.send(board));
    await deleteBoard(board);
    expect((await classes.cleanup.send(board)).status).toBe(200);
  });

  it("checks the gates before the identity, so a deleted or frozen board never learns who asked", async () => {
    const deleted = freshBoard();
    await seed(deleted);
    await deleteBoard(deleted);
    expect((await classes.protected.send(deleted, { board: null, user: null })).status).toBe(410);
    const frozen = freshBoard();
    await seed(frozen);
    await freeze(frozen);
    await expectChanging(await classes.protected.send(frozen, { user: null }));
  });

  it("gives a path no route owns the same gates as a route, then the socket's upgrade check", async () => {
    const live = freshBoard();
    await seed(live);
    const plain = await call(live, "GET", "/no/such/route");
    expect(plain.status).toBe(426);
    expect(await plain.text()).toBe("expected websocket upgrade");

    const deleted = freshBoard();
    await seed(deleted);
    await deleteBoard(deleted);
    expect((await call(deleted, "GET", "/no/such/route")).status).toBe(410);

    const frozen = freshBoard();
    await seed(frozen);
    await freeze(frozen);
    await expectChanging(await call(frozen, "GET", "/no/such/route"));
  });

  describe("protected: the actor", () => {
    it("asks for a well-formed user id after the board id", async () => {
      const board = freshBoard();
      await seed(board);
      for (const bad of [null, "", "u".repeat(65)]) {
        const response = await classes.protected.send(board, { user: bad });
        expect(response.status, String(bad)).toBe(400);
        expect(await response.text()).toBe("invalid identity");
      }
    });

    it("refuses a user the board does not admit, before the handler writes anything", async () => {
      const board = freshBoard();
      await seed(board);
      const refused = await classes.protected.send(board, { user: STRANGER });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe("forbidden");
      // Staging a key writes a lease; the refused request must have written none.
      const leases = await runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(board)), (_instance, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM attachment_cleanup").toArray()[0]!.n,
      );
      expect(leases).toBe(0);
    });

    it("does not ask a class that names no actor for one", async () => {
      const board = freshBoard();
      await seed(board);
      expect((await classes.open.send(board, { user: null })).status).toBe(200);
      expect((await classes.cleanup.send(board, { user: null })).status).toBe(200);
    });
  });

  describe("the method comes after the gates and before the identity", () => {
    it("answers 405 on a live board and the gate's refusal on a deleted one", async () => {
      const board = freshBoard();
      await seed(board);
      const wrong = await call(board, "GET", STAGE_ATTACHMENT_PATH, undefined, { board: null });
      expect(wrong.status).toBe(405);
      await deleteBoard(board);
      expect((await call(board, "GET", STAGE_ATTACHMENT_PATH)).status).toBe(410);
    });
  });
});

describe("what the table changed", () => {
  const bundle = () => ({
    card: {
      id: "gate-card",
      columnId: "col-src",
      title: "Moved",
      description: "",
      position: "a0",
      taskNumber: 1,
      assigneeId: null,
      priority: "medium",
      taskType: "task",
      dueDate: null,
      subtaskDone: false,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    },
    checklistItems: [],
    attachments: [],
    comments: [],
    activities: [],
    labels: [],
    pullRequestAssociation: null,
    developmentPullRequests: [
      { repositoryId: 4242, repository: "o/r", number: 7, title: "A PR", state: "open", url: "https://github.com/o/r/pull/7", updatedAt: 1700000000000 },
    ],
    developmentBranches: [],
    developmentUnlinks: [],
  });
  const importBody = () => ({
    transferId: "gate-transfer",
    sourceBoardId: "gate-source",
    destinationColumnId: "col-missing",
    assigneeId: null,
    bundle: bundle(),
  });
  const routedTo = async (board: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM github_pr_routes WHERE board_id = ?").bind(board).first<{ n: number }>())!.n;

  it("admits an import before it routes the card's pull requests, not only right before the transaction", async () => {
    const board = freshBoard();
    await seed(board);
    const refused = await call(board, "POST", CARD_TRANSFER_IMPORT_PATH, importBody(), { user: STRANGER });
    expect(refused.status).toBe(403);
    expect(await routedTo(board)).toBe(0);

    // A member passes the early admission and reaches the route sync; the missing column then refuses the import.
    const admitted = await call(board, "POST", CARD_TRANSFER_IMPORT_PATH, importBody());
    expect(admitted.status).toBe(400);
    expect(await admitted.json()).toMatchObject({ error: "destination column not found" });
    expect(await routedTo(board)).toBe(1);
  });

  it("parses an MCP read before it admits the caller", async () => {
    const board = freshBoard();
    await seed(board);
    const wellFormed = { board: { id: board, key: "GATES", name: "Gates", appOrigin: "https://app.example" } };
    const stranger = { user: STRANGER };
    expect((await call(board, "POST", MCP_BOARD_READ_PATH, wellFormed, stranger)).status).toBe(403);
    const malformed = await call(board, "POST", MCP_BOARD_READ_PATH, { board: { id: board } }, stranger);
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toBe("invalid request");
    expect((await call(board, "POST", MCP_BOARD_READ_PATH, wellFormed)).status).toBe(200);
    const otherBoard = { board: { ...wellFormed.board, id: "gate-elsewhere" } };
    for (const who of [{}, stranger]) {
      const mismatched = await call(board, "POST", MCP_BOARD_READ_PATH, otherBoard, who);
      expect(mismatched.status).toBe(400);
      expect(await mismatched.text()).toBe("invalid board identity");
    }
  });

  it("stamps the board's identity only on routes that declare it", async () => {
    const board = freshBoard();
    await seed(board);
    const stampedId = () =>
      runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName(board)), (_instance, state) =>
        state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'board_id'").toArray()[0]?.value,
      );
    expect((await call(board, "GET", BOARD_DEVELOPMENT_PATH)).status).toBe(200);
    expect(await stampedId()).toBeUndefined();
    expect((await call(board, "GET", `/internal/attachments/key/${ATTACHMENT}`)).status).toBe(404);
    expect(await stampedId()).toBe(board);
  });

  it("asks for the board id on the development reads and the attachment key lookup", async () => {
    const board = freshBoard();
    await seed(board);
    for (const path of [BOARD_DEVELOPMENT_PATH, "/internal/cards/gate-card/development", `/internal/attachments/key/${ATTACHMENT}`]) {
      const response = await call(board, "GET", path, undefined, { board: null });
      expect(response.status, path).toBe(400);
      expect(await response.text()).toBe("invalid board id");
    }
    expect((await call(board, "GET", "/internal/cards/gate-card/development")).status).toBe(404);
    expect((await call(board, "GET", `/internal/attachments/key/${ATTACHMENT}`)).status).toBe(404);
  });

  it("answers the attachment key lookup to GET only", async () => {
    const board = freshBoard();
    await seed(board);
    for (const method of ["POST", "DELETE"]) {
      expect((await call(board, method, `/internal/attachments/key/${ATTACHMENT}`)).status, method).toBe(405);
    }
  });

  it("refuses the webhook and link routes on a deleted board through the gate alone", async () => {
    const board = freshBoard();
    await seed(board);
    await deleteBoard(board);
    const cases: Array<[string, string, unknown]> = [
      ["POST", PULL_REQUEST_WRITE_PATH, {}],
      ["POST", "/internal/github/branch", {}],
      ["POST", "/internal/cards/gate-card/development/pull-requests", {}],
      ["DELETE", "/internal/cards/gate-card/development/pull-requests", {}],
      ["DELETE", "/internal/cards/gate-card/development/branches", {}],
    ];
    for (const [method, path, body] of cases) {
      const response = await call(board, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(410);
      expect(await response.text()).toBe("board deleted");
    }
  });
});
