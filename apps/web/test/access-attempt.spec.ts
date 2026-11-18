import { expect, test } from "@playwright/test";
import { QueryClient } from "@tanstack/react-query";
import {
  ACCESS_ATTEMPT_POLL_MS,
  AccessRequestError,
  accessScope,
  accessSubjectPrefix,
  applyAccessChangeOutcome,
  beginAccessAttempt,
  classifyAccessChange,
  clearAccessAttempt,
  interpretAccessStatus,
  isPollingExhausted,
  markAccessAttemptUnresolvable,
  planBoardReconnect,
  readAccessAttempt,
  requestAccessChange,
  resetAccessAttempts,
} from "../src/lib/access-attempt";
import { boardPrivateCacheKeys, clearBoardAccessCaches } from "../src/lib/board-cache";

/** What `runAccessChange` answers while the change is still preparing. */
function pendingEnvelope(operationId: string, state: "preparing" | "committed" | "aborted" = "preparing") {
  return { operationId, state, recoveryPending: true } as const;
}

function completedEnvelope(operationId: string, outcome: "committed" | "aborted", result: unknown = null) {
  return { operationId, state: "completed", outcome, result } as const;
}

/** Applies a terminal status the way the status poll does. */
function settleFromStatus(scopeKey: string, operationId: string, outcome: "committed" | "aborted", result: unknown = null): void {
  const classified = classifyAccessChange(completedEnvelope(operationId, outcome, result));
  if (!classified) throw new Error("expected a classifiable envelope");
  applyAccessChangeOutcome(scopeKey, operationId, classified);
}

test.beforeEach(() => {
  resetAccessAttempts();
});

test("a 202 answer stays pending and is only settled by the confirmed outcome", async () => {
  const scope = accessScope("board-member-remove", "board-1", "user-1");
  const sentOperationIds: string[] = [];
  const attempt = await requestAccessChange(
    scope,
    "board-member-remove",
    { boardId: "board-1", userId: "user-1" },
    (current) => {
      sentOperationIds.push(current.operationId);
      return Promise.resolve(pendingEnvelope(current.operationId));
    },
  );

  // The server accepted the attempt but has not finished it: reporting a
  // completed action here is exactly what the retained state machine prevents.
  expect(attempt.state).toBe("pending");
  expect(readAccessAttempt(scope)?.state).toBe("pending");

  settleFromStatus(scope, attempt.operationId, "committed");
  expect(readAccessAttempt(scope)?.state).toBe("committed");
  expect(sentOperationIds).toEqual([attempt.operationId]);
});

test("a phase-marked envelope is pending even when its phase reads committed", () => {
  const operationId = "11111111-1111-4111-8111-111111111111";
  for (const phase of ["preparing", "committed", "aborted"] as const)
    expect(classifyAccessChange(pendingEnvelope(operationId, phase))).toEqual({ state: "pending", operationId });
});

test("an ok answer from a member endpoint is committed under the attempt's own identity", async () => {
  // `POST /boards/:id/members` answers a committed attempt with `{ok:true}` and
  // no envelope, so the retained operationId is what identifies the outcome.
  const scope = accessScope("board-member-add", "board-1", "user-1");
  const attempt = await requestAccessChange(
    scope,
    "board-member-add",
    { boardId: "board-1", userId: "user-1" },
    () => Promise.resolve({ ok: true }),
  );
  expect(attempt.state).toBe("committed");
  expect(attempt.operationId).toBe(readAccessAttempt(scope)?.operationId);

  // An unrecognized body is not a success.
  const otherScope = accessScope("board-member-add", "board-2", "user-2");
  await expect(
    requestAccessChange(otherScope, "board-member-add", { boardId: "board-2", userId: "user-2" }, () =>
      Promise.resolve({ unexpected: true }),
    ),
  ).rejects.toThrow("unrecognized access response");
  expect(readAccessAttempt(otherScope)).toBeUndefined();
});

test("an aborted outcome is not reported as committed", () => {
  const scope = accessScope("board-move", "board-1");
  const attempt = beginAccessAttempt(scope, "board-move", { boardId: "board-1", destinationWorkspaceId: "workspace-b" });
  settleFromStatus(scope, attempt.operationId, "aborted", { reason: "forbidden" });
  const settled = readAccessAttempt(scope);
  expect(settled?.state).toBe("aborted");
  expect(settled?.state).not.toBe("committed");
  expect(settled?.result).toEqual({ reason: "forbidden" });
});

