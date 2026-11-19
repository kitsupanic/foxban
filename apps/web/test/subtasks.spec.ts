import { createBoardReconciler } from "./reconciler-helpers";
import { expect, test } from "@playwright/test";
import { buildSubtaskHierarchy, type Card, type CardRelation } from "@foxban/shared";
import { buildSubtaskNodes, directSubtaskCounts } from "../src/lib/subtask-nodes";
import {
  applyMutation,
  boardAncestors,
  columnCards,
  columnRootCards,
  reconcileArchivedCards,
} from "../src/lib/apply-mutation";
import type { BoardState } from "../src/lib/apply-mutation";
import { isMutationPresentInBoardState } from "../src/lib/reconciliation";

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    columnId: "col-a",
    title: id,
    description: "",
    position: "a0",
    taskNumber: 1,
    assigneeId: null,
    priority: "medium",
    taskType: "task",
    dueDate: null,
    subtaskDone: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function subtask(id: string, parent: string, child: string): CardRelation {
  return { id, sourceCardId: parent, targetCardId: child, kind: "subtask" };
}

/** A board whose workflow roles an admin chose: col-a starts work, col-b finishes it. */
function state(cards: Card[], relations: CardRelation[] = []): BoardState {
  return {
    workflowRolesExplicit: true,
    columns: [
      { id: "col-a", title: "A", position: "a0", starting: true, completed: false },
      { id: "col-b", title: "B", position: "a1", starting: false, completed: true },
    ],
    cards,
    archivedCards: [],
    checklistItems: [],
    attachments: [],
    comments: [], commentCounts: {},
    relations,
    labels: [],
    cardLabels: [],
  };
}

test.describe("subtask hierarchy", () => {
  test("parents, children and roots come from the stored relations", () => {
    const cards = [
      card("A", { columnId: "col-b", position: "a0" }),
      card("B", { columnId: "col-a", position: "a1" }),
      card("C", { columnId: "col-a", position: "a2" }),
      card("root", { columnId: "col-a", position: "a3" }),
    ];
    const hierarchy = buildSubtaskHierarchy(cards, [
      subtask("r1", "A", "B"),
      subtask("r2", "B", "C"),
    ]);

    expect(hierarchy.parentByChild.get("B")).toBe("A");
    expect(hierarchy.parentByChild.get("C")).toBe("B");
    expect(hierarchy.childrenByParent.get("A")).toEqual(["B"]);
    expect(hierarchy.childrenByParent.get("B")).toEqual(["C"]);
    expect(hierarchy.rootByCard.get("C")).toBe("A");
    expect(hierarchy.rootByCard.get("root")).toBe("root");
  });

  test("siblings sort by position then id, matching byPosition", () => {
    const cards = [
      card("parent", { position: "a0" }),
      card("later", { position: "a2" }),
      card("tie-b", { position: "a1" }),
      card("tie-a", { position: "a1" }),
    ];
    const hierarchy = buildSubtaskHierarchy(cards, [
      subtask("r1", "parent", "later"),
      subtask("r2", "parent", "tie-b"),
      subtask("r3", "parent", "tie-a"),
    ]);

    expect(hierarchy.childrenByParent.get("parent")).toEqual(["tie-a", "tie-b", "later"]);
  });

  test("malformed legacy forests terminate and leave every card visible as a root", () => {
    const cards = [card("A"), card("B"), card("C"), card("orphan")];
    const hierarchy = buildSubtaskHierarchy(cards, [
      // Self-link.
      subtask("self", "A", "A"),
      // Missing endpoint.
      subtask("missing", "A", "ghost"),
      // Duplicate identical pair.
      subtask("dup-1", "A", "B"),
      subtask("dup-2", "A", "B"),
      // Cycle A -> B -> C -> A.
      subtask("r1", "A", "B"),
      subtask("r2", "B", "C"),
      subtask("r3", "C", "A"),
    ]);

    // Every member of the cycle is its own root; nothing is hidden or lost.
    expect(hierarchy.parentByChild.size).toBe(0);
    for (const id of ["A", "B", "C", "orphan"]) {
      expect(hierarchy.rootByCard.get(id)).toBe(id);
    }
    expect(hierarchy.childrenByParent.size).toBe(0);
  });

  test("a child with two distinct parents is left as a root instead of guessing", () => {
    const hierarchy = buildSubtaskHierarchy(
      [card("P1"), card("P2"), card("child")],
      [subtask("r1", "P1", "child"), subtask("r2", "P2", "child")],
    );

    expect(hierarchy.parentByChild.has("child")).toBe(false);
    expect(hierarchy.rootByCard.get("child")).toBe("child");
    expect(hierarchy.childrenByParent.size).toBe(0);
  });

  test("edges whose endpoints are not both active are ignored", () => {
    // An archived parent is absent from the active card list.
    const hierarchy = buildSubtaskHierarchy([card("child")], [subtask("r1", "parent", "child")]);

    expect(hierarchy.parentByChild.size).toBe(0);
    expect(hierarchy.rootByCard.get("child")).toBe("child");
  });
});

