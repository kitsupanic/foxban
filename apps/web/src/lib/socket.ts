import { useCallback, useEffect, useRef, useState } from "react";
import { isCancelledError, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  REALTIME_PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type Comment,
  type ServerMessage,
} from "@foxban/shared";
import { api } from "./api";
import { requestAppUpdateCheck } from "./app-update";
import { boardQueryKey, clearBoardAccessCaches } from "./board-cache";
import { invalidateCardActivity, recordActivities } from "./activity";
import { invalidateDevelopmentQueries } from "./card-development";
import {
  BOARD_AUTHORED_RESYNC_CLOSE,
  planBoardReconnect,
  STABLE_CONNECTION_MS,
  type AccessProbe,
} from "./access-attempt";
import type { BoardState } from "./apply-mutation";
import {
  BoardReconciler,
  createBoardReconciler,
  extractBoardState,
  isMutationPresentInBoardState,
  type PendingMutation,
  type ServerMessageOutcome,
} from "./reconciliation";

export {
  BoardReconciler,
  createBoardReconciler,
  extractBoardState,
  isMutationPresentInBoardState,
  type PendingMutation,
  type ServerMessageOutcome,
};

/** An optimistic mutation is rolled back if neither its echo nor an error arrives in time. */
const PENDING_TIMEOUT_MS = 5_000;

/** Returns false when the mutation was dropped (no open socket, or no snapshot yet). */
export type SendMutation = (msg: ClientMessage) => boolean;

/**
 * Board state, or undefined until the first snapshot lands. There is no REST
 * load: the query cache is written exclusively by `useBoardSocket`, so the
 * query itself is permanently disabled and never fetches.
 */