test("a remount rejoins the retained attempt with its original identity and context", async () => {
  const scope = accessScope("board-move", "board-1");
  const first = beginAccessAttempt(scope, "board-move", { boardId: "board-1", destinationWorkspaceId: "workspace-b" });

  // The dialog is closed and reopened — or the route remounts — and would submit
  // a different destination. The live operation still owns the operationId and
  // the payload the server hashed, so it must not be replaced.
  const resentOperationIds: string[] = [];
  const second = await requestAccessChange(scope, "board-move", { boardId: "board-1", destinationWorkspaceId: "workspace-c" }, (current) => {
    resentOperationIds.push(current.operationId);
    return Promise.resolve(pendingEnvelope(current.operationId));
  });

  expect(second.operationId).toBe(first.operationId);
  expect(second.context.destinationWorkspaceId).toBe("workspace-b");
  expect(resentOperationIds).toEqual([first.operationId]);
});

test("attempts for different subjects keep separate identities and contexts", () => {
  const boardA = accessScope("board-delete", "workspace-a", "board-a");
  const boardB = accessScope("board-delete", "workspace-b", "board-b");
  const attemptA = beginAccessAttempt(boardA, "board-delete", { boardId: "board-a", workspaceId: "workspace-a" });
  const attemptB = beginAccessAttempt(boardB, "board-delete", { boardId: "board-b", workspaceId: "workspace-b" });
  expect(attemptA.operationId).not.toBe(attemptB.operationId);

  // A → B → A: a page for workspace B observes only its own scope, so it can
  // neither deliver nor overwrite the attempt workspace A started, and going
  // back to A still finds the original context.
  const workspaceAPrefix = accessSubjectPrefix("board-delete", "workspace-a");
  const workspaceBPrefix = accessSubjectPrefix("board-delete", "workspace-b");
  expect(attemptA.scopeKey.startsWith(workspaceAPrefix)).toBe(true);
  expect(attemptA.scopeKey.startsWith(workspaceBPrefix)).toBe(false);
  expect(attemptB.scopeKey.startsWith(workspaceBPrefix)).toBe(true);

  const reopenedInA = beginAccessAttempt(boardA, "board-delete", { boardId: "board-a", workspaceId: "workspace-b" });
  expect(reopenedInA.operationId).toBe(attemptA.operationId);
  expect(reopenedInA.context.workspaceId).toBe("workspace-a");

  clearAccessAttempt(boardB, attemptB.operationId);
  expect(readAccessAttempt(boardB)).toBeUndefined();
  expect(readAccessAttempt(boardA)?.operationId).toBe(attemptA.operationId);
});

test("a status read tells a live attempt from one the server never journalled", () => {
  const operationId = "11111111-1111-4111-8111-111111111111";
  // Still preparing, and the D1 phase already committed: both are live.
  expect(interpretAccessStatus(pendingEnvelope(operationId), null)).toEqual({ kind: "pending" });
  expect(interpretAccessStatus(completedEnvelope(operationId, "committed"), null)).toEqual({
    kind: "settled",
    outcome: { state: "committed", operationId, result: null },
  });
  // A 404 is the server holding no such operation: the identity can never
  // resolve, so polling must stop and the attempt must be released.
  expect(interpretAccessStatus(null, new AccessRequestError(404, "not found"))).toEqual({ kind: "unresolvable" });
  // A failure that says nothing about the operation leaves it recoverable.
  expect(interpretAccessStatus(null, new AccessRequestError(500, "boom"))).toEqual({ kind: "unknown" });
  expect(interpretAccessStatus(null, new Error("network down"))).toEqual({ kind: "unknown" });
  expect(interpretAccessStatus({ unexpected: true }, null)).toEqual({ kind: "unknown" });
});

test("a status 404 does not discard the retained identity of a request still in flight", () => {
  // The poll can reach the status endpoint before the write it belongs to has
  // been journalled (a slow 5xx response, an intercepted request). Dropping the
  // attempt there is what silently swallowed the outcome of the real response.
  const scope = accessScope("board-delete", "workspace-a", "board-1");
  const attempt = beginAccessAttempt(scope, "board-delete", { boardId: "board-1", workspaceId: "workspace-a" });
  expect(interpretAccessStatus(null, new AccessRequestError(404, "not found"))).toEqual({ kind: "unresolvable" });

  expect(markAccessAttemptUnresolvable(attempt.operationId)).toBe(true);
  expect(isPollingExhausted(attempt.operationId)).toBe(true);
  expect(readAccessAttempt(scope)?.state).toBe("pending");
  expect(readAccessAttempt(scope)?.operationId).toBe(attempt.operationId);

  // The attempt's own response is still the authority, and it re-enables polling.
  settleFromStatus(scope, attempt.operationId, "committed");
  expect(readAccessAttempt(scope)?.state).toBe("committed");
  expect(isPollingExhausted(attempt.operationId)).toBe(false);

  // Releasing the identity releases the mark with it.
  markAccessAttemptUnresolvable(attempt.operationId);
  clearAccessAttempt(scope, attempt.operationId);
  expect(isPollingExhausted(attempt.operationId)).toBe(false);
});

