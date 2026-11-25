import { expect, test } from "@playwright/test";
import type { ArchivedCard, Column } from "@foxban/shared";
import { applyMutation, reconcileRestoredDescription, type BoardState } from "../src/lib/apply-mutation";
import { createBoardReconciler } from "./reconciler-helpers";

/**
 * ADR 0089: the snapshot lists archived cards with an empty `description`, and the
 * server's `card.restored` frame, sent right after the verbatim `card.restore`,
 * brings the real text back to the sender and to every peer.
 */

const column: Column = { id: "col-1", title: "Todo", position: "a0", starting: true, completed: false };

/** An archived card as a reconnect snapshot delivers it: its text is empty. */
const snapshotArchived: ArchivedCard = {
  id: "card-1",
  columnId: "col-gone",
  title: "Archived",
  description: "",
  position: "a0",
  taskNumber: 4,
  assigneeId: null,
  priority: "medium",
  taskType: "task",
  dueDate: null,
  subtaskDone: false,
  createdAt: 1000,
  updatedAt: 1000,
  archivedAt: 2000,
  archivedColumnTitle: "Gone",
};

const state = (archived: ArchivedCard[] = [snapshotArchived]): BoardState => ({
  workflowRolesExplicit: false,
  columns: [column],
  cards: [],
  archivedCards: archived,
  checklistItems: [],
  attachments: [],
  comments: [],
  commentCounts: {},
  relations: [],
  labels: [],
  cardLabels: [],
});

const restore = { type: "card.restore", mutationId: "restore-1", id: "card-1", columnId: "col-1", position: "a0" } as const;
const restored = { type: "card.restored", id: "card-1", description: "the **real** text" } as const;

test.describe("card.restored brings an archived card's description back", () => {
  test("applyMutation sets the description of the active card and nothing else", () => {
    const afterRestore = applyMutation(state(), restore, "board-1");
    expect(afterRestore.cards[0]).toMatchObject({ id: "card-1", description: "", columnId: "col-1" });

    const filled = applyMutation(afterRestore, restored, "board-1");
    expect(filled.cards[0]).toEqual({ ...afterRestore.cards[0]!, description: "the **real** text" });
    expect(filled.archivedCards).toEqual([]);
  });

  test("a frame for a card that is not active leaves the state untouched", () => {
    const archivedOnly = state();
    expect(applyMutation(archivedOnly, restored, "board-1")).toBe(archivedOnly);
    expect(reconcileRestoredDescription(archivedOnly, "card-missing", "text")).toBe(archivedOnly);
    const afterRestore = applyMutation(state(), restore, "board-1");
    expect(reconcileRestoredDescription(afterRestore, "card-1", "")).toBe(afterRestore);
  });

  test("the sender sees the card come back empty, then complete, and the restore settles on its echo alone", () => {
    const session = createBoardReconciler("board-1", state());
    const optimistic = session.sendOptimistic(restore);
    expect(optimistic.cards[0]).toMatchObject({ id: "card-1", description: "" });

    const echo = session.applyServerMessage(restore);
    expect(echo.ackedMutationIds).toEqual(["restore-1"]);
    expect(echo.cacheState!.cards[0]).toMatchObject({ id: "card-1", description: "" });
    expect(session.hasPending("restore-1")).toBe(false);

    const frame = session.applyServerMessage(restored);
    expect(frame.ackedMutationIds).toEqual([]);
    expect(frame.cacheState!.cards).toHaveLength(1);
    expect(frame.cacheState!.cards[0]).toMatchObject({ id: "card-1", description: "the **real** text", columnId: "col-1" });
    expect(frame.cacheState!.archivedCards).toEqual([]);
    expect(session.getBaseState()!.cards[0]!.description).toBe("the **real** text");
  });

  test("a peer that never held the text gets it from the frame", () => {
    const peer = createBoardReconciler("board-1", state());
    peer.applyServerMessage(restore);
    const after = peer.applyServerMessage(restored).cacheState!;
    expect(after.cards.map(({ id, description }) => ({ id, description }))).toEqual([{ id: "card-1", description: "the **real** text" }]);
  });

  test("a pending edit of the restored card still sits on top of the frame's text", () => {
    const session = createBoardReconciler("board-1", state());
    session.applyServerMessage(restore);
    session.sendOptimistic({ type: "card.update", mutationId: "edit-1", id: "card-1", description: "my edit" });
    const after = session.applyServerMessage(restored).cacheState!;
    expect(after.cards[0]!.description).toBe("my edit");
    expect(session.getBaseState()!.cards[0]!.description).toBe("the **real** text");
  });
});