test.describe("subtask placement in the board reducers", () => {
  const parentAndChild = state(
    [
      card("parent", { columnId: "col-a", position: "a0" }),
      card("child", { columnId: "col-a", position: "a1", taskType: "subtask" }),
    ],
    [subtask("rel-1", "parent", "child")],
  );

  test("a parent move leaves its child in its own column", () => {
    const moved = applyMutation(parentAndChild, {
      type: "card.move",
      mutationId: "m1",
      id: "parent",
      columnId: "col-b",
      position: "b0",
    }, "board-1");
    const hierarchy = buildSubtaskHierarchy(moved.cards, moved.relations);

    // One card row moved. The child still sits in col-a: it is a root there,
    // because its parent is in another column.
    expect(moved.cards.find((c) => c.id === "parent")?.columnId).toBe("col-b");
    expect(moved.cards.find((c) => c.id === "child")?.columnId).toBe("col-a");
    expect(columnCards(moved, "col-b").map((c) => c.id)).toEqual(["parent"]);
    expect(columnCards(moved, "col-a").map((c) => c.id)).toEqual(["child"]);
    expect(columnRootCards(moved, "col-a", hierarchy).map((c) => c.id)).toEqual(["child"]);
  });

  test("unlinking promotes the child to a task without moving it, and a peer move survives the rollback", () => {
    const unlink = { type: "relation.delete", mutationId: "m2", id: "rel-1" } as const;
    const session = createBoardReconciler("board-1", parentAndChild);
    const unlinked = session.sendOptimistic(unlink);
    expect(unlinked.cards.find((c) => c.id === "child")).toMatchObject({ columnId: "col-a", taskType: "task" });

    // A peer re-orders the child after the unlink; the rejection restores the type only.
    session.applyServerMessage({
      type: "card.move",
      mutationId: "peer",
      id: "child",
      columnId: "col-b",
      position: "a9",
    });
    const rolledBack = session.rollback(unlink.mutationId).cacheState!;
    expect(rolledBack.cards.find((c) => c.id === "child")).toMatchObject({
      columnId: "col-b",
      position: "a9",
      taskType: "subtask",
    });
    expect(rolledBack.relations).toEqual(parentAndChild.relations);
  });

  test("archiving a parent removes only that card; its child stays active", () => {
    const archived = applyMutation(parentAndChild, {
      type: "card.delete",
      mutationId: "m2",
      id: "parent",
    }, "board-1");
    expect(archived.cards.map((c) => c.id)).toEqual(["child"]);

    // A peer's authoritative lifecycle frame removes the named row and keeps the other.
    const reconciled = reconcileArchivedCards(parentAndChild, [
      { ...card("parent", { columnId: "col-a", position: "a0" }), archivedAt: 3000, archivedColumnTitle: "A" },
    ]);
    expect(reconciled.cards.map((c) => c.id)).toEqual(["child"]);
    expect(reconciled.archivedCards.map((candidate) => candidate.id)).toEqual(["parent"]);
  });

  test("deleting a column archives the cards stored in it", () => {
    const moved = applyMutation(parentAndChild, {
      type: "card.move",
      mutationId: "m1",
      id: "parent",
      columnId: "col-b",
      position: "b0",
    }, "board-1");
    const afterChildColumn = applyMutation(moved, {
      type: "column.delete",
      mutationId: "m2",
      id: "col-a",
    }, "board-1");
    expect(afterChildColumn.columns.map((c) => c.id)).toEqual(["col-b"]);
    expect(afterChildColumn.cards.map((c) => c.id)).toEqual(["parent"]);
    expect(afterChildColumn.archivedCards.map((c) => [c.id, c.columnId])).toEqual([["child", "col-a"]]);

    const afterParentColumn = applyMutation(moved, {
      type: "column.delete",
      mutationId: "m3",
      id: "col-b",
    }, "board-1");
    expect(afterParentColumn.cards.map((c) => c.id)).toEqual(["child"]);
    expect(afterParentColumn.archivedCards.map((c) => [c.id, c.columnId])).toEqual([["parent", "col-b"]]);
  });

  test("restoring a linked child uses the column it is sent to and derives its completion", () => {
    const withArchived: BoardState = {
      ...state(
        [card("parent", { columnId: "col-a", position: "a0" })],
        [subtask("rel-1", "parent", "child")],
      ),
      archivedCards: [
        { ...card("child", { taskType: "subtask" }), archivedAt: 2000, archivedColumnTitle: "A" },
      ],
    };

    const restored = applyMutation(withArchived, {
      type: "card.restore",
      mutationId: "m1",
      id: "child",
      columnId: "col-b",
      position: "a5",
    }, "board-1");

    expect(restored.cards.find((c) => c.id === "child")).toMatchObject({ columnId: "col-b", subtaskDone: true });
    expect(restored.archivedCards).toEqual([]);
  });
});

