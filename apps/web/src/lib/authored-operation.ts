import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ClientMessage } from "@foxban/shared";
import type { BoardState } from "./apply-mutation";
import type { MutationSettledCallback } from "./socket";

/**
 * Settlement for authored operations (ADR 0069). The core below is React-free;
 * the hooks at the bottom are thin adapters over it.
 */

export type AuthoredTransport = {
  send(message: ClientMessage): boolean;
  subscribe(mutationId: string, callback: MutationSettledCallback): () => void;
  retire(mutationId: string): void;
  /** The live board cache, read when an accepted attempt is confirmed. */
  readBoard(): BoardState | undefined;
};

export type AuthoredFailureReason = "rejected" | "unverified" | "not-connected" | "accepted-gone";
export type AuthoredStatus = "idle" | "pending" | "uncertain" | "failed" | "settled";

export type AuthoredState<S> = {
  status: AuthoredStatus;
  /** Snapshot the current or last lineage was started with. */
  sent: S | null;
  failure: AuthoredFailureReason | null;
  error: string | null;
};

export type AuthoredOperationOptions<S> = {
  /** Runs on every attempt, retries included; `null` means there is nothing to send. */
  build(mutationId: string, sent: S): ClientMessage | null;
  /** Checked when an attempt is accepted; `false` fails it as `accepted-gone`. */
  confirm?(board: BoardState | undefined, sent: S): boolean;
  /** Runs once when any attempt of the lineage is accepted; `mutationId` is that attempt's, which may be an earlier one. */
  onAccepted?(sent: S, mutationId: string): void;
  copy: Record<AuthoredFailureReason, string>;
};

export type AuthoredOperation<S> = {
  getState(): AuthoredState<S>;
  subscribe(listener: () => void): () => void;
  /** Ignored (false) while pending or uncertain; otherwise starts a new lineage. */
  start(sent: S): boolean;
  /** Only from `failed`: a fresh mutationId, the same `sent`. */
  retry(): boolean;
  discard(): void;
};

export type AuthoredScope = {
  /** Options are read on every use, so a caller may hand in an object with getters. */
  operation<S>(options: AuthoredOperationOptions<S>): AuthoredOperation<S>;
  /** Any operation of this scope pending or uncertain. */
  hasActiveWork(): boolean;
  /** Discards a one-shot operation and forgets it, so the scope does not retain it. */
  release(op: AuthoredOperation<unknown>): void;
  dispose(): void;
};

type Outcome = Parameters<MutationSettledCallback>[0];

const IDLE: AuthoredState<never> = { status: "idle", sent: null, failure: null, error: null };

export function createAuthoredScope(transport: AuthoredTransport): AuthoredScope {
  const operations = new Set<AuthoredOperation<never>>();
  let disposed = false;

  function operation<S>(options: AuthoredOperationOptions<S>): AuthoredOperation<S> {
    let state: AuthoredState<S> = IDLE;
    // Every attempt of the current lineage that has not been retired. A socket entry outlives its
    // notification until retired, so an attempt that failed as unverified stays live: the server
    // may still answer it late, and any answer from any attempt of the lineage settles it.
    const live = new Map<string, () => void>();
    let latest: string | null = null;
    const listeners = new Set<() => void>();

    const set = (next: AuthoredState<S>) => {
      state = next;
      for (const listener of Array.from(listeners)) listener();
    };
    const release = (id: string) => {
      const unsubscribe = live.get(id);
      if (!unsubscribe) return;
      live.delete(id);
      unsubscribe();
      transport.retire(id);
    };
    const releaseAll = () => {
      for (const id of Array.from(live.keys())) release(id);
    };
    const fail = (sent: S, failure: AuthoredFailureReason, error?: string) =>
      set({ status: "failed", sent, failure, error: error || options.copy[failure] });

    const settle = (id: string, sent: S, { status, error }: Outcome) => {
      if (!live.has(id)) return;
      if (status === "accepted") {
        releaseAll();
        if (options.confirm && !options.confirm(transport.readBoard(), sent)) fail(sent, "accepted-gone");
        else {
          set({ status: "settled", sent, failure: null, error: null });
          options.onAccepted?.(sent, id);
        }
        return;
      }
      if (id !== latest) {
        // An older attempt can no longer change what the user sees, except by being accepted.
        if (status === "rejected" || status === "verified-retry") release(id);
        return;
      }
      if (status === "timeout" || status === "uncertain") {
        if (state.status === "pending") set({ ...state, status: "uncertain" });
      } else if (status === "rejected") {
        release(id);
        fail(sent, "rejected", error);
      } else fail(sent, "unverified");
    };

    const attempt = (sent: S): boolean => {
      const id = crypto.randomUUID();
      const message = options.build(id, sent);
      if (!message) {
        releaseAll();
        set({ status: "settled", sent, failure: null, error: null });
        return true;
      }
      // Subscribe before sending: the outcome can only arrive after send.
      live.set(id, transport.subscribe(id, (outcome) => settle(id, sent, outcome)));
      latest = id;
      set({ status: "pending", sent, failure: null, error: null });
      if (!transport.send(message)) {
        release(id);
        fail(sent, "not-connected");
      }
      return true;
    };

    const op: AuthoredOperation<S> = {
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      start(sent) {
        if (disposed || state.status === "pending" || state.status === "uncertain") return false;
        releaseAll();
        return attempt(sent);
      },
      retry() {
        if (disposed || state.status !== "failed") return false;
        return attempt(state.sent as S);
      },
      discard() {
        releaseAll();
        if (state.status !== "idle") set(IDLE);
      },
    };
    operations.add(op as AuthoredOperation<never>);
    return op;
  }

  return {
    operation,
    hasActiveWork: () =>
      Array.from(operations).some((op) => {
        const { status } = op.getState();
        return status === "pending" || status === "uncertain";
      }),
    release(op) {
      op.discard();
      operations.delete(op as AuthoredOperation<never>);
    },
    dispose() {
      disposed = true;
      for (const op of operations) op.discard();
    },
  };
}