test("a 202 on the attempt's own response revives polling the status 404 had stopped", async () => {
  const workspaceId = "workspace-1";
  const scope = accessScope("workspace-invite-accept", workspaceId, "user-1");
  const first = beginAccessAttempt(scope, "workspace-invite-accept", { workspaceId, token: "token-1" });
  // The page that consumed this attempt observes the workspace-wide prefix, so
  // an attempt whose first segment were the account alone would be unreachable.
  expect(first.scopeKey.startsWith(accessSubjectPrefix("workspace-invite-accept", workspaceId))).toBe(true);
  markAccessAttemptUnresolvable(first.operationId);
  expect(isPollingExhausted(first.operationId)).toBe(true);

  // The user retries and the server answers 202: the operation exists now, so
  // the same id becomes pollable again without becoming a new operation.
  const sent: string[] = [];
  const rejoined = await requestAccessChange(
    scope,
    "workspace-invite-accept",
    { workspaceId, token: "token-2" },
    (attempt) => {
      sent.push(attempt.operationId);
      return Promise.resolve(pendingEnvelope(attempt.operationId));
    },
  );
  expect(sent).toEqual([first.operationId]);
  expect(rejoined.operationId).toBe(first.operationId);
  // The retained token is the payload the server hashed, not the one in the hash now.
  expect(rejoined.context.token).toBe("token-1");
  expect(readAccessAttempt(scope)?.state).toBe("pending");
  expect(isPollingExhausted(first.operationId)).toBe(false);
});

test("a member role change replayed under a later selection still sends the retained role", async () => {
  const scope = accessScope("workspace-member-role", "workspace-1", "user-2");
  const first = beginAccessAttempt(scope, "workspace-member-role", {
    workspaceId: "workspace-1",
    userId: "user-2",
    name: "Ada",
    role: "admin",
  });

  const sent: { operationId: string; role: string }[] = [];
  await requestAccessChange(
    scope,
    "workspace-member-role",
    { workspaceId: "workspace-1", userId: "user-2", name: "Ada", role: "member" },
    (attempt) => {
      sent.push({ operationId: attempt.operationId, role: attempt.context.role ?? "" });
      return Promise.resolve(pendingEnvelope(attempt.operationId));
    },
  );
  expect(sent).toEqual([{ operationId: first.operationId, role: "admin" }]);
});

test("a server refusal clears the attempt while a transport failure keeps it recoverable", async () => {
  const refusedScope = accessScope("board-member-add", "board-1", "user-1");
  await expect(
    requestAccessChange(refusedScope, "board-member-add", { boardId: "board-1", userId: "user-1" }, () =>
      Promise.reject(new AccessRequestError(403, "forbidden")),
    ),
  ).rejects.toThrow("forbidden");
  expect(readAccessAttempt(refusedScope)).toBeUndefined();

  const unreachableScope = accessScope("board-member-add", "board-2", "user-2");
  await expect(
    requestAccessChange(unreachableScope, "board-member-add", { boardId: "board-2", userId: "user-2" }, () =>
      Promise.reject(new Error("network down")),
    ),
  ).rejects.toThrow("network down");
  // The request may have been applied anyway: keep the operationId to check it.
  expect(readAccessAttempt(unreachableScope)?.state).toBe("pending");
});

test("a pending access change never consumes the transport failure budget", () => {
  let attempt = 0;
  let failures = 0;
  let inTransition = false;
  for (let close = 0; close < 8; close += 1) {
    const plan = planBoardReconnect({ code: 1006, attempt, failures, inTransition, probe: "pending" });
    expect(plan.mode).toBe("transition");
    expect(plan.delayMs).toBe(ACCESS_ATTEMPT_POLL_MS);
    expect(plan.failures).toBe(0);
    ({ attempt, failures, inTransition } = plan);
  }
});

