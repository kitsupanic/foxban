import { expect, test } from "@playwright/test";
import type { ClientMessage, Comment } from "@foxban/shared";
import type { BoardState } from "../src/lib/apply-mutation";
import { createAuthoredScope, type AuthoredTransport } from "../src/lib/authored-operation";
import { createCommentThread } from "../src/lib/comment-thread";
import type { MutationSettledStatus } from "../src/lib/socket";

// Callbacks stay reachable after unsubscribe so the tests can prove the core ignores them itself.
function fakeTransport() {
  const sends: ClientMessage[] = [];
  const subscribed: string[] = [];
  const callbacks = new Map<string, Parameters<AuthoredTransport["subscribe"]>[1]>();
  const state = { connected: true, board: undefined as BoardState | undefined };
  return {
    state,
    sends,
    ids: subscribed,
    fire(mutationId: string, status: MutationSettledStatus, error?: string) {
      callbacks.get(mutationId)?.({ mutationId, status, error });
    },
    transport: {
      send(message) {
        if (!state.connected) return false;
        sends.push(message);
        return true;
      },
      subscribe(mutationId, callback) {
        subscribed.push(mutationId);
        callbacks.set(mutationId, callback);
        return () => {};
      },
      retire: () => {},
      readBoard: () => state.board,
    } satisfies AuthoredTransport,
  };
}

const comment = (id: string, body: string, parentCommentId: string | null = null): Comment => ({
  id,
  cardId: "card-1",
  authorId: "user-1",
  parentCommentId,
  body,
  createdAt: 1,
  updatedAt: 1,
  deleted: false,
});
const tombstone = (id: string): Comment => ({ ...comment(id, ""), deleted: true });
const boardWith = (...found: { id: string; deleted: boolean }[]) => ({ comments: found }) as unknown as BoardState;

const UPLOADED = { url: "/boards/b/attachments/a1", alt: "pic.png" };
const EMBED = "![pic.png](/boards/b/attachments/a1)";
const png = () => new File(["x"], "pic.png", { type: "image/png" });

function setup(comments: Comment[] = []) {
  const fake = fakeTransport();
  const scope = createAuthoredScope(fake.transport);
  const env = {
    comments,
    me: { id: "user-1" } as { id: string } | null,
    // Every requestClose parks its action, as a dirty modal does; a test runs it to confirm the discard.
    parked: [] as (() => void)[],
    focused: [] as string[],
    uploads: [] as { file: File; options?: { rasterizeSvg?: boolean }; resolve(value: { url: string; alt: string }): void; reject(error: Error): void }[],
  };
  const thread = createCommentThread(scope, {
    cardId: () => "card-1",
    me: () => env.me,
    comments: () => env.comments,
    requestClose: (action) => void env.parked.push(action),
    upload: (file, options) => new Promise((resolve, reject) => void env.uploads.push({ file, options, resolve, reject })),
    onReplyClosed: (targetId) => void env.focused.push(targetId),
  });
  const last = () => fake.ids[fake.ids.length - 1];
  const compose = (text: string) => {
    thread.openComposer();
    thread.setDraft(text);
  };
  return { fake, env, thread, last, compose };
}

test("a comment goes out with its author and trimmed body, and a retry is the same comment", () => {
  const { fake, thread, last, compose } = setup();
  compose("  Looks good ");
  thread.submitComment();
  const first = fake.sends[0] as { id: string };
  expect(fake.sends[0]).toEqual({
    type: "comment.create",
    mutationId: last(),
    id: first.id,
    cardId: "card-1",
    authorId: "user-1",
    parentCommentId: null,
    body: "Looks good",
    createdAt: expect.any(Number),
  });
  expect(thread.getState()).toMatchObject({ composing: true, draft: "  Looks good ", composer: { pending: true, uncertain: false, error: null, recovery: null } });
  const firstAttempt = last();

  fake.fire(last(), "rejected");
  expect(thread.getState().composer).toEqual({
    pending: false,
    uncertain: false,
    error: null,
    recovery: { error: "Server rejected comment.", rawDraft: "  Looks good ", parentCommentId: null },
  });
  expect(thread.getState().draft).toBe("  Looks good ");

  thread.retryCommentRecovery();
  expect(fake.sends).toHaveLength(2);
  expect(fake.sends[1]).toMatchObject({ type: "comment.create", id: first.id, body: "Looks good" });
  expect(last()).not.toBe(firstAttempt);
  expect(thread.getState().composer).toMatchObject({ pending: true, recovery: { error: "Server rejected comment." } });
});

