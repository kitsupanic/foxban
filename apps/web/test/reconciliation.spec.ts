import { expect, test } from "@playwright/test";
import type {
  ArchivedCard,
  Card,
  CardLabel,
  ChecklistItem,
  ClientMessage,
  Column,
  Label,
  ServerMessage,
} from "@foxban/shared";
import type { BoardState } from "../src/lib/apply-mutation";
import { createBoardReconciler } from "../src/lib/reconciliation";

function createInitialState(): BoardState {
  const col1: Column = { id: "col-1", title: "Column 1", position: "a0" };
  const col2: Column = { id: "col-2", title: "Column 2", position: "a1" };
  const col3: Column = { id: "col-3", title: "Column 3", position: "a2" };

  const card1: Card = {
    id: "card-1",
    columnId: "col-1",
    title: "Original Title",
    description: "Original Description",
    position: "a0",
    taskNumber: 1,
    assigneeId: null,
    priority: "low",
    taskType: "task",
    dueDate: null,
    subtaskDone: false,
    createdAt: 1000,
    updatedAt: 1000,
  };

  const checklistItem: ChecklistItem = {
    id: "chk-1",
    cardId: "card-1",
    text: "Original Check",
    done: false,
    position: "a0",
  };

  const label: Label = { id: "lbl-1", name: "Bug", color: "red" };
  const cardLabel: CardLabel = { id: "cl-1", cardId: "card-1", labelId: "lbl-1" };

  return {
    columns: [col1, col2, col3],
    cards: [card1],
    archivedCards: [],
    checklistItems: [checklistItem],
    attachments: [],
    comments: [],
    relations: [],
    labels: [label],
    cardLabels: [cardLabel],
  };
}

test.describe("F3: realtime last-write-wins convergence and mutation interleaving", () => {
  test("peer-before-own interleaving converges client cache to authoritative DO order", () => {
    const session = createBoardReconciler(createInitialState(), "board-test");

    // Alice sends optimistic move to Column 2
    const aliceMove: ClientMessage = {
      type: "card.move",
      mutationId: "mut-alice-col2",
      id: "card-1",
      columnId: "col-2",
      position: "a1",
    };
    session.sendOptimistic(aliceMove);
    expect(session.getCacheState().cards[0]?.columnId).toBe("col-2");

    // DO received Bob's move to Col 3 first, then Alice's move to Col 2 second.
    // Bob's broadcast arrives at Alice before Alice's echo:
    const bobMoveServer: ServerMessage = {
      type: "card.move",
      mutationId: "mut-bob-col3",
      id: "card-1",
      columnId: "col-3",
      position: "a2",
    };
    session.receiveServerMessage(bobMoveServer);

    // With baseState + optimistic rebase, Alice's unconfirmed move to Col 2 stays active in cache
    expect(session.getCacheState().cards[0]?.columnId).toBe("col-2");
    expect(session.getBaseState().cards[0]?.columnId).toBe("col-3");

    // Alice's echo arrives from server (processed second by DO, making Col 2 final)
    session.receiveServerMessage(aliceMove as unknown as ServerMessage);

    // Final convergence: both baseState and cacheState match DO order (col-2)
    expect(session.getBaseState().cards[0]?.columnId).toBe("col-2");
    expect(session.getCacheState().cards[0]?.columnId).toBe("col-2");
  });

  test("own-before-peer interleaving converges client cache to authoritative DO order", () => {
    const session = createBoardReconciler(createInitialState(), "board-test");

    // Alice sends optimistic move to Column 2
    const aliceMove: ClientMessage = {
      type: "card.move",
      mutationId: "mut-alice-col2",
      id: "card-1",
      columnId: "col-2",
      position: "a1",
    };
    session.sendOptimistic(aliceMove);

    // DO received Alice's move first, Bob's move to Col 3 second.
    // Alice's echo arrives first:
    session.receiveServerMessage(aliceMove as unknown as ServerMessage);
    expect(session.getCacheState().cards[0]?.columnId).toBe("col-2");

    // Bob's move arrives second:
    const bobMoveServer: ServerMessage = {
      type: "card.move",
      mutationId: "mut-bob-col3",
      id: "card-1",
      columnId: "col-3",
      position: "a2",
    };
    session.receiveServerMessage(bobMoveServer);

    // Final convergence: card is in Column 3 (DO last-write-wins)
    expect(session.getBaseState().cards[0]?.columnId).toBe("col-3");
    expect(session.getCacheState().cards[0]?.columnId).toBe("col-3");
  });

  test("multiple pending mutations interleaved with peer updates converge accurately", () => {
    const session = createBoardReconciler(createInitialState(), "board-test");

    // Alice queues priority change and title change
    const mut1: ClientMessage = {
      type: "card.prioritize",
      mutationId: "mut-prio-high",
      id: "card-1",
      priority: "highest",
    };
    const mut2: ClientMessage = {
      type: "card.update",
      mutationId: "mut-title-edit",
      id: "card-1",
      title: "Alice Title",
    };

    session.sendOptimistic(mut1);
    session.sendOptimistic(mut2);

    expect(session.getCacheState().cards[0]?.priority).toBe("highest");
    expect(session.getCacheState().cards[0]?.title).toBe("Alice Title");

    // DO processed mut1, then peer mut3 (priority low), then mut2
    session.receiveServerMessage(mut1 as unknown as ServerMessage);
    const peerMut3: ServerMessage = {
      type: "card.prioritize",
      mutationId: "peer-prio-low",
      id: "card-1",
      priority: "low",
    };
    session.receiveServerMessage(peerMut3);

    // Alice still has pending mut2 for title, while priority updated to peer's low
    expect(session.getBaseState().cards[0]?.priority).toBe("low");
    expect(session.getCacheState().cards[0]?.priority).toBe("low");
    expect(session.getCacheState().cards[0]?.title).toBe("Alice Title");

    // Alice's mut2 echo arrives
    session.receiveServerMessage(mut2 as unknown as ServerMessage);

    expect(session.getBaseState().cards[0]?.priority).toBe("low");
    expect(session.getBaseState().cards[0]?.title).toBe("Alice Title");
    expect(session.getCacheState().cards[0]?.priority).toBe("low");
    expect(session.getCacheState().cards[0]?.title).toBe("Alice Title");
  });
});

