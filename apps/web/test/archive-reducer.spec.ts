import { createBoardReconciler } from "../src/lib/reconciliation";
import { expect, test } from "@playwright/test";
import type {
  Activity,
  ArchivedCard,
  Attachment,
  Card,
  CardLabel,
  CardRelation,
  ChecklistItem,
  ClientMessage,
  Column,
  Comment,
  Label,
} from "@foxban/shared";
import {
  applyMutation,
  type BoardState,
} from "../src/lib/apply-mutation";

test.describe("archive reducer and rollback state transitions", () => {
  test("Scenario A: pending optimistic card delete rolled back after column archive leaves card archived and never active", () => {
    const col1: Column = { id: "col-1", title: "Doomed", position: "a0" };
    const card1: Card = {
      id: "card-1",
      columnId: "col-1",
      title: "Card to Delete",
      description: "Original description",
      position: "a0",
      taskNumber: 1,
      assigneeId: null,
      priority: "medium",
      taskType: "task",
      dueDate: null,
      subtaskDone: false,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const checklistItem: ChecklistItem = {
      id: "chk-1",
      cardId: "card-1",
      text: "Task 1",
      done: false,
      position: "a0",
    };
    const attachment: Attachment = {
      id: "att-1",
      cardId: "card-1",
      fileName: "file.txt",
      contentType: "text/plain",
      size: 100,
    };
    const comment: Comment = {
      id: "com-1",
      cardId: "card-1",
      authorId: "user-1",
      parentCommentId: null,
      deleted: false,
      body: "Initial comment",
      createdAt: 1000,
      updatedAt: 1000,
    };
    const activity: Activity = {
      id: "act-1",
      cardId: "card-1",
      actorId: "user-1",
      sequence: 1,
      createdAt: 1000,
      detail: { type: "card.created" },
    };
    const label: Label = { id: "lbl-1", name: "Bug", color: "red" };
    const cardLabel: CardLabel = { id: "cl-1", cardId: "card-1", labelId: "lbl-1" };
    const relation: CardRelation = {
      id: "rel-1",
      sourceCardId: "card-1",
      targetCardId: "card-other",
      kind: "blocks",
    };

    const initialState: BoardState = {
      columns: [col1],
      cards: [card1],
      archivedCards: [],
      checklistItems: [checklistItem],
      attachments: [attachment],
      comments: [comment],
      activities: [activity],
      relations: [relation],
      labels: [label],
      cardLabels: [cardLabel],
    };

    // 1. Capture and apply pending optimistic card.delete
    const deleteMutation: ClientMessage = {
      type: "card.delete",
      mutationId: "mut-card-delete-1",
      id: "card-1",
    };
    const session = createBoardReconciler("board-1", initialState);
    const stateAfterOptimisticDelete = session.sendOptimistic(deleteMutation);

    expect(stateAfterOptimisticDelete.cards.some((c) => c.id === "card-1")).toBe(false);
    expect(stateAfterOptimisticDelete.archivedCards.some((c) => c.id === "card-1")).toBe(false);
    expect(stateAfterOptimisticDelete.checklistItems).toEqual(initialState.checklistItems);
    expect(stateAfterOptimisticDelete.attachments).toEqual(initialState.attachments);
    expect(stateAfterOptimisticDelete.comments).toEqual(initialState.comments);
    expect(stateAfterOptimisticDelete.activities).toEqual(initialState.activities);
    expect(stateAfterOptimisticDelete.relations).toEqual(initialState.relations);
    expect(stateAfterOptimisticDelete.labels).toEqual(initialState.labels);
    expect(stateAfterOptimisticDelete.cardLabels).toEqual(initialState.cardLabels);

    // A rejection or timeout restores only the prior active card, once.
    const stateAfterRejectedDelete = session.rollback(deleteMutation.mutationId).cacheState!;
    expect(stateAfterRejectedDelete.cards).toEqual([card1]);
    expect(session.rollback(deleteMutation.mutationId).cacheState).toBe(stateAfterRejectedDelete);
    expect(stateAfterRejectedDelete.checklistItems).toEqual(initialState.checklistItems);
    expect(stateAfterRejectedDelete.attachments).toEqual(initialState.attachments);
    expect(stateAfterRejectedDelete.comments).toEqual(initialState.comments);
    expect(stateAfterRejectedDelete.activities).toEqual(initialState.activities);
    expect(stateAfterRejectedDelete.relations).toEqual(initialState.relations);
    expect(stateAfterRejectedDelete.cardLabels).toEqual(initialState.cardLabels);

    // A peer-restored active row wins over the original active row.
    const peerSession = createBoardReconciler("board-1", initialState);
    peerSession.sendOptimistic(deleteMutation);
    const peerRestoredCard = { ...card1, title: "Peer-restored title", updatedAt: 9000 };
    peerSession.applyServerMessage({ type: "cards.archived", cards: [{ ...card1, archivedAt: 9000, archivedColumnTitle: "Doomed" }] });
    peerSession.applyServerMessage({ type: "card.restore", mutationId: "peer-restore", id: card1.id, columnId: col1.id, position: card1.position });
    peerSession.applyServerMessage({ type: "card.update", mutationId: "peer-title", id: card1.id, title: peerRestoredCard.title });
    expect(peerSession.rollback(deleteMutation.mutationId).cacheState!.cards[0].title).toBe(peerRestoredCard.title);

    // Board-scoped peer changes made while the delete is pending are not undone.
    const labelSession = createBoardReconciler("board-1", initialState);
    labelSession.sendOptimistic(deleteMutation);
    labelSession.applyServerMessage({ type: "label.delete", mutationId: "mut-label-delete", id: label.id });
    const stateAfterLabelDeleteRollback = labelSession.rollback(deleteMutation.mutationId).cacheState!;
    expect(stateAfterLabelDeleteRollback.cards).toEqual([card1]);
    expect(stateAfterLabelDeleteRollback.labels).toEqual([]);
    expect(stateAfterLabelDeleteRollback.cardLabels).toEqual([]);

    // 2. Apply authoritative column.delete, then reconcile cards.archived
    const columnDeleteMsg: ClientMessage = {
      type: "column.delete",
      mutationId: "mut-col-delete-1",
      id: "col-1",
    };
    const columnSession = createBoardReconciler("board-1", initialState);
    columnSession.sendOptimistic(deleteMutation);
    columnSession.applyServerMessage(columnDeleteMsg);
    const authoritativeArchivedCard: ArchivedCard = {
      ...card1,
      archivedAt: 1234567890,
      archivedColumnTitle: "Doomed",
    };
    const stateAfterAuthoritative = columnSession.applyServerMessage({ type: "cards.archived", cards: [authoritativeArchivedCard] }).cacheState!;
    const archiveSession = createBoardReconciler("board-1", initialState);
    archiveSession.sendOptimistic(deleteMutation);
    archiveSession.applyServerMessage({ type: "cards.archived", cards: [authoritativeArchivedCard] });
    const stateAfterIndividualArchiveRollback = archiveSession.rollback(deleteMutation.mutationId).cacheState!;
    expect(stateAfterIndividualArchiveRollback.cards.some((c) => c.id === "card-1")).toBe(false);
    expect(stateAfterIndividualArchiveRollback.archivedCards).toContainEqual(authoritativeArchivedCard);

    expect(stateAfterAuthoritative.archivedCards.some((c) => c.id === "card-1")).toBe(true);
    expect(stateAfterAuthoritative.cards.some((c) => c.id === "card-1")).toBe(false);

    // 3. Run delete rollback (e.g. sender error / timeout for the optimistic card.delete)
    const stateAfterRollback = columnSession.rollback(deleteMutation.mutationId).cacheState!;

    // Observable invariant: card MUST remain in archivedCards and NEVER reappear in active cards
    expect(stateAfterRollback.cards.some((c) => c.id === "card-1")).toBe(false);
    expect(stateAfterRollback.archivedCards.some((c) => c.id === "card-1")).toBe(true);
    expect(stateAfterRollback.archivedCards.find((c) => c.id === "card-1")).toEqual(
      authoritativeArchivedCard,
    );
    expect(stateAfterRollback.columns.some((col) => col.id === "col-1")).toBe(false);
  });

  test("Scenario B: pending optimistic card restore rolled back after server archive purge leaves card and all dependents absent", () => {
    const survivingColumn: Column = { id: "col-backlog", title: "Backlog", position: "a0" };
    const otherCard: Card = {
      id: "card-other",
      columnId: "col-backlog",
      title: "Other Card",
      description: "",
      position: "a0",
      taskNumber: 2,
      assigneeId: null,
      priority: "low",
      taskType: "task",
      dueDate: null,
      subtaskDone: false,
      createdAt: 500,
      updatedAt: 500,
    };
    const archivedCard: ArchivedCard = {
      id: "card-archived",
      columnId: "col-doomed",
      title: "Archived Card",
      description: "Preserved description",
      position: "a1",
      taskNumber: 3,
      assigneeId: null,
      priority: "high",
      taskType: "bug",
      dueDate: "2026-10-01",
      subtaskDone: false,
      createdAt: 1000,
      updatedAt: 1000,
      archivedAt: 2000,
      archivedColumnTitle: "Doomed",
    };
    const checklistItem: ChecklistItem = {
      id: "chk-archived",
      cardId: "card-archived",
      text: "Archived Task",
      done: false,
      position: "a0",
    };
    const attachment: Attachment = {
      id: "att-archived",
      cardId: "card-archived",
      fileName: "archived.png",
      contentType: "image/png",
      size: 2048,
    };
    const comment: Comment = {
      id: "com-archived",
      cardId: "card-archived",
      authorId: "user-1",
      parentCommentId: null,
      deleted: false,
      body: "Archived comment",
      createdAt: 1200,
      updatedAt: 1200,
    };
    const activity: Activity = {
      id: "act-archived",
      cardId: "card-archived",
      actorId: "user-1",
      sequence: 1,
      createdAt: 1000,
      detail: { type: "card.created" },
    };
    const sourceRelation: CardRelation = {
      id: "rel-source",
      sourceCardId: "card-archived",
      targetCardId: "card-other",
      kind: "blocks",
    };
    const targetRelation: CardRelation = {
      id: "rel-target",
      sourceCardId: "card-other",
      targetCardId: "card-archived",
      kind: "relates",
    };
    const label: Label = { id: "lbl-1", name: "Feature", color: "blue" };
    const cardLabel: CardLabel = {
      id: "cl-archived",
      cardId: "card-archived",
      labelId: "lbl-1",
    };

    const initialState: BoardState = {
      columns: [survivingColumn],
      cards: [otherCard],
      archivedCards: [archivedCard],
      checklistItems: [checklistItem],
      attachments: [attachment],
      comments: [comment],
      activities: [activity],
      relations: [sourceRelation, targetRelation],
      labels: [label],
      cardLabels: [cardLabel],
    };

    const manualPurge: ClientMessage = {
      type: "card.purge",
      mutationId: "mut-purge-1",
      id: "card-archived",
    };
    expect(applyMutation(initialState, manualPurge, "board-1")).toBe(initialState);
    const purgeSession = createBoardReconciler("board-1", initialState);
    purgeSession.sendOptimistic(manualPurge);
    expect(purgeSession.rollback(manualPurge.mutationId).cacheState).toBe(initialState);

    // 1. Capture and apply optimistic card.restore
    const restoreMutation: ClientMessage = {
      type: "card.restore",
      mutationId: "mut-restore-1",
      id: "card-archived",
      columnId: "col-backlog",
      position: "a2",
    };
    const session = createBoardReconciler("board-1", initialState);
    const stateAfterOptimisticRestore = session.sendOptimistic(restoreMutation);

    expect(stateAfterOptimisticRestore.cards.some((c) => c.id === "card-archived")).toBe(true);
    expect(stateAfterOptimisticRestore.archivedCards.some((c) => c.id === "card-archived")).toBe(
      false,
    );

    // 2. Apply authoritative purgeArchivedCards (e.g. server alarm expired 90-day retention)
    const stateAfterPurge = session.applyServerMessage({ type: "archive.purged", cardIds: ["card-archived"] }).cacheState!;

    expect(stateAfterPurge.cards.some((c) => c.id === "card-archived")).toBe(false);
    expect(stateAfterPurge.archivedCards.some((c) => c.id === "card-archived")).toBe(false);
    expect(stateAfterPurge.checklistItems.some((i) => i.cardId === "card-archived")).toBe(false);
    expect(stateAfterPurge.attachments.some((a) => a.cardId === "card-archived")).toBe(false);
    expect(stateAfterPurge.comments.some((c) => c.cardId === "card-archived")).toBe(false);
    expect(stateAfterPurge.activities.some((a) => a.cardId === "card-archived")).toBe(false);
    expect(
      stateAfterPurge.relations.some(
        (r) => r.sourceCardId === "card-archived" || r.targetCardId === "card-archived",
      ),
    ).toBe(false);
    expect(stateAfterPurge.cardLabels.some((cl) => cl.cardId === "card-archived")).toBe(false);

    // 3. Run restore rollback (e.g. server refused restore because card was already purged)
    const stateAfterRollback = session.rollback(restoreMutation.mutationId).cacheState!;

    // Observable invariant: card and all specified dependent rows/relations/card-label joins remain absent
    expect(stateAfterRollback.cards.some((c) => c.id === "card-archived")).toBe(false);
    expect(stateAfterRollback.archivedCards.some((c) => c.id === "card-archived")).toBe(false);
    expect(stateAfterRollback.checklistItems.some((i) => i.cardId === "card-archived")).toBe(false);
    expect(stateAfterRollback.attachments.some((a) => a.cardId === "card-archived")).toBe(false);
    expect(stateAfterRollback.comments.some((c) => c.cardId === "card-archived")).toBe(false);
    expect(stateAfterRollback.activities.some((a) => a.cardId === "card-archived")).toBe(false);
    expect(
      stateAfterRollback.relations.some(
        (r) => r.sourceCardId === "card-archived" || r.targetCardId === "card-archived",
      ),
    ).toBe(false);
    expect(stateAfterRollback.cardLabels.some((cl) => cl.cardId === "card-archived")).toBe(false);

    // Surviving column, unrelated card, and label definitions remain intact
    expect(stateAfterRollback.columns).toEqual([survivingColumn]);
    expect(stateAfterRollback.cards).toEqual([otherCard]);
    expect(stateAfterRollback.labels).toEqual([label]);
  });
});

test.describe("column.move reducer and rollback state transitions", () => {
  test("Scenario C: optimistic column.move applies position, rollback restores prior position without overwriting peer column edits, and becomes a no-op if column was deleted", () => {
    const col1: Column = { id: "col-1", title: "Backlog", position: "a0" };
    const col2: Column = { id: "col-2", title: "Todo", position: "a1" };
    const col3: Column = { id: "col-3", title: "Done", position: "a2" };

    const initialState: BoardState = {
      columns: [col1, col2, col3],
      cards: [],
      archivedCards: [],
      checklistItems: [],
      attachments: [],
      comments: [],
      activities: [],
      relations: [],
      labels: [],
      cardLabels: [],
    };

    // 1. Move col-1 to position a3 (after col-3)
    const moveMsg: ClientMessage = {
      type: "column.move",
      mutationId: "mut-col-move-1",
      id: "col-1",
      position: "a3",
    };

    const session = createBoardReconciler("board-1", initialState);
    const stateAfterMove = session.sendOptimistic(moveMsg);

    const movedCol = stateAfterMove.columns.find((c) => c.id === "col-1");
    expect(movedCol?.position).toBe("a3");

    // 2. Peer adds a new column or renames col-2 while move is pending
    const peerColumn: Column = { id: "col-peer", title: "In Review", position: "a15" };
    session.applyServerMessage({ type: "column.create", mutationId: "peer-create", ...peerColumn });

    // Rollback restores the position while preserving the accepted new column.
    const stateAfterRollback = session.rollback(moveMsg.mutationId).cacheState!;
    const restoredCol1 = stateAfterRollback.columns.find((c) => c.id === "col-1");
    expect(restoredCol1?.position).toBe("a0");
    expect(stateAfterRollback.columns.some((c) => c.id === "col-peer")).toBe(true);
    expect(stateAfterRollback.columns.find((c) => c.id === "col-2")?.position).toBe("a1");

    // 4. If col-1 was deleted by a peer in the meantime, rollback is a no-op and does not resurrect col-1
    const deleteSession = createBoardReconciler("board-1", initialState);
    deleteSession.sendOptimistic(moveMsg);
    deleteSession.applyServerMessage({ type: "column.delete", mutationId: "peer-delete", id: "col-1" });
    const stateAfterRollbackDeleted = deleteSession.rollback(moveMsg.mutationId).cacheState!;
    expect(stateAfterRollbackDeleted.columns.some((c) => c.id === "col-1")).toBe(false);
  });
});
test.describe("card.retype reducer and rollback state transitions", () => {
  test("optimistic card.retype applies new taskType, and rollback restores prior taskType while preserving concurrent unrelated field edits", () => {
    const card: Card = {
      id: "card-retype-1",
      columnId: "col-1",
      title: "Task to retype",
      description: "Initial description",
      position: "a0",
      taskNumber: 1,
      assigneeId: null,
      priority: "medium",
      taskType: "task",
      dueDate: null,
      subtaskDone: false,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const initialState: BoardState = {
      columns: [{ id: "col-1", title: "Todo", position: "a0" }],
      cards: [card],
      archivedCards: [],
      checklistItems: [],
      attachments: [],
      comments: [],
      activities: [],
      relations: [],
      labels: [],
      cardLabels: [],
    };

    const retypeMsg: ClientMessage = {
      type: "card.retype",
      mutationId: "mut-retype-1",
      id: "card-retype-1",
      taskType: "bug",
    };

    const session = createBoardReconciler("board-1", initialState);
    const stateAfterRetype = session.sendOptimistic(retypeMsg);

    const retypedCard = stateAfterRetype.cards.find((c) => c.id === "card-retype-1");
    expect(retypedCard?.taskType).toBe("bug");
    expect(retypedCard?.updatedAt).toBeGreaterThanOrEqual(1000);

    session.applyServerMessage({ type: "card.update", mutationId: "peer-title", id: card.id, title: "Concurrently renamed title" });
    session.applyServerMessage({ type: "card.prioritize", mutationId: "peer-priority", id: card.id, priority: "highest" });
    session.applyServerMessage({ type: "card.assign", mutationId: "peer-assign", id: card.id, assigneeId: "user-bob" });
    session.applyServerMessage({ type: "card.schedule", mutationId: "peer-due", id: card.id, dueDate: "2026-12-31" });
    const stateAfterRollback = session.rollback(retypeMsg.mutationId).cacheState!;
    const restoredCard = stateAfterRollback.cards.find((c) => c.id === "card-retype-1");
    expect(restoredCard).toBeDefined();
    expect(restoredCard?.taskType).toBe("task");
    expect(restoredCard?.title).toBe("Concurrently renamed title");
    expect(restoredCard?.priority).toBe("highest");
    expect(restoredCard?.assigneeId).toBe("user-bob");
    expect(restoredCard?.dueDate).toBe("2026-12-31");
  });
});

test.describe("subtask families through archive interleavings", () => {
  const family = (): BoardState => ({
    columns: [
      { id: "col-1", title: "Todo", position: "a0" },
      { id: "col-2", title: "Doing", position: "a1" },
    ],
    cards: [
      {
        id: "parent",
        columnId: "col-2",
        title: "Parent",
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
      },
      {
        id: "child",
        columnId: "col-1",
        title: "Child",
        description: "",
        position: "a1",
        taskNumber: 2,
        assigneeId: null,
        priority: "medium",
        taskType: "task",
        dueDate: null,
        subtaskDone: true,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ],
    archivedCards: [],
    checklistItems: [],
    attachments: [],
    comments: [],
    activities: [],
    relations: [{ id: "rel-1", sourceCardId: "parent", targetCardId: "child", kind: "subtask" }],
    labels: [],
    cardLabels: [],
  });

  test("a pending parent delete rolled back after the authoritative archive never reactivates it", () => {
    const initial = family();
    const deleteMutation: ClientMessage = {
      type: "card.delete",
      mutationId: "mut-parent-delete",
      id: "parent",
    };
    const session = createBoardReconciler("board-1", initial);
    const afterOptimisticDelete = session.sendOptimistic(deleteMutation);
    expect(afterOptimisticDelete.cards.map((card) => card.id)).toEqual(["child"]);

    // Archive is per card: the frame names the parent alone.
    const archivedParent = initial.cards
      .filter((card) => card.id === "parent")
      .map((card) => ({ ...card, archivedAt: 4000, archivedColumnTitle: "Doing" }));
    session.applyServerMessage({ type: "cards.archived", cards: archivedParent });
    const rolledBack = session.rollback(deleteMutation.mutationId).cacheState!;
    expect(rolledBack.cards.map((card) => card.id)).toEqual(["child"]);
    expect(rolledBack.archivedCards.map((card) => card.id)).toEqual(["parent"]);
  });

  test("a rejected optimistic parent delete restores the parent and leaves its child alone", () => {
    const initial = family();
    const deleteMutation: ClientMessage = {
      type: "card.delete",
      mutationId: "mut-parent-delete",
      id: "parent",
    };
    const session = createBoardReconciler("board-1", initial);
    const afterOptimisticDelete = session.sendOptimistic(deleteMutation);
    expect(afterOptimisticDelete.cards.map((card) => card.id)).toEqual(["child"]);

    const rolledBack = session.rollback(deleteMutation.mutationId).cacheState!;
    expect(rolledBack.cards.map((card) => card.id)).toEqual(["parent", "child"]);
    expect(rolledBack.cards.find((card) => card.id === "child")).toMatchObject({
      columnId: "col-1",
      subtaskDone: true,
    });
  });
});