test("a comment retry after discard is not sent", () => {
  const { fake, thread, compose } = setup();
  compose("Looks good");
  thread.submitComment();
  fake.fire(fake.ids[0], "rejected");
  expect(thread.getState().composer.recovery).not.toBeNull();

  thread.discardCommentRecovery();
  expect(thread.getState().composer).toMatchObject({ pending: false, error: null, recovery: null });
  thread.retryCommentRecovery();
  expect(fake.sends).toHaveLength(1);
  expect(thread.getState().composer.pending).toBe(false);
  // The draft is still there to be sent as a fresh lineage.
  expect(thread.getState()).toMatchObject({ composing: true, draft: "Looks good" });
});

test("acceptance clears the composer only while the draft is unchanged, no newer generation took over and no image uploads", async () => {
  const { fake, env, thread, last, compose } = setup();
  compose("Looks good");
  thread.submitComment();
  fake.fire(last(), "accepted");
  expect(thread.getState()).toMatchObject({ composing: false, draft: "", feedbackResetToken: 1, composer: { pending: false, recovery: null }, hasWork: false });

  // Typed on after the submit: the draft is the user's, not the accepted comment.
  compose("Looks good");
  thread.submitComment();
  thread.setDraft("Looks good, ship it");
  fake.fire(last(), "accepted");
  expect(thread.getState()).toMatchObject({ composing: true, draft: "Looks good, ship it", composer: { pending: false } });

  // A cancel after the submit forgets the lineage: its late acceptance changes nothing, even when
  // the field holds the same text again.
  thread.submitComment();
  const submitted = last();
  thread.cancelComposer(true);
  expect(thread.getState()).toMatchObject({ composing: false, draft: "" });
  compose("Looks good, ship it");
  fake.fire(submitted, "accepted");
  expect(thread.getState()).toMatchObject({ composing: true, draft: "Looks good, ship it" });

  // An image still being prepared belongs to the draft the acceptance would throw away.
  thread.submitComment();
  const upload = thread.uploadCommentImage(png());
  expect(thread.getState().uploading).toBe(true);
  fake.fire(last(), "accepted");
  expect(thread.getState()).toMatchObject({ composing: true, draft: "Looks good, ship it", uploading: true });
  env.uploads[0].resolve(UPLOADED);
  await upload;
  expect(thread.getState().uploading).toBe(false);
});

test("a first attempt that never left is an inline error, and a retry's failure is a recovery", () => {
  const { fake, thread, last, compose } = setup();
  fake.state.connected = false;
  compose("Hello");
  thread.submitComment();
  expect(fake.sends).toEqual([]);
  expect(thread.getState().composer).toEqual({ pending: false, uncertain: false, error: "Not connected — try again.", recovery: null });
  expect(thread.getState()).toMatchObject({ draft: "Hello", hasWork: true });

  // Typing dismisses it; the next submit is a new lineage.
  thread.setDraft("Hello!");
  expect(thread.getState().composer.error).toBeNull();
  fake.state.connected = true;
  thread.submitComment();
  expect(fake.sends).toHaveLength(1);

  // A retry that does not leave is a recovery, and keeps showing why.
  fake.fire(last(), "rejected", "No room.");
  expect(thread.getState().composer.recovery).toMatchObject({ error: "No room." });
  fake.state.connected = false;
  thread.retryCommentRecovery();
  expect(thread.getState().composer).toMatchObject({
    pending: false,
    error: null,
    recovery: { error: "Not connected — try again.", rawDraft: "Hello!" },
  });
});

