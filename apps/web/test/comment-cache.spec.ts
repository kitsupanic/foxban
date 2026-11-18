import { expect, test } from "@playwright/test";
import type { ClientMessage, Comment, ServerMessage } from "@foxban/shared";
import { buildBoardIndex, cardFace, purgeArchivedCards } from "../src/lib/apply-mutation";
import { createBoardReconciler, extractBoardState } from "../src/lib/reconciliation";

// ADR 0078: the snapshot carries per-card comment counts; comments are a cache of the cards read.

const comment = (id: string, cardId: string, extra: Partial<Comment> = {}): Comment => ({
  id, cardId, authorId: "u1", parentCommentId: null, deleted: false, body: id, createdAt: 1, updatedAt: 1, ...extra,
});

function snapshot(commentCounts: Record<string, number>): Extract<ServerMessage, { type: "snapshot" }> {
  return {
    type: "snapshot", workflowRolesExplicit: false, columns: [], cards: [], archivedCards: [],
    checklistItems: [], attachments: [], commentCounts, relations: [], labels: [], cardLabels: [],
  };
}

const create = (id: string, cardId: string): ClientMessage => ({
  type: "comment.create", mutationId: `m-${id}`, id, cardId, authorId: "u1", parentCommentId: null, body: id, createdAt: 2,
});

test("comment frames keep counts right for a card whose comments were never read", () => {
  const session = createBoardReconciler("board");
  session.applySnapshot(snapshot({ a: 2 }));
  session.receiveServerMessage({ type: "comment.delete", mutationId: "d1", id: "unseen", cardId: "a" } as ServerMessage);
  expect(session.getBaseState()!.commentCounts).toEqual({ a: 1 });
  session.receiveServerMessage({ type: "comment.delete", mutationId: "d2", id: "unseen-2", cardId: "a" } as ServerMessage);
  // At zero the card drops out, as it is absent from a snapshot.
  expect(session.getBaseState()!.commentCounts).toEqual({});
  session.receiveServerMessage(create("c1", "b") as ServerMessage);
  expect(cardFace(buildBoardIndex(session.getCacheState()!), "b").commentCount).toBe(1);
});

test("a create already cached by a read still counts once, and an optimistic one counts until rolled back", () => {
  const session = createBoardReconciler("board");
  session.applySnapshot(snapshot({}));
  // The read ran after the server applied the create but before its frame arrived.
  session.installCardComments("a", [comment("c1", "a")]);
  session.receiveServerMessage(create("c1", "a") as ServerMessage);
  expect(session.getBaseState()!.comments.map((c) => c.id)).toEqual(["c1"]);
  expect(session.getBaseState()!.commentCounts).toEqual({ a: 1 });

  expect(session.sendOptimistic(create("c2", "a")).commentCounts).toEqual({ a: 2 });
  expect(session.rollback("m-c2").cacheState!.commentCounts).toEqual({ a: 1 });
});

test("a snapshot carries the read comments over, and a read replaces one card's comments without touching counts", () => {
  const session = createBoardReconciler("board");
  session.applySnapshot(snapshot({ a: 1, b: 1 }));
  session.installCardComments("a", [comment("a1", "a")]);
  session.installCardComments("b", [comment("b1", "b")]);
  // The open card's thread does not blank out on a reconnect; its next read replaces it.
  session.applySnapshot(snapshot({ a: 3, b: 1 }));
  expect(session.getBaseState()!.comments.map((c) => c.id)).toEqual(["a1", "b1"]);
  const state = session.installCardComments("a", [comment("a2", "a"), comment("a3", "a"), comment("a4", "a")])!;
  expect(state.comments.map((c) => c.id)).toEqual(["b1", "a2", "a3", "a4"]);
  expect(state.commentCounts).toEqual({ a: 3, b: 1 });
});

test("an archive purge drops the purged cards' counts with their comments", () => {
  const state = extractBoardState(snapshot({ a: 1, b: 2 }), [comment("a1", "a")]);
  const purged = purgeArchivedCards(state, ["a"]);
  expect(purged.commentCounts).toEqual({ b: 2 });
  expect(purged.comments).toEqual([]);
});
