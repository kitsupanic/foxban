import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

/**
 * Access-changing operations (member add/remove, moves, deletions, invite
 * acceptance) are journalled server-side and may answer `202` while the change
 * is still preparing. The attempt is therefore a client-side object with a
 * lifetime longer than the dialog that started it: the same `operationId` must
 * be reused for status polls, replayed requests and remounts, and only a
 * definitive outcome may be reported as success.
 *
 * The store lives at module scope on purpose. React state is discarded when a
 * route or dialog remounts (workspace switch, board navigation, dialog reopen);
 * a pending operation must not be discarded with it, or the UI starts a second
 * attempt for a change the server is already applying.
 */

export type AccessAttemptKind =
  | "board-member-add"
  | "board-member-remove"
  | "board-move"
  | "board-delete"
  | "workspace-member-add"
  | "workspace-member-role"
  | "workspace-member-remove"
  | "workspace-invite-accept";

/** Everything a retry needs to reproduce the exact payload the server hashed. */
export type AccessAttemptContext = Readonly<Record<string, string>>;

export type AccessAttemptState = "pending" | "committed" | "aborted";

export type AccessAttempt = {
  /** Identity of the subject (board+member, workspace+member, board), not of the dialog. */
  readonly scopeKey: string;
  readonly kind: AccessAttemptKind;
  readonly operationId: string;
  readonly context: AccessAttemptContext;
  readonly state: AccessAttemptState;
  readonly result: unknown;
  /** Settled outcomes are announced to the UI exactly once, even across remounts. */
  readonly delivered: boolean;
};

/** The status poll interval; the server answers a frozen board with `Retry-After: 2`. */
export const ACCESS_ATTEMPT_POLL_MS = 2_000;

/**
 * A subject's retained identity: `kind:subject…`. Consumers observe a
 * `kind:subject:` prefix, so the FIRST subject segment is the scope a page or
 * dialog claims — a workspace for a workspace-wide page, a board for a board
 * dialog. A key whose first segment is the narrower subject is unreachable by
 * the wider consumer.
 */
export function accessScope(kind: AccessAttemptKind, ...subject: string[]): string {
  return `${kind}:${subject.join(":")}`;
}

/** Every attempt of one kind touching `subject` — one board or one workspace. */
export function accessSubjectPrefix(kind: AccessAttemptKind, subject: string): string {
  return `${kind}:${subject}:`;
}

const attempts = new Map<string, AccessAttempt>();
const listeners = new Set<() => void>();
const snapshots = new Map<string, { revision: number; attempts: readonly AccessAttempt[] }>();
/**
 * Operation ids the status endpoint answered 404 for. Such an attempt keeps its
 * identity — a 5xx response leaves the outcome unknown and an exact retry must
 * reuse the same id — but polling it again would only repeat the 404, so the
 * poller stops until the attempt's own response lands.
 */
const pollingExhausted = new Set<string>();
let revision = 0;

function publish(): void {
  revision += 1;
  for (const listener of [...listeners]) listener();
}

function subscribeAccessAttempts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Revision-cached so `useSyncExternalStore` sees a stable reference between writes. */
function accessAttemptSnapshot(prefix: string): readonly AccessAttempt[] {
  const cached = snapshots.get(prefix);
  if (cached && cached.revision === revision) return cached.attempts;
  const matching = [...attempts.values()].filter((attempt) => attempt.scopeKey.startsWith(prefix));
  snapshots.set(prefix, { revision, attempts: matching });
  return matching;
}

export function readAccessAttempt(scopeKey: string): AccessAttempt | undefined {
  return attempts.get(scopeKey);
}

/**
 * Returns the attempt to send for `scopeKey`: an unfinished one is rejoined
 * with its original operationId and captured context, so a reopened dialog or a
 * remounted route continues the operation instead of starting a rival one.
 */
export function beginAccessAttempt(
  scopeKey: string,
  kind: AccessAttemptKind,
  context: AccessAttemptContext,
): AccessAttempt {
  const existing = attempts.get(scopeKey);
  if (existing && existing.state === "pending") return existing;
  const attempt: AccessAttempt = {
    scopeKey,
    kind,
    operationId: crypto.randomUUID(),
    context: Object.freeze({ ...context }),
    state: "pending",
    result: null,
    delivered: false,
  };
  attempts.set(scopeKey, attempt);
  publish();
  return attempt;
}