test("a blank draft, no signed-in user, a write in flight, a recovery or an upload each ignore a submit", async () => {
  const { fake, env, thread, last, compose } = setup();
  compose("   ");
  thread.submitComment();
  expect(fake.sends).toEqual([]);

  thread.setDraft("Hello");
  env.me = null;
  thread.submitComment();
  expect(fake.sends).toEqual([]);
  env.me = { id: "user-1" };
  thread.submitComment();
  thread.submitComment();
  expect(fake.sends).toHaveLength(1);

  fake.fire(last(), "timeout");
  expect(thread.getState().composer).toMatchObject({ pending: true, uncertain: true });
  thread.submitComment();
  thread.retryCommentRecovery();
  expect(fake.sends).toHaveLength(1);

  // An unverified attempt is a recovery; a new submit waits for retry or discard.
  fake.fire(last(), "verified-retry");
  expect(thread.getState().composer).toMatchObject({ pending: false, recovery: { error: "Sync could not verify comment. You can retry sending." } });
  thread.submitComment();
  expect(fake.sends).toHaveLength(1);

  thread.discardCommentRecovery();
  const upload = thread.uploadCommentImage(png());
  thread.submitComment();
  thread.retryCommentRecovery();
  expect(fake.sends).toHaveLength(1);
  env.uploads[0].resolve(UPLOADED);
  await upload;
  thread.submitComment();
  expect(fake.sends).toHaveLength(2);
});

test("cancelling the composer is ignored while an image uploads or a write is in flight unless forced", async () => {
  const { fake, env, thread, last, compose } = setup();
  compose("Hello");
  const upload = thread.uploadCommentImage(png());
  thread.cancelComposer();
  expect(thread.getState()).toMatchObject({ composing: true, draft: "Hello", feedbackResetToken: 0 });
  env.uploads[0].resolve(UPLOADED);
  await upload;

  thread.submitComment();
  thread.cancelComposer();
  expect(thread.getState()).toMatchObject({ composing: true, draft: "Hello" });
  fake.fire(last(), "rejected");
  // A recovery does not block Cancel: it is the draft that goes, the recovery stays on screen.
  thread.cancelComposer();
  expect(thread.getState()).toMatchObject({ composing: false, draft: "", feedbackResetToken: 1, composer: { recovery: { rawDraft: "Hello" } } });
});

test("an image upload holds one flag, refuses what is not a PNG, JPEG, GIF or WebP, and clears the flag when it fails", async () => {
  const { env, thread, compose } = setup();
  compose("Hello");
  await expect(thread.uploadCommentImage(new File(["x"], "notes.txt", { type: "text/plain" }))).rejects.toThrow("Choose a PNG, JPEG, GIF, or WebP image.");
  await expect(thread.uploadCommentImage(new File(["<svg/>"], "pic.svg", { type: "image/svg+xml" }))).rejects.toThrow("Choose a PNG, JPEG, GIF, or WebP image.");
  expect(env.uploads).toEqual([]);
  expect(thread.getState().uploading).toBe(false);

  const first = thread.uploadCommentImage(png());
  expect(thread.getState().uploading).toBe(true);
  expect(env.uploads).toHaveLength(1);
  expect(env.uploads[0].options).toEqual({ rasterizeSvg: false });
  await expect(thread.uploadCommentImage(png())).rejects.toThrow("An image is still uploading. Paste again when it finishes.");
  expect(thread.getState().uploading).toBe(true);
  env.uploads[0].resolve(UPLOADED);
  await expect(first).resolves.toEqual(UPLOADED);
  expect(thread.getState().uploading).toBe(false);

  const failing = thread.uploadCommentImage(png());
  env.uploads[1].reject(new Error("Could not upload the attachment."));
  await expect(failing).rejects.toThrow("Could not upload the attachment.");
  expect(thread.getState().uploading).toBe(false);
});

test("a reply to a reply flattens to the thread root, goes out under it and acceptance returns focus", () => {
  const root = comment("c1", "Root");
  const child = comment("c2", "Child", "c1");
  const { fake, env, thread, last } = setup([root, child]);
  thread.startReply(child);
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c2", replyingRootId: "c1", replyDraft: "" });
  thread.setReplyDraft(" Agreed ");
  thread.submitReply("c1");
  expect(fake.sends[0]).toEqual({
    type: "comment.create",
    mutationId: last(),
    id: (fake.sends[0] as { id: string }).id,
    cardId: "card-1",
    authorId: "user-1",
    parentCommentId: "c1",
    body: "Agreed",
    createdAt: expect.any(Number),
  });
  expect(thread.getState().reply).toMatchObject({ pending: true });

  fake.fire(last(), "accepted");
  expect(thread.getState()).toMatchObject({ replyingCommentId: null, replyingRootId: null, replyDraft: "", reply: { pending: false, recovery: null }, hasWork: false });
  expect(env.focused).toEqual(["c2"]);
});

