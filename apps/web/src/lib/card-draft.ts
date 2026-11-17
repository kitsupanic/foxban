import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DESCRIPTION_MAX_BYTES, descriptionByteLength, type Card, type ClientMessage } from "@foxban/shared";
import type { AttachmentView, BoardAttachments } from "./attachments";
import { composerLane, type AuthoredScope } from "./authored-operation";

/**
 * The title and description draft on one card, committed by Save (ADR 0007, 0010, 0013, 0035, 0069):
 * one authored operation, `card.update`, with the fields Save diffed. The draft is seeded once on
 * mount; an untouched field then follows the live card, an edited one is left alone, and each
 * field is sent only if it differs from the baseline its edit started from. The core is React-free;
 * the hook at the bottom is a thin adapter.
 */

type Diff = { title?: string; description?: string };
/** `entityId` is the card, only so the lane helper has a marker for "in flight". */
type SaveSent = { entityId: string; submittedTitle?: string; submittedDescription?: string; draftTitle: string; draftDescription: string };

export type CardDraftSave = {
  /** A write in flight, uncertain included. */
  pending: boolean;
  uncertain: boolean;
  /** The "Description must be…" refusal, or a send that never left. */
  error: string | null;
  /** The unsent save, kept with its last error until it is retried or discarded. */
  recovery: { error: string; submittedTitle?: string; submittedDescription?: string } | null;
};

export type CardDraftState = {
  title: string;
  editingTitle: boolean;
  /** The draft with every embed of a server-confirmed attachment deletion on this card removed. */
  description: string;
  /** An image is being prepared for the description. */
  uploading: boolean;
  saveLane: CardDraftSave;
  titleHasChanges: boolean;
  descriptionHasChanges: boolean;
  unsavedTextMessage: string;
  /** Unsent text, an image in preparation or a save in flight or awaiting recovery. */
  hasWork: boolean;
};

/** What the core reads but does not own. Read at call time, so it always sees the latest values. */
export type CardDraftEnv = {
  /** The live card: what an untouched field follows and what a retry re-diffs against. */
  card(): { id: string; title: string; description: string };
  /** The draft with every embed of a server-confirmed deletion on this card removed. */
  descriptionFor(draft: string): string;
  /** An own attachment deletion on this card whose outcome is still unknown; Save waits for it. */
  attachmentDeletePending(): boolean;
  /** Work Save does not own that must keep the card open after an accepted save. */
  keepsOpen(): boolean;
  /** An accepted first attempt that left nothing else to do closes the card. */
  close(): void;
};

