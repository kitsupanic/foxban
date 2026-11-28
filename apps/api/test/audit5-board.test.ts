import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { CARD_TRANSFER_IMPORT_PATH } from "../src/board-api";
import { INTERNAL_BOARD_ID_HEADER, INTERNAL_USER_ID_HEADER } from "../src/internal-headers";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const OWNER = "a5-owner";
const MEMBER = "a5-member";
const REMOVED = "a5-removed";
const BOARD = "a5-board";
const COLUMN = "a5-col";

const stub = () => env.BOARD_DO.get(env.BOARD_DO.idFromName(BOARD));

/** The owner and both assignees are real users; only MEMBER still holds a grant when the import lands. */
async function seed(): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    ...[OWNER, MEMBER, REMOVED].map((id) =>
      env.DB.prepare(`INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`).bind(id, `${id}@audit5.test`, id, now),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO boards(id,name,owner_id,icon,color,access_mode,created_at) VALUES(?,?,?,'square-kanban','amber','restricted',?)`,
    ).bind(BOARD, BOARD, OWNER, now),
    env.DB.prepare(`INSERT OR IGNORE INTO board_members(board_id,user_id,role) VALUES(?,?,'manager')`).bind(BOARD, OWNER),
    env.DB.prepare(`INSERT OR IGNORE INTO board_members(board_id,user_id,role) VALUES(?,?,'member')`).bind(BOARD, MEMBER),
  ]);
  await runInDurableObject(stub(), (_instance, state) => {
    state.storage.sql.exec("INSERT OR IGNORE INTO columns(id, title, position) VALUES (?, 'Todo', 'a0')", COLUMN);
  });
}

function importBody(cardId: string, assigneeId: string) {
  return {
    transferId: crypto.randomUUID(),
    sourceBoardId: "a5-source",
    destinationColumnId: COLUMN,
    assigneeId,
    bundle: {
      card: {
        id: cardId, columnId: "src-col", title: "Moved", description: "", position: "a0", taskNumber: 1,
        assigneeId, priority: "medium", taskType: "task", dueDate: null, subtaskDone: false,
        createdAt: 1700000000000, updatedAt: 1700000000000,
      },
      checklistItems: [], attachments: [], comments: [], activities: [], labels: [],
      pullRequestAssociation: null, developmentPullRequests: [], developmentBranches: [], developmentUnlinks: [],
    },
  };
}

async function importCard(cardId: string, assigneeId: string): Promise<string | null | undefined> {
  const response = await stub().fetch(`https://board.internal${CARD_TRANSFER_IMPORT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [INTERNAL_BOARD_ID_HEADER]: BOARD, [INTERNAL_USER_ID_HEADER]: OWNER },
    body: JSON.stringify(importBody(cardId, assigneeId)),
  });
  expect(response.status).toBe(200);
  return runInDurableObject(stub(), (_instance, state) =>
    state.storage.sql
      .exec<{ assigneeId: string | null }>("SELECT assignee_id AS assigneeId FROM cards WHERE id = ?", cardId)
      .toArray()[0]?.assigneeId,
  );
}

describe("transfer import re-checks the assignee", () => {
  it("keeps an assignee who is still a member and drops one removed during the saga", async () => {
    await seed();
    expect(await importCard("a5-card-kept", MEMBER)).toBe(MEMBER);
    // REMOVED was on the Worker's member list before the saga but holds no grant now: the
    // card still lands, unassigned.
    expect(await importCard("a5-card-dropped", REMOVED)).toBeNull();
  });
});