test("a reply after its parent comment is deleted is rejected with the server's text and keeps the draft", () => {
  const root = comment("c1", "Root");
  const { fake, env, thread, last } = setup([root]);
  thread.startReply(root);
  thread.setReplyDraft("Agreed");
  thread.submitReply("c1");
  env.comments = [];
  fake.fire(last(), "rejected", "Reply target is unavailable.");

  expect(thread.getState().reply).toEqual({
    pending: false,
    uncertain: false,
    error: null,
    recovery: { error: "Reply target is unavailable.", rawDraft: "Agreed", parentCommentId: "c1" },
  });
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c1", replyDraft: "Agreed", hasWork: true, keepsCardOpen: true });
  expect(env.focused).toEqual([]);

  // Discarding the recovery keeps the draft in the composer.
  thread.discardReplyRecovery();
  expect(thread.getState()).toMatchObject({ reply: { recovery: null }, replyDraft: "Agreed" });
});

test("a late acceptance of a reply does not close a composer the user has moved on in", () => {
  const root = comment("c1", "Root");
  const { fake, env, thread, last } = setup([root]);
  thread.startReply(root);
  thread.setReplyDraft("Agreed");
  thread.submitReply("c1");
  const submitted = last();

  // The draft moved on after the submit.
  thread.setReplyDraft("Agreed, but");
  fake.fire(submitted, "accepted");
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c1", replyDraft: "Agreed, but" });

  // A cancel and a fresh composer with the same text is a newer generation, and the earlier
  // attempt, failed as unverified but still live, may be accepted late.
  thread.setReplyDraft("Agreed");
  thread.submitReply("c1");
  const second = last();
  fake.fire(second, "timeout");
  fake.fire(second, "verified-retry");
  thread.cancelReplyComposer();
  expect(env.focused).toEqual(["c1"]);
  thread.startReply(root);
  thread.setReplyDraft("Agreed");
  fake.fire(second, "accepted");
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c1", replyDraft: "Agreed", reply: { pending: false } });
  expect(env.focused).toEqual(["c1"]);
});

test("cancelling a reply is ignored while it uploads or is in flight unless forced, and returns focus to its Reply button", async () => {
  const root = comment("c1", "Root");
  const { fake, env, thread, last } = setup([root]);
  thread.startReply(root);
  const upload = thread.uploadReplyImage(png());
  thread.cancelReplyComposer();
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c1", replyUploading: true });
  env.uploads[0].resolve(UPLOADED);
  await upload;

  thread.setReplyDraft("Agreed");
  thread.submitReply("c1");
  thread.cancelReplyComposer();
  fake.fire(last(), "timeout");
  thread.cancelReplyComposer();
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c1", replyDraft: "Agreed", reply: { pending: true, uncertain: true } });
  expect(env.focused).toEqual([]);

  thread.cancelReplyComposer(true);
  expect(thread.getState()).toMatchObject({ replyingCommentId: null, replyingRootId: null, replyDraft: "" });
  expect(env.focused).toEqual(["c1"]);
});

test("starting a reply is ignored while one uploads, is in flight or is orphaned, and a typed reply elsewhere waits behind the discard strip", async () => {
  const a = comment("c1", "A");
  const b = comment("c2", "B");
  const { fake, env, thread } = setup([a, b]);
  thread.startReply(a);
  const opened = thread.getState();
  thread.startReply(a);
  expect(thread.getState()).toBe(opened);

  // An empty composer moves at once.
  thread.startReply(b);
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c2", replyingRootId: "c2" });
  expect(env.parked).toEqual([]);

  // A typed one parks the move until the user confirms the discard.
  thread.setReplyDraft("Typed");
  thread.startReply(a);
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c2", replyDraft: "Typed" });
  expect(env.parked).toHaveLength(1);
  env.parked[0]();
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c1", replyingRootId: "c1", replyDraft: "" });

  thread.setReplyDraft("Agreed");
  thread.submitReply("c1");
  thread.startReply(b);
  expect(thread.getState().replyingCommentId).toBe("c1");
  expect(env.parked).toHaveLength(1);
  fake.fire(fake.ids[fake.ids.length - 1], "rejected");
  thread.discardReplyRecovery();

  const upload = thread.uploadReplyImage(png());
  thread.startReply(b);
  expect(thread.getState().replyingCommentId).toBe("c1");
  env.uploads[0].resolve(UPLOADED);
  await upload;

  // A peer deleted the target mid-upload elsewhere: the orphan blocks a new reply until it is dealt with.
  thread.setReplyDraft("");
  env.comments = [b];
  const orphaning = thread.uploadReplyImage(png());
  env.uploads[1].resolve(UPLOADED);
  await orphaning;
  expect(thread.getState().orphanedReply).toEqual({ text: EMBED });
  thread.startReply(b);
  expect(thread.getState().replyingCommentId).toBeNull();
});

