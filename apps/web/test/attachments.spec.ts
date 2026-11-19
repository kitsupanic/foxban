import { expect, test } from "@playwright/test";
import type { Attachment, Card, ClientMessage, ServerMessage } from "@foxban/shared";
import { applyMutation, type BoardState } from "../src/lib/apply-mutation";
import { createAuthoredScope, type AuthoredTransport } from "../src/lib/authored-operation";
import { createBoardAttachments } from "../src/lib/attachments";
import type { MutationSettledStatus } from "../src/lib/socket";

// Service-free (ADR 0049): the socket is played by calling `events` the way `useBoardSocket` does.

const boardId = "board-1";
const url = (id: string) => `/boards/${boardId}/attachments/${id}`;
const original = `Before\n\n![shot](${url("att-1")})\n\nAfter`;
const cleaned = "Before\n\n\n\nAfter";

function board(description = original): BoardState {
  const card: Card = {
    id: "card-1", columnId: "col-1", title: "Owner", description, position: "a0", taskNumber: 1,
    assigneeId: null, priority: "medium", taskType: "task", dueDate: null, subtaskDone: false, createdAt: 1, updatedAt: 1,
  };
  const attachment: Attachment = { id: "att-1", cardId: card.id, fileName: "shot.png", contentType: "image/png", size: 10 };
  return {
    workflowRolesExplicit: false, columns: [{ id: "col-1", title: "Tasks", position: "a0" }], cards: [card], archivedCards: [],
    checklistItems: [], attachments: [attachment], comments: [], commentCounts: {}, relations: [], labels: [], cardLabels: [],
  } as BoardState;
}
const snapshot = (attachments: Attachment[]) => ({ type: "snapshot", attachments }) as unknown as Extract<ServerMessage, { type: "snapshot" }>;
const deleteMessage = (mutationId: string): ClientMessage => ({ type: "attachment.delete", mutationId, id: "att-1" });

/** Sends an own delete: the socket reports the cache before and after the optimistic apply. */
function sendDelete(attachments: ReturnType<typeof createBoardAttachments>, mutationId = "del-1") {
  const before = board();
  attachments.events.snapshot?.(snapshot(before.attachments));
  const msg = deleteMessage(mutationId);
  const after = applyMutation(before, msg, boardId);
  attachments.events.sent?.(msg, before, after);
  return { before, after, msg };
}

test("an in-flight delete gates Save and seeds the pre-delete text; a refused delete rolls back to the plain seed", () => {
  const attachments = createBoardAttachments(boardId);
  const { after } = sendDelete(attachments);
  const optimistic = after.cards[0].description;
  expect(optimistic).toBe(cleaned);

  expect(attachments.getView().isDeletePending("card-1")).toBe(true);
  // A modal opened now sees the optimistic cache, but must seed the text the server still has.
  expect(attachments.seedDescription("card-1", optimistic)).toBe(original);
  expect(attachments.seedDescription("card-2", optimistic)).toBe(optimistic);

  // Rejected or timed out: the socket rolls the cache back and resolves the mutation.
  attachments.events.resolved?.("del-1");
  expect(attachments.getView().isDeletePending("card-1")).toBe(false);
  expect(attachments.seedDescription("card-1", original)).toBe(original);
  // Nothing was confirmed, so open drafts keep the embed.
  expect(attachments.getView().descriptionFor("card-1", original)).toBe(original);
});

test("an accepted own delete strips the embed from open drafts and ends the gate", () => {
  const attachments = createBoardAttachments(boardId);
  sendDelete(attachments);
  const views: unknown[] = [];
  attachments.subscribe(() => views.push(attachments.getView()));

  attachments.events.message?.({ type: "attachment.delete", mutationId: "del-1", id: "att-1" } as ServerMessage, true);
  attachments.events.resolved?.("del-1");

  const view = attachments.getView();
  expect(view.isDeletePending("card-1")).toBe(false);
  expect(view.descriptionFor("card-1", `${original}\n\nunsaved prose`)).toBe(`${cleaned}\n\nunsaved prose`);
  expect(view.descriptionFor("card-2", original)).toBe(original);
  expect(views.length).toBeGreaterThan(0);
});

