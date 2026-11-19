import type { ClientMessage, Comment, ServerMessage } from "@foxban/shared";
import {
  applyMutation,
  applyRebalancedPositions,
  purgeArchivedCards,
  reconcileArchivedCards,
  reconcileTaskNumber,
  type BoardState,
} from "./apply-mutation";

export type PendingMutation = {
  msg: ClientMessage;
};

export type ServerMessageOutcome = {
  cacheState: BoardState | null;
  ackedMutationIds: string[];
  rolledBackMutationId?: string;
};

/**
 * A snapshot carries comment counts, not comments (ADR 0078): the comments already
 * read are `carried` over until the next read of their card replaces them, so an
 * open card's thread does not blank out on a reconnect.
 */
export function extractBoardState(
  snapshot: BoardState | (ServerMessage & { type: "snapshot" }),
  carried: Comment[] = [],
): BoardState {
  return {
    workflowRolesExplicit: snapshot.workflowRolesExplicit,
    columns: snapshot.columns,
    cards: snapshot.cards,
    archivedCards: snapshot.archivedCards,
    checklistItems: snapshot.checklistItems,
    attachments: snapshot.attachments,
    comments: "comments" in snapshot ? snapshot.comments : carried,
    commentCounts: snapshot.commentCounts,
    relations: snapshot.relations,
    labels: snapshot.labels,
    cardLabels: snapshot.cardLabels,
  };
}

/**
 * Pure state-machine primitive owning the authoritative DO base state,
 * in-flight pending optimistic mutations in send order, and derivation of
 * the client cache state via rebase.
 */
export class BoardReconciler {
  readonly boardId: string;
  private baseState: BoardState | null = null;
  private pending = new Map<string, PendingMutation>();

  constructor(
    boardIdOrInitial: string | BoardState,
    initialOrBoardId?: BoardState | string | null,
  ) {
    if (typeof boardIdOrInitial === "string") {
      this.boardId = boardIdOrInitial;
      this.baseState = (initialOrBoardId as BoardState | null | undefined) ?? null;
    } else {
      this.boardId = typeof initialOrBoardId === "string" ? initialOrBoardId : "board-test";
      this.baseState = extractBoardState(boardIdOrInitial);
    }
  }

  /**
   * Reset authoritative base state to snapshot and clear all pending optimistic mutations.
   * Derives and returns the new cache state (equivalent to the snapshot).
   */
  applySnapshot(snapshot: BoardState | (ServerMessage & { type: "snapshot" })): {
    cacheState: BoardState;
    settledPending: Array<{ entry: PendingMutation; presentInSnapshot: boolean }>;
  } {
    const state = extractBoardState(snapshot, this.baseState?.comments);
    const settledPending: Array<{ entry: PendingMutation; presentInSnapshot: boolean }> = [];
    for (const entry of this.pending.values()) {
      const present = isMutationPresentInBoardState(state, entry.msg);
      settledPending.push({ entry, presentInSnapshot: present });
    }
    this.pending.clear();
    this.baseState = state;
    return { cacheState: this.baseState, settledPending };
  }

  /**
   * Replaces one card's cached comments with a fresh read (ADR 0078) and returns the
   * cache state; counts are untouched, they come from the snapshot and frames only.
   */
  installCardComments(cardId: string, comments: readonly Comment[]): BoardState | null {
    if (!this.baseState) return null;
    this.baseState = {
      ...this.baseState,
      comments: [...this.baseState.comments.filter((comment) => comment.cardId !== cardId), ...comments],
    };
    return this.getCacheState();
  }

  /**
   * Optimistically enqueues a client mutation.
   * Derives and returns the updated cache state with the mutation applied.
   * Returns null if base state has not been initialized by a snapshot.
   */
  enqueueOptimistic(msg: ClientMessage): { cacheState: BoardState } | null {
    if (!this.baseState) return null;
    this.pending.set(msg.mutationId, { msg });
    const cacheState = this.getCacheState()!;
    return { cacheState };
  }

  /**
   * Parity method with ClientSession for tests.
   */
  sendOptimistic(msg: ClientMessage): BoardState {
    const outcome = this.enqueueOptimistic(msg);
    if (!outcome) {
      throw new Error("Cannot send optimistic mutation before snapshot is loaded");
    }
    return outcome.cacheState;
  }

