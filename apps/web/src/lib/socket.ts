import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  REALTIME_PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
} from "@foxban/shared";
import { requestAppUpdateCheck } from "./app-update";
import { boardQueryKey, clearBoardAccessCaches } from "./board-cache";
import { invalidateDevelopmentQueries } from "./card-development";
import {
  planBoardReconnect,
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
const STABLE_CONNECTION_MS = 10_000;

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


type UnresolvedAttachmentDelete = {
  attachmentId: string;
  ownerId: string;
  descriptionBefore: string | undefined;
  descriptionAfter: string | undefined;
};

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
  } = {},
): {
  connected: boolean;
  accessState: "ready" | "transitioning" | "denied";
  handshakeFailed: boolean;
  retry: () => void;
  sendMutation: SendMutation;
  confirmedAttachmentDeletes: ReadonlyMap<string, string>;
  pendingAttachmentDeletes: ReadonlyMap<string, string>;
  seedDescriptionDraft: (cardId: string, description: string) => string;
  subscribeMutation: (mutationId: string, callback: MutationSettledCallback) => () => void;
  retireTrackedMutation: (mutationId: string) => void;
} {
  const queryClient = useQueryClient();
  const accessProbeRef = useRef({ pending: false, checkedAt: 0 });
  accessProbeRef.current = {
    pending: handlers.accessChangePending ?? false,
    checkedAt: handlers.accessCheckedAt ?? 0,
  };
  const [connected, setConnected] = useState(false);
  const [handshakeFailed, setHandshakeFailed] = useState(false);
  const [accessState, setAccessState] = useState<"ready" | "transitioning" | "denied">("transitioning");
  // Bumped by `retry()` to tear the connect loop down and start it over.
  const [attemptEpoch, setAttemptEpoch] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const reconcilerRef = useRef(new BoardReconciler(boardId));
  const pendingTimersRef = useRef(new Map<string, number>());
  const knownAttachmentOwners = useRef(new Map<string, string>());
  // In send order; unlike rollback timers these survive a transport close.
  const unresolvedAttachmentDeletes = useRef(new Map<string, UnresolvedAttachmentDelete>());
  const [confirmedAttachmentDeletes, setConfirmedAttachmentDeletes] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [pendingAttachmentDeletes, setPendingAttachmentDeletes] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const mutationSubscribersRef = useRef(new Map<string, Set<MutationSettledCallback>>());
  const pendingSentMutationsRef = useRef(new Map<string, ClientMessage>());

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

  const clearPendingAttachmentDelete = useCallback((mutationId: string) => {
    unresolvedAttachmentDeletes.current.delete(mutationId);
    setPendingAttachmentDeletes((current) => {
      if (!current.has(mutationId)) return current;
      const next = new Map(current);
      next.delete(mutationId);
      return next;
    });
  }, []);

  const seedDescriptionDraft = useCallback((cardId: string, description: string) => {
    let seed = description;
    const deletes = [...unresolvedAttachmentDeletes.current.values()];
    for (let index = deletes.length - 1; index >= 0; index -= 1) {
      const deletion = deletes[index];
      if (
        deletion.ownerId === cardId &&
        deletion.descriptionBefore !== undefined &&
        seed === deletion.descriptionAfter
      ) {
        seed = deletion.descriptionBefore;
      }
    }
    return seed;
  }, []);

  // A retry restarts the transport, not the board session's deletion evidence.
  useEffect(() => {
    setConfirmedAttachmentDeletes((current) => (current.size ? new Map() : current));
    setPendingAttachmentDeletes((current) => (current.size ? new Map() : current));
    return () => {
      for (const timer of pendingTimersRef.current.values()) clearTimeout(timer);
      pendingTimersRef.current.clear();
      knownAttachmentOwners.current.clear();
      unresolvedAttachmentDeletes.current.clear();
    };
  }, [boardId]);

  const rollback = useCallback(
    (mutationId: string, reason: "timeout" | "rejected" = "timeout", error?: string) => {
      clearPendingAttachmentDelete(mutationId);
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
      // Do NOT close transport for ordinary instant or attachment mutations.
      if (reason === "timeout" && mutationSubscribersRef.current.has(mutationId)) {
        const ws = socketRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close(4000, "authored operation timeout resync");
        }
      }
    },
    [boardId, queryClient, clearPendingAttachmentDelete, notifyMutation],
  );
  const retry = useCallback(() => {
    setHandshakeFailed(false);
    setAttemptEpoch((epoch) => epoch + 1);
  }, []);
  useEffect(() => {
    let unmounted = false;
    let attempt = 0;
    let consecutiveFailures = 0;
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
      if (msg.type === "snapshot") {
        setAccessState("ready");
        inTransition = false;
        // A reconnect snapshot is the missed-event backstop: whatever changed
        // while this socket was down arrives here as a fresh read, not a replay.
        invalidateDevelopmentQueries(queryClient, boardId);
        void queryClient.invalidateQueries({ queryKey: ["board-meta-by-key"] });
        clearTimeout(stableTimer);
        stableTimer = window.setTimeout(() => {
          attempt = 0;
          consecutiveFailures = 0;
        }, STABLE_CONNECTION_MS);
        for (const timer of pendingTimersRef.current.values()) clearTimeout(timer);
        pendingTimersRef.current.clear();
        const snapshotOwners = new Map(
          msg.attachments.map((attachment) => [attachment.id, attachment.cardId]),
        );
        const presentIds = new Set(snapshotOwners.keys());
        const missingOwners = [...knownAttachmentOwners.current].filter(
          ([id]) => !presentIds.has(id),
        );
        setConfirmedAttachmentDeletes((current) => {
          let next: Map<string, string> | undefined;
          for (const id of presentIds) {
            if (current.has(id)) {
              next ??= new Map(current);
              next.delete(id);
            }
          }
          for (const [id, ownerId] of missingOwners) {
            if (current.get(id) !== ownerId) {
              next ??= new Map(current);
              next.set(id, ownerId);
            }
          }
          return next ?? current;
        });
        knownAttachmentOwners.current = snapshotOwners;
        unresolvedAttachmentDeletes.current.clear();
        setPendingAttachmentDeletes((current) => (current.size ? new Map() : current));
        const { cacheState: snapshotState, settledPending } = reconcilerRef.current.applySnapshot(msg);
        queryClient.setQueryData<BoardState>(boardQueryKey(boardId), snapshotState);
        for (const { entry, presentInSnapshot } of settledPending) {
          clearPendingAttachmentDelete(entry.msg.mutationId);
          if (presentInSnapshot) {
            notifyMutation(entry.msg.mutationId, "accepted");
          } else {
            notifyMutation(entry.msg.mutationId, "verified-retry");
          }
        }
        // Check any remaining tracked mutations from disconnects/timeouts
        for (const [mutationId, sentMsg] of Array.from(pendingSentMutationsRef.current.entries())) {
          const present = isMutationPresentInBoardState(snapshotState, sentMsg);
          if (present) {
            notifyMutation(mutationId, "accepted");
          } else {
            notifyMutation(mutationId, "verified-retry");
          }
        }
        return;
      }
      if (msg.type === "error") {
        console.warn("board socket: server rejected mutation:", msg.message);
        if (msg.mutationId) rollback(msg.mutationId, "rejected", msg.message);
        return;
      }
      // Lifecycle frames must settle drafts even for an own echo.
      if (msg.type === "attachment.create") {
        knownAttachmentOwners.current.set(msg.id, msg.cardId);
        setConfirmedAttachmentDeletes((current) => {
          if (!current.has(msg.id)) return current;
          const next = new Map(current);
          next.delete(msg.id);
          return next;
        });
      } else if (msg.type === "attachment.delete") {
        const ownerId = knownAttachmentOwners.current.get(msg.id);
        if (ownerId !== undefined) {
          setConfirmedAttachmentDeletes((current) => {
            if (current.get(msg.id) === ownerId) return current;
            const next = new Map(current);
            next.set(msg.id, ownerId);
            return next;
          });
          knownAttachmentOwners.current.delete(msg.id);
        }
        const deleteMsg = msg;
        const isOwn = pendingSentMutationsRef.current.has(deleteMsg.mutationId);
        if (isOwn) {
          clearPendingAttachmentDelete(deleteMsg.mutationId);
        } else {
          for (const [mutationId, deletion] of unresolvedAttachmentDeletes.current) {
            if (deletion.attachmentId !== deleteMsg.id) continue;
            clearPendingAttachmentDelete(mutationId);
          }
        }
      }
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
        clearPendingAttachmentDelete(id);
        notifyMutation(id, "accepted");
      }
      if (outcome.rolledBackMutationId) {
        const timer = pendingTimersRef.current.get(outcome.rolledBackMutationId);
        if (timer !== undefined) {
          clearTimeout(timer);
          pendingTimersRef.current.delete(outcome.rolledBackMutationId);
        }
        clearPendingAttachmentDelete(outcome.rolledBackMutationId);
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
          setHandshakeFailed(true);
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

    return () => {
      unmounted = true;
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
  }, [attemptEpoch, boardId, queryClient, rollback, clearPendingAttachmentDelete]);

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
      if (msg.type === "attachment.delete") {
        const attachment = current.attachments.find((attachment) => attachment.id === msg.id);
        const ownerId = attachment?.cardId ?? knownAttachmentOwners.current.get(msg.id);
        if (ownerId !== undefined) {
          knownAttachmentOwners.current.set(msg.id, ownerId);
          unresolvedAttachmentDeletes.current.set(msg.mutationId, {
            attachmentId: msg.id,
            ownerId,
            descriptionBefore: current.cards.find((card) => card.id === ownerId)?.description,
            descriptionAfter: outcome.cacheState.cards.find((card) => card.id === ownerId)?.description,
          });
          setPendingAttachmentDeletes((pending) => {
            if (pending.get(msg.mutationId) === ownerId) return pending;
            const next = new Map(pending);
            next.set(msg.mutationId, ownerId);
            return next;
          });
        }
      }
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
    confirmedAttachmentDeletes,
    pendingAttachmentDeletes,
    seedDescriptionDraft,
    subscribeMutation,
    retireTrackedMutation,
  };
}

/** A JSON object carrying a string `type`: shaped like a protocol message we just cannot read. */
function isTaggedMessage(json: unknown): json is { type: string } {
  if (!json || typeof json !== "object" || !("type" in json)) return false;
  const value = json.type;
  return typeof value === "string";
}
