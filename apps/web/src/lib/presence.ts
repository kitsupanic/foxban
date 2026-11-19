import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PresenceServerMessageSchema,
  REALTIME_PROTOCOL_VERSION,
  SESSION_REVOKED_CLOSE,
  type PresenceState,
} from "@foxban/shared";
import { leaveRevokedSession, type User } from "./auth";
import { requestAppUpdateCheck } from "./app-update";
import { planBoardReconnect, STABLE_CONNECTION_MS } from "./access-attempt";
import { invalidateWorkspaceContext } from "./workspaces";

export const presenceQueryKey = ["presence"] as const;

export type PresenceMap = Record<string, PresenceState>;

/**
 * Reads the current presence map from query cache without issuing fetches.
 */
export function usePresenceState(): PresenceMap {
  const { data } = useQuery({
    queryKey: presenceQueryKey,
    queryFn: (): Promise<PresenceMap> =>
      Promise.reject(new Error("presence arrives over the WebSocket")),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? {};
}

/**
 * Owns the single app-wide WebSocket connection to /presence/ws.
 * Reconnects with bounded exponential backoff when disconnected.
 * Reconnects whenever user.id or user.timezone changes.
 */
export function usePresenceSocket(user: User | null | undefined): void {
  const queryClient = useQueryClient();
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!user) {
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
      return;
    }

    let unmounted = false;
    let attempt = 0;
    let consecutiveFailures = 0;
    // True once the failure budget ran out: no timer and no socket until the network is back.
    let stopped = false;
    let retryTimer: number | undefined;
    let stableTimer: number | undefined;

    const connect = () => {
      if (unmounted) return;
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      let browserZone: string | undefined;
      try {
        browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        // Leave undefined
      }

      const url = new URL(`${scheme}://${location.host}/presence/ws`);
      url.searchParams.set("realtimeVersion", REALTIME_PROTOCOL_VERSION);
      if (browserZone) {
        url.searchParams.set("timezone", browserZone);
      }

      const ws = new WebSocket(url.toString());
      socketRef.current = ws;

      ws.onopen = () => {
        // Connection health is defined by a validated snapshot, not onopen.
      };

      ws.onmessage = (event: MessageEvent) => {
        let json: unknown;
        try {
          json = JSON.parse(event.data);
        } catch {
          ws.close();
          return;
        }

        const parsed = PresenceServerMessageSchema.safeParse(json);
        if (!parsed.success) {
          // Unknown or invalid frame: close to trigger resynchronization within retry budget
          ws.close();
          return;
        }

        const msg = parsed.data;
        if (msg.type === "presence.snapshot") {
          clearTimeout(stableTimer);
          stableTimer = window.setTimeout(() => {
            attempt = 0;
            consecutiveFailures = 0;
          }, STABLE_CONNECTION_MS);
          const map: PresenceMap = {};
          for (const member of msg.members) {
            map[member.userId] = member;
          }
          queryClient.setQueryData<PresenceMap>(presenceQueryKey, map);
        } else if (msg.type === "presence.updated") {
          queryClient.setQueryData<PresenceMap>(presenceQueryKey, (current) => {
            const next: PresenceMap = { ...(current ?? {}) };
            next[msg.member.userId] = msg.member;
            return next;
          });
        } else if (msg.type === "workspace.invalidated") {
          invalidateWorkspaceContext(queryClient, msg.workspaceIds, msg.boardIds);
        }
      };

      ws.onclose = (event) => {
        clearTimeout(stableTimer);
        if (unmounted) return;
        if (event.code === SESSION_REVOKED_CLOSE) {
          leaveRevokedSession();
          return;
        }
        // The same backoff and failure budget as the board socket (transport branch).
        const plan = planBoardReconnect({
          code: 1006,
          attempt,
          failures: consecutiveFailures,
          inTransition: false,
          probe: "unknown",
        });
        attempt = plan.attempt;
        consecutiveFailures = plan.failures;
        if (plan.delayMs === null) {
          console.warn("presence socket: stopped reconnecting after unsynchronized failures");
          stopped = true;
          return;
        }
        retryTimer = window.setTimeout(() => {
          requestAppUpdateCheck();
          connect();
        }, plan.delayMs);
      };

      ws.onerror = () => {
        // onclose will follow and handle reconnection
      };
    };
    // A short network drop can exhaust the failure budget; coming back online
    // or visible starts a fresh loop.
    const restartIfStopped = () => {
      if (!stopped || unmounted) return;
      stopped = false;
      attempt = 0;
      consecutiveFailures = 0;
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") restartIfStopped();
    };
    window.addEventListener("online", restartIfStopped);
    document.addEventListener("visibilitychange", onVisible);
    retryTimer = window.setTimeout(connect, 0);

    return () => {
      unmounted = true;
      clearTimeout(retryTimer);
      clearTimeout(stableTimer);
      window.removeEventListener("online", restartIfStopped);
      document.removeEventListener("visibilitychange", onVisible);
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
  }, [user?.id, user?.timezone, queryClient]);
}