  /**
   * Applies any server-sent message (own echo, peer broadcast, error rejection,
   * activity, archived cards, purge, numbering) to the authoritative base state
   * and rebases remaining pending mutations over it.
   */
  applyServerMessage(msg: ServerMessage): ServerMessageOutcome {
    if (msg.type === "error") {
      let rolledBackMutationId: string | undefined;
      if (msg.mutationId && this.pending.has(msg.mutationId)) {
        this.pending.delete(msg.mutationId);
        rolledBackMutationId = msg.mutationId;
      }
      return {
        cacheState: this.getCacheState(),
        ackedMutationIds: [],
        rolledBackMutationId,
      };
    }

    if (msg.type === "cards.archived") {
      if (this.baseState) {
        this.baseState = reconcileArchivedCards(this.baseState, msg.cards);
      }
      return {
        cacheState: this.getCacheState(),
        ackedMutationIds: [],
      };
    }

    if (msg.type === "archive.purged") {
      if (this.baseState) {
        this.baseState = purgeArchivedCards(this.baseState, msg.cardIds);
      }
      return {
        cacheState: this.getCacheState(),
        ackedMutationIds: [],
      };
    }

    if (msg.type === "card.numbered") {
      if (this.baseState) {
        this.baseState = reconcileTaskNumber(this.baseState, msg.id, msg.taskNumber);
      }
      return {
        cacheState: this.getCacheState(),
        ackedMutationIds: [],
      };
    }

    if (msg.type === "positions.rebalanced") {
      // A peer change, not a snapshot: re-key the base and rebase what is still pending over it (ADR 0076).
      if (this.baseState) {
        this.baseState = applyRebalancedPositions(this.baseState, msg.table, msg.positions);
      }
      return {
        cacheState: this.getCacheState(),
        ackedMutationIds: [],
      };
    }

    if (msg.type === "github.invalidated" || msg.type === "activity.recorded") {
      // Not a mutation: it changes no board entity. The socket runtime answers a
      // github hint with authoritative reads and merges recorded activity into the
      // card's own cache (ADR 0073).
      return {
        cacheState: this.getCacheState(),
        ackedMutationIds: [],
      };
    }

    // Mutation broadcast: could be an own echo or a peer broadcast
    const ackedMutationIds: string[] = [];

    // Attachment deletion: peer broadcast resolves pending delete only for peer
    if (msg.type === "attachment.delete") {
      const deleteMsg = msg;
      const isPeer = !this.pending.has(deleteMsg.mutationId);
      if (isPeer) {
        for (const [pendingId, entry] of this.pending) {
          if (entry.msg.type === "attachment.delete" && entry.msg.id === deleteMsg.id) {
            this.pending.delete(pendingId);
            ackedMutationIds.push(pendingId);
          }
        }
      }
    }

    if ("mutationId" in msg && msg.mutationId && this.pending.has(msg.mutationId)) {
      this.pending.delete(msg.mutationId);
      if (!ackedMutationIds.includes(msg.mutationId)) {
        ackedMutationIds.push(msg.mutationId);
      }
    }

    if (this.baseState) {
      this.baseState = applyMutation(this.baseState, msg as ClientMessage, this.boardId);
    }

    return {
      cacheState: this.getCacheState(),
      ackedMutationIds,
    };
  }

  /**
   * Parity method with ClientSession for tests.
   */
  receiveServerMessage(msg: ServerMessage): BoardState | null {
    return this.applyServerMessage(msg).cacheState;
  }

  /**
   * Rolls back a pending optimistic mutation (e.g. on timeout or rejection).
   * Recomputes cache state by rebasing remaining pending mutations on authoritative base.
   */
  rollback(mutationId: string): {
    cacheState: BoardState | null;
    removed: boolean;
    entry?: PendingMutation;
  } {
    const entry = this.pending.get(mutationId);
    if (!entry) {
      return { cacheState: this.getCacheState(), removed: false };
    }
    this.pending.delete(mutationId);
    return {
      cacheState: this.getCacheState(),
      removed: true,
      entry,
    };
  }