test("the reply composer re-anchors to the surviving root when the target reply is deleted", () => {
  const root = comment("c1", "Root");
  const child = comment("c2", "Child", "c1");
  const { env, thread } = setup([root, child]);
  thread.startReply(child);
  thread.setReplyDraft("Agreed");

  env.comments = [root];
  thread.reconcile();
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c1", replyingRootId: "c1", replyDraft: "Agreed" });
  expect(env.parked).toEqual([]);

  // A tombstoned root, kept for its surviving replies, still anchors the composer.
  const second = setup([tombstone("c1"), comment("c3", "Other", "c1")]);
  second.thread.startReply(second.env.comments[1]);
  second.env.comments = [tombstone("c1")];
  second.thread.reconcile();
  expect(second.thread.getState()).toMatchObject({ replyingCommentId: "c1", replyingRootId: "c1" });
  expect(second.env.parked).toEqual([]);
});

test("with no anchor left an empty reply just closes and a typed one goes through requestClose", () => {
  const root = comment("c1", "Root");
  const empty = setup([root]);
  empty.thread.startReply(root);
  empty.env.comments = [];
  empty.thread.reconcile();
  expect(empty.thread.getState()).toMatchObject({ replyingCommentId: null, replyingRootId: null, replyDraft: "" });
  expect(empty.env.parked).toEqual([]);

  const typed = setup([root]);
  typed.thread.startReply(root);
  typed.thread.setReplyDraft("Agreed");
  typed.env.comments = [];
  typed.thread.reconcile();
  expect(typed.thread.getState()).toMatchObject({ replyingCommentId: "c1", replyDraft: "Agreed" });
  expect(typed.env.parked).toHaveLength(1);
  typed.env.parked[0]();
  expect(typed.thread.getState()).toMatchObject({ replyingCommentId: null, replyingRootId: null, replyDraft: "" });
});

test("a live target is left alone, and an uploading composer keeps ownership of a vanished one", async () => {
  const root = comment("c1", "Root");
  const { env, thread } = setup([root]);
  thread.reconcile();
  expect(thread.getState().replyingCommentId).toBeNull();

  thread.startReply(root);
  const before = thread.getState();
  thread.reconcile();
  expect(thread.getState()).toBe(before);

  const upload = thread.uploadReplyImage(png());
  env.comments = [];
  thread.reconcile();
  expect(thread.getState()).toMatchObject({ replyingCommentId: "c1", replyUploading: true });
  expect(env.parked).toEqual([]);
  env.uploads[0].resolve(UPLOADED);
  await upload;
});

test("an upload that finishes after its target was deleted leaves an orphaned reply with the image at the end", async () => {
  const root = comment("c1", "Root");
  const { fake, env, thread, last, compose } = setup([root]);
  thread.startReply(root);
  thread.setReplyDraft("See");
  const upload = thread.uploadReplyImage(png());
  expect(env.uploads[0].options).toBeUndefined();
  expect(thread.getState()).toMatchObject({ replyUploading: true, hasWork: true });
  env.comments = [];
  env.uploads[0].resolve(UPLOADED);
  await expect(upload).resolves.toEqual(UPLOADED);
  expect(thread.getState()).toMatchObject({
    replyingCommentId: null,
    replyingRootId: null,
    replyDraft: "",
    replyUploading: false,
    orphanedReply: { text: `See\n\n${EMBED}` },
    hasWork: true,
    keepsCardOpen: true,
  });

  // Moving it into the composer waits for the composer to be idle.
  compose("Existing");
  thread.submitComment();
  thread.moveOrphanedReplyToComment();
  expect(thread.getState().orphanedReply).not.toBeNull();
  fake.fire(last(), "rejected");
  thread.moveOrphanedReplyToComment();
  expect(thread.getState().orphanedReply).not.toBeNull();
  thread.discardCommentRecovery();
  thread.moveOrphanedReplyToComment();
  expect(thread.getState()).toMatchObject({ draft: `Existing\n\nSee\n\n${EMBED}`, composing: true, orphanedReply: null });

  // Discard just drops it.
  const second = setup([root]);
  second.thread.startReply(root);
  const again = second.thread.uploadReplyImage(png());
  second.env.comments = [];
  second.env.uploads[0].resolve(UPLOADED);
  await again;
  expect(second.thread.getState().orphanedReply).toEqual({ text: EMBED });
  second.thread.discardOrphanedReply();
  expect(second.thread.getState()).toMatchObject({ orphanedReply: null, hasWork: false });
});