test.describe("subtask creation, completion and recovery", () => {
  const base = state([card("parent", { position: "a0" })]);

  test("a created subtask starts in the starting column, and a done checklist item converts into the completed one", () => {
    const withItem: BoardState = {
      ...base,
      checklistItems: [
        { id: "item-1", cardId: "parent", text: "Write docs", done: true, position: "a0" },
      ],
    };
    const created = applyMutation(withItem, {
      type: "subtask.create",
      mutationId: "m1",
      id: "child",
      parentCardId: "parent",
      relationId: "rel-1",
      title: "Write docs",
      position: "a1",
      checklistItemId: "item-1",
    }, "board-1");

    expect(created.checklistItems).toEqual([]);
    const child = created.cards.find((c) => c.id === "child");
    expect(child?.columnId).toBe("col-b");
    expect(child?.subtaskDone).toBe(true);
    expect(child?.taskType).toBe("subtask");
    expect(created.relations).toEqual([
      { id: "rel-1", sourceCardId: "parent", targetCardId: "child", kind: "subtask" },
    ]);

    // An idempotent replay writes nothing: no second child, no second relation.
    const replayed = applyMutation(created, {
      type: "subtask.create",
      mutationId: "m2",
      id: "child",
      parentCardId: "parent",
      relationId: "rel-1",
      title: "Write docs",
      position: "a1",
      checklistItemId: "item-1",
    }, "board-1");
    expect(replayed).toBe(created);

    const retyped = applyMutation(created, {
      type: "card.retype",
      mutationId: "retype-child",
      id: "child",
      taskType: "bug",
    }, "board-1");
    expect(retyped.cards.find((candidate) => candidate.id === "child")?.taskType).toBe("subtask");

    const nested = applyMutation(created, {
      type: "subtask.create",
      mutationId: "nested-child",
      id: "grandchild",
      parentCardId: "child",
      relationId: "nested-rel",
      title: "Nested",
      position: "a2",
    }, "board-1");
    expect(nested).toBe(created);
  });

  test("without a starting and a completed column a new subtask joins its parent and nothing is done", () => {
    const noRoles: BoardState = {
      ...base,
      columns: base.columns.map(({ id, title, position }) => ({ id, title, position })),
      checklistItems: [
        { id: "item-1", cardId: "parent", text: "Write docs", done: true, position: "a0" },
      ],
    };
    const created = applyMutation(noRoles, {
      type: "subtask.create",
      mutationId: "m1",
      id: "child",
      parentCardId: "parent",
      relationId: "rel-1",
      title: "Write docs",
      position: "a1",
      checklistItemId: "item-1",
    }, "board-1");
    expect(created.cards.find((c) => c.id === "child")).toMatchObject({ columnId: "col-a", subtaskDone: false });
  });

  test("a conversion whose source item is gone writes nothing", () => {
    const missing = applyMutation(base, {
      type: "subtask.create",
      mutationId: "m1",
      id: "child",
      parentCardId: "parent",
      relationId: "rel-1",
      title: "Write docs",
      position: "a1",
      checklistItemId: "vanished",
    }, "board-1");

    expect(missing).toBe(base);
  });

  test("creation rollback restores the converted item only when it is still missing", () => {
    const withItem: BoardState = {
      ...base,
      checklistItems: [
        { id: "item-1", cardId: "parent", text: "Write docs", done: false, position: "a0" },
      ],
    };
    const create = {
      type: "subtask.create",
      mutationId: "m1",
      id: "child",
      parentCardId: "parent",
      relationId: "rel-1",
      title: "Write docs",
      position: "a1",
      checklistItemId: "item-1",
    } as const;
    const session = createBoardReconciler("board-1", withItem);
    const created = session.sendOptimistic(create);

    expect(created.checklistItems).toEqual([]);
    const rolledBack = session.rollback(create.mutationId).cacheState!;
    expect(rolledBack.cards.map((c) => c.id)).toEqual(["parent"]);
    expect(rolledBack.relations).toEqual([]);
    expect(rolledBack.checklistItems.map((item) => item.id)).toEqual(["item-1"]);

    // Repeated rollback never duplicates the restored item.
    const rolledBackTwice = session.rollback(create.mutationId).cacheState!;
    expect(rolledBackTwice.checklistItems.map((item) => item.id)).toEqual(["item-1"]);
  });

  test("completing a child moves only that child, and its rollback keeps peer edits", () => {
    const linked = state(
      [
        card("parent", { position: "a0" }),
        card("child", { position: "a1", columnId: "col-a", taskType: "subtask" }),
      ],
      [subtask("rel-1", "parent", "child")],
    );
    const complete = { type: "card.move", mutationId: "m1", id: "child", columnId: "col-b", position: "a0" } as const;
    const session = createBoardReconciler("board-1", linked);
    const done = session.sendOptimistic(complete);

    expect(done.cards.find((c) => c.id === "child")?.subtaskDone).toBe(true);
    // Checking a child never completes its parent and never moves another card.
    expect(done.cards.find((c) => c.id === "parent")?.subtaskDone).toBe(false);
    expect(done.cards.map((c) => c.columnId)).toEqual(["col-a", "col-b"]);

    // A peer renames the child while our completion is in flight; the rollback
    // restores the placement and leaves the title alone.
    session.applyServerMessage({
      type: "card.update",
      mutationId: "peer",
      id: "child",
      title: "Renamed by peer",
    });
    const rolledBack = session.rollback(complete.mutationId).cacheState!;
    expect(rolledBack.cards.find((c) => c.id === "child")).toMatchObject({
      subtaskDone: false,
      columnId: "col-a",
      title: "Renamed by peer",
    });
  });

  test("creation presence is the child plus its link", () => {
    const linked = state(
      [card("parent"), card("child", { subtaskDone: true })],
      [subtask("rel-1", "parent", "child")],
    );

    const create = {
      type: "subtask.create",
      mutationId: "m2",
      id: "child",
      parentCardId: "parent",
      relationId: "rel-1",
      title: "child",
      position: "a1",
    } as const;
    expect(isMutationPresentInBoardState(linked, create)).toBe(true);
    // The child without its link is not evidence of this creation, and neither is
    // a link that names a different relation.
    expect(
      isMutationPresentInBoardState(
        { ...linked, relations: [] },
        create,
      ),
    ).toBe(false);
    expect(
      isMutationPresentInBoardState(linked, { ...create, relationId: "other" }),
    ).toBe(false);
    // Later title and completion edits are still the same creation.
    expect(
      isMutationPresentInBoardState(
        { ...linked, cards: [card("parent"), card("child", { title: "Edited later" })] },
        { ...create, title: "child" },
      ),
    ).toBe(true);
  });

  test("counts and node lists use direct children only and keep a matched path reachable", () => {
    const cards = [
      card("parent", { position: "a0" }),
      card("child", { position: "a1", subtaskDone: true }),
      card("grandchild", { position: "a2" }),
      card("sibling", { position: "a3" }),
    ];
    const relations = [subtask("r1", "parent", "child"), subtask("r2", "child", "grandchild")];
    const hierarchy = buildSubtaskHierarchy(cards, relations);

    // Only direct children count: the grandchild belongs to its own parent.
    expect(directSubtaskCounts(cards, hierarchy, "parent")).toEqual({ done: 1, total: 1 });
    expect(directSubtaskCounts(cards, hierarchy, "child")).toEqual({ done: 0, total: 1 });

    const boardNodes = buildSubtaskNodes({ cards, relations }, hierarchy, "parent");
    expect(boardNodes.map((node) => node.card.id)).toEqual(["child"]);
    expect(boardNodes[0]?.children.map((node) => node.card.id)).toEqual(["grandchild"]);

    // A filter that matches only the grandchild keeps both ancestors as context,
    // and drops the unmatched sibling entirely.
    const filtered = buildSubtaskNodes({ cards, relations }, hierarchy, "parent", {
      includeCard: (id) => id === "grandchild",
    });
    expect(filtered.map((node) => node.card.id)).toEqual(["child"]);
    expect(filtered[0]?.children.map((node) => node.card.id)).toEqual(["grandchild"]);

    // The detail view lists one level and navigates for the rest.
    const detail = buildSubtaskNodes({ cards, relations }, hierarchy, "parent", {
      directOnly: true,
    });
    expect(detail.map((node) => node.card.id)).toEqual(["child"]);
    expect(detail[0]?.children).toEqual([]);
    expect(detail[0]?.relationId).toBe("r1");
  });
});