export function clearAccessAttempt(scopeKey: string, operationId?: string): void {
  const existing = attempts.get(scopeKey);
  if (!existing) return;
  if (operationId !== undefined && existing.operationId !== operationId) return;
  attempts.delete(scopeKey);
  pollingExhausted.delete(existing.operationId);
  publish();
}

/** Drops every retained attempt; used on sign-out so one account never inherits another's. */
export function resetAccessAttempts(): void {
  if (attempts.size === 0) return;
  attempts.clear();
  pollingExhausted.clear();
  publish();
}

export type AccessChangeOutcome =
  | { state: "pending"; operationId: string }
  | { state: "committed" | "aborted"; operationId: string; result: unknown };

/**
 * Classifies an attempt response or a status poll. Only `completed` is terminal:
 * the pending envelope reports `committed` once D1 has applied the change but
 * before participants are released, which is still not a finished operation.
 * The member endpoints answer a committed attempt with `{ok:true}` and no
 * envelope, so the attempt's own operationId is passed as the fallback.
 */
export function classifyAccessChange(body: unknown, fallbackOperationId?: string): AccessChangeOutcome | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { ok?: unknown; operationId?: unknown; state?: unknown; outcome?: unknown; result?: unknown };
  if (typeof record.operationId !== "string") {
    if (record.ok === true && fallbackOperationId !== undefined)
      return { state: "committed", operationId: fallbackOperationId, result: body };
    return null;
  }
  if (record.state === "completed")
    return {
      state: record.outcome === "aborted" ? "aborted" : "committed",
      operationId: record.operationId,
      result: record.result ?? null,
    };
  if (record.state === "preparing" || record.state === "committed" || record.state === "aborted")
    return { state: "pending", operationId: record.operationId };
  return null;
}

function settleAccessAttempt(scopeKey: string, operationId: string, state: AccessAttemptState, result: unknown): void {
  const existing = attempts.get(scopeKey);
  if (!existing || existing.operationId !== operationId || existing.state !== "pending") return;
  attempts.set(scopeKey, { ...existing, state, result });
  publish();
}

/** Applies one classified outcome; a pending outcome keeps the retained identity. */
export function applyAccessChangeOutcome(scopeKey: string, operationId: string, outcome: AccessChangeOutcome): void {
  // The attempt's own response is authoritative, so polling it is allowed again.
  const wasExhausted = pollingExhausted.delete(operationId);
  if (outcome.state === "pending") {
    // A 202 after the status endpoint answered 404 means the operation exists
    // now, so polling must resume. The poller derives the ids it watches from a
    // published snapshot, so releasing the mark without publishing would leave
    // it polling nothing: the outcome would never be observed.
    if (wasExhausted) publish();
    return;
  }
  settleAccessAttempt(scopeKey, operationId, outcome.state, outcome.result);
}

function markAccessAttemptDelivered(scopeKey: string, operationId: string): boolean {
  const existing = attempts.get(scopeKey);
  if (!existing || existing.operationId !== operationId || existing.state === "pending" || existing.delivered) return false;
  attempts.set(scopeKey, { ...existing, delivered: true });
  publish();
  return true;
}

/** A server refusal (4xx) is definitive; a transport failure leaves the outcome unknown. */
export class AccessRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AccessRequestError";
  }
}

/** Sends one access request and reports its status, so callers can tell a refusal from an unknown outcome. */
export async function sendAccessChange(url: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `${method} ${url} failed with ${response.status}`;
    throw new AccessRequestError(response.status, detail);
  }
  return payload;
}

/**
 * Sends one access-changing request under a retained identity. A 4xx means the
 * operation was refused and never started, so the attempt is dropped; any other
 * failure (network, 5xx) leaves the attempt pending for a status check, because
 * the server may have applied it anyway.
 */
