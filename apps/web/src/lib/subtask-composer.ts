import { useMemo, useRef, useSyncExternalStore } from "react";
import type { ChecklistItem, ClientMessage } from "@foxban/shared";
import { composerLane, type AuthoredScope } from "./authored-operation";

/**
 * The subtask composer and the checklist conversion on one card (ADR 0067, 0069): two authored
 * operations, one lineage each. The entity and relation ids are chosen at submit and survive
 * retries, so a retry is the same creation rather than a second child. One `subtask.create` frame
 * is the whole creation (child, parent link and, for conversion, the source item's removal), so
 * settling one lane never speaks for the other. The conversion lane is single-slot: while it is
 * pending or holds a recovery it is the whole lane's state, not just the source item's. The core
 * is React-free; the hook at the bottom is a thin adapter.
 */

type SubtaskSent = { entityId: string; relationId: string; position: string; rawDraft: string };
type ConvertSent = SubtaskSent & { checklistItemId: string };

export type SubtaskLane = {
  /** A write in flight, uncertain included. */
  pending: boolean;
  uncertain: boolean;
  error: string | null;
  /** The unsent subtask, kept with its last error until it is retried or discarded. */
  recovery: { error: string; rawDraft: string } | null;
};

export type ConversionLane = {
  /** The checklist item whose conversion is in flight. */
  pendingItemId: string | null;
  uncertain: boolean;
  error: string | null;
  recovery: { error: string } | null;
  /** One pending write or one retained recovery owns every Convert action until it settles or is discarded. */
  busy: boolean;
};

export type SubtaskComposerState = {
  composing: boolean;
  draft: string;
  composer: SubtaskLane;
  conversion: ConversionLane;
  /** What the discard strip guards: a typed title, or a write in flight or recovery on either lane. */
  hasWork: boolean;
  /** What keeps the card open after an accepted save: a typed title or a recovery. A write in flight is the scope's to report. */
  keepsCardOpen: boolean;
};

/** What the core reads but does not own. Read at call time, so it always sees the latest values. */
export type SubtaskComposerEnv = {
  cardId(): string;
  /** A subtask card cannot have children, so it cannot convert. */
  isSubtask(): boolean;
  /** A new subtask's key in the column it lands in: the completed column for a done checklist item, else the starting one, or this card's own on a board without roles. */
  placeTail(done: boolean): string;
};

const copy = (rejected: string, unverified: string) => ({
  rejected,
  unverified,
  "not-connected": "Not connected — try again.",
  "accepted-gone": rejected, // unreachable: no `confirm`
});