/** The transport is read through a ref: `sendMutation` changes identity with the board. */
const scopeOver = (latest: { current: AuthoredTransport }) =>
  createAuthoredScope({
    send: (message) => latest.current.send(message),
    subscribe: (id, callback) => latest.current.subscribe(id, callback),
    retire: (id) => latest.current.retire(id),
    readBoard: () => latest.current.readBoard(),
  });

export function useAuthoredScope(transport: AuthoredTransport): AuthoredScope {
  const latest = useRef(transport);
  latest.current = transport;
  const [scope, setScope] = useState(() => scopeOver(latest));
  const disposedScope = useRef<AuthoredScope | null>(null);
  useEffect(() => {
    // StrictMode's simulated unmount keeps state, so a disposed scope is swapped for a fresh one.
    if (disposedScope.current === scope) setScope(scopeOver(latest));
    return () => {
      disposedScope.current = scope;
      scope.dispose();
    };
  }, [scope]);
  return scope;
}

export function useAuthoredOperation<S>(
  scope: AuthoredScope,
  options: AuthoredOperationOptions<S>,
): AuthoredState<S> & Pick<AuthoredOperation<S>, "start" | "retry" | "discard"> {
  const latest = useRef(options);
  latest.current = options;
  const op = useMemo(
    () =>
      scope.operation<S>({
        build: (id, sent) => latest.current.build(id, sent),
        confirm: (board, sent) => latest.current.confirm?.(board, sent) ?? true,
        onAccepted: (sent, mutationId) => latest.current.onAccepted?.(sent, mutationId),
        get copy() {
          return latest.current.copy;
        },
      }),
    [scope],
  );
  const state = useSyncExternalStore(op.subscribe, op.getState, op.getState);
  return { ...state, start: op.start, retry: op.retry, discard: op.discard };
}

// The old render shape: pending / uncertain / inline error / retained recovery. A first attempt
// that never left (not connected) is only an inline error; a retry's failure and any rejected or
// unverified attempt is a recovery, which stays on screen, with its last error, while a retry runs.
export function composerLane<S extends { entityId: string }>(op: AuthoredState<S>, retried: boolean, lastError: { current: string }) {
  const active = op.status === "pending" || op.status === "uncertain";
  const retained = op.status === "failed" ? retried || op.failure !== "not-connected" : active && retried;
  if (op.status === "failed" && retained) lastError.current = op.error ?? "";
  return {
    pendingId: active ? op.sent?.entityId ?? null : null,
    uncertain: op.status === "uncertain",
    error: op.status === "failed" && !retained ? op.error : null,
    recovery: retained && op.sent ? { ...op.sent, error: lastError.current } : null,
  };
}