export async function requestAccessChange(
  scopeKey: string,
  kind: AccessAttemptKind,
  context: AccessAttemptContext,
  send: (attempt: AccessAttempt) => Promise<unknown>,
): Promise<AccessAttempt> {
  const attempt = beginAccessAttempt(scopeKey, kind, context);
  let body: unknown;
  try {
    body = await send(attempt);
  } catch (error) {
    if (error instanceof AccessRequestError && error.status >= 400 && error.status < 500)
      clearAccessAttempt(scopeKey, attempt.operationId);
    throw error;
  }
  const outcome = classifyAccessChange(body, attempt.operationId);
  if (!outcome) {
    clearAccessAttempt(scopeKey, attempt.operationId);
    throw new Error("The server returned an unrecognized access response.");
  }
  applyAccessChangeOutcome(scopeKey, attempt.operationId, outcome);
  return readAccessAttempt(scopeKey) ?? attempt;
}

export async function readAccessChangeStatus(operationId: string): Promise<unknown> {
  return sendAccessChange(`/access-changes/${encodeURIComponent(operationId)}`, "GET");
}

/**
 * What one status read means for a retained attempt. `unresolvable` is the
 * server answering 404: it holds no such operation, so the identity can never
 * resolve and the caller must release it rather than poll forever.
 */
export type AccessStatusResult =
  | { kind: "settled"; outcome: AccessChangeOutcome }
  | { kind: "pending" }
  | { kind: "unknown" }
  | { kind: "unresolvable" };

export function interpretAccessStatus(body: unknown, error: unknown): AccessStatusResult {
  if (error !== null && error !== undefined)
    return error instanceof AccessRequestError && error.status === 404 ? { kind: "unresolvable" } : { kind: "unknown" };
  const outcome = classifyAccessChange(body);
  if (!outcome) return { kind: "unknown" };
  return outcome.state === "pending" ? { kind: "pending" } : { kind: "settled", outcome };
}

export function isPollingExhausted(operationId: string): boolean {
  return pollingExhausted.has(operationId);
}

/**
 * Records that the status endpoint does not know this id yet. The attempt keeps
 * its identity — the outcome of its own request is still unknown, and an exact
 * retry must reuse the id — while polling it stops.
 */
export function markAccessAttemptUnresolvable(operationId: string): boolean {
  if (pollingExhausted.has(operationId)) return false;
  pollingExhausted.add(operationId);
  publish();
  return true;
}

/** Observes every retained attempt whose scope key starts with `prefix`. */
export function useAccessAttempts(prefix: string): readonly AccessAttempt[] {
  const getSnapshot = useCallback(() => accessAttemptSnapshot(prefix), [prefix]);
  return useSyncExternalStore(subscribeAccessAttempts, getSnapshot, getSnapshot);
}

export type AccessAttemptTracking = {
  /** Attempts still waiting for a definitive outcome. */
  pending: readonly AccessAttempt[];
  /** Every entry of the last poll failed, so the server state is unknown. */
  statusUnavailable: boolean;
  /** The server holds no record of these attempts yet: retry the action to continue them. */
  unreachable: boolean;
  /** Re-checks the retained attempts now, without starting a new operation. */
  checkStatus: () => void;
};

/**
 * Polls the retained attempts under `prefix` by their own operationId and hands
 * each definitive outcome to `onOutcome` exactly once — including an outcome the
 * user triggered before this component mounted.
 */
export function useAccessAttemptOutcomes(
  prefix: string,
  onOutcome: (attempt: AccessAttempt) => void,
): AccessAttemptTracking {
  const observed = useAccessAttempts(prefix);
  const pending = useMemo(() => observed.filter((attempt) => attempt.state === "pending"), [observed]);
  // An attempt whose status the server does not know yet is left alone: its own
  // response is still the authority, and clearing it here would drop the
  // outcome of the request that is still in flight.
  const polled = useMemo(() => pending.filter((attempt) => !pollingExhausted.has(attempt.operationId)), [pending]);
  const pendingIds = polled.map((attempt) => attempt.operationId).join(",");

  const poll = useQuery({
    queryKey: ["access-change-status", prefix, pendingIds],
    enabled: polled.length > 0,
    gcTime: 0,
    retry: false,
    refetchInterval: ACCESS_ATTEMPT_POLL_MS,
    queryFn: async () =>
      Promise.all(
        polled.map(async (attempt) => {
          try {
            return { operationId: attempt.operationId, status: interpretAccessStatus(await readAccessChangeStatus(attempt.operationId), null) };
          } catch (error) {
            return { operationId: attempt.operationId, status: interpretAccessStatus(null, error) };
          }
        }),
      ),
  });

  const polls = poll.data;
  useEffect(() => {
    if (!polls) return;
    for (const entry of polls) {
      const attempt = pending.find((candidate) => candidate.operationId === entry.operationId);
      if (!attempt) continue;
      if (entry.status.kind === "settled") {
        applyAccessChangeOutcome(attempt.scopeKey, attempt.operationId, entry.status.outcome);
        continue;
      }
      // The server has no row for this id yet. Keep the identity (an exact retry
      // must reuse it) and stop polling it until its own response arrives.
      if (entry.status.kind === "unresolvable") markAccessAttemptUnresolvable(attempt.operationId);
    }
  }, [polls, pending]);

  const onOutcomeRef = useRef(onOutcome);
  onOutcomeRef.current = onOutcome;
  useEffect(() => {
    for (const attempt of observed) {
      if (!markAccessAttemptDelivered(attempt.scopeKey, attempt.operationId)) continue;
      onOutcomeRef.current(attempt);
    }
  }, [observed]);

  const checkStatus = useCallback(() => {
    void poll.refetch();
  }, [poll]);
  const statusUnavailable = pending.length > 0 && polls !== undefined && polls.every((entry) => entry.status.kind === "unknown");
  const unreachable = pending.length > 0 && polled.length === 0;

  return { pending, statusUnavailable, unreachable, checkStatus };
}

