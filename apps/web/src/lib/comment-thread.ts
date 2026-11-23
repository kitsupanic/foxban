import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { isPreviewableImageContentType, normalizeAttachmentContentType, type ClientMessage, type Comment } from "@foxban/shared";
import { composerLane, type AuthoredScope } from "./authored-operation";
import { uploadImageFor, type UploadImage } from "./image-upload";

/**
 * The comment thread on one card (ADR 0015, 0043, 0060, 0069): the comment composer, the one-level
 * reply composer and the inline editor of an existing comment. Creation is an authored operation
 * per composer, one lineage each: the entity id is chosen at submit and survives retries, and
 * acceptance is the only thing that clears a draft. An edit is a third one, which also keeps its
 * draft on a rejection. The core is React-free; the hook at the bottom is a thin adapter that also
 * does the DOM work (returning focus) and reconciles the reply composer when the comments change.
 */

/** `rawDraft` is what the editor held, `body` its trim. `sent` is what a retry re-sends and what the draft must still equal when the attempt is accepted. */
type CommentSent = { entityId: string; authorId: string; parentCommentId: string | null; rawDraft: string; body: string };
type EditSent = { id: string; body: string };

export type CommentLane = {
  /** A write in flight, uncertain included. */
  pending: boolean;
  uncertain: boolean;
  error: string | null;
  /** The unsent comment or reply, kept with its last error until it is retried or discarded. */
  recovery: { error: string; rawDraft: string; parentCommentId: string | null } | null;
};

export type CommentEditLane = {
  /** The comment whose edit is in flight, uncertain included. */
  pendingId: string | null;
  uncertain: boolean;
  /** A deleted comment shows its own banner, so an accepted-but-gone edit has no error line. */
  error: string | null;
};

export type CommentThreadState = {
  composing: boolean;
  draft: string;
  /** Bumped by every cancel, so the editor drops its own paste and upload feedback. */
  feedbackResetToken: number;
  /** An image is being prepared for the composer or for an edited comment. */
  uploading: boolean;
  composer: CommentLane;
  /** The comment the reply composer sits under; a reply to a reply flattens to `replyingRootId`. */
  replyingCommentId: string | null;
  replyingRootId: string | null;
  replyDraft: string;
  replyUploading: boolean;
  /** A reply whose target a peer deleted mid-upload, kept for "Move to comment". */
  orphanedReply: { text: string } | null;
  reply: CommentLane;
  editingCommentId: string | null;
  editDraft: string;
  edit: CommentEditLane;
  /** A peer deleted the comment being edited; its draft is kept for "Move to comment". */
  editedCommentDeleted: boolean;
  /** The editor holds a changed draft, or its save is in flight. */
  editHasWork: boolean;
  /** What the discard strip guards: any draft, upload, write in flight or recovery in the thread. */
  hasWork: boolean;
  /** What keeps the card open after an accepted save: a draft, an upload into it or a recovery. A write in flight is the scope's to report. */
  keepsCardOpen: boolean;
};

/** What the core reads but does not own. Read at call time, so it always sees the latest values. */
export type CommentThreadEnv = {
  cardId(): string;
  /** The signed-in user: a comment needs an author. */
  me(): { id: string } | null;
  /** This card's live comments, oldest first. */
  comments(): readonly Comment[];
  /** Parks an exit behind the discard strip while the modal has unsaved work (ADR 0020). */
  requestClose(action: () => void): void;
  /** The shared attachment upload. */
  upload: UploadImage;
  /** The reply composer under `targetId` closed by acceptance, Cancel or Escape; the view returns focus to its Reply button. */
  onReplyClosed(targetId: string): void;
};

const copy = (noun: "comment" | "reply") => ({
  rejected: `Server rejected ${noun}.`,
  unverified: `Sync could not verify ${noun}. You can retry sending.`,
  "not-connected": "Not connected — try again.",
  "accepted-gone": `Server rejected ${noun}.`, // unreachable: no `confirm`
});

const laneOf = (view: ReturnType<typeof composerLane<CommentSent>>): CommentLane => ({
  pending: view.pendingId !== null,
  uncertain: view.uncertain,
  error: view.error,
  recovery: view.recovery && { error: view.recovery.error, rawDraft: view.recovery.rawDraft, parentCommentId: view.recovery.parentCommentId },
});

