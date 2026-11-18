import { env, runInDurableObject } from "cloudflare:test";
import { ClientMessageSchema } from "@foxban/shared";
import { describe, expect, it } from "vitest";
import { runMutation } from "../src/board-mutations";
import { MutationRefusal, type MutationContext } from "../src/mutation-gate";

/**
 * The mutation pipeline straight against a board's real SQLite (a fresh BoardDO
 * per case, so the schema is the migrated one). The socket and MCP tests remain
 * the end-to-end contract.
 */
let boardCount = 0;
async function onBoard(check: (sql: SqlStorage, run: (message: unknown, context?: MutationContext) => ReturnType<typeof runMutation>) => void): Promise<void> {
  const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`board-mutations-${++boardCount}`));
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT INTO columns(id, title, position, starting, completed) VALUES ('todo','To do','a',1,0), ('done','Done','b',0,1)");
    const run = (message: unknown, context: MutationContext = { actorId: "u1", boardId: null, canManageColumns: true }) =>
      state.storage.transactionSync(() => runMutation(sql, ClientMessageSchema.parse(message), context, 1000));
    check(sql, run);
  });
}
// The board's own counter hands out the next number, so a seeded card moves it on.
function seedCard(sql: SqlStorage, id: string, taskNumber: number): void {
  sql.exec("INSERT INTO cards(id, column_id, title, position, task_number, created_at, updated_at) VALUES (?,'todo',?,'a',?,0,0)", id, id, taskNumber);
  sql.exec("UPDATE meta SET value = ? WHERE key = 'next_task_number'", taskNumber + 1);
}
const count = (sql: SqlStorage, table: string) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

describe("mutation pipeline", () => {
  it("writes nothing when the gate refuses", () =>
    onBoard((sql, run) => {
      const refused = { type: "column.create", mutationId: "m", id: "extra", title: "Extra", position: "c" };
      expect(() => run(refused, { actorId: "u1", boardId: null, canManageColumns: false })).toThrow(MutationRefusal);
      expect([count(sql, "columns"), count(sql, "activities")]).toEqual([2, 0]);
    }));

  it("returns the numbered card with the next task number", () =>
    onBoard((sql, run) => {
      seedCard(sql, "old", 4);
      const outcome = run({ type: "card.create", mutationId: "m", id: "new", columnId: "todo", title: "New", position: "b" });
      expect(outcome.numberedCard).toEqual({ id: "new", taskNumber: 5 });
      expect(sql.exec<{ task_number: number }>("SELECT task_number FROM cards WHERE id = 'new'").one().task_number).toBe(5);
    }));

  it("refuses a child row for a card that is gone and writes nothing", () =>
    onBoard((sql, run) => {
      // A finalized transfer deletes the card without a trace the gate reads, so this is the only fence between a late write and an orphan.
      seedCard(sql, "live", 1);
      const lateWrites = [
        { type: "checklist.create", mutationId: "m1", id: "item", cardId: "gone", text: "Late", position: "a" },
        { type: "comment.create", mutationId: "m2", id: "note", cardId: "gone", authorId: "u1", parentCommentId: null, body: "Late", createdAt: 1 },
        { type: "label.assign", mutationId: "m3", id: "join", cardId: "gone", labelId: "label" },
        { type: "relation.create", mutationId: "m4", id: "rel-target", sourceCardId: "live", targetCardId: "gone", kind: "blocks" },
        { type: "relation.create", mutationId: "m5", id: "rel-source", sourceCardId: "gone", targetCardId: "live", kind: "relates" },
      ];
      for (const write of lateWrites) expect(() => run(write)).toThrow("card is unavailable");
      expect(["checklist_items", "comments", "card_labels", "card_relations", "activities"].map((table) => count(sql, table))).toEqual([0, 0, 0, 0, 0]);
    }));

  it("logs no history for an edit or a delete that finds the comment already deleted", () =>
    onBoard((sql, run) => {
      seedCard(sql, "p", 1);
      const comment = (id: string, parentCommentId: string | null) =>
        ({ type: "comment.create", mutationId: `create-${id}`, id, cardId: "p", authorId: "u1", parentCommentId, body: id, createdAt: 1 });
      run(comment("root", null));
      run(comment("reply", "root"));
      // A root with a reply is kept as a tombstone, so later messages for it still find a row.
      expect(run({ type: "comment.delete", mutationId: "d1", id: "root" }).activities.map(({ detail }) => detail)).toEqual([{ type: "comment.deleted" }]);
      expect(run({ type: "comment.update", mutationId: "e1", id: "root", body: "late edit", updatedAt: 2 }).activities).toEqual([]);
      expect(run({ type: "comment.delete", mutationId: "d2", id: "root" }).activities).toEqual([]);
      expect(sql.exec<{ body: string }>("SELECT body FROM comments WHERE id = 'root'").one().body).toBe("");
      // A live comment's edit is still history.
      expect(run({ type: "comment.update", mutationId: "e2", id: "reply", body: "edit", updatedAt: 2 }).activities.map(({ detail }) => detail)).toEqual([{ type: "comment.edited" }]);
    }));

  it("records no activities when an idempotent replay writes nothing", () =>
    onBoard((sql, run) => {
      seedCard(sql, "p", 1);
      const create = { type: "subtask.create", mutationId: "m", id: "kid", parentCardId: "p", relationId: "r", title: "Kid", position: "b" };
      expect(run(create).activities).not.toHaveLength(0);
      const recorded = count(sql, "activities");
      const replay = run(create);
      expect(replay.activities).toEqual([]);
      expect(replay.numberedCard).toEqual({ id: "kid", taskNumber: 2 });
      expect(count(sql, "activities")).toBe(recorded);
    }));
});
