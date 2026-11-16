import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PresenceServerMessageSchema,
  REALTIME_PROTOCOL_VERSION,
  type PresenceState,
} from "@foxban/shared";
import type { User } from "./auth";
import { requestAppUpdateCheck } from "./app-update";
import { invalidateWorkspaceContext } from "./workspaces";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const STABLE_CONNECTION_MS = 10_000;
const MAX_FAILED_SYNCHRONIZATIONS = 3;

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

      ws.onclose = () => {
        clearTimeout(stableTimer);
        if (unmounted) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_FAILED_SYNCHRONIZATIONS) {
          console.warn("presence socket: stopped reconnecting after unsynchronized failures");
          return;
        }
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt);
        retryTimer = window.setTimeout(() => {
          requestAppUpdateCheck();
          connect();
        }, delay);
        attempt += 1;
      };

      ws.onerror = () => {
        // onclose will follow and handle reconnection
      };
    };
    const refreshWorkspaceData = () => {
      if (document.visibilityState === "visible") {
        void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
        void queryClient.invalidateQueries({ queryKey: ["boards"] });
      }
    };
    window.addEventListener("focus", refreshWorkspaceData);
    document.addEventListener("visibilitychange", refreshWorkspaceData);
    retryTimer = window.setTimeout(connect, 0);

    return () => {
      unmounted = true;
      clearTimeout(retryTimer);
      clearTimeout(stableTimer);
      window.removeEventListener("focus", refreshWorkspaceData);
      document.removeEventListener("visibilitychange", refreshWorkspaceData);
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