test.describe("independent production model", () => {
  function independent(): BoardState {
    const board = state([card("parent"), card("child", { taskType: "subtask", position: "a1" })], [subtask("link", "parent", "child")]);
    board.columns = board.columns.map(c => ({ ...c, starting: c.id === "col-a", completed: c.id === "col-b" }));
    return board;
  }
  test("one child move changes its completion and grouping, parent moves do not drag it", () => {
    let board = independent();
    board = applyMutation(board, { type: "card.move", mutationId: "child", id: "child", columnId: "col-b", position: "a0" }, "board");
    expect(board.cards.find(c => c.id === "child")?.subtaskDone).toBe(true);
    let hierarchy = buildSubtaskHierarchy(board.cards, board.relations);
    expect(columnRootCards(board, "col-b", hierarchy).map(c => c.id)).toEqual(["child"]);
    expect(directSubtaskCounts(board.cards, hierarchy, "parent")).toEqual({ done: 1, total: 1 });
    board = applyMutation(board, { type: "card.move", mutationId: "parent", id: "parent", columnId: "col-b", position: "a1" }, "board");
    hierarchy = buildSubtaskHierarchy(board.cards, board.relations);
    expect(columnRootCards(board, "col-b", hierarchy).map(c => c.id)).toEqual(["parent"]);
    expect(board.cards.find(c => c.id === "child")?.columnId).toBe("col-b");
  });
  test("restore derives completion and unlink promotes without moving; rollback preserves semantics", () => {
    let board = independent();
    const move = { type: "card.move" as const, mutationId: "move", id: "child", columnId: "col-b", position: "a0" };
    const moveSession = createBoardReconciler("board", board);
    moveSession.sendOptimistic(move);
    expect(moveSession.rollback(move.mutationId).cacheState!.cards.find(c => c.id === "child")).toMatchObject({ columnId: "col-a", subtaskDone: false });
    board = applyMutation(board, move, "board");
    const archived = board.cards.find(c => c.id === "child")!;
    board = applyMutation(board, { type: "card.delete", mutationId: "archive", id: "child" }, "board");
    board = reconcileArchivedCards(board, [{ ...archived, archivedAt: 1000, archivedColumnTitle: "B" }]);
    board = applyMutation(board, { type: "card.restore", mutationId: "restore", id: "child", columnId: "col-a", position: "a2" }, "board");
    expect(board.cards.find(c => c.id === "child")).toMatchObject({ columnId: "col-a", subtaskDone: false });
    const unlink = { type: "relation.delete" as const, mutationId: "unlink", id: "link" };
    const session = createBoardReconciler("board", board);
    const promoted = session.sendOptimistic(unlink);
    expect(promoted.cards.find(c => c.id === "child")).toMatchObject({ columnId: "col-a", taskType: "task" });
    expect(session.rollback(unlink.mutationId).cacheState!.cards.find(c => c.id === "child")?.taskType).toBe("subtask");
  });
});