test("a reply upload refuses a non-image, fails when the composer moved on, and keeps typed text when its target vanished", async () => {
  const root = comment("c1", "Root");
  const other = comment("c2", "Other");
  const { env, thread } = setup([root, other]);
  thread.startReply(root);
  await expect(thread.uploadReplyImage(new File(["x"], "notes.txt", { type: "text/plain" }))).rejects.toThrow("Choose a PNG, JPEG, GIF, or WebP image.");
  expect(env.uploads).toEqual([]);
  expect(thread.getState().replyUploading).toBe(false);

  // The composer was closed before the upload came back.
  const moved = thread.uploadReplyImage(png());
  thread.cancelReplyComposer(true);
  env.uploads[0].resolve(UPLOADED);
  await expect(moved).rejects.toThrow("Reply composer target changed or closed before upload completed.");
  expect(thread.getState()).toMatchObject({ replyingCommentId: null, replyUploading: false, orphanedReply: null });

  // A failed upload whose target a peer deleted does not lose the typed text.
  thread.startReply(other);
  thread.setReplyDraft("See");
  const failing = thread.uploadReplyImage(png());
  env.comments = [root];
  env.uploads[1].reject(new Error("Could not upload the attachment."));
  await expect(failing).rejects.toThrow("Could not upload the attachment.");
  expect(thread.getState()).toMatchObject({
    replyingCommentId: null,
    replyingRootId: null,
    replyDraft: "",
    replyUploading: false,
    orphanedReply: { text: "See" },
  });

  // With nothing typed there is nothing to keep: the composer stays for reconcile to close.
  const empty = setup([root]);
  empty.thread.startReply(root);
  const nothing = empty.thread.uploadReplyImage(png());
  empty.env.comments = [];
  empty.env.uploads[0].reject(new Error("Could not upload the attachment."));
  await expect(nothing).rejects.toThrow("Could not upload the attachment.");
  expect(empty.thread.getState()).toMatchObject({ replyingCommentId: "c1", orphanedReply: null, replyUploading: false });
});

test("saving an edit sends the trimmed text, and acceptance closes the editor only while the draft still holds it", () => {
  const mine = comment("c1", "Original");
  const { fake, thread, last } = setup([mine]);
  thread.startEdit(mine);
  expect(thread.getState()).toMatchObject({ editingCommentId: "c1", editDraft: "Original", editHasWork: false, hasWork: false });

  thread.setEditDraft("  Edited ");
  expect(thread.getState()).toMatchObject({ editHasWork: true, hasWork: true, keepsCardOpen: true });
  thread.saveCommentEdit();
  expect(fake.sends).toEqual([{ type: "comment.update", mutationId: last(), id: "c1", cardId: "card-1", body: "Edited", updatedAt: expect.any(Number) }]);
  expect(thread.getState().edit).toEqual({ pendingId: "c1", uncertain: false, error: null });

  // A late acceptance must not close an editor the user kept typing in.
  thread.setEditDraft("Edited more");
  fake.state.board = boardWith({ id: "c1", deleted: false });
  fake.fire(last(), "accepted");
  expect(thread.getState()).toMatchObject({ editingCommentId: "c1", editDraft: "Edited more", edit: { pendingId: null, error: null } });

  thread.saveCommentEdit();
  fake.fire(last(), "accepted");
  expect(thread.getState()).toMatchObject({ editingCommentId: null, editHasWork: false, hasWork: false });
});