test.describe("F10: partial-update rollbacks preserve unrelated accepted fields and same-field updates", () => {
  test("card.update rollback restores only modified field and preserves peer's description edit", () => {
    const session = createBoardReconciler(createInitialState(), "board-test");
    const cardId = "card-1";

    // Alice prepares title-only update (description is undefined)
    const aliceTitleMsg: ClientMessage = {
      type: "card.update",
      mutationId: "mut-alice-title",
      id: cardId,
      title: "Optimistic Title",
    };

    session.sendOptimistic(aliceTitleMsg);
    expect(session.getCacheState()?.cards[0]?.title).toBe("Optimistic Title");
    expect(session.getCacheState()?.cards[0]?.description).toBe("Original Description");

    // While pending, peer's accepted description edit arrives
    const peerDescMsg: ServerMessage = {
      type: "card.update",
      mutationId: "mut-peer-desc",
      id: cardId,
      description: "Authoritative Peer Description",
    };
    session.receiveServerMessage(peerDescMsg);
    expect(session.getCacheState()?.cards[0]?.title).toBe("Optimistic Title");
    expect(session.getCacheState()?.cards[0]?.description).toBe("Authoritative Peer Description");

    // Alice's title mutation fails / times out, so rollback runs
    const outcome = session.rollback("mut-alice-title");
    expect(outcome.removed).toBe(true);

    // Title rolls back to Original Title; Peer's description is PRESERVED
    expect(session.getCacheState()?.cards[0]?.title).toBe("Original Title");
    expect(session.getCacheState()?.cards[0]?.description).toBe("Authoritative Peer Description");
    expect(session.getBaseState()?.cards[0]?.title).toBe("Original Title");
    expect(session.getBaseState()?.cards[0]?.description).toBe("Authoritative Peer Description");
  });

  test("checklist.update rollback restores only modified field and preserves peer's done toggle", () => {
    const session = createBoardReconciler(createInitialState(), "board-test");
    const chkId = "chk-1";

    // Alice prepares text-only update (done is undefined)
    const aliceTextMsg: ClientMessage = {
      type: "checklist.update",
      mutationId: "mut-alice-text",
      id: chkId,
      text: "Optimistic Text",
    };

    session.sendOptimistic(aliceTextMsg);
    expect(session.getCacheState()?.checklistItems[0]?.text).toBe("Optimistic Text");
    expect(session.getCacheState()?.checklistItems[0]?.done).toBe(false);

    // Peer toggles done = true
    const peerDoneMsg: ServerMessage = {
      type: "checklist.update",
      mutationId: "mut-peer-done",
      id: chkId,
      done: true,
    };
    session.receiveServerMessage(peerDoneMsg);
    expect(session.getCacheState()?.checklistItems[0]?.text).toBe("Optimistic Text");
    expect(session.getCacheState()?.checklistItems[0]?.done).toBe(true);

    // Rollback Alice's text update
    const outcome = session.rollback("mut-alice-text");
    expect(outcome.removed).toBe(true);

    // Text rolls back; done = true is PRESERVED
    expect(session.getCacheState()?.checklistItems[0]?.text).toBe("Original Check");
    expect(session.getCacheState()?.checklistItems[0]?.done).toBe(true);
    expect(session.getBaseState()?.checklistItems[0]?.text).toBe("Original Check");
    expect(session.getBaseState()?.checklistItems[0]?.done).toBe(true);
  });

  test("label.update rollback restores only modified field and preserves peer's color edit", () => {
    const session = createBoardReconciler(createInitialState(), "board-test");
    const labelId = "lbl-1";

    // Alice prepares name-only update (color is undefined)
    const aliceNameMsg: ClientMessage = {
      type: "label.update",
      mutationId: "mut-alice-name",
      id: labelId,
      name: "Renamed Bug",
    };

    session.sendOptimistic(aliceNameMsg);
    expect(session.getCacheState()?.labels[0]?.name).toBe("Renamed Bug");
    expect(session.getCacheState()?.labels[0]?.color).toBe("red");

    // Peer edits color to green
    const peerColorMsg: ServerMessage = {
      type: "label.update",
      mutationId: "mut-peer-color",
      id: labelId,
      color: "green",
    };
    session.receiveServerMessage(peerColorMsg);
    expect(session.getCacheState()?.labels[0]?.name).toBe("Renamed Bug");
    expect(session.getCacheState()?.labels[0]?.color).toBe("green");

    // Rollback Alice's name update
    const outcome = session.rollback("mut-alice-name");
    expect(outcome.removed).toBe(true);

    // Name rolls back; color = green is PRESERVED
    expect(session.getCacheState()?.labels[0]?.name).toBe("Bug");
    expect(session.getCacheState()?.labels[0]?.color).toBe("green");
    expect(session.getBaseState()?.labels[0]?.name).toBe("Bug");
    expect(session.getBaseState()?.labels[0]?.color).toBe("green");
  });

  test("rollback does not overwrite a peer's newer accepted value on the same field", () => {
    const session = createBoardReconciler(createInitialState(), "board-test");
    const cardId = "card-1";

    // Alice prepares title update to "Alice V2"
    const aliceTitleMsg: ClientMessage = {
      type: "card.update",
      mutationId: "mut-alice-same-field",
      id: cardId,
      title: "Alice V2",
    };

    session.sendOptimistic(aliceTitleMsg);
    expect(session.getCacheState()?.cards[0]?.title).toBe("Alice V2");

    // Peer concurrently updates title to "Bob V3" which is accepted
    const peerTitleMsg: ServerMessage = {
      type: "card.update",
      mutationId: "mut-bob-same-field",
      id: cardId,
      title: "Bob V3",
    };
    session.receiveServerMessage(peerTitleMsg);
    // Base state is now "Bob V3", cache still has Alice's pending rebased over it ("Alice V2")
    expect(session.getBaseState()?.cards[0]?.title).toBe("Bob V3");
    expect(session.getCacheState()?.cards[0]?.title).toBe("Alice V2");

    // Alice's rejected update rolls back
    const outcome = session.rollback("mut-alice-same-field");
    expect(outcome.removed).toBe(true);

    // Since card.title is "Bob V3" (not "Alice V2"), rollback does NOT overwrite it with stale "Original Title"
    expect(session.getCacheState()?.cards[0]?.title).toBe("Bob V3");
    expect(session.getBaseState()?.cards[0]?.title).toBe("Bob V3");
  });
});

