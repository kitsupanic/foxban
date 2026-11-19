import { createBoardReconciler } from "./reconciler-helpers";
import { expect, test } from "@playwright/test";
import type { ArchivedCard, Attachment, Card, ClientMessage } from "@foxban/shared";
import {
  applyMutation,
  type BoardState,
} from "../src/lib/apply-mutation";

const boardId = "board-1";
const attachmentUrl = `/boards/${boardId}/attachments/att-1`;
const originalDescription = `Before **keep**\n\n![remove](${attachmentUrl})\n\n[download](${attachmentUrl})\n\n![keep](/boards/${boardId}/attachments/att-2)\n\nAfter`;
const cleanedDescription = `Before **keep**\n\n\n\ndownload\n\n![keep](/boards/${boardId}/attachments/att-2)\n\nAfter`;
const deleteMutation: ClientMessage = {
  type: "attachment.delete",
  mutationId: "delete-att-1",
  id: "att-1",
};

function initialState(description = originalDescription): BoardState {
  const owner: Card = {
    id: "card-1",
    columnId: "col-1",
    title: "Attachment owner",
    description,
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
  const attachment: Attachment = {
    id: "att-1",
    cardId: owner.id,
    fileName: "remove.png",
    contentType: "image/png",
    size: 100,
  };
  return {
    columns: [{ id: "col-1", title: "Tasks", position: "a0" }],
    cards: [
      owner,
      { ...owner, id: "card-2", title: "Other card", position: "a1", description: originalDescription },
    ],
    archivedCards: [
      {
        ...owner,
        id: "card-3",
        title: "Archived card",
        description: originalDescription,
        archivedAt: 2000,
        archivedColumnTitle: "Old tasks",
      },
    ],
    attachments: [attachment, { ...attachment, id: "att-2", fileName: "keep.png" }],
    comments: [
      {
        id: "comment-1",
        cardId: owner.id,
        authorId: "user-1",
        parentCommentId: null,
        deleted: false,
        body: originalDescription,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ],
    commentCounts: { [owner.id]: 1 },
    checklistItems: [],
    relations: [],
    labels: [],
    cardLabels: [],
  };
}

test.describe("attachment deletion reducer and rollback state transitions", () => {
  test("deletion cleans only the active owner's description and preserves unrelated content", () => {
    const state = initialState();
    const deleted = applyMutation(state, deleteMutation, boardId);

    expect(deleted.cards[0]).toEqual({
      ...state.cards[0],
      description: cleanedDescription,
      updatedAt: expect.any(Number),
    });
    expect(deleted.cards[0].updatedAt).toBeGreaterThan(state.cards[0].updatedAt);
    expect(deleted.attachments).toEqual([state.attachments[1]]);
    expect(deleted.cards[1]).toEqual(state.cards[1]);
    expect(deleted.archivedCards).toEqual(state.archivedCards);
    expect(deleted.comments).toEqual(state.comments);
  });

  test("a missing attachment is a no-op even when its URL is in descriptions", () => {
    const state = initialState();
    state.attachments = [state.attachments[1]];

    expect(applyMutation(state, deleteMutation, boardId)).toEqual(state);
    const session = createBoardReconciler(boardId, state);
    session.sendOptimistic(deleteMutation);
    expect(session.rollback(deleteMutation.mutationId).cacheState).toEqual(state);
  });

  test("deletion without an owner reference preserves the owner's timestamp", () => {
    const state = initialState("Unrelated **prose**\n");
    const deleted = applyMutation(state, deleteMutation, boardId);

    expect(deleted.cards).toEqual(state.cards);
    expect(deleted.attachments).toEqual([state.attachments[1]]);
  });

  test("deletion never rewrites an archived owner's description", () => {
    const state = initialState();
    state.attachments[0] = { ...state.attachments[0], cardId: "card-3" };
    const deleted = applyMutation(state, deleteMutation, boardId);

    expect(deleted.archivedCards).toEqual(state.archivedCards);
    expect(deleted.cards).toEqual(state.cards);
    expect(deleted.attachments).toEqual([state.attachments[1]]);
  });

  test("rollback restores description and metadata once while preserving accepted peer fields", () => {
    const state = initialState();
    const session = createBoardReconciler(boardId, state);
    session.sendOptimistic(deleteMutation);
    session.applyServerMessage({ type: "card.update", mutationId: "peer-title", id: "card-1", title: "Peer's new title" });
    session.applyServerMessage({ type: "card.assign", mutationId: "peer-assignee", id: "card-1", assigneeId: "user-2" });
    session.applyServerMessage({ type: "card.prioritize", mutationId: "peer-priority", id: "card-1", priority: "high" });
    session.applyServerMessage({ type: "card.schedule", mutationId: "peer-due", id: "card-1", dueDate: "2026-10-01" });
    session.applyServerMessage({ type: "card.move", mutationId: "peer-move", id: "card-1", columnId: "col-1", position: "a2" });
    const authoritative = session.getBaseState()!;
    const restored = session.rollback(deleteMutation.mutationId).cacheState!;

    expect(restored.cards[0]).toEqual(authoritative.cards[0]);
    expect(restored.cards[0]).toMatchObject({ title: "Peer's new title", assigneeId: "user-2", priority: "high", dueDate: "2026-10-01", position: "a2", description: originalDescription });
    expect(restored.attachments).toEqual(state.attachments);
    expect(restored.cards[1]).toEqual(state.cards[1]);
    expect(restored.comments).toEqual(state.comments);
    expect(session.rollback(deleteMutation.mutationId)).toMatchObject({ removed: false, cacheState: restored });
  });

  test("rollback preserves a newer accepted description instead of restoring stale text", () => {
    const state = initialState();
    const session = createBoardReconciler(boardId, state);
    session.sendOptimistic(deleteMutation);
    const description = `${cleanedDescription}\n\nA newer edit`;
    session.applyServerMessage({ type: "card.update", mutationId: "peer-edit", id: "card-1", description });
    const newerOwner = session.getBaseState()!.cards[0];
    const restored = session.rollback(deleteMutation.mutationId).cacheState!;

    expect(restored.cards[0]).toEqual(newerOwner);
    expect(restored.cards[0].description).toBe(description);
    expect(restored.attachments.filter((attachment) => attachment.id === "att-1")).toEqual([state.attachments[0]]);
  });

  test("snapshot settlement preserves authoritative attachment metadata", () => {
    const state = initialState();
    const session = createBoardReconciler(boardId, state);
    session.sendOptimistic(deleteMutation);
    const authoritativeAttachment = { ...state.attachments[0], fileName: "renamed.png", size: 250 };
    session.applySnapshot({ ...state, attachments: [authoritativeAttachment, state.attachments[1]] });
    const outcome = session.rollback(deleteMutation.mutationId);

    expect(outcome.removed).toBe(false);
    expect(outcome.cacheState!.attachments.filter((attachment) => attachment.id === "att-1")).toEqual([authoritativeAttachment]);
    expect(outcome.cacheState!.cards[0].description).toBe(originalDescription);
  });

  test("rollback after owner purge never resurrects the owner or its attachment", () => {
    const state = initialState();
    const session = createBoardReconciler(boardId, state);
    session.sendOptimistic(deleteMutation);
    const authoritativeOwner: ArchivedCard = { ...state.cards[0], archivedAt: 9000, archivedColumnTitle: "Tasks" };
    session.applyServerMessage({ type: "cards.archived", cards: [authoritativeOwner] });
    session.applyServerMessage({ type: "archive.purged", cardIds: ["card-1"] });
    const ownerPurged = session.getCacheState()!;
    const restored = session.rollback(deleteMutation.mutationId).cacheState!;

    expect(restored).toEqual(ownerPurged);
    expect(restored.cards.some((card) => card.id === "card-1")).toBe(false);
    expect(restored.archivedCards.some((card) => card.id === "card-1")).toBe(false);
    expect(restored.attachments.some((attachment) => attachment.cardId === "card-1")).toBe(false);
  });

  test("rollback after archival restores metadata without rewriting the authoritative archive", () => {
    const state = initialState();
    const session = createBoardReconciler(boardId, state);
    session.sendOptimistic(deleteMutation);
    const authoritativeOwner: ArchivedCard = { ...state.cards[0], title: "Authoritative archived title", description: cleanedDescription, updatedAt: 9000, archivedAt: 9000, archivedColumnTitle: "Tasks" };
    session.applyServerMessage({ type: "cards.archived", cards: [authoritativeOwner] });
    const restored = session.rollback(deleteMutation.mutationId).cacheState!;

    expect(restored.cards.some((card) => card.id === "card-1")).toBe(false);
    expect(restored.archivedCards.find((card) => card.id === "card-1")).toEqual(authoritativeOwner);
    expect(restored.attachments.filter((attachment) => attachment.id === "att-1")).toEqual([state.attachments[0]]);
    expect(session.rollback(deleteMutation.mutationId)).toMatchObject({ removed: false, cacheState: restored });
  });
});