test("a peer's accepted delete retires the own pending delete of the same attachment", () => {
  const attachments = createBoardAttachments(boardId);
  sendDelete(attachments);
  attachments.events.message?.({ type: "attachment.delete", mutationId: "peer-1", id: "att-1" } as ServerMessage, false);
  expect(attachments.getView().isDeletePending("card-1")).toBe(false);
  expect(attachments.getView().descriptionFor("card-1", original)).toBe(cleaned);
});

test("a snapshot proves an attachment gone, and a re-create clears that evidence", () => {
  const attachments = createBoardAttachments(boardId);
  attachments.events.snapshot?.(snapshot(board().attachments));
  attachments.events.snapshot?.(snapshot([]));
  expect(attachments.getView().descriptionFor("card-1", original)).toBe(cleaned);

  attachments.events.message?.({ type: "attachment.create", mutationId: "m", id: "att-1", cardId: "card-1", fileName: "shot.png", contentType: "image/png", size: 10 } as ServerMessage, false);
  expect(attachments.getView().descriptionFor("card-1", original)).toBe(original);
});

test("a transport close does not drop delete evidence; only the reconnect snapshot does", () => {
  const attachments = createBoardAttachments(boardId);
  sendDelete(attachments);
  // A close calls none of the events; the gate holds until the snapshot.
  expect(attachments.getView().isDeletePending("card-1")).toBe(true);
  attachments.events.snapshot?.(snapshot(board().attachments));
  expect(attachments.getView().isDeletePending("card-1")).toBe(false);
  expect(attachments.seedDescription("card-1", cleaned)).toBe(cleaned);
});

// --- upload ---

function fakeTransport() {
  const sends: ClientMessage[] = [];
  const callbacks = new Map<string, Parameters<AuthoredTransport["subscribe"]>[1]>();
  const state = { connected: true };
  const transport: AuthoredTransport = {
    send(message) {
      if (!state.connected) return false;
      sends.push(message);
      return true;
    },
    subscribe(mutationId, callback) {
      callbacks.set(mutationId, callback);
      return () => void callbacks.delete(mutationId);
    },
    retire: () => {},
    readBoard: () => undefined,
  };
  const fire = (status: MutationSettledStatus, error?: string) => {
    const { mutationId } = sends.at(-1)!;
    callbacks.get(mutationId)?.({ mutationId, status, error });
  };
  return { transport, sends, state, fire };
}

function uploadSetup(response: { ok: boolean; body?: unknown } = { ok: true, body: { id: "att-9", contentType: "application/pdf", size: 4 } }) {
  const posts: { input: string; init?: RequestInit }[] = [];
  const attachments = createBoardAttachments(boardId, {
    fetch: async (input, init) => {
      posts.push({ input: String(input), init });
      return { ok: response.ok, json: async () => response.body } as Response;
    },
  });
  const fake = fakeTransport();
  const scope = createAuthoredScope(fake.transport);
  const file = new File(["%PDF"], "spec (v2).pdf", { type: "application/pdf" });
  return { attachments, fake, scope, posts, file };
}

