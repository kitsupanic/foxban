import { env, runInDurableObject } from "cloudflare:test";
import { ClientMessageSchema } from "@foxban/shared";
import { describe, expect, it } from "vitest";
import { generateKeyBetween } from "fractional-indexing";
import { REBALANCE_KEY_LENGTH, runMutation } from "../src/board-mutations";
import { COMMENT_TIME_TOLERANCE_MS, MutationRefusal, type MutationContext } from "../src/mutation-gate";

/**
 * The mutation pipeline straight against a board's real SQLite (a fresh BoardDO
 * per case, so the schema is the migrated one). The socket and MCP tests remain
 * the end-to-end contract.
 */
let boardCount = 0;
async function onBoard(check: (sql: SqlStorage, run: (message: unknown, context?: MutationContext, now?: number) => ReturnType<typeof runMutation>) => void): Promise<void> {
  const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`board-mutations-${++boardCount}`));
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT INTO columns(id, title, position, starting, completed) VALUES ('todo','To do','a',1,0), ('done','Done','b',0,1)");
    const run = (message: unknown, context: MutationContext = { actorId: "u1", boardId: null, canManageColumns: true }, now = 1000) =>
      state.storage.transactionSync(() => runMutation(sql, ClientMessageSchema.parse(message), context, now));
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
  it("keeps comment authorship to the socket's own user", () =>
    onBoard((sql, run) => {
      seedCard(sql, "c1", 1);
      const bob = { actorId: "bob", boardId: null, canManageColumns: false };
      // Posting as someone else is refused.
      expect(() => run({ type: "comment.create", mutationId: "m1", id: "fake", cardId: "c1", authorId: "alice", parentCommentId: null, body: "Ship it", createdAt: 1 }, bob)).toThrow(MutationRefusal);
      run({ type: "comment.create", mutationId: "m2", id: "note", cardId: "c1", authorId: "alice", parentCommentId: null, body: "Hold", createdAt: 1 }, { ...bob, actorId: "alice" });
      // Another member may neither edit nor delete it; an instance Admin may delete it but not edit it.
      expect(() => run({ type: "comment.update", mutationId: "m3", id: "note", cardId: "c1", body: "Ship it", updatedAt: 2 }, bob)).toThrow(MutationRefusal);
      expect(() => run({ type: "comment.delete", mutationId: "m4", id: "note", cardId: "c1" }, bob)).toThrow(MutationRefusal);
      expect(() => run({ type: "comment.update", mutationId: "m5", id: "note", cardId: "c1", body: "Ship it", updatedAt: 2 }, { ...bob, isAdmin: true })).toThrow(MutationRefusal);
      expect(sql.exec<{ body: string }>("SELECT body FROM comments WHERE id = 'note'").one().body).toBe("Hold");
      run({ type: "comment.delete", mutationId: "m6", id: "note", cardId: "c1" }, { ...bob, isAdmin: true });
      expect(count(sql, "comments")).toBe(0);
    }));

  it("holds a live comment's own timestamp to the board's clock", () =>
    onBoard((sql, run) => {
      seedCard(sql, "c1", 1);
      const now = 1_800_000_000_000;
      const create = (id: string, createdAt: number) => ({ type: "comment.create", mutationId: `m-${id}`, id, cardId: "c1", authorId: "u1", parentCommentId: null, body: "hi", createdAt });
      // Backdated to the epoch, or a hair past the window either way: refused, nothing written.
      for (const [id, createdAt] of [["epoch", 0], ["past", now - COMMENT_TIME_TOLERANCE_MS - 1], ["future", now + COMMENT_TIME_TOLERANCE_MS + 1]] as const) {
        expect(() => run(create(id, createdAt), undefined, now)).toThrow(MutationRefusal);
      }
      expect(count(sql, "comments")).toBe(0);
      // The window's own edges are in, and so is now.
      for (const [id, createdAt] of [["edge-past", now - COMMENT_TIME_TOLERANCE_MS], ["edge-future", now + COMMENT_TIME_TOLERANCE_MS], ["now", now]] as const) {
        run(create(id, createdAt), undefined, now);
      }
      expect(count(sql, "comments")).toBe(3);
      // An edit is held to the same clock.
      expect(() => run({ type: "comment.update", mutationId: "m-u", id: "now", cardId: "c1", body: "later", updatedAt: 0 }, undefined, now)).toThrow(MutationRefusal);
      run({ type: "comment.update", mutationId: "m-u2", id: "now", cardId: "c1", body: "later", updatedAt: now }, undefined, now);
      expect(sql.exec<{ body: string }>("SELECT body FROM comments WHERE id = 'now'").one().body).toBe("later");
    }));

  describe("position key rebalance", () => {
    const place = (sql: SqlStorage, id: string, columnId: string, position: string, archived = false) => {
      seedCard(sql, id, Number(sql.exec<{ n: number }>("SELECT COUNT(*) + 1 AS n FROM cards").one().n));
      sql.exec("UPDATE cards SET column_id = ?, position = ?, archived_at = ? WHERE id = ?", columnId, position, archived ? 1 : null, id);
    };
    const order = (sql: SqlStorage, columnId: string, archived = false) =>
      sql.exec<{ id: string; position: string }>(`SELECT id, position FROM cards WHERE column_id = ? AND archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY position, id`, columnId).toArray();
    // The first key between a0 and a1 past the threshold: what a client computes dropping into a gap that has run out of room.
    const longKey = () => {
      let key = "a1";
      while (key.length <= REBALANCE_KEY_LENGTH) key = generateKeyBetween("a0", key);
      return key;
    };

    it("spreads the column's active keys in their order, tied keys included, and leaves everything else", () =>
      onBoard((sql, run) => {
        place(sql, "first", "todo", "a0");
        place(sql, "tied-b", "todo", "a1");
        place(sql, "tied-a", "todo", "a1");
        place(sql, "mover", "todo", "a2");
        place(sql, "elsewhere", "done", "a9");
        place(sql, "archived", "todo", "a1V", true);
        const rebalanced = run({ type: "card.move", mutationId: "m", id: "mover", columnId: "todo", position: longKey() }).rebalanced;
        // mover sits between first and the tied pair; the tie is broken by id, as every client does.
        const spread = [
          { id: "first", position: "a0" }, { id: "mover", position: "a1" }, { id: "tied-a", position: "a2" }, { id: "tied-b", position: "a3" },
        ];
        expect(order(sql, "todo")).toEqual(spread);
        // The frame lists exactly what was written, in that order.
        expect(rebalanced).toEqual({ type: "positions.rebalanced", table: "cards", positions: spread });
        expect(order(sql, "done")).toEqual([{ id: "elsewhere", position: "a9" }]);
        expect(order(sql, "todo", true)).toEqual([{ id: "archived", position: "a1V" }]);
      }));

    it("does nothing for a key under the threshold, and rewrites columns by the same rule", () =>
      onBoard((sql, run) => {
        place(sql, "c1", "todo", "a0");
        expect(run({ type: "card.move", mutationId: "m1", id: "c1", columnId: "todo", position: "a5" }).rebalanced).toBeNull();
        expect(order(sql, "todo")).toEqual([{ id: "c1", position: "a5" }]);

        expect(run({ type: "column.create", mutationId: "m2", id: "mid", title: "Mid", position: "a0V" }).rebalanced).toBeNull();
        expect(run({ type: "column.move", mutationId: "m3", id: "mid", position: longKey() }).rebalanced).toEqual({
          type: "positions.rebalanced",
          table: "columns",
          positions: [{ id: "todo", position: "a0" }, { id: "mid", position: "a1" }, { id: "done", position: "a2" }],
        });
        expect(sql.exec<{ id: string; position: string }>("SELECT id, position FROM columns ORDER BY position, id").toArray()).toEqual([
          { id: "todo", position: "a0" }, { id: "mid", position: "a1" }, { id: "done", position: "a2" },
        ]);
        // The workflow roles follow position, which did not change.
        expect(sql.exec<{ id: string }>("SELECT id FROM columns WHERE starting = 1").one().id).toBe("todo");
        expect(sql.exec<{ id: string }>("SELECT id FROM columns WHERE completed = 1").one().id).toBe("done");
      }));

    it("sends no frame when the card or column moved is gone: a stale move writes nothing, even into a non-empty list", () =>
      onBoard((sql, run) => {
        expect(run({ type: "card.move", mutationId: "m", id: "missing", columnId: "todo", position: longKey() }).rebalanced).toBeNull();
        expect(order(sql, "todo")).toEqual([]);

        place(sql, "c1", "todo", "a0");
        place(sql, "c2", "todo", "a1");
        expect(run({ type: "card.move", mutationId: "m2", id: "missing", columnId: "todo", position: longKey() }).rebalanced).toBeNull();
        expect(order(sql, "todo")).toEqual([{ id: "c1", position: "a0" }, { id: "c2", position: "a1" }]);

        expect(run({ type: "column.move", mutationId: "m3", id: "gone", position: longKey() }).rebalanced).toBeNull();
        expect(sql.exec<{ id: string; position: string }>("SELECT id, position FROM columns ORDER BY position, id").toArray()).toEqual([
          { id: "todo", position: "a" }, { id: "done", position: "b" },
        ]);
      }));
  });

  it("indexes what the card, comment and attachment paths look up by", () =>
    onBoard((sql) => {
      const indexed = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").toArray().map((row) => row.name);
      expect(indexed).toEqual(expect.arrayContaining(["comments_card", "comments_parent", "attachments_object_key", "attachments_card"]));
    }));

  it("writes nothing when the gate refuses", () =>
    onBoard((sql, run) => {
      const refused = { type: "column.create", mutationId: "m", id: "extra", title: "Extra", position: "a2" };
      expect(() => run(refused, { actorId: "u1", boardId: null, canManageColumns: false })).toThrow(MutationRefusal);
      expect([count(sql, "columns"), count(sql, "activities")]).toEqual([2, 0]);
    }));

  it("refuses a position key the ordering library rejects and writes nothing", () =>
    onBoard((sql, run) => {
      seedCard(sql, "c1", 1);
      // "zzz" is not a valid fractional-indexing key: stored, it would make every later insert beside it throw.
      expect(() => run({ type: "card.move", mutationId: "m", id: "c1", columnId: "done", position: "zzz" })).toThrow("invalid position key");
      expect(sql.exec<{ column_id: string; position: string }>("SELECT column_id, position FROM cards WHERE id = 'c1'").one()).toEqual({ column_id: "todo", position: "a" });
    }));

  it("refuses a position key with characters outside the library's digits", () =>
    onBoard((sql, run) => {
      seedCard(sql, "c1", 1);
      // fractional-indexing does not check characters after the first two, so "a0~" would sort after the keys generated beside it.
      for (const position of ["a0~", "a0ü"]) {
        expect(() => run({ type: "card.move", mutationId: "m", id: "c1", columnId: "done", position })).toThrow("invalid position key");
      }
      expect(sql.exec<{ position: string }>("SELECT position FROM cards WHERE id = 'c1'").one().position).toBe("a");
    }));

  it("lets an active child be unlinked from an archived parent, still fenced by a transfer lock", () =>
    onBoard((sql, run) => {
      seedCard(sql, "p", 1);
      run({ type: "subtask.create", mutationId: "m1", id: "kid", parentCardId: "p", relationId: "r", title: "Kid", position: "a1" });
      sql.exec("UPDATE cards SET archived_at = 1 WHERE id = 'p'");
      const unlink = { type: "relation.delete", mutationId: "m2", id: "r" };
      // A lock on either end still refuses it.
      for (const locked of ["p", "kid"]) {
        sql.exec("INSERT INTO card_transfer_locks(card_id, transfer_id, destination_board_id, phase, expires_at) VALUES (?, 't', 'dest', 'prepared', 9999999999999)", locked);
        expect(() => run(unlink)).toThrow("card transfer in progress");
        sql.exec("DELETE FROM card_transfer_locks");
      }
      run(unlink);
      expect(count(sql, "card_relations")).toBe(0);
      expect(sql.exec<{ task_type: string }>("SELECT task_type FROM cards WHERE id = 'kid'").one().task_type).toBe("task");
      // The archived parent itself stays read-only.
      expect(() => run({ type: "card.update", mutationId: "m3", id: "p", title: "Edit" })).toThrow("archived cards are read-only");
    }));

  it("returns the numbered card with the next task number", () =>
    onBoard((sql, run) => {
      seedCard(sql, "old", 4);
      const outcome = run({ type: "card.create", mutationId: "m", id: "new", columnId: "todo", title: "New", position: "a1" });
      expect(outcome.numberedCard).toEqual({ id: "new", taskNumber: 5 });
      expect(sql.exec<{ task_number: number }>("SELECT task_number FROM cards WHERE id = 'new'").one().task_number).toBe(5);
    }));

  it("refuses a child row for a card that is gone and writes nothing", () =>
    onBoard((sql, run) => {
      // A finalized transfer deletes the card without a trace the gate reads, so this is the only fence between a late write and an orphan.
      seedCard(sql, "live", 1);
      const lateWrites = [
        { type: "checklist.create", mutationId: "m1", id: "item", cardId: "gone", text: "Late", position: "a0" },
        { type: "comment.create", mutationId: "m2", id: "note", cardId: "gone", authorId: "u1", parentCommentId: null, body: "Late", createdAt: 1 },
        { type: "label.assign", mutationId: "m3", id: "join", cardId: "gone", labelId: "label" },
        { type: "relation.create", mutationId: "m4", id: "rel-target", sourceCardId: "live", targetCardId: "gone", kind: "blocks" },
        { type: "relation.create", mutationId: "m5", id: "rel-source", sourceCardId: "gone", targetCardId: "live", kind: "relates" },
      ];
      for (const write of lateWrites) expect(() => run(write)).toThrow("card is unavailable");
      expect(["checklist_items", "comments", "card_labels", "card_relations", "activities"].map((table) => count(sql, table))).toEqual([0, 0, 0, 0, 0]);
    }));

  it("logs no history for an edit of a deleted comment, and refuses a second delete", () =>
    onBoard((sql, run) => {
      seedCard(sql, "p", 1);
      const comment = (id: string, parentCommentId: string | null) =>
        ({ type: "comment.create", mutationId: `create-${id}`, id, cardId: "p", authorId: "u1", parentCommentId, body: id, createdAt: 1 });
      run(comment("root", null));
      run(comment("reply", "root"));
      // A root with a reply is kept as a tombstone, so later messages for it still find a row.
      expect(run({ type: "comment.delete", mutationId: "d1", id: "root", cardId: "p" }).activities.map(({ detail }) => detail)).toEqual([{ type: "comment.deleted" }]);
      expect(run({ type: "comment.update", mutationId: "e1", id: "root", cardId: "p", body: "late edit", updatedAt: 2 }).activities).toEqual([]);
      // A second delete is refused, not a silent no-op, so peers can count broadcast deletes (ADR 0078).
      expect(() => run({ type: "comment.delete", mutationId: "d2", id: "root", cardId: "p" })).toThrow("Comment is already deleted.");
      expect(sql.exec<{ body: string }>("SELECT body FROM comments WHERE id = 'root'").one().body).toBe("");
      // A live comment's edit is still history.
      expect(run({ type: "comment.update", mutationId: "e2", id: "reply", cardId: "p", body: "edit", updatedAt: 2 }).activities.map(({ detail }) => detail)).toEqual([{ type: "comment.edited" }]);
    }));

  it("records no activities when an idempotent replay writes nothing", () =>
    onBoard((sql, run) => {
      seedCard(sql, "p", 1);
      const create = { type: "subtask.create", mutationId: "m", id: "kid", parentCardId: "p", relationId: "r", title: "Kid", position: "a1" };
      expect(run(create).activities).not.toHaveLength(0);
      const recorded = count(sql, "activities");
      const replay = run(create);
      expect(replay.activities).toEqual([]);
      expect(replay.numberedCard).toEqual({ id: "kid", taskNumber: 2 });
      expect(count(sql, "activities")).toBe(recorded);
    }));

  it("refuses a label that is gone and a card linked to itself, writing nothing", () =>
    onBoard((sql, run) => {
      seedCard(sql, "live", 1);
      expect(() => run({ type: "label.assign", mutationId: "m1", id: "join", cardId: "live", labelId: "deleted" })).toThrow("label is unavailable");
      for (const kind of ["blocks", "relates", "subtask"]) {
        expect(() => run({ type: "relation.create", mutationId: `m-${kind}`, id: `rel-${kind}`, sourceCardId: "live", targetCardId: "live", kind })).toThrow();
      }
      expect([count(sql, "card_labels"), count(sql, "card_relations"), count(sql, "activities")]).toEqual([0, 0, 0]);
    }));
});