test("a refused edit keeps its draft with the server's text, and Cancel clears the failure", () => {
  const mine = comment("c1", "Original");
  const { fake, thread, last } = setup([mine]);
  thread.startEdit(mine);
  thread.setEditDraft("Edited");
  thread.saveCommentEdit();
  fake.fire(last(), "timeout");
  expect(thread.getState().edit).toEqual({ pendingId: "c1", uncertain: true, error: null });
  // Neither a second save nor Cancel gets past a write in flight.
  thread.saveCommentEdit();
  thread.cancelCommentEdit();
  expect(fake.sends).toHaveLength(1);
  expect(thread.getState().editingCommentId).toBe("c1");

  fake.fire(last(), "rejected", "No room.");
  expect(thread.getState()).toMatchObject({ editingCommentId: "c1", editDraft: "Edited", edit: { pendingId: null, uncertain: false, error: "No room." }, keepsCardOpen: true });

  thread.cancelCommentEdit();
  expect(thread.getState()).toMatchObject({ editingCommentId: null, edit: { pendingId: null, error: null }, hasWork: false });
});

test("an edit accepted after a peer deleted the comment fails as accepted-gone with no error line and keeps the draft", () => {
  const mine = comment("c1", "Original");
  const { fake, env, thread, last, compose } = setup([mine]);
  thread.startEdit(mine);
  thread.setEditDraft("Edited");
  thread.saveCommentEdit();

  // The peer's deletion reaches the board cache before the acceptance does.
  env.comments = [tombstone("c1")];
  fake.state.board = boardWith({ id: "c1", deleted: true });
  fake.fire(last(), "accepted");
  expect(thread.getState()).toMatchObject({
    editingCommentId: "c1",
    editDraft: "Edited",
    editedCommentDeleted: true,
    editHasWork: true,
    hasWork: true,
    keepsCardOpen: true,
    edit: { pendingId: null, uncertain: false, error: null },
  });

  // "Move to comment" appends the preserved draft to the composer and closes the editor.
  compose("Mine");
  thread.moveEditToComment();
  expect(thread.getState()).toMatchObject({ draft: "Mine\n\nEdited", composing: true, editingCommentId: null, editedCommentDeleted: false, edit: { error: null } });
});

test("starting an edit waits behind the discard strip for changed text, and is ignored while a save or an image is in flight", async () => {
  const a = comment("c1", "A");
  const b = comment("c2", "B");
  const { fake, env, thread, last } = setup([a, b]);
  thread.startEdit(a);
  const opened = thread.getState();
  thread.startEdit(a);
  expect(thread.getState()).toBe(opened);

  // An unchanged editor gives way at once.
  thread.startEdit(b);
  expect(thread.getState()).toMatchObject({ editingCommentId: "c2", editDraft: "B" });
  expect(env.parked).toEqual([]);

  thread.setEditDraft("Changed");
  thread.startEdit(a);
  expect(thread.getState()).toMatchObject({ editingCommentId: "c2", editDraft: "Changed" });
  expect(env.parked).toHaveLength(1);
  env.parked[0]();
  expect(thread.getState()).toMatchObject({ editingCommentId: "c1", editDraft: "A", editHasWork: false });

  thread.setEditDraft("A!");
  thread.saveCommentEdit();
  thread.startEdit(b);
  expect(thread.getState().editingCommentId).toBe("c1");
  fake.fire(last(), "rejected");

  thread.setEditDraft("A");
  const upload = thread.uploadCommentImage(png());
  thread.startEdit(b);
  thread.saveCommentEdit();
  thread.cancelCommentEdit();
  expect(thread.getState().editingCommentId).toBe("c1");
  expect(fake.sends).toHaveLength(1);
  env.uploads[0].resolve(UPLOADED);
  await upload;
});

test("an image uploaded into an editor whose comment was deleted is kept in the preserved draft", async () => {
  const mine = comment("c1", "Original");
  const { env, thread } = setup([mine]);
  thread.startEdit(mine);
  const kept = thread.uploadEditedCommentImage(png());
  env.uploads[0].resolve(UPLOADED);
  await expect(kept).resolves.toEqual(UPLOADED);
  // The live editor inserts the embed itself.
  expect(thread.getState().editDraft).toBe("Original");

  const upload = thread.uploadEditedCommentImage(png());
  env.comments = [];
  env.uploads[1].resolve(UPLOADED);
  await upload;
  expect(thread.getState()).toMatchObject({ editDraft: `Original\n\n${EMBED}`, editedCommentDeleted: true, uploading: false });
});