test("4010 enters transition and a later successful read restores the ordinary budget", () => {
  const closed = planBoardReconnect({ code: 4010, attempt: 0, failures: 2, inTransition: false, probe: "ready" });
  expect(closed).toMatchObject({ mode: "transition", inTransition: true, failures: 0 });
  expect(closed.delayMs).toBe(ACCESS_ATTEMPT_POLL_MS);

  // The metadata read succeeded after the transition began: this is a real
  // transport failure again, so the unsynchronized-failure budget applies.
  const first = planBoardReconnect({ code: 1006, attempt: 0, failures: 0, inTransition: true, probe: "ready" });
  expect(first).toMatchObject({ mode: "transport", inTransition: false, failures: 1 });
  expect(first.delayMs).toBe(500);

  const second = planBoardReconnect({ code: 1006, attempt: 1, failures: 1, inTransition: false, probe: "ready" });
  expect(second).toMatchObject({ mode: "transport", failures: 2 });

  const third = planBoardReconnect({ code: 1006, attempt: 2, failures: 2, inTransition: false, probe: "ready" });
  expect(third).toMatchObject({ mode: "stopped", delayMs: null });
});

test("a stale metadata read cannot claim the board is ready during a transition", () => {
  // "unknown" means no read has landed since the transition began, so the close
  // is still a transition close rather than a transport one.
  const plan = planBoardReconnect({ code: 1006, attempt: 0, failures: 0, inTransition: true, probe: "unknown" });
  expect(plan).toMatchObject({ mode: "transition", failures: 0 });
});

test("a denied close stops reconnecting", () => {
  expect(planBoardReconnect({ code: 4003, attempt: 3, failures: 2, inTransition: true, probe: "ready" })).toMatchObject({
    mode: "denied",
    delayMs: null,
  });
});

test("denial cleanup removes every board-private key and leaves other context alone", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const identity = { boardId: "board-1", boardKey: "KEY" };
  for (const key of [...boardPrivateCacheKeys(identity), ["board-members", "board-2"], ["workspace-members", "workspace-1"], ["boards", "workspace-1"]])
    client.setQueryData(key, "private");
  client.setQueryData(["card-development", "board-1", "card-1"], "development");
  client.setQueryData(["card-activity", "board-1", "card-1"], "history");

  clearBoardAccessCaches(client, identity);

  for (const key of [
    ["board", "board-1"],
    ["board-meta", "board-1"],
    ["board-meta-by-key", "KEY"],
    ["board-members", "board-1"],
    ["board-membership-candidates", "board-1"],
    ["board-transfer-options", "board-1"],
    ["card-development", "board-1"],
    ["card-development", "board-1", "card-1"],
    ["card-activity", "board-1"],
    ["card-activity", "board-1", "card-1"],
    ["board-development", "board-1"],
    ["connected-repos", "board-1"],
  ]) {
    expect(client.getQueryData(key), `expected ${JSON.stringify(key)} to be cleared`).toBeUndefined();
  }
  expect(client.getQueryData(["board-members", "board-2"])).toBe("private");
  expect(client.getQueryData(["workspace-members", "workspace-1"])).toBe("private");
  expect(client.getQueryData(["boards", "workspace-1"])).toBe("private");
  client.clear();
});

test("a read still in flight when denial lands cannot reinstall board data", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let releaseRead: (value: string) => void = () => undefined;
  const read = client.query({
    queryKey: ["board-members", "board-1"],
    queryFn: () => new Promise<string>((resolve) => { releaseRead = resolve; }),
  });
  await Promise.resolve();

  clearBoardAccessCaches(client, { boardId: "board-1", boardKey: "KEY" });
  releaseRead("members that must never be shown");
  await read.catch(() => undefined);
  await Promise.resolve();

  expect(client.getQueryData(["board-members", "board-1"])).toBeUndefined();
  expect(client.getQueryData(["board", "board-1"])).toBeUndefined();
  client.clear();
});

test("a settled outcome survives a remount until its consumer forgets it", () => {
  const scope = accessScope("board-delete", "board-1");
  const attempt = beginAccessAttempt(scope, "board-delete", { boardId: "board-1" });
  settleFromStatus(scope, attempt.operationId, "committed");
  expect(readAccessAttempt(scope)?.state).toBe("committed");

  // A stale continuation from a different operation cannot clear or settle it.
  clearAccessAttempt(scope, "22222222-2222-4222-8222-222222222222");
  settleFromStatus(scope, "22222222-2222-4222-8222-222222222222", "aborted");
  expect(readAccessAttempt(scope)?.state).toBe("committed");

  clearAccessAttempt(scope, attempt.operationId);
  expect(readAccessAttempt(scope)).toBeUndefined();
});