export function useBoardState(boardId: string): BoardState | undefined {
  const { data } = useQuery({
    queryKey: boardQueryKey(boardId),
    queryFn: (): Promise<BoardState> =>
      Promise.reject(new Error("board state arrives over the WebSocket snapshot")),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}

/**
 * Board events for a domain module that tracks more than the cache (the attachment
 * lifecycle). Each is called where the socket itself acts on the same fact.
 */
export type BoardEventObserver = {
  /** A snapshot is about to replace the base; it supersedes all earlier evidence. */
  snapshot?(msg: Extract<ServerMessage, { type: "snapshot" }>): void;
  /** An accepted broadcast, before the reconciler applies it. `own`: an echo of a mutation this client sent. */
  message?(msg: ServerMessage, own: boolean): void;
  /** An optimistic mutation went out; the cache before and after it. */
  sent?(msg: ClientMessage, before: BoardState, after: BoardState): void;
  /** An own pending mutation left the pending set: acked, rejected, timed out or rolled back. A transport close is not one. */
  resolved?(mutationId: string): void;
  /** The socket stopped reconnecting (access denied, or the reconnect budget ran out); nothing settles until a manual retry. */
  halted?(): void;
};

type CommentMessage = Extract<ClientMessage, { type: "comment.create" | "comment.update" | "comment.delete" }>;
const isCommentMessage = (msg: ClientMessage | ServerMessage): msg is CommentMessage =>
  msg.type === "comment.create" || msg.type === "comment.update" || msg.type === "comment.delete";

export type MutationSettledStatus = "accepted" | "rejected" | "timeout" | "uncertain" | "verified-retry";
export type MutationSettledCallback = (outcome: {
  mutationId: string;
  status: MutationSettledStatus;
  error?: string;
}) => void;

/**
 * Owns the single WebSocket for `boardId`. Inbound snapshots initialize or reset
 * the authoritative base state and populate the query cache. Accepted mutation
 * broadcasts (both peer mutations and own accepted echoes) apply in server order
 * to the authoritative base state; own echoes retire their rollback timer and
 * pending entry. Remaining pending optimistic mutations are then rebased in send
 * order on top of the updated authoritative base state to keep the cache convergent.
 */
export function useBoardSocket(
  boardId: string,
  handlers: {
    /**
     * What the route's authoritative metadata read reports: a pending access
     * change is retried as a transition, never charged to the transport budget.
     */
    accessChangePending?: boolean;
    /** `dataUpdatedAt` of that read, so a stale success cannot claim the board is ready. */
    accessCheckedAt?: number;
    /** Read through a ref, so a new observer never restarts the connection. */
    events?: BoardEventObserver;
  } = {},
): {
  connected: boolean;
  accessState: "ready" | "transitioning" | "denied";
  handshakeFailed: boolean;
  retry: () => void;
  sendMutation: SendMutation;
  subscribeMutation: (mutationId: string, callback: MutationSettledCallback) => () => void;
  retireTrackedMutation: (mutationId: string) => void;
  cardCommentsQuery: (cardId: string) => {
    queryKey: readonly unknown[];
    queryFn: (context: { signal: AbortSignal }) => Promise<true>;
  };
} {
  const queryClient = useQueryClient();
  const accessProbeRef = useRef({ pending: false, checkedAt: 0 });
  accessProbeRef.current = {
    pending: handlers.accessChangePending ?? false,
    checkedAt: handlers.accessCheckedAt ?? 0,
  };
  const eventsRef = useRef(handlers.events);
  eventsRef.current = handlers.events;
  const [connected, setConnected] = useState(false);
  const [handshakeFailed, setHandshakeFailed] = useState(false);
  const [accessState, setAccessState] = useState<"ready" | "transitioning" | "denied">("transitioning");
  // Bumped by `retry()` to tear the connect loop down and start it over.
  const [attemptEpoch, setAttemptEpoch] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconcilerRef = useRef(new BoardReconciler(boardId));
  const pendingTimersRef = useRef(new Map<string, number>());
  const mutationSubscribersRef = useRef(new Map<string, Set<MutationSettledCallback>>());
  const pendingSentMutationsRef = useRef(new Map<string, ClientMessage>());
  // Bumped by every comment frame for a card and by every snapshot: a comment read that saw either land mid-flight is retried.
  const commentReadsRef = useRef({ snapshots: 0, byCard: new Map<string, number>() });

  /**
   * One card's comments (ADR 0078): the snapshot has only counts, so the open card
   * reads them and installs them into the reconciler's base. The query's data is
   * just "loaded"; the comments themselves live in the board state like any entity.
   */
  const cardCommentsQuery = useCallback(
    (cardId: string) => ({
      queryKey: ["card-comments", boardId, cardId] as const,
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<true> => {
        const reads = commentReadsRef.current;
        const generation = () => `${reads.snapshots}:${reads.byCard.get(cardId) ?? 0}`;
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = generation();
          const response = await api.boards[":id"].cards[":cardId"].comments.$get({ param: { id: boardId, cardId } }, { init: { signal } });
          if (!response.ok) throw new Error("Could not load the card's comments.");
          const { comments } = (await response.json()) as { comments: Comment[] };
          // A frame or snapshot that landed mid-read may or may not be in it: read again.
          if (generation() !== before) continue;
          const cacheState = reconcilerRef.current.installCardComments(cardId, comments);
          if (!cacheState) throw new Error("The board is not loaded yet.");
          queryClient.setQueryData<BoardState>(boardQueryKey(boardId), cacheState);
          return true;
        }
        throw new Error("The card's comments kept changing while loading.");
      },
    }),
    [boardId, queryClient],
  );

  const subscribeMutation = useCallback((mutationId: string, callback: MutationSettledCallback) => {
    let subs = mutationSubscribersRef.current.get(mutationId);
    if (!subs) {
      subs = new Set();
      mutationSubscribersRef.current.set(mutationId, subs);
    }
    subs.add(callback);
    return () => {
      subs.delete(callback);
      if (subs.size === 0) mutationSubscribersRef.current.delete(mutationId);
    };
  }, []);

  const retireTrackedMutation = useCallback((mutationId: string) => {
    pendingSentMutationsRef.current.delete(mutationId);
    mutationSubscribersRef.current.delete(mutationId);
  }, []);
  const notifyMutation = useCallback(
    (mutationId: string, status: MutationSettledStatus, error?: string) => {
      if (status !== "uncertain" && status !== "timeout" && status !== "verified-retry") {
        pendingSentMutationsRef.current.delete(mutationId);
      }
      const subs = mutationSubscribersRef.current.get(mutationId);
      // Nobody can retry an unsubscribed instant mutation, and a late echo still applies as a peer frame.
      if (!subs && status === "timeout") pendingSentMutationsRef.current.delete(mutationId);
      if (!subs) return;
      if (status !== "uncertain" && status !== "timeout" && status !== "verified-retry") {
        mutationSubscribersRef.current.delete(mutationId);
      }
      for (const sub of Array.from(subs)) {
        sub({ mutationId, status, error });
      }
    },
    [],
  );

  useEffect(() => {
    return () => {
      for (const timer of pendingTimersRef.current.values()) clearTimeout(timer);
      pendingTimersRef.current.clear();
    };
  }, [boardId]);

  const rollback = useCallback(
    (mutationId: string, reason: "timeout" | "rejected" = "timeout", error?: string) => {
      eventsRef.current?.resolved?.(mutationId);
      const timer = pendingTimersRef.current.get(mutationId);
      if (timer !== undefined) {
        clearTimeout(timer);
        pendingTimersRef.current.delete(mutationId);
      }
      const outcome = reconcilerRef.current.rollback(mutationId);
      if (outcome.removed && outcome.cacheState) {
        queryClient.setQueryData<BoardState>(boardQueryKey(boardId), outcome.cacheState);
      }
      notifyMutation(mutationId, reason, error);

      // On live-socket timeout of an authored operation requiring authoritative settlement verification,
      // initiate resync by closing the transport so the subsequent reconnect snapshot resolves it.
      // Unsubscribed instant mutations keep the socket open; subscribed ones, attachment uploads included, close it on purpose (ADR 0069).
      if (reason === "timeout" && mutationSubscribersRef.current.has(mutationId)) {
        const ws = socketRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close(BOARD_AUTHORED_RESYNC_CLOSE, "authored operation timeout resync");
        }
      }
    },
    [boardId, queryClient, notifyMutation],
  );
  const retry = useCallback(() => {
    setHandshakeFailed(false);
    setAttemptEpoch((epoch) => epoch + 1);
  }, []);
  useEffect(() => {
    let unmounted = false;
    let attempt = 0;
    let consecutiveFailures = 0;
    // True once the failure budget ran out (not on a denial): only a manual or network-return retry restarts.
    let stopped = false;
    // Set by the server's 4010 and cleared by a snapshot or a fresh metadata read.
    let inTransition = false;
    let transitionStartedAt = 0;
    let retryTimer: number | undefined;
    let stableTimer: number | undefined;
    setHandshakeFailed(false);
    /**
     * A reconnect snapshot replaces the authoritative base; discard its old
     * pending mutations instead of rebasing them onto the new snapshot.
     */
    const discardPending = () => {
      for (const timer of pendingTimersRef.current.values()) clearTimeout(timer);
      pendingTimersRef.current.clear();
      const clearedEntries = reconcilerRef.current.clearPending();
      for (const entry of clearedEntries) {
        notifyMutation(entry.msg.mutationId, "uncertain");
      }
    };

    /**
     * The snapshot carries no comments (ADR 0078), so a comment write left uncertain is
     * settled by a fresh read of its card. An unreadable card leaves it unverified, and
     * the user decides whether to retry.
     */
    const verifyComment = async (mutationId: string, msg: CommentMessage) => {
      let present = false;
      try {
        // A transient failure must not settle it: "not verified" invites a resend the server then refuses as a duplicate.
        await queryClient.fetchQuery({ ...cardCommentsQuery(msg.cardId), staleTime: 0, retry: 2 });
        const base = reconcilerRef.current.getBaseState();
        present = base !== null && isMutationPresentInBoardState(base, msg);
      } catch (error) {
        // Cancelled by a later snapshot (which verifies it again) or an access loss: stay uncertain.
        if (isCancelledError(error)) return;
        present = false;
      }
      // Settled meanwhile: retired, or answered by a later snapshot's read.
      if (unmounted || !pendingSentMutationsRef.current.has(mutationId)) return;
      notifyMutation(mutationId, present ? "accepted" : "verified-retry");
    };

    const handleMessage = (ws: WebSocket, raw: string) => {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        console.warn("board socket: unparseable frame");
        ws.close();
        return;
      }
      const parsed = ServerMessageSchema.safeParse(json);
      if (!parsed.success) {
        if (isTaggedMessage(json)) {
          const issuePaths = parsed.error.issues.map((i) => i.path.join(".")).filter(Boolean);
          console.warn("board socket: unsupported message, resyncing", {
            type: json.type,
            issues: issuePaths,
          });
          ws.close();
          return;
        }
        console.warn("board socket: unknown message");
        return;
      }
      const msg = parsed.data;
      if (msg.type === "github.invalidated") {
        // A development-info hint, not data: mark the caches stale and let the
        // next authoritative read install the truth.
        invalidateDevelopmentQueries(queryClient, boardId);
      }
      if (msg.type === "activity.recorded") recordActivities(queryClient, boardId, msg.activities);
      if (isCommentMessage(msg)) {
        const { byCard } = commentReadsRef.current;
        byCard.set(msg.cardId, (byCard.get(msg.cardId) ?? 0) + 1);
      }
      if (msg.type === "snapshot") {
        setAccessState("ready");
        inTransition = false;
        // A reconnect snapshot is the missed-event backstop: whatever changed
        // while this socket was down arrives here as a fresh read, not a replay.
        invalidateDevelopmentQueries(queryClient, boardId);
        invalidateCardActivity(queryClient, boardId);
        commentReadsRef.current.snapshots += 1;
        void queryClient.invalidateQueries({ queryKey: ["card-comments", boardId] });
        void queryClient.invalidateQueries({ queryKey: ["board-meta-by-key"] });
        clearTimeout(stableTimer);
        stableTimer = window.setTimeout(() => {
          attempt = 0;
          consecutiveFailures = 0;
        }, STABLE_CONNECTION_MS);
        for (const timer of pendingTimersRef.current.values()) clearTimeout(timer);
        pendingTimersRef.current.clear();
        eventsRef.current?.snapshot?.(msg);
        const { cacheState: snapshotState, settledPending } = reconcilerRef.current.applySnapshot(msg);
        queryClient.setQueryData<BoardState>(boardQueryKey(boardId), snapshotState);
        for (const { entry, presentInSnapshot } of settledPending) {
          // A subscribed comment write is also tracked as sent: it is verified below, against its card's read.
          if (isCommentMessage(entry.msg) && mutationSubscribersRef.current.has(entry.msg.mutationId)) continue;
          if (presentInSnapshot) {
            notifyMutation(entry.msg.mutationId, "accepted");
          } else {
            notifyMutation(entry.msg.mutationId, "verified-retry");
          }
        }
        // Check any remaining tracked mutations from disconnects/timeouts
        for (const [mutationId, sentMsg] of Array.from(pendingSentMutationsRef.current.entries())) {
          if (isCommentMessage(sentMsg) && mutationSubscribersRef.current.has(mutationId)) {
            void verifyComment(mutationId, sentMsg);
            continue;
          }
          const present = isMutationPresentInBoardState(snapshotState, sentMsg);
          if (present) {
            notifyMutation(mutationId, "accepted");
          } else {
            notifyMutation(mutationId, "verified-retry");
          }
          // Instant mutations have no subscriber to retry them; nothing else would ever delete the entry.
          if (!mutationSubscribersRef.current.has(mutationId)) pendingSentMutationsRef.current.delete(mutationId);
        }
        return;
      }
      if (msg.type === "error") {
        console.warn("board socket: server rejected mutation:", msg.message);
        if (msg.mutationId) rollback(msg.mutationId, "rejected", msg.message);
        return;
      }
      eventsRef.current?.message?.(
        msg,
        "mutationId" in msg && typeof msg.mutationId === "string" && pendingSentMutationsRef.current.has(msg.mutationId),
      );
      const outcome = reconcilerRef.current.applyServerMessage(msg);
      // Settle any acknowledged mutations (including late echoes)
      const ackedIds = new Set(outcome.ackedMutationIds);
      if (
        msg.type !== "activity.recorded" &&
        msg.type !== "attachment.delete" &&
        msg.type !== "cards.archived" &&
        msg.type !== "archive.purged" &&
        msg.type !== "card.numbered" &&
        "mutationId" in msg &&
        typeof msg.mutationId === "string" &&
        pendingSentMutationsRef.current.has(msg.mutationId)
      ) {
        ackedIds.add(msg.mutationId);
      }
      for (const id of ackedIds) {
        const timer = pendingTimersRef.current.get(id);
        if (timer !== undefined) {
          clearTimeout(timer);
          pendingTimersRef.current.delete(id);
        }
        eventsRef.current?.resolved?.(id);
        notifyMutation(id, "accepted");
      }
      if (outcome.rolledBackMutationId) {
        const timer = pendingTimersRef.current.get(outcome.rolledBackMutationId);
        if (timer !== undefined) {
          clearTimeout(timer);
          pendingTimersRef.current.delete(outcome.rolledBackMutationId);
        }
        eventsRef.current?.resolved?.(outcome.rolledBackMutationId);
      }
      if (outcome.cacheState) {
        queryClient.setQueryData<BoardState>(boardQueryKey(boardId), outcome.cacheState);
      }
    };

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const url = new URL(`${scheme}://${location.host}/boards/${boardId}/ws`);
      url.searchParams.set("realtimeVersion", REALTIME_PROTOCOL_VERSION);
      const ws = new WebSocket(url.toString());
      socketRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
      };
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === "string") handleMessage(ws, event.data);
      };
      ws.onclose = (event) => {
        setConnected(false);
        clearTimeout(stableTimer);
        discardPending();
        if (unmounted) return;
        const accessProbe = accessProbeRef.current;
        const probe: AccessProbe = accessProbe.pending
          ? "pending"
          : accessProbe.checkedAt > transitionStartedAt
            ? "ready"
            : "unknown";
        const plan = planBoardReconnect({
          code: event.code,
          attempt,
          failures: consecutiveFailures,
          inTransition,
          probe,
        });
        attempt = plan.attempt;
        consecutiveFailures = plan.failures;
        if (plan.mode === "denied") {
          setAccessState("denied");
          setHandshakeFailed(true);
          eventsRef.current?.halted?.();
          clearBoardAccessCaches(queryClient, { boardId });
          return;
        }
        if (plan.mode === "transition") {
          if (!inTransition) {
            inTransition = true;
            transitionStartedAt = Date.now();
          }
          setAccessState("transitioning");
          setHandshakeFailed(false);
          // The authoritative read decides whether access survived; the socket
          // itself cannot see the status code of a rejected upgrade.
          void queryClient.invalidateQueries({ queryKey: ["board-meta-by-key"] });
          void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
          retryTimer = window.setTimeout(connect, plan.delayMs ?? 0);
          return;
        }
        inTransition = false;
        if (plan.mode === "stopped" || plan.delayMs === null) {
          console.warn("board socket: stopped reconnecting after unsynchronized failures");
          stopped = true;
          setHandshakeFailed(true);
          eventsRef.current?.halted?.();
          return;
        }
        retryTimer = window.setTimeout(() => {
          requestAppUpdateCheck();
          connect();
        }, plan.delayMs);
      };
    };
    // teardown cancels cleanly without establishing a spurious unmounted connection.
    retryTimer = window.setTimeout(connect, 0);

    // A short network drop can exhaust the failure budget; coming back online or visible retries.
    const retryIfStopped = () => {
      if (stopped && !unmounted) retry();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") retryIfStopped();
    };
    window.addEventListener("online", retryIfStopped);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      unmounted = true;
      window.removeEventListener("online", retryIfStopped);
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(retryTimer);
      clearTimeout(stableTimer);
      discardPending();
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
    };
  }, [attemptEpoch, boardId, queryClient, rollback, retry, cardCommentsQuery, notifyMutation]);

  const sendMutation = useCallback<SendMutation>(
    (msg) => {
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Disconnected mutations fail fast; nothing is queued.
        console.warn("board socket: not connected, dropping", msg.type);
        return false;
      }
      const baseState = reconcilerRef.current.getBaseState();
      const current = reconcilerRef.current.getCacheState();
      if (!baseState || !current) {
        console.warn("board socket: no snapshot yet, dropping", msg.type);
        return false;
      }
      const outcome = reconcilerRef.current.enqueueOptimistic(msg);
      if (!outcome) {
        return false;
      }
      eventsRef.current?.sent?.(msg, current, outcome.cacheState);
      pendingSentMutationsRef.current.set(msg.mutationId, msg);
      queryClient.setQueryData<BoardState>(boardQueryKey(boardId), outcome.cacheState);
      const timer = window.setTimeout(() => rollback(msg.mutationId), PENDING_TIMEOUT_MS);
      pendingTimersRef.current.set(msg.mutationId, timer);
      ws.send(JSON.stringify(msg));
      return true;
    },
    [boardId, queryClient, rollback],
  );

  return {
    accessState,
    connected,
    handshakeFailed,
    retry,
    sendMutation,
    subscribeMutation,
    retireTrackedMutation,
    cardCommentsQuery,
  };
}

/** A JSON object carrying a string `type`: shaped like a protocol message we just cannot read. */
function isTaggedMessage(json: unknown): json is { type: string } {
  if (!json || typeof json !== "object" || !("type" in json)) return false;
  const value = json.type;
  return typeof value === "string";
}