  /**
   * Discards all pending optimistic mutations without rollback (e.g. on socket close / reconnect).
   * Returns the PendingMutation entries so the caller can clear associated timers and notify subscribers.
   */
  clearPending(): PendingMutation[] {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    return entries;
  }

  /**
   * Derives current cache state: authoritative base state with all unacknowledged
   * optimistic mutations rebased in send order.
   */
  getCacheState(): BoardState | null {
    if (!this.baseState) return null;
    let next = this.baseState;
    for (const entry of this.pending.values()) {
      next = applyMutation(next, entry.msg, this.boardId);
    }
    return next;
  }

  /**
   * Returns authoritative DO base state.
   */
  getBaseState(): BoardState | null {
    return this.baseState;
  }

  hasPending(mutationId: string): boolean {
    return this.pending.has(mutationId);
  }

  getPendingMutations(): readonly ClientMessage[] {
    return Array.from(this.pending.values(), (entry) => entry.msg);
  }
}
export function isMutationPresentInBoardState(state: BoardState, msg: ClientMessage): boolean {
  switch (msg.type) {
    case "card.finish": return [{ id: msg.id, position: msg.position }, ...msg.children].every(move => state.cards.some(card => card.id === move.id && card.columnId === msg.columnId && card.position === move.position));
    case "workflow.configure": return state.workflowRolesExplicit === true && state.columns.some(c => c.id === msg.startingColumnId && c.starting) && state.columns.some(c => c.id === msg.completedColumnId && c.completed);
    case "comment.create":
      return state.comments.some((c) => c.id === msg.id);
    case "comment.update":
      return state.comments.some((c) => c.id === msg.id && c.body === msg.body);
    case "comment.delete":
      return !state.comments.some((c) => c.id === msg.id && !c.deleted);
    case "card.create":
      // Identity, like subtask creation: the row itself — active or archived —
      // is this creation's evidence. A peer's later edit or archive of it does
      // not justify duplicating a card the server did create.
      return (
        state.cards.some((card) => card.id === msg.id) ||
        state.archivedCards.some((card) => card.id === msg.id)
      );
    case "column.create":
      return state.columns.some((column) => column.id === msg.id);
    case "subtask.create":
      // The child — active or archived — carrying the requested parent link is
      // the creation's evidence. A later title or completion edit is still the
      // same creation; a child whose link changed is not evidence for a second
      // one, so the caller keeps its recovery rather than replaying blindly.
      return (
        (state.cards.some((c) => c.id === msg.id) ||
          state.archivedCards.some((c) => c.id === msg.id)) &&
        state.relations.some(
          (relation) =>
            relation.id === msg.relationId &&
            relation.kind === "subtask" &&
            relation.sourceCardId === msg.parentCardId &&
            relation.targetCardId === msg.id,
        )
      );
    case "card.update": {
      const card = state.cards.find((c) => c.id === msg.id);
      if (!card) return false;
      if (msg.title !== undefined && card.title !== msg.title) return false;
      if (msg.description !== undefined && card.description !== msg.description) return false;
      return true;
    }
    case "card.delete":
      return !state.cards.some((c) => c.id === msg.id);
    case "checklist.create":
      return state.checklistItems.some((item) => item.id === msg.id);
    case "checklist.update": {
      const item = state.checklistItems.find((i) => i.id === msg.id);
      if (!item) return false;
      if (msg.text !== undefined && item.text !== msg.text) return false;
      if (msg.done !== undefined && item.done !== msg.done) return false;
      return true;
    }
    case "checklist.delete":
      return !state.checklistItems.some((item) => item.id === msg.id);
    case "attachment.create":
      return state.attachments.some((a) => a.id === msg.id);
    case "attachment.delete":
      return !state.attachments.some((a) => a.id === msg.id);
    case "label.assign":
      return state.cardLabels.some((cl) => cl.id === msg.id);
    case "label.unassign":
      return !state.cardLabels.some((cl) => cl.id === msg.id);
    default:
      return false;
  }
}


export function createBoardReconciler(
  boardIdOrInitial: string | BoardState,
  initialOrBoardId?: BoardState | string | null,
): BoardReconciler {
  return new BoardReconciler(boardIdOrInitial, initialOrBoardId);
}