export function createCardDraft(scope: AuthoredScope, env: CardDraftEnv, seed: { title: string; description: string }) {
  let title = seed.title;
  let editingTitle = false;
  let descriptionDraft = seed.description;
  let uploading = false;
  // Only the "Description must be…" refusal; a failed send is the save operation's own error.
  let validationError: string | null = null;
  const effective = () => env.descriptionFor(descriptionDraft);

  // Each field is sent only when the user edited it and it differs from the
  // value that edit started from, so an untouched field never overwrites a peer.
  let titleBaseline = env.card().title;
  let descriptionBaseline = env.card().description;
  let titleDirty = false;
  let descriptionDirty = effective() !== env.card().description;

  let retried = false;
  const recoveryError = { current: "" };
  // What each attempt of the lineage actually carried, by mutationId: a retry re-diffs against the
  // live card, so it can drop a field a peer already saved, and an earlier attempt may still be
  // accepted late. Acceptance updates baselines for exactly what the accepted attempt carried.
  const attemptDiffs = new Map<string, Diff>();
  // The first attempt went uncertain, or failed and was kept as a recovery, before being accepted
  // late: the user has seen it in trouble, so its acceptance must not close the card.
  let interrupted = false;

  const listeners = new Set<() => void>();
  let snapshot: CardDraftState | null = null;
  let stale = true;

  /** What Save would send: the draft diffed against its baselines. Shared with the dirty check, so "unsaved changes" means exactly "Save has work". */
  const changes = (): Diff => {
    const nextTitle = title.trim();
    const diff: Diff = {};
    // An emptied title is a slip, not an edit — the card keeps the old one.
    if (titleDirty && nextTitle && nextTitle !== titleBaseline) diff.title = nextTitle;
    const description = effective();
    if (descriptionDirty && description !== descriptionBaseline) diff.description = description;
    return diff;
  };

  const saveOp = scope.operation<SaveSent>({
    build: (mutationId, { submittedTitle, submittedDescription }): ClientMessage | null => {
      const card = env.card();
      const diff: Diff = {};
      if (submittedTitle !== undefined && (!retried || submittedTitle !== card.title)) diff.title = submittedTitle;
      if (submittedDescription !== undefined && (!retried || submittedDescription !== card.description)) diff.description = submittedDescription;
      attemptDiffs.set(mutationId, diff);
      // Nothing left to send: the lineage settles and its recovery goes with it.
      if (diff.title === undefined && diff.description === undefined) return null;
      return { type: "card.update", mutationId, id: card.id, ...diff };
    },
    onAccepted: ({ draftTitle, draftDescription }, mutationId) => {
      const { title: sentTitle, description: sentDescription } = attemptDiffs.get(mutationId) ?? {};
      attemptDiffs.clear();
      const currentTitle = title.trim();
      const currentDescription = effective();
      if (sentTitle !== undefined) {
        titleBaseline = sentTitle;
        if (currentTitle === sentTitle) titleDirty = false;
      }
      if (sentDescription !== undefined) {
        descriptionBaseline = sentDescription;
        if (currentDescription === sentDescription) descriptionDirty = false;
      }
      changed();
      // Only a first attempt closes the card, and only if nothing else needs it open.
      if (!retried && !interrupted && !env.keepsOpen() && currentTitle === draftTitle && currentDescription === draftDescription) {
        env.close();
      }
    },
    copy: {
      rejected: "Server rejected save.",
      unverified: "Sync could not verify save. You can retry sending.",
      "not-connected": "Not connected — changes won't send.",
      "accepted-gone": "Server rejected save.", // unreachable: no `confirm`
    },
  });
  let lane = composerLane(saveOp.getState(), retried, recoveryError);

  // The lane is rebuilt on every change, so the retained recovery's last error is captured as each attempt fails.
  const changed = () => {
    const { status } = saveOp.getState();
    if (status === "uncertain" || status === "failed") interrupted = true;
    lane = composerLane(saveOp.getState(), retried, recoveryError);
    stale = true;
    for (const listener of Array.from(listeners)) listener();
  };
  saveOp.subscribe(changed);

  const hasWork = () => getState().hasWork;

  // The attachment view changes without a notification, so what is derived from it is compared on
  // every read; the snapshot keeps its identity while nothing differs.
  const getState = (): CardDraftState => {
    const description = effective();
    const diff = changes();
    const titleHasChanges = diff.title !== undefined;
    const descriptionHasChanges = diff.description !== undefined;
    if (
      stale ||
      snapshot === null ||
      snapshot.description !== description ||
      snapshot.titleHasChanges !== titleHasChanges ||
      snapshot.descriptionHasChanges !== descriptionHasChanges
    ) {
      stale = false;
      snapshot = {
        title,
        editingTitle,
        description,
        uploading,
        saveLane: { pending: lane.pendingId !== null, uncertain: lane.uncertain, error: validationError ?? lane.error, recovery: lane.recovery },
        titleHasChanges,
        descriptionHasChanges,
        unsavedTextMessage:
          titleHasChanges && descriptionHasChanges ? "Unsaved title and description" : titleHasChanges ? "Unsaved title" : "Unsaved description",
        hasWork: titleHasChanges || descriptionHasChanges || uploading || lane.pendingId !== null || lane.uncertain || lane.recovery !== null,
      };
    }
    return snapshot;
  };

  // Typing dismisses an inline error; a retained recovery stays until retried or discarded.
  const clearError = () => {
    if (validationError !== null) {
      validationError = null;
      changed();
    }
    if (lane.error !== null) saveOp.discard();
  };

  return {
    getState,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    hasWork,
    setTitle(value: string) {
      const wasDirty = titleDirty;
      titleDirty = true;
      if (value === title && wasDirty) return;
      title = value;
      changed();
    },
    setEditingTitle(value: boolean) {
      if (value === editingTitle) return;
      editingTitle = value;
      changed();
    },
    setDescription(next: string) {
      const wasDirty = descriptionDirty;
      // Compared with the text the editor shows: an echo of it is not an edit.
      if (next !== effective()) descriptionDirty = true;
      if (next === descriptionDraft && wasDirty === descriptionDirty) return;
      descriptionDraft = next;
      changed();
    },
    /** An untouched field follows the live card, and its baseline with it; an edited one is left alone. */
    followCard() {
      const card = env.card();
      let moved = false;
      if (!titleDirty) {
        if (card.title !== title) {
          title = card.title;
          moved = true;
        }
        titleBaseline = card.title;
      }
      if (!descriptionDirty) {
        if (card.description !== effective() && card.description !== descriptionDraft) {
          descriptionDraft = card.description;
          moved = true;
        }
        descriptionBaseline = card.description;
      }
      if (moved) changed();
    },
    save() {
      if (env.attachmentDeletePending() || uploading || lane.pendingId !== null || lane.uncertain || lane.recovery !== null) return;
      if (descriptionByteLength(effective()) > DESCRIPTION_MAX_BYTES) {
        if (validationError === null) {
          validationError = "Description must be 100,000 bytes or fewer.";
          changed();
        }
        return;
      }
      clearError();
      const diff = changes();
      if (diff.title === undefined && diff.description === undefined) return;
      retried = false;
      attemptDiffs.clear();
      interrupted = false;
      saveOp.start({
        entityId: env.card().id,
        submittedTitle: diff.title,
        submittedDescription: diff.description,
        draftTitle: title.trim(),
        draftDescription: effective(),
      });
    },
    /** Re-sends the retained save, re-diffed against the live card. */
    retry() {
      if (!lane.recovery || uploading || lane.pendingId !== null || lane.uncertain) return;
      retried = true;
      saveOp.retry();
    },
    discardRecovery: () => saveOp.discard(),
    clearError,
    /** An image is about to be prepared for the description; false while one already is. */
    beginUpload() {
      if (uploading) return false;
      uploading = true;
      changed();
      return true;
    },
    endUpload() {
      uploading = false;
      changed();
    },
  };
}