export function createSubtaskComposer(scope: AuthoredScope, env: SubtaskComposerEnv) {
  let composing = false;
  let draft = "";
  // Only the "Checklist item is empty." refusal; a failed send is the operation's own error.
  let convertEmptyError: string | null = null;
  // The composer generation the running attempt is compared against, bumped by every submit and retry.
  let acceptGeneration = 0;
  let generation = 0;
  let composerRetried = false;
  let conversionRetried = false;
  const composerRecoveryError = { current: "" };
  const conversionRecoveryError = { current: "" };

  const listeners = new Set<() => void>();
  // Rebuilt on every change, so the retained recovery's last error is captured as each attempt fails.
  const changed = () => {
    state = build();
    for (const listener of Array.from(listeners)) listener();
  };

  const composerOp = scope.operation<SubtaskSent>({
    // The composer trims its draft; conversion sends the stored item text as is.
    build: (mutationId, { entityId, relationId, position, rawDraft }): ClientMessage => ({
      type: "subtask.create",
      mutationId,
      id: entityId,
      parentCardId: env.cardId(),
      relationId,
      title: rawDraft.trim(),
      position,
    }),
    // Acceptance is the only thing that clears the draft, and only while this lane's own
    // submission is still what the field holds.
    onAccepted: ({ rawDraft }) => {
      if (generation === acceptGeneration && draft === rawDraft) {
        draft = "";
        composing = false;
        changed();
      }
    },
    copy: copy("Server rejected the subtask.", "Sync could not verify the subtask. You can retry sending."),
  });
  // Conversion carries the item's EXACT stored text (a stored " Write docs " is legal, and the
  // server compares it byte for byte) plus its id: the BoardDO re-reads the item inside the
  // transaction and refuses only a real change.
  const conversionOp = scope.operation<ConvertSent>({
    build: (mutationId, { entityId, relationId, position, rawDraft, checklistItemId }): ClientMessage => ({
      type: "subtask.create",
      mutationId,
      id: entityId,
      parentCardId: env.cardId(),
      relationId,
      title: rawDraft,
      position,
      checklistItemId,
    }),
    copy: copy("Server rejected the conversion.", "Sync could not verify the conversion. You can retry the same item."),
  });

  const build = (): SubtaskComposerState => {
    const composerView = composerLane(composerOp.getState(), composerRetried, composerRecoveryError);
    const conversionView = composerLane(conversionOp.getState(), conversionRetried, conversionRecoveryError);
    const pendingItemId = conversionView.pendingId === null ? null : conversionOp.getState().sent?.checklistItemId ?? null;
    const typed = composing && draft.trim() !== "";
    const busy = pendingItemId !== null || conversionView.uncertain || conversionView.recovery !== null;
    return {
      composing,
      draft,
      composer: {
        pending: composerView.pendingId !== null,
        uncertain: composerView.uncertain,
        error: composerView.error,
        recovery: composerView.recovery,
      },
      conversion: {
        pendingItemId,
        uncertain: conversionView.uncertain,
        error: convertEmptyError ?? conversionView.error,
        recovery: conversionView.recovery,
        busy,
      },
      // The subtask composer is authored work too: a typed title is a draft, and a submitted one
      // is a write still to be verified. A conversion in flight is as well: closing before it
      // settles would drop its recovery and retire its ownership behind the user's back.
      hasWork: typed || composerView.pendingId !== null || composerView.recovery !== null || busy,
      // Save never commits an open subtask composer, so an unaccepted child being written (or a
      // conversion landing) must not close the card either.
      keepsCardOpen: typed || composerView.recovery !== null || conversionView.recovery !== null,
    };
  };
  let state = build();
  composerOp.subscribe(changed);
  conversionOp.subscribe(changed);

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    openComposer() {
      composing = true;
      changed();
    },
    setDraft(value: string) {
      if (value === draft) return;
      draft = value;
      changed();
    },
    add() {
      const { composer } = state;
      if (draft.trim() === "" || composer.pending || composer.recovery !== null) return;
      composerRetried = false;
      acceptGeneration = ++generation;
      // Stable per submitted draft: this click's ids are the creation's identity.
      composerOp.start({ entityId: crypto.randomUUID(), relationId: crypto.randomUUID(), position: env.placeTail(false), rawDraft: draft });
    },
    retry() {
      const { composer } = state;
      if (!composer.recovery || composer.pending) return;
      composerRetried = true;
      acceptGeneration = ++generation;
      composerOp.retry();
    },
    /** Collapses the composer and drops its draft. Ignored while a write or recovery is in play, unless `force`. */
    cancel(force = false) {
      const { composer } = state;
      if (!force && (composer.pending || composer.recovery !== null)) return;
      ++generation;
      draft = "";
      composing = false;
      composerOp.discard();
      changed();
    },
    /** Typing dismisses an inline error; a retained recovery stays until retried or discarded. */
    clearError() {
      if (state.composer.error !== null) composerOp.discard();
    },
    discardRecovery: () => composerOp.discard(),
    convert(item: ChecklistItem) {
      if (env.isSubtask() || state.conversion.busy) return;
      if (item.text.trim() === "") {
        convertEmptyError = "Checklist item is empty.";
        changed();
        return;
      }
      convertEmptyError = null;
      conversionRetried = false;
      conversionOp.start({
        entityId: crypto.randomUUID(),
        relationId: crypto.randomUUID(),
        position: env.placeTail(item.done),
        rawDraft: item.text,
        checklistItemId: item.id,
      });
    },
    /** Retries the same conversion with its retained ids, so it cannot duplicate. */
    retryConversion() {
      const { conversion } = state;
      if (env.isSubtask() || !conversion.recovery || conversion.pendingItemId !== null || conversion.uncertain) return;
      conversionRetried = true;
      conversionOp.retry();
    },
    discardConversion: () => conversionOp.discard(),
  };
}


export function useSubtaskComposer(scope: AuthoredScope, live: { cardId: string; isSubtask: boolean; placeTail: (done: boolean) => string }) {
  const latest = useRef(live);
  latest.current = live;
  const core = useMemo(
    () =>
      createSubtaskComposer(scope, {
        cardId: () => latest.current.cardId,
        isSubtask: () => latest.current.isSubtask,
        placeTail: (done) => latest.current.placeTail(done),
      }),
    [scope],
  );
  const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);
  const { getState, subscribe, ...actions } = core;
  // `state` is as of this render; `current` reads the live state for callbacks that outlive it.
  return { ...state, ...actions, current: getState };
}

export type SubtaskComposer = ReturnType<typeof useSubtaskComposer>;
