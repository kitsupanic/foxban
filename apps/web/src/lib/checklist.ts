import { useMemo, useRef, useSyncExternalStore } from "react";
import { Title, type ChecklistItem, type ClientMessage } from "@foxban/shared";
import type { AuthoredOperation, AuthoredOperationOptions, AuthoredScope } from "./authored-operation";
import { restoreFocusSoon } from "./focus";

/**
 * Checklist text on one card (ADR 0062): the add field and the inline item editor, each an
 * authored operation (ADR 0069) over its own lane. Acceptance is the only thing that clears
 * the add draft or closes the editor. The core is React-free; the hook at the bottom is a
 * thin adapter that also does the DOM work (returning focus).
 */

type Lane = "add" | "edit";
type ChecklistSent = { id: string; text: string; position?: string };

export type ChecklistLane = { pending: boolean; uncertain: boolean; error: string | null };

export type ChecklistState = {
  newItem: string;
  /** Inline item editor: the id being edited plus its own draft text. */
  editingId: string | null;
  editText: string;
  /** The "Add item" reveal on an empty checklist. */
  adding: boolean;
  add: ChecklistLane;
  edit: ChecklistLane;
  /** A peer deleted the item being edited; its text is kept for "Save as new item". */
  editedItemDeleted: boolean;
  /** Unsent text, a changed edit or a submission in flight. */
  hasWork: boolean;
};

/** What the core reads but does not own. Read at call time, so it always sees the latest values. */
export type ChecklistEnv = {
  cardId(): string;
  /** This card's live checklist items. */
  items(): readonly ChecklistItem[];
  /** A fractional key past this card's last item, for a new item. */
  placeNew(): string;
  /** The editor for `itemId` closed by acceptance or Escape; the view returns focus to its edit button. */
  onEditClosed(itemId: string): void;
};

