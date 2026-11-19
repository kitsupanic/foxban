import type { BoardState } from "../src/lib/board-cache";
import type { ClientMessage, ServerMessage } from "@foxban/shared";
import { BoardReconciler, extractBoardState } from "../src/lib/reconciliation";

/** The real reconciler plus the synchronous send/receive shortcuts the specs drive it with. */
class TestReconciler extends BoardReconciler {
  sendOptimistic(msg: ClientMessage): BoardState {
    const outcome = this.enqueueOptimistic(msg);
    if (!outcome) throw new Error("Cannot send optimistic mutation before snapshot is loaded");
    return outcome.cacheState;
  }

  receiveServerMessage(msg: ServerMessage): BoardState | null {
    return this.applyServerMessage(msg).cacheState;
  }

  hasPending(mutationId: string): boolean {
    return this.pending.has(mutationId);
  }

  getPendingMutations(): readonly ClientMessage[] {
    return Array.from(this.pending.values(), (entry) => entry.msg);
  }
}

/** `(boardId, initial?)`, or `(initial, boardId?)` where the initial state is read as a snapshot. */
export function createBoardReconciler(
  boardIdOrInitial: string | BoardState,
  initialOrBoardId?: BoardState | string | null,
): TestReconciler {
  if (typeof boardIdOrInitial === "string") {
    return new TestReconciler(boardIdOrInitial, (initialOrBoardId as BoardState | null | undefined) ?? null);
  }
  const boardId = typeof initialOrBoardId === "string" ? initialOrBoardId : "board-test";
  return new TestReconciler(boardId, extractBoardState(boardIdOrInitial));
}

export { extractBoardState };