/** Lets the POST and JSON body resolve so `attachment.create` goes out. */
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("upload POSTs the bytes, then resolves only when attachment.create is accepted", async () => {
  const { attachments, fake, scope, posts, file } = uploadSetup();
  let settled = false;
  const result = attachments.upload({ file, cardId: "card-1", scope }).finally(() => { settled = true; });
  await flush();

  expect(posts).toEqual([{ input: `/boards/${boardId}/attachments`, init: expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/pdf" } }) }]);
  expect(fake.sends).toEqual([
    { type: "attachment.create", mutationId: expect.any(String), id: "att-9", cardId: "card-1", fileName: "spec (v2).pdf", contentType: "application/pdf", size: 4 },
  ]);
  expect(settled).toBe(false);

  fake.fire("accepted");
  await expect(result).resolves.toEqual({ url: url("att-9"), alt: "spec v2.pdf" });
});

test("an upload accepted late, after a timeout, still resolves", async () => {
  const { attachments, fake, scope, file } = uploadSetup();
  let outcome: string | undefined;
  const result = attachments.upload({ file, cardId: "card-1", scope }).then(() => (outcome = "resolved"), () => (outcome = "rejected"));
  await flush();

  fake.fire("timeout");
  fake.fire("uncertain");
  await flush();
  expect(outcome).toBeUndefined();

  // The reconnect snapshot finds the attachment.
  fake.fire("accepted");
  await result;
  expect(outcome).toBe("resolved");
  expect(scope.hasActiveWork()).toBe(false);
});

test("an upload the snapshot cannot find fails as unconfirmed", async () => {
  const { attachments, fake, scope, file } = uploadSetup();
  const result = attachments.upload({ file, cardId: "card-1", scope });
  await flush();
  fake.fire("timeout");
  fake.fire("verified-retry");
  await expect(result).rejects.toThrow("Could not confirm the upload — try again.");
  expect(scope.hasActiveWork()).toBe(false);
});

test("a refused upload rejects with the server's reason, or the fallback copy", async () => {
  const first = uploadSetup();
  const refused = first.attachments.upload({ file: first.file, cardId: "card-1", scope: first.scope });
  await flush();
  first.fake.fire("rejected", "Card not found.");
  await expect(refused).rejects.toThrow("Card not found.");

  const second = uploadSetup();
  const bare = second.attachments.upload({ file: second.file, cardId: "card-1", scope: second.scope });
  await flush();
  second.fake.fire("rejected");
  await expect(bare).rejects.toThrow("Could not attach the upload.");
});

test("upload fails fast when offline, when the POST fails, or before spending bytes on a bad name", async () => {
  const offline = uploadSetup();
  offline.fake.state.connected = false;
  await expect(offline.attachments.upload({ file: offline.file, cardId: "card-1", scope: offline.scope })).rejects.toThrow("Not connected — try again.");

  const failedPost = uploadSetup({ ok: false });
  await expect(failedPost.attachments.upload({ file: failedPost.file, cardId: "card-1", scope: failedPost.scope })).rejects.toThrow("Could not upload the attachment.");
  expect(failedPost.fake.sends).toEqual([]);

  const badName = uploadSetup();
  const file = new File(["x"], "a".repeat(201), { type: "application/pdf" });
  await expect(badName.attachments.upload({ file, cardId: "card-1", scope: badName.scope })).rejects.toThrow("File name must be 200 characters or fewer.");
  expect(badName.posts).toEqual([]);
});

test("an uncertain upload fails out when the socket halts instead of waiting forever", async () => {
  const { attachments, fake, scope, file } = uploadSetup();
  const result = attachments.upload({ file, cardId: "card-1", scope });
  await flush();
  fake.fire("timeout");
  // Denied, or the reconnect budget ran out: no snapshot is coming.
  attachments.events.halted?.();
  await expect(result).rejects.toThrow("Could not confirm the upload — try again.");
  expect(scope.hasActiveWork()).toBe(false);
  // A late answer after the fail-out changes nothing.
  fake.fire("accepted");
});

test("an upload discarded by its scope, or started on a disposed one, rejects", async () => {
  const discarded = uploadSetup();
  const pendingUpload = discarded.attachments.upload({ file: discarded.file, cardId: "card-1", scope: discarded.scope });
  await flush();
  discarded.scope.dispose();
  await expect(pendingUpload).rejects.toThrow("Could not confirm the upload — try again.");

  const disposed = uploadSetup();
  disposed.scope.dispose();
  await expect(disposed.attachments.upload({ file: disposed.file, cardId: "card-1", scope: disposed.scope })).rejects.toThrow("Could not attach the upload.");
  expect(disposed.fake.sends).toEqual([]);
});