export function createChecklist(scope: AuthoredScope, env: ChecklistEnv) {
  let newItem = "";
  let editingId: string | null = null;
  let editText = "";
  let adding = false;
  // Validation errors are local; everything else comes from the add / edit operations.
  const invalid: Record<Lane, string | null> = { add: null, edit: null };

  const listeners = new Set<() => void>();
  let snapshot: ChecklistState | null = null;
  let stale = true;
  const changed = () => {
    stale = true;
    for (const listener of Array.from(listeners)) listener();
  };

  const options = (onAccepted: (sent: ChecklistSent) => void): AuthoredOperationOptions<ChecklistSent> => ({
    build: (mutationId, { id, text, position }): ClientMessage =>
      position === undefined
        ? { type: "checklist.update", mutationId, id, text }
        : { type: "checklist.create", mutationId, id, cardId: env.cardId(), text, position },
    confirm: (board, { id }) => !!board?.checklistItems.some((item) => item.id === id),
    onAccepted,
    copy: {
      rejected: "Server rejected checklist save.",
      unverified: "Sync could not verify checklist save. You can retry saving.",
      "not-connected": "Not connected — try again.",
      "accepted-gone": "This item was deleted. Your draft is preserved below.",
    },
  });
  const editedItemDeleted = () => editingId !== null && !env.items().some((item) => item.id === editingId);
  const ops: Record<Lane, AuthoredOperation<ChecklistSent>> = {
    add: scope.operation(options(() => {
      newItem = "";
      changed();
    })),
    edit: scope.operation(options(({ id }) => {
      // The user already left this edit (Escape/Discard): a late acceptance must not steal focus. "Save as
      // new item" sends a fresh id while the edited item is deleted, so that case still belongs to the edit.
      if (editingId !== id && !editedItemDeleted()) return;
      editingId = null;
      changed();
      env.onEditClosed(id);
    })),
  };
  ops.add.subscribe(changed);
  ops.edit.subscribe(changed);

  const pending = (lane: Lane) => {
    const { status } = ops[lane].getState();
    return status === "pending" || status === "uncertain";
  };
  const laneState = (lane: Lane): ChecklistLane => {
    const { status, error } = ops[lane].getState();
    return { pending: pending(lane), uncertain: status === "uncertain", error: invalid[lane] ?? error };
  };

  const hasWork = () =>
    newItem !== "" ||
    (editingId !== null && (editedItemDeleted() || editText !== env.items().find((item) => item.id === editingId)?.text)) ||
    pending("add") ||
    pending("edit");

  // `items` can change without a notification, so the two values derived from them are compared
  // on every read; the snapshot keeps its identity while nothing differs.
  const getState = (): ChecklistState => {
    const deleted = editedItemDeleted();
    const work = hasWork();
    if (stale || snapshot === null || snapshot.editedItemDeleted !== deleted || snapshot.hasWork !== work) {
      stale = false;
      snapshot = { newItem, editingId, editText, adding, add: laneState("add"), edit: laneState("edit"), editedItemDeleted: deleted, hasWork: work };
    }
    return snapshot;
  };

  // A failed lineage is only kept for its error; the draft lives here.
  const clearError = (lane: Lane) => {
    if (invalid[lane] !== null) {
      invalid[lane] = null;
      changed();
    }
    if (ops[lane].getState().status === "failed") ops[lane].discard();
  };

  const sendText = (lane: Lane, itemId?: string) => {
    if (pending(lane)) return;
    const text = (lane === "add" ? newItem : editText).trim();
    if (!text || !Title.safeParse(text).success) {
      invalid[lane] = "Checklist text must contain 1–200 characters.";
      changed();
      return;
    }
    invalid[lane] = null;
    ops[lane].start({
      id: itemId ?? crypto.randomUUID(),
      text,
      position: itemId ? undefined : env.placeNew(),
    });
  };

  const closeEdit = () => {
    editingId = null;
    changed();
  };

  return {
    getState,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    hasWork,
    setNewItem(value: string) {
      if (value === newItem) return;
      newItem = value;
      changed();
    },
    addItem: () => sendText("add"),
    revealAdd() {
      adding = true;
      changed();
    },
    hideAdd() {
      adding = false;
      changed();
    },
    startEdit(item: ChecklistItem) {
      clearError("edit");
      editingId = item.id;
      editText = item.text;
      changed();
    },
    setEditText(value: string) {
      if (value === editText) return;
      editText = value;
      changed();
    },
    /** Escape: leaves the edit and returns focus to the item. Ignored while its save is in flight. */
    cancelEdit() {
      if (pending("edit") || editingId === null) return;
      const id = editingId;
      closeEdit();
      env.onEditClosed(id);
    },
    /** Blur or Enter: an unchanged text just closes the editor, anything else is sent. */
    commitEdit(item: ChecklistItem) {
      if (pending("edit")) return;
      if (editText.trim() === item.text) {
        closeEdit();
        return;
      }
      sendText("edit", item.id);
    },
    /** The edited item was deleted: its draft becomes a new item. */
    saveEditAsNew: () => sendText("edit"),
    discardEdit: closeEdit,
    clearError,
  };
}

export type ChecklistCore = ReturnType<typeof createChecklist>;

export function useChecklist(scope: AuthoredScope, live: { cardId: string; items: readonly ChecklistItem[]; placeNew: () => string }) {
  const latest = useRef(live);
  latest.current = live;
  const core = useMemo(
    () =>
      createChecklist(scope, {
        cardId: () => latest.current.cardId,
        items: () => latest.current.items,
        placeNew: () => latest.current.placeNew(),
        onEditClosed: (itemId) =>
          restoreFocusSoon(() => document.querySelector<HTMLElement>(`[data-checklist-item-edit="${itemId}"]`)),
      }),
    [scope],
  );
  const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);
  const { getState, subscribe, hasWork, ...actions } = core;
  // `state` is as of this render; `current` reads the live state for callbacks that outlive it.
  return { ...state, ...actions, current: getState };
}

export type Checklist = ReturnType<typeof useChecklist>;