test("hasWork guards every draft, upload, write in flight and recovery; keepsCardOpen a draft, an upload into one or a recovery", async () => {
  const root = comment("c1", "Root");
  const { fake, env, thread, last } = setup([root]);
  expect(thread.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });

  // An open composer with no text is nothing yet; a typed comment is a draft.
  thread.openComposer();
  expect(thread.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });
  thread.setDraft("  ");
  expect(thread.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });
  thread.setDraft("Hello");
  expect(thread.getState()).toMatchObject({ hasWork: true, keepsCardOpen: true });

  // A write in flight guards the close but is the scope's to report, not the card's to be kept open for.
  thread.submitComment();
  thread.setDraft("");
  expect(thread.getState()).toMatchObject({ hasWork: true, keepsCardOpen: false });
  fake.fire(last(), "rejected");
  expect(thread.getState()).toMatchObject({ hasWork: true, keepsCardOpen: true });
  thread.discardCommentRecovery();
  expect(thread.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });

  // An image alone guards the close; into an open composer it keeps the card open too.
  thread.cancelComposer(true);
  const upload = thread.uploadCommentImage(png());
  expect(thread.getState()).toMatchObject({ hasWork: true, keepsCardOpen: false });
  thread.openComposer();
  expect(thread.getState()).toMatchObject({ hasWork: true, keepsCardOpen: true });
  env.uploads[0].resolve(UPLOADED);
  await upload;
  expect(thread.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });

  // The same for a reply: an open composer is nothing until it holds text, an upload or a write.
  thread.startReply(root);
  expect(thread.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });
  thread.setReplyDraft("Agreed");
  expect(thread.getState()).toMatchObject({ hasWork: true, keepsCardOpen: true });
  thread.submitReply("c1");
  thread.setReplyDraft("");
  expect(thread.getState()).toMatchObject({ hasWork: true, keepsCardOpen: false });
  fake.fire(last(), "timeout");
  expect(thread.getState()).toMatchObject({ hasWork: true, keepsCardOpen: false });
  fake.fire(last(), "verified-retry");
  expect(thread.getState()).toMatchObject({ hasWork: true, keepsCardOpen: true });
  thread.discardReplyRecovery();
  thread.cancelReplyComposer(true);
  expect(thread.getState()).toMatchObject({ hasWork: false, keepsCardOpen: false });
});

test("getState keeps its identity until something changes, follows a comment deleted under the editor, and subscribers hear each change", () => {
  const mine = comment("c1", "Original");
  const { fake, env, thread, last } = setup([mine]);
  const first = thread.getState();
  expect(thread.getState()).toBe(first);

  let heard = 0;
  const unsubscribe = thread.subscribe(() => void heard++);
  thread.openComposer();
  expect(heard).toBe(1);
  thread.openComposer();
  expect(heard).toBe(1);
  const second = thread.getState();
  expect(second).not.toBe(first);
  expect(thread.getState()).toBe(second);

  thread.setDraft("Hello");
  expect(heard).toBe(2);
  thread.setDraft("Hello");
  expect(heard).toBe(2);

  // An operation's own state changes are heard too.
  thread.submitComment();
  expect(heard).toBeGreaterThan(2);
  const pending = thread.getState();
  expect(pending.composer.pending).toBe(true);
  fake.fire(last(), "accepted");
  expect(thread.getState()).not.toBe(pending);

  // The comments change without a notification: the one value derived from them is compared on read.
  thread.startEdit(mine);
  const editing = thread.getState();
  expect(editing.editedCommentDeleted).toBe(false);
  expect(thread.getState()).toBe(editing);
  env.comments = [];
  const deleted = thread.getState();
  expect(deleted).not.toBe(editing);
  expect(deleted.editedCommentDeleted).toBe(true);
  expect(thread.getState()).toBe(deleted);

  unsubscribe();
  const before = heard;
  thread.setEditDraft("Edited");
  expect(heard).toBe(before);
});