export function createCommentThread(scope: AuthoredScope, env: CommentThreadEnv) {
  // The composer.
  let composing = false;
  let draft = "";
  let feedbackResetToken = 0;
  // One flag for the composer and for an edited comment: both prepare their images through it.
  let uploading = false;
  // The composer generation the running attempt is compared against: the one the submit bumped to,
  // or the live one when a retry starts.
  let commentGeneration = 0;
  let commentAcceptGeneration = 0;
  let commentRetried = false;
  const commentRecoveryError = { current: "" };

  // The reply composer.
  let replyingCommentId: string | null = null;
  let replyingRootId: string | null = null;
  let replyDraft = "";
  let replyUploading = false;
  let orphanedReply: { text: string } | null = null;
  let replyGeneration = 0;
  let replyAcceptGeneration = 0;
  let replyRetried = false;
  const replyRecoveryError = { current: "" };

  // The inline editor.
  let editingCommentId: string | null = null;
  let editDraft = "";
  let editBaseline = "";

  const listeners = new Set<() => void>();
  let snapshot: CommentThreadState | null = null;
  let stale = true;
  // Both lanes are rebuilt on every change, so a retained recovery's last error is captured as each attempt fails.
  let commentLane: CommentLane;
  let replyLane: CommentLane;
  const changed = () => {
    commentLane = laneOf(composerLane(commentOp.getState(), commentRetried, commentRecoveryError));
    replyLane = laneOf(composerLane(replyOp.getState(), replyRetried, replyRecoveryError));
    stale = true;
    for (const listener of Array.from(listeners)) listener();
  };

  // `authorId` and the timestamps ride the wire: the DO is identity-blind and
  // rebroadcasts frames verbatim, so a server stamp would not reach peers until
  // their next snapshot (ADR 0015).
  const createMessage = (mutationId: string, { entityId, authorId, parentCommentId, body }: CommentSent): ClientMessage => ({
    type: "comment.create",
    mutationId,
    id: entityId,
    cardId: env.cardId(),
    authorId,
    parentCommentId,
    body,
    createdAt: Date.now(),
  });
  const commentOp = scope.operation<CommentSent>({
    build: createMessage,
    onAccepted: ({ rawDraft }) => {
      if (commentGeneration === commentAcceptGeneration && draft === rawDraft && !uploading) cancelComposer(true);
    },
    copy: copy("comment"),
  });
  const replyOp = scope.operation<CommentSent>({
    build: createMessage,
    onAccepted: ({ rawDraft, parentCommentId }) => {
      if (replyGeneration === replyAcceptGeneration && replyingRootId === parentCommentId && replyDraft === rawDraft && !replyUploading) {
        cancelReplyComposer(true);
      }
    },
    copy: copy("reply"),
  });
  const editOp = scope.operation<EditSent>({
    build: (mutationId, { id, body }): ClientMessage => ({ type: "comment.update", mutationId, id, cardId: env.cardId(), body, updatedAt: Date.now() }),
    // Socket settlement can precede React rendering the peer's deletion.
    confirm: (board, { id }) => !!board?.comments.some((comment) => comment.id === id && !comment.deleted),
    // A late acceptance of an earlier attempt must not close an editor the user has kept typing in.
    onAccepted: ({ id, body }) => {
      if (editingCommentId === id && editDraft.trim() === body && !uploading) {
        editingCommentId = null;
        changed();
      }
    },
    copy: {
      rejected: "Server rejected comment edit.",
      unverified: "Sync could not verify comment edit. You can retry saving.",
      "not-connected": "Not connected — try again.",
      "accepted-gone": "",
    },
  });
  commentOp.subscribe(changed);
  replyOp.subscribe(changed);
  editOp.subscribe(changed);
  commentLane = laneOf(composerLane(commentOp.getState(), commentRetried, commentRecoveryError));
  replyLane = laneOf(composerLane(replyOp.getState(), replyRetried, replyRecoveryError));

  const editLane = (): CommentEditLane => {
    const { status, sent, failure, error } = editOp.getState();
    const active = status === "pending" || status === "uncertain";
    return { pendingId: active ? sent?.id ?? null : null, uncertain: status === "uncertain", error: failure === "accepted-gone" ? null : error };
  };
  const editPendingId = () => editLane().pendingId;
  const editedCommentDeleted = () => editingCommentId !== null && !env.comments().some((c) => c.id === editingCommentId && !c.deleted);
  const editHasWork = () => editingCommentId !== null && (editDraft !== editBaseline || editPendingId() !== null);
  const composerHasText = () => composing && (draft.trim() !== "" || uploading);
  const replyHasText = () => replyingCommentId !== null && (replyDraft.trim() !== "" || replyUploading);
  const hasWork = () =>
    editHasWork() ||
    uploading ||
    replyUploading ||
    orphanedReply !== null ||
    commentLane.pending ||
    replyLane.pending ||
    commentLane.recovery !== null ||
    replyLane.recovery !== null ||
    composerHasText() ||
    replyHasText();
  const keepsCardOpen = () =>
    editHasWork() || composerHasText() || replyHasText() || orphanedReply !== null || commentLane.recovery !== null || replyLane.recovery !== null;

  // `comments` can change without a notification, so the one value derived from them is compared
  // on every read; the snapshot keeps its identity while nothing differs.
  const getState = (): CommentThreadState => {
    const deleted = editedCommentDeleted();
    if (stale || snapshot === null || snapshot.editedCommentDeleted !== deleted) {
      stale = false;
      snapshot = {
        composing,
        draft,
        feedbackResetToken,
        uploading,
        composer: commentLane,
        replyingCommentId,
        replyingRootId,
        replyDraft,
        replyUploading,
        orphanedReply,
        reply: replyLane,
        editingCommentId,
        editDraft,
        edit: editLane(),
        editedCommentDeleted: deleted,
        editHasWork: editHasWork(),
        hasWork: hasWork(),
        keepsCardOpen: keepsCardOpen(),
      };
    }
    return snapshot;
  };

  // Typing dismisses an inline error; a retained recovery stays until retried or discarded.
  const clearCommentError = () => {
    if (commentLane.error !== null) commentOp.discard();
  };
  const clearReplyError = () => {
    if (replyLane.error !== null) replyOp.discard();
  };
  const clearEditError = () => {
    if (editPendingId() === null) editOp.discard();
  };

  const cancelComposer = (force = false) => {
    if (!force && (uploading || commentLane.pending)) return;
    ++commentGeneration;
    ++feedbackResetToken;
    draft = "";
    composing = false;
    changed();
  };

  const cancelReplyComposer = (force = false) => {
    if (!force && (replyUploading || replyLane.pending)) return;
    ++replyGeneration;
    const targetId = replyingCommentId;
    replyDraft = "";
    replyingCommentId = null;
    replyingRootId = null;
    changed();
    if (targetId) env.onReplyClosed(targetId);
  };

  const cancelCommentEdit = () => {
    if (editPendingId() !== null || uploading) return;
    editingCommentId = null;
    clearEditError();
    changed();
  };

  const uploadCommentImage = uploadImageFor(
    (file, options) => env.upload(file, options),
    {
      begin() {
        if (uploading) return false;
        uploading = true;
        changed();
        return true;
      },
      end() {
        uploading = false;
        changed();
      },
    },
    false,
  );

  return {
    getState,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    openComposer() {
      if (composing) return;
      composing = true;
      changed();
    },
    setDraft(value: string) {
      const unchanged = composing && value === draft;
      composing = true;
      draft = value;
      if (commentLane.error !== null) clearCommentError();
      else if (!unchanged) changed();
    },
    cancelComposer,
    submitComment() {
      const rawDraft = draft;
      const body = rawDraft.trim();
      const me = env.me();
      if (!body || !me || uploading || commentLane.pending || commentLane.recovery !== null) return;
      commentRetried = false;
      commentAcceptGeneration = ++commentGeneration;
      commentOp.start({ entityId: crypto.randomUUID(), authorId: me.id, parentCommentId: null, rawDraft, body });
    },
    retryCommentRecovery() {
      if (!commentLane.recovery || !env.me() || uploading || commentLane.pending) return;
      commentRetried = true;
      commentAcceptGeneration = commentGeneration;
      commentOp.retry();
    },
    discardCommentRecovery() {
      if (commentLane.pending) return;
      commentOp.discard();
    },
    uploadCommentImage,

    /** Opens the reply composer under `target`; a typed reply elsewhere goes through the discard strip first. */
    startReply(target: Comment) {
      if (replyUploading || replyLane.pending || orphanedReply !== null) return;
      if (replyingCommentId === target.id) return;
      const rootId = target.parentCommentId ?? target.id;
      const activate = () => {
        ++replyGeneration;
        replyingCommentId = target.id;
        replyingRootId = rootId;
        replyDraft = "";
        changed();
      };
      if (replyingCommentId !== null && (replyDraft.trim() !== "" || replyUploading)) {
        env.requestClose(activate);
        return;
      }
      activate();
    },
    setReplyDraft(value: string) {
      const unchanged = value === replyDraft;
      replyDraft = value;
      if (replyLane.error !== null) clearReplyError();
      else if (!unchanged) changed();
    },
    cancelReplyComposer,
    submitReply(rootCommentId: string) {
      const rawDraft = replyDraft;
      const body = rawDraft.trim();
      const me = env.me();
      if (!body || !me || replyUploading || replyLane.pending || replyLane.recovery !== null) return;
      replyRetried = false;
      replyAcceptGeneration = ++replyGeneration;
      replyOp.start({ entityId: crypto.randomUUID(), authorId: me.id, parentCommentId: rootCommentId, rawDraft, body });
    },
    retryReplyRecovery() {
      if (!replyLane.recovery || !env.me() || replyUploading || replyLane.pending) return;
      replyRetried = true;
      replyAcceptGeneration = replyGeneration;
      replyOp.retry();
    },
    discardReplyRecovery() {
      if (replyLane.pending) return;
      replyOp.discard();
    },
    /**
     * Reconciles the reply composer with the live comments: re-anchors it to a surviving thread
     * root, keeps ownership while an image uploads, otherwise closes it, or parks the exit behind
     * the discard strip when it holds text.
     */
    reconcile() {
      if (replyingCommentId === null) return;
      const comments = env.comments();
      const target = comments.find((c) => c.id === replyingCommentId);
      if (target) {
        // The target still exists. Ensure root comment tracking is synced.
        const rootId = target.parentCommentId ?? target.id;
        if (replyingRootId !== rootId) {
          replyingRootId = rootId;
          changed();
        }
        return;
      }

      // If reply is currently uploading, keep ownership; the upload completion
      // will detect the missing target and create an orphan recovery.
      // The uploading guard precedes child-to-root reanchor.
      if (replyUploading) return;

      // The target comment was deleted or pruned by a peer.
      // Check if the thread's root comment still survives (either active or tombstoned with remaining replies).
      const root = replyingRootId ? comments.find((c) => c.id === replyingRootId) : null;
      if (root) {
        // Re-anchor the active composer visibly directly beneath the surviving root.
        // If the root is tombstoned, the reply composer appears under the root row,
        // keeping the draft visible and editable!
        replyingCommentId = root.id;
        changed();
        return;
      }

      // Neither the target comment nor any thread root survives.
      // Prompt the user via the discard guard if dirty, or close if empty.
      const close = () => {
        replyingCommentId = null;
        replyingRootId = null;
        replyDraft = "";
        changed();
      };
      if (replyDraft.trim() !== "") env.requestClose(close);
      else close();
    },
    async uploadReplyImage(file: File): Promise<{ url: string; alt: string }> {
      const capturedGeneration = replyGeneration;
      const capturedTargetId = replyingCommentId;
      const contentType = normalizeAttachmentContentType(file.type);
      if (!isPreviewableImageContentType(contentType)) {
        throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
      }
      replyUploading = true;
      changed();
      try {
        const result = await env.upload(file);
        // Tie async completion to reply owner generation + target.
        // It may never overwrite another target's or newer reply draft.
        if (replyGeneration !== capturedGeneration || replyingCommentId !== capturedTargetId) {
          throw new Error("Reply composer target changed or closed before upload completed.");
        }
        const targetStillExists = capturedTargetId ? env.comments().some((c) => c.id === capturedTargetId && !c.deleted) : false;
        if (!targetStillExists && capturedTargetId !== null) {
          // Target was deleted by peer while upload was in flight.
          // Form exact markdown embed using the current live reply draft.
          const markup = `![${result.alt}](${result.url})`;
          const finalOrphanText = replyDraft.trim() !== "" ? `${replyDraft}\n\n${markup}` : markup;
          orphanedReply ??= { text: finalOrphanText };
          replyingCommentId = null;
          replyingRootId = null;
          replyDraft = "";
          return result;
        }
        return result;
      } catch (err) {
        const targetId = replyingCommentId ?? capturedTargetId;
        const targetStillExists = targetId ? env.comments().some((c) => c.id === targetId && !c.deleted) : true;
        if (!targetStillExists && capturedTargetId !== null) {
          if (replyDraft.trim() !== "") {
            orphanedReply ??= { text: replyDraft };
            replyingCommentId = null;
            replyingRootId = null;
            replyDraft = "";
          }
        }
        throw err;
      } finally {
        replyUploading = false;
        changed();
      }
    },
    /** The orphaned reply becomes the composer's draft. */
    moveOrphanedReplyToComment() {
      if (orphanedReply === null || commentLane.pending || uploading || commentLane.recovery !== null) return;
      const { text } = orphanedReply;
      draft = draft.trim() !== "" ? `${draft}\n\n${text}` : text;
      composing = true;
      orphanedReply = null;
      changed();
    },
    discardOrphanedReply() {
      orphanedReply = null;
      changed();
    },

    /** Opens the editor on `target`; changed text in another editor goes through the discard strip first. */
    startEdit(target: Comment) {
      if (editPendingId() !== null || uploading) return;
      if (editingCommentId === target.id) return;
      const begin = () => {
        editingCommentId = target.id;
        editDraft = target.body;
        editBaseline = target.body;
        clearEditError();
        changed();
      };
      if (editHasWork()) {
        env.requestClose(begin);
        return;
      }
      begin();
    },
    setEditDraft(value: string) {
      if (value === editDraft) return;
      editDraft = value;
      changed();
    },
    saveCommentEdit() {
      const body = editDraft.trim();
      if (!body || !editingCommentId || uploading || editPendingId() !== null) return;
      editOp.start({ id: editingCommentId, body });
    },
    cancelCommentEdit,
    /** The deleted comment's preserved edit becomes the composer's draft. */
    moveEditToComment() {
      draft = draft !== "" ? `${draft}\n\n${editDraft}` : editDraft;
      composing = true;
      cancelCommentEdit();
      changed();
    },
    async uploadEditedCommentImage(file: File) {
      const targetId = editingCommentId;
      const result = await uploadCommentImage(file);
      if (targetId && !env.comments().some((c) => c.id === targetId && !c.deleted)) {
        // The deleted row unmounted its editor, so preserve its pending image here.
        editDraft = `${editDraft}\n\n![${result.alt}](${result.url})`;
        changed();
      }
      return result;
    },
  };
}


export function useCommentThread(
  scope: AuthoredScope,
  live: {
    cardId: string;
    me: { id: string } | null;
    comments: readonly Comment[];
    requestClose: (action: () => void) => void;
    upload: UploadImage;
  },
) {
  const latest = useRef(live);
  latest.current = live;
  const replyButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const core = useMemo(
    () =>
      createCommentThread(scope, {
        cardId: () => latest.current.cardId,
        me: () => latest.current.me,
        comments: () => latest.current.comments,
        requestClose: (action) => latest.current.requestClose(action),
        upload: (file, options) => latest.current.upload(file, options),
        onReplyClosed: (targetId) => replyButtonRefs.current[targetId]?.focus(),
      }),
    [scope],
  );
  const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);
  useEffect(() => {
    core.reconcile();
  }, [core, live.comments, state.replyingCommentId, state.replyingRootId, state.replyDraft]);
  const { getState, subscribe, reconcile, ...actions } = core;
  // `state` is as of this render; `current` reads the live state for callbacks that outlive it.
  return { ...state, ...actions, replyButtonRefs, current: getState };
}

export type CommentThread = ReturnType<typeof useCommentThread>;
