import { env, runInDurableObject } from "cloudflare:test";
import type { ClientMessage } from "@foxban/shared";
import { describe, expect, it } from "vitest";
import {
  checkFinish,
  checkSubtaskLink,
  checkSubtaskParent,
  completionFor,
  isCompleted,
  loadFamily,
  placementFor,
  roleColumn,
} from "../src/subtask-family";

/**
 * The subtask family rules straight against a board's real SQLite (a fresh BoardDO
 * per case, so the schema is the migrated one). The socket tests in
 * board-do.test.ts remain the end-to-end contract.
 */
type Row = { id: string; column: string; position: string; type?: "task" | "subtask"; archived?: boolean };
type Board = {
  roles?: boolean;
  cards: Row[];
  links?: [parent: string, child: string][];
};

let boardCount = 0;
async function onBoard(board: Board, check: (sql: SqlStorage) => void): Promise<void> {
  const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`subtask-family-${++boardCount}`));
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const roles = board.roles ?? true;
    sql.exec("INSERT INTO columns(id, title, position, starting, completed) VALUES ('todo','To do','a',?,0), ('done','Done','b',0,?)", roles ? 1 : 0, roles ? 1 : 0);
    board.cards.forEach((card, index) =>
      sql.exec(
        "INSERT INTO cards(id, column_id, title, position, task_number, task_type, archived_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,0)",
        card.id, card.column, card.id, card.position, index + 1, card.type ?? "task", card.archived ? 1 : null,
      ),
    );
    (board.links ?? []).forEach(([parent, child], index) =>
      sql.exec("INSERT INTO card_relations(id, source_card_id, target_card_id, kind) VALUES (?,?,?,'subtask')", `r${index}`, parent, child),
    );
    check(sql);
  });
}

const family: Board = {
  cards: [
    { id: "p", column: "todo", position: "a" },
    { id: "open", column: "todo", position: "b", type: "subtask" },
    { id: "closed", column: "done", position: "a", type: "subtask" },
  ],
  links: [["p", "open"], ["p", "closed"]],
};
const finish = (overrides: Partial<Extract<ClientMessage, { type: "card.finish" }>> = {}) =>
  ({
    type: "card.finish", mutationId: "m", id: "p", columnId: "done", position: "c", scope: "family",
    expectedParentColumnId: "todo", expectedParentPosition: "a",
    expectedFamily: [
      { id: "open", parentId: "p", columnId: "todo", position: "b" },
      { id: "closed", parentId: "p", columnId: "done", position: "a" },
    ],
    children: [{ id: "open", position: "d" }],
    ...overrides,
  }) as Extract<ClientMessage, { type: "card.finish" }>;

describe("subtask family", () => {
  it("loads the active family, or the retained one with archived parents", () =>
    onBoard(
      { cards: [{ id: "gone", column: "todo", position: "a", archived: true }, { id: "kid", column: "todo", position: "b", type: "subtask" }], links: [["gone", "kid"]] },
      (sql) => {
        expect(loadFamily(sql, "active").parentByChild.has("kid")).toBe(false);
        expect(loadFamily(sql, "retained").parentByChild.get("kid")).toBe("gone");
      },
    ));

  it("derives completion and the role columns from the columns", () =>
    onBoard(family, (sql) => {
      expect([isCompleted(sql, "done"), isCompleted(sql, "todo"), isCompleted(sql, "missing")]).toEqual([true, false, false]);
      expect([roleColumn(sql, "starting"), roleColumn(sql, "completed")]).toEqual(["todo", "done"]);
    }));

  it("accepts the reviewed finish and refuses every stale or partial one", () =>
    onBoard(family, (sql) => {
      expect(() => checkFinish(sql, finish())).not.toThrow();
      expect(() => checkFinish(sql, finish({ scope: "parent", children: [] }))).not.toThrow();
      expect(() => checkFinish(sql, finish({ columnId: "todo" }))).toThrow("Completed status changed.");
      expect(() => checkFinish(sql, finish({ expectedParentPosition: "z" }))).toThrow("Parent changed.");
      expect(() => checkFinish(sql, finish({ expectedFamily: [] }))).toThrow("Subtasks changed.");
      expect(() => checkFinish(sql, finish({ scope: "parent" }))).toThrow("Review every unfinished subtask");
      expect(() => checkFinish(sql, finish({ children: [] }))).toThrow("Review every unfinished subtask");
      expect(() => checkFinish(sql, finish({ children: [{ id: "open", position: "d" }, { id: "open", position: "e" }] }))).toThrow("Review every unfinished subtask");
    }));

  it("sends a completed or reopened subtask to its role column", () =>
    onBoard(family, (sql) => {
      expect(completionFor(sql, "open", true)).toBe("done");
      expect(completionFor(sql, "closed", false)).toBe("todo");
      expect(() => completionFor(sql, "p", true)).toThrow("Subtask is unavailable.");
    }));

  it("refuses completion on a board without roles", () =>
    onBoard({ ...family, roles: false }, (sql) => {
      expect(() => completionFor(sql, "open", true)).toThrow("The board has no starting and completed columns yet.");
    }));

  it("places a new subtask by the roles, or in its parent's column without them", async () => {
    await onBoard(family, (sql) => {
      expect([placementFor(sql, "p", false), placementFor(sql, "p", true)]).toEqual(["todo", "done"]);
    });
    await onBoard({ ...family, roles: false, cards: [{ id: "p", column: "done", position: "a" }], links: [] }, (sql) => {
      expect(placementFor(sql, "p", false)).toBe("done");
    });
  });

  it("keeps families one level deep under a live parent", () =>
    onBoard({ ...family, cards: [...family.cards, { id: "old", column: "todo", position: "c", archived: true }] }, (sql) => {
      expect(() => checkSubtaskParent(sql, "p")).not.toThrow();
      expect(() => checkSubtaskParent(sql, "old")).toThrow("Parent task is unavailable.");
      expect(() => checkSubtaskParent(sql, "missing")).toThrow("Parent task is unavailable.");
      expect(() => checkSubtaskParent(sql, "open")).toThrow("Subtasks cannot have subtasks.");
    }));

  it("refuses every structurally impossible link with one error", () =>
    onBoard(
      {
        cards: [
          { id: "a", column: "todo", position: "a" },
          { id: "b", column: "todo", position: "b" },
          { id: "c", column: "todo", position: "c" },
          { id: "kid", column: "todo", position: "d", type: "subtask" },
          { id: "old", column: "todo", position: "e", archived: true },
          { id: "d", column: "todo", position: "f" },
        ],
        links: [["a", "kid"], ["b", "a"]],
      },
      (sql) => {
        expect(() => checkSubtaskLink(sql, "c", "d")).not.toThrow();
        for (const [source, target] of [["a", "a"], ["c", "kid"], ["kid", "c"], ["c", "a"], ["a", "b"], ["c", "b"], ["old", "c"], ["c", "missing"]]) {
          expect(() => checkSubtaskLink(sql, source!, target!), `${source}→${target}`).toThrow("Invalid subtask hierarchy.");
        }
      },
    ));
});