test("historical multilevel board ancestors and filtered nodes stop at every status boundary", () => {
  const board = state([card("A"), card("B", { columnId: "col-b", taskType: "subtask" }), card("C", { columnId: "col-b", taskType: "subtask" })], [subtask("ab", "A", "B"), subtask("bc", "B", "C")]);
  board.columns = board.columns.map(c => ({ ...c, starting: c.id === "col-a", completed: c.id === "col-b" }));
  const hierarchy = buildSubtaskHierarchy(board.cards, board.relations);
  expect(boardAncestors(board, hierarchy, "C")).toEqual(["B"]);
  expect(boardAncestors(board, hierarchy, "B")).toEqual([]);
  expect(buildSubtaskNodes(board, hierarchy, "A", { sameColumn: true, includeCard: id => id === "C" })).toEqual([]);
  expect(buildSubtaskNodes(board, hierarchy, "B", { sameColumn: true, includeCard: id => id === "C" }).map(n => n.card.id)).toEqual(["C"]);
});


test("workflow.configure sets the roles, derives completion and moves no card", () => {
  const board = state([card("a", { columnId: "col-a" }), card("b", { columnId: "col-b", subtaskDone: true })]);
  const configure = {
    type: "workflow.configure" as const,
    mutationId: "configure",
    startingColumnId: "col-b",
    completedColumnId: "col-a",
    expectedStartingColumnId: "col-a",
    expectedCompletedColumnId: "col-b",
  };
  const session = createBoardReconciler("board", board);
  const optimistic = session.sendOptimistic(configure);
  expect(optimistic.columns.map((c) => [c.id, c.starting, c.completed])).toEqual([["col-a", false, true], ["col-b", true, false]]);
  expect(optimistic.cards.map((c) => [c.id, c.columnId, c.subtaskDone])).toEqual([["a", "col-a", true], ["b", "col-b", false]]);
  expect(isMutationPresentInBoardState(optimistic, configure)).toBe(true);
  expect(isMutationPresentInBoardState(board, configure)).toBe(false);

  const rejected = session.rollback(configure.mutationId).cacheState!;
  expect(rejected.columns).toEqual(board.columns);
  expect(rejected.cards).toEqual(board.cards);

  // Choosing the roles freezes them: an automatic board turns explicit.
  const automatic = { ...board, workflowRolesExplicit: false };
  expect(applyMutation(automatic, configure, "board").workflowRolesExplicit).toBe(true);
});