/** A board's access is being changed, per the authoritative metadata read. */
export const ACCESS_CHANGE_PENDING = "access_change_pending";

export class AccessChangePendingError extends Error {
  constructor() {
    super(ACCESS_CHANGE_PENDING);
    this.name = "AccessChangePendingError";
  }
}

export function isAccessChangePending(error: unknown): boolean {
  return (
    error instanceof AccessChangePendingError ||
    (error instanceof Error && error.message === ACCESS_CHANGE_PENDING)
  );
}

/** What the last authoritative metadata read says about a board's access. */
export type AccessProbe = "pending" | "ready" | "unknown";

export const BOARD_ACCESS_TRANSITION_CLOSE = 4010;
export const BOARD_ACCESS_DENIED_CLOSE = 4003;
/** The client closes its own socket with this code to resync after an authored operation timed out (ADR 0069). */
export const BOARD_AUTHORED_RESYNC_CLOSE = 4000;
const FAILED_SYNCHRONIZATION_LIMIT = 3;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;
/** A socket that held a validated snapshot this long resets its backoff and failure budget. */
export const STABLE_CONNECTION_MS = 10_000;

export type BoardReconnectPlan = {
  mode: "denied" | "transition" | "transport" | "stopped";
  /** Delay before the next attempt, or null when the loop stops. */
  delayMs: number | null;
  attempt: number;
  failures: number;
  inTransition: boolean;
};

/**
 * Decides what a closed board socket does next. A pending access change is not
 * a transport failure: the server answers the upgrade with 503 until the change
 * is released, so counting those closes would exhaust the unsynchronized-failure
 * budget and stop reconnecting exactly when recovery is about to succeed.
 */
export function planBoardReconnect(input: {
  code: number;
  attempt: number;
  failures: number;
  inTransition: boolean;
  probe: AccessProbe;
}): BoardReconnectPlan {
  if (input.code === BOARD_ACCESS_DENIED_CLOSE)
    return { mode: "denied", delayMs: null, attempt: input.attempt, failures: 0, inTransition: false };
  const transitioning =
    input.code === BOARD_ACCESS_TRANSITION_CLOSE ||
    input.probe === "pending" ||
    (input.inTransition && input.probe !== "ready");
  if (transitioning)
    return { mode: "transition", delayMs: ACCESS_ATTEMPT_POLL_MS, attempt: input.attempt, failures: 0, inTransition: true };
  // A deliberate resync is not a transport failure: reconnect promptly and keep the budget as it was.
  if (input.code === BOARD_AUTHORED_RESYNC_CLOSE)
    return { mode: "transport", delayMs: RECONNECT_MIN_MS, attempt: input.attempt, failures: input.failures, inTransition: false };
  const failures = input.failures + 1;
  if (failures >= FAILED_SYNCHRONIZATION_LIMIT)
    return { mode: "stopped", delayMs: null, attempt: input.attempt, failures, inTransition: false };
  return {
    mode: "transport",
    delayMs: Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** input.attempt),
    attempt: input.attempt + 1,
    failures,
    inTransition: false,
  };
}