export type CardDraftCore = ReturnType<typeof createCardDraft>;

export function useCardDraft(
  scope: AuthoredScope,
  live: {
    card: Pick<Card, "id" | "title" | "description">;
    boardAttachments: BoardAttachments;
    attachmentView: AttachmentView;
    keepsOpen: () => boolean;
    close: () => void;
  },
) {
  const latest = useRef(live);
  latest.current = live;
  // Mount-only seed; never replaces an already-open draft on live updates.
  const [seed] = useState(() => ({
    title: live.card.title,
    description: live.boardAttachments.seedDescription(live.card.id, live.card.description),
  }));
  const core = useMemo(() => {
    // Stripping parses the draft, so it is redone only when its inputs change.
    let memo: { view: AttachmentView; cardId: string; draft: string; result: string } | null = null;
    return createCardDraft(
      scope,
      {
        card: () => latest.current.card,
        descriptionFor(draft) {
          const { attachmentView: view, card } = latest.current;
          if (memo === null || memo.view !== view || memo.cardId !== card.id || memo.draft !== draft) {
            memo = { view, cardId: card.id, draft, result: view.descriptionFor(card.id, draft) };
          }
          return memo.result;
        },
        attachmentDeletePending: () => latest.current.attachmentView.isDeletePending(latest.current.card.id),
        keepsOpen: () => latest.current.keepsOpen(),
        close: () => latest.current.close(),
      },
      seed,
    );
  }, [scope, seed]);
  const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);
  useEffect(() => {
    core.followCard();
  }, [core, live.card.title, live.card.description]);
  const { getState, subscribe, hasWork, followCard, ...actions } = core;
  // `state` is as of this render; `current` reads the live state for callbacks that outlive it.
  return { ...state, ...actions, current: getState };
}

export type CardDraft = ReturnType<typeof useCardDraft>;