test("automatic roles follow the board's ends, exactly as the BoardDO does", () => {
  const one: BoardState = {
    ...state([card("a", { columnId: "col-a" })]),
    workflowRolesExplicit: false,
    columns: [{ id: "col-a", title: "A", position: "a1", starting: false, completed: false }],
  };
  const apply = (board: BoardState, msg: Parameters<typeof applyMutation>[1]) => applyMutation(board, msg, "board");
  const created = (board: BoardState, id: string, position: string) =>
    apply(board, { type: "column.create", mutationId: `m-${id}`, id, title: id, position });
  const roleOf = (board: BoardState) => board.columns.map((c) => [c.id, c.starting === true, c.completed === true]);

  // One column has no workflow yet.
  expect(created(one, "col-a", "a1")).toBe(one);

  // The new column sorts first, so it starts work and col-a finishes it; the card
  // in col-a is done because completion follows its column.
  const two = created(one, "col-first", "a0");
  expect(roleOf(two)).toEqual([["col-a", false, true], ["col-first", true, false]]);
  expect(two.cards.map((c) => c.subtaskDone)).toEqual([true]);

  // A third column on the right takes the completed role; the card is open again.
  const three = created(two, "col-third", "a2");
  expect(roleOf(three)).toEqual([["col-a", false, false], ["col-first", true, false], ["col-third", false, true]]);
  expect(three.cards.map((c) => [c.columnId, c.subtaskDone])).toEqual([["col-a", false]]);

  // Moving and deleting columns recompute them too, and a board below two columns has none.
  const moved = apply(three, { type: "column.move", mutationId: "m-move", id: "col-third", position: "Z" });
  expect(roleOf(moved)).toEqual([["col-a", false, true], ["col-first", false, false], ["col-third", true, false]]);
  const afterDelete = apply(moved, { type: "column.delete", mutationId: "m-delete", id: "col-a" });
  expect(roleOf(afterDelete)).toEqual([["col-first", false, true], ["col-third", true, false]]);
  expect(roleOf(apply(afterDelete, { type: "column.delete", mutationId: "m-delete-2", id: "col-first" }))).toEqual([["col-third", false, false]]);

  // Explicit roles never drift: not on create, move or delete of any other column.
  const chosen = { ...three, workflowRolesExplicit: true, columns: three.columns.map((c) => ({ ...c, starting: c.id === "col-first", completed: c.id === "col-a" })) };
  expect(roleOf(created(chosen, "col-fourth", "a3"))).toEqual([
    ["col-a", false, true], ["col-first", true, false], ["col-third", false, false], ["col-fourth", false, false],
  ]);
  expect(roleOf(apply(chosen, { type: "column.move", mutationId: "m-move-2", id: "col-first", position: "a9" }))).toEqual(roleOf(chosen));

  // A rejected creation puts the roles back with the column.
  const session = createBoardReconciler("board", one);
  session.sendOptimistic({ type: "column.create", mutationId: "m1", id: "col-b", title: "B", position: "a2" });
  expect(roleOf(session.getCacheState()!)).toEqual([["col-a", true, false], ["col-b", false, true]]);
  expect(roleOf(session.rollback("m1").cacheState!)).toEqual([["col-a", false, false]]);
});