test.describe("Subtask settlement through the reconciler", () => {
  function linkedBoard(): BoardState {
    return {
      columns: [
        { id: "col-1", title: "Todo", position: "a0", starting: true, completed: false },
        { id: "col-2", title: "Doing", position: "a1", starting: false, completed: true },
      ],
      cards: [
        {
          id: "parent",
          columnId: "col-1",
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
      ],
      archivedCards: [],
      checklistItems: [
        { id: "item-1", cardId: "parent", text: "Write docs", done: false, position: "a0" },
      ],
      attachments: [],
      comments: [],
      relations: [],
      labels: [],
      cardLabels: [],
    };
  }

  const createMessage: ClientMessage = {
    type: "subtask.create",
    mutationId: "mut-create",
    id: "child",
    parentCardId: "parent",
    relationId: "rel-1",
    title: "Write docs",
    position: "a1",
    checklistItemId: "item-1",
  };

  test("a rejected creation restores the converted item and never duplicates the child", () => {
    const session = createBoardReconciler("board-1", linkedBoard());
    session.sendOptimistic(createMessage);
    const optimistic = session.getCacheState();
    expect(optimistic?.cards.map((card) => card.id)).toEqual(["parent", "child"]);
    expect(optimistic?.checklistItems).toEqual([]);

    // The server refuses it: the rollback puts the item back and removes the child.
    const outcome = session.rollback("mut-create");
    expect(outcome.removed).toBe(true);
    const rolledBack = session.getCacheState();
    expect(rolledBack?.cards.map((card) => card.id)).toEqual(["parent"]);
    expect(rolledBack?.relations).toEqual([]);
    expect(rolledBack?.checklistItems.map((item) => item.id)).toEqual(["item-1"]);

    // A deliberate retry re-uses the same ids, so replaying cannot add a second.
    session.sendOptimistic({ ...createMessage, mutationId: "mut-create-retry" });
    const retried = session.getCacheState();
    expect(retried?.cards.filter((card) => card.id === "child")).toHaveLength(1);
    expect(retried?.relations.filter((relation) => relation.id === "rel-1")).toHaveLength(1);
  });

  test("a snapshot settles the creation by the child and its link, not by later edits", () => {
    const session = createBoardReconciler("board-1", linkedBoard());
    session.sendOptimistic(createMessage);

    // The child arrived, and a peer has since renamed it: still this creation.
    const present: BoardState = {
      ...linkedBoard(),
      cards: [
        ...linkedBoard().cards,
        {
          ...linkedBoard().cards[0]!,
          id: "child",
          title: "Renamed by peer",
          position: "a1",
        },
      ],
      relations: [
        { id: "rel-1", sourceCardId: "parent", targetCardId: "child", kind: "subtask" },
      ],
      checklistItems: [],
    };
    const settled = session.applySnapshot(present);
    expect(settled.settledPending).toHaveLength(1);
    expect(settled.settledPending[0]?.presentInSnapshot).toBe(true);

    // A snapshot with the child but without its link is not permission to create
    // another: the pending creation settles absent and stays recoverable.
    const second = createBoardReconciler("board-1", linkedBoard());
    second.sendOptimistic(createMessage);
    const childOnly = second.applySnapshot({
      ...present,
      relations: [],
    });
    expect(childOnly.settledPending[0]?.presentInSnapshot).toBe(false);

    // A snapshot without the child at all settles absent the same way.
    const third = createBoardReconciler("board-1", linkedBoard());
    third.sendOptimistic(createMessage);
    const absent = third.applySnapshot(linkedBoard());
    expect(absent.settledPending[0]?.presentInSnapshot).toBe(false);
  });

  test("completion settlement keeps a peer's title edit and restores only the placement", () => {
    const session = createBoardReconciler("board-1", linkedBoard());
    const complete: ClientMessage = {
      type: "card.move",
      mutationId: "mut-complete",
      id: "child",
      columnId: "col-2",
      position: "a0",
    };
    // The child is already accepted on the board.
    session.sendOptimistic({
      type: "subtask.create",
      mutationId: "mut-seed",
      id: "child",
      parentCardId: "parent",
      relationId: "rel-1",
      title: "Write docs",
      position: "a1",
    });
    session.receiveServerMessage({
      type: "subtask.create",
      mutationId: "mut-seed",
      id: "child",
      parentCardId: "parent",
      relationId: "rel-1",
      title: "Write docs",
      position: "a1",
    });
    expect(session.hasPending("mut-seed")).toBe(false);

    session.sendOptimistic(complete);
    expect(session.getCacheState()?.cards.find((card) => card.id === "child")?.subtaskDone).toBe(
      true,
    );

    // A peer renames the child; our rejection must not touch that title.
    session.receiveServerMessage({
      type: "card.update",
      mutationId: "peer-rename",
      id: "child",
      title: "Renamed by peer",
    });
    const outcome = session.rollback("mut-complete");
    expect(outcome.removed).toBe(true);

    const child = session.getCacheState()?.cards.find((card) => card.id === "child");
    expect(child?.title).toBe("Renamed by peer");
    expect(child).toMatchObject({ subtaskDone: false, columnId: "col-1" });
  });
});

test.describe("Creation settlement through the reconciler", () => {
  function emptyBoard(): BoardState {
    return {
      columns: [{ id: "col-1", title: "Todo", position: "a0" }],
      cards: [],
      archivedCards: [],
      checklistItems: [],
      attachments: [],
      comments: [],
      relations: [],
      labels: [],
      cardLabels: [],
    };
  }

  const cardCreate: ClientMessage = {
    type: "card.create",
    mutationId: "mut-card",
    id: "card-1",
    columnId: "col-1",
    title: "Enriched",
    position: "a0",
    taskType: "epic",
    priority: "highest",
    assigneeId: "member-1",
  };

  test("an enriched creation is optimistic in one step and rolls back cleanly when rejected", () => {
    const session = createBoardReconciler("board-1", emptyBoard());
    session.sendOptimistic(cardCreate);

    // One mutation, one row: the draft's type, priority and assignee are already
    // on the optimistic card, so no follow-up edit has to land.
    const optimistic = session.getCacheState();
    expect(optimistic?.cards).toHaveLength(1);
    expect(optimistic?.cards[0]).toMatchObject({
      id: "card-1",
      columnId: "col-1",
      title: "Enriched",
      taskType: "epic",
      priority: "highest",
      assigneeId: "member-1",
      taskNumber: 0,
    });

    const outcome = session.rollback("mut-card");
    expect(outcome.removed).toBe(true);
    expect(session.getCacheState()?.cards).toEqual([]);
    expect(session.getBaseState()?.cards).toEqual([]);
  });

  test("an omitted draft field keeps the defaults every card has always been created with", () => {
    const session = createBoardReconciler("board-1", emptyBoard());
    session.sendOptimistic({
      type: "card.create",
      mutationId: "mut-plain",
      id: "card-plain",
      columnId: "col-1",
      title: "Plain",
      position: "a0",
    });
    expect(session.getCacheState()?.cards[0]).toMatchObject({
      taskType: "task",
      priority: "medium",
      assigneeId: null,
    });
  });

  test("a snapshot settles a creation by identity: a column by its id, a card even after a peer archived it", () => {
    // The column's own id is the creation's evidence.
    const columnSession = createBoardReconciler("board-1", emptyBoard());
    columnSession.sendOptimistic({
      type: "column.create",
      mutationId: "mut-col",
      id: "col-1",
      title: "Todo",
      position: "a0",
    });
    const columnSettled = columnSession.applySnapshot({
      ...emptyBoard(),
      columns: [{ id: "col-1", title: "Renamed by a peer", position: "a0" }],
    });
    expect(columnSettled.settledPending).toHaveLength(1);
    expect(columnSettled.settledPending[0]?.presentInSnapshot).toBe(true);

    // A peer archived the card before this socket reconnected: still this creation.
    const cardSession = createBoardReconciler("board-1", emptyBoard());
    cardSession.sendOptimistic(cardCreate);
    const archived: ArchivedCard = {
      ...cardSession.getCacheState()!.cards[0]!,
      archivedAt: 2000,
      archivedColumnTitle: "Todo",
    };
    const cardSettled = cardSession.applySnapshot({
      ...emptyBoard(),
      archivedCards: [archived],
    });
    expect(cardSettled.settledPending).toHaveLength(1);
    expect(cardSettled.settledPending[0]?.presentInSnapshot).toBe(true);

    // A snapshot carrying neither leaves the attempt recoverable, not duplicated.
    const absentSession = createBoardReconciler("board-1", emptyBoard());
    absentSession.sendOptimistic(cardCreate);
    const absent = absentSession.applySnapshot(emptyBoard());
    expect(absent.settledPending).toHaveLength(1);
    expect(absent.settledPending[0]?.presentInSnapshot).toBe(false);
  });
});

test.describe("positions.rebalanced through the reconciler (ADR 0076)", () => {
  const card = (id: string, position: string): Card => ({
    ...createInitialState().cards[0]!,
    id,
    columnId: "col-1",
    title: id,
    position,
  });
  const rebalanced: ServerMessage = {
    type: "positions.rebalanced",
    table: "cards",
    positions: [
      { id: "x1", position: "a0" },
      { id: "x2", position: "a1" },
      { id: "x3", position: "a2" },
    ],
  };

  test("re-keys the base and keeps every in-flight mutation pending", () => {
    const longKey = "a0VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
    const session = createBoardReconciler(
      { ...createInitialState(), cards: [card("x1", "a0"), card("x2", longKey), card("x3", "a1")] },
      "board-test",
    );
    const comment: ClientMessage = {
      type: "comment.create",
      mutationId: "mut-comment",
      id: "cmt-1",
      cardId: "x1",
      authorId: "me",
      parentCommentId: null,
      body: "still in flight",
      createdAt: 5000,
    };
    const edit: ClientMessage = { type: "card.update", mutationId: "mut-edit", id: "x2", title: "edited" };
    const move: ClientMessage = { type: "card.move", mutationId: "mut-move", id: "x3", columnId: "col-2", position: "a5" };
    for (const msg of [comment, edit, move]) session.sendOptimistic(msg);

    const outcome = session.applyServerMessage(rebalanced);

    // Nothing is settled, retired or rolled back: a rebalance is a peer change, not a reconnect snapshot.
    expect(outcome.ackedMutationIds).toEqual([]);
    expect(outcome.rolledBackMutationId).toBeUndefined();
    expect(session.getPendingMutations()).toEqual([comment, edit, move]);
    // The base carries the new keys, and the pending mutations are re-applied over them.
    expect(session.getBaseState()!.cards.map((c) => [c.id, c.position])).toEqual([["x1", "a0"], ["x2", "a1"], ["x3", "a2"]]);
    expect(session.getBaseState()!.cards.find((c) => c.id === "x2")!.title).toBe("x2");
    const cache = session.getCacheState()!;
    expect(cache.comments.map((c) => c.id)).toEqual(["cmt-1"]);
    expect(cache.cards.find((c) => c.id === "x2")!.title).toBe("edited");
    expect(cache.cards.find((c) => c.id === "x3")).toMatchObject({ columnId: "col-2", position: "a5" });

    // The own echo still settles the comment normally afterwards.
    const echo = session.applyServerMessage(comment);
    expect(echo.ackedMutationIds).toEqual(["mut-comment"]);
    expect(session.getPendingMutations()).toEqual([edit, move]);
  });

  test("re-keys columns by id and ignores ids it does not hold", () => {
    const initial = createInitialState();
    const session = createBoardReconciler(
      { ...initial, columns: initial.columns.map((c, i) => ({ ...c, position: ["a0", "a0VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV", "a1"][i]! })) },
      "board-test",
    );
    session.applyServerMessage({
      type: "positions.rebalanced",
      table: "columns",
      positions: [
        { id: "col-1", position: "a0" },
        { id: "col-2", position: "a1" },
        { id: "col-3", position: "a2" },
        { id: "gone", position: "a3" },
      ],
    });
    expect(session.getCacheState()!.columns.map((c) => [c.id, c.position])).toEqual([["col-1", "a0"], ["col-2", "a1"], ["col-3", "a2"]]);
  });
});
