import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { buildSubtaskHierarchy, type ClientMessage, type LabelColor, type Priority, type TaskType } from "@foxban/shared";
import { generateKeyBetween } from "fractional-indexing";
import { cardChecklist, cardLabelViews, columnCards, sortedColumns, type BoardState } from "./apply-mutation";
import { boardQueryKey } from "./board-cache";
import { resolveCardDrop } from "./card-drop";
import { completionFamily } from "./family-completion";
import { alreadyLinked, buildRelation, type RelationOptionValue } from "./relations";
import type { SendMutation } from "./socket";

/**
 * Instant (non-authored) board mutations, by intent. This module mints every
 * mutation and entity id (ADR 0010), builds the protocol message and chooses the
 * fractional key, so components never touch `ClientMessage` or key generation.
 * Authored operations (ADR 0069) keep their own builders and only borrow the
 * placement helpers below.
 */
export type Sent = "sent" | "not-sent" | "no-op";
/** A move into a completed column with open subtasks is never sent: the caller must ask how to finish. */
export type MoveResult = Sent | { needsFinish: { columnId: string; position: string } };

/** A protocol message before its mutation id is minted. */
type Draft = ClientMessage extends infer M ? (M extends ClientMessage ? Omit<M, "mutationId"> : never) : never;

/**
 * A new card's key: past every card in the column. That is last among whatever peers it is
 * shown with, and unlike a peer-only tail it never ties a key already in the column (a first
 * subtask would otherwise mint "a0" beside the column's first root).
 */
export const newCardPosition = (state: BoardState, columnId: string) => generateKeyBetween(columnCards(state, columnId).at(-1)?.position ?? null, null);
export const newColumnPosition = (state: BoardState) => generateKeyBetween(sortedColumns(state).at(-1)?.position ?? null, null);
export const newChecklistPosition = (state: BoardState, cardId: string) => generateKeyBetween(cardChecklist(state, cardId).at(-1)?.position ?? null, null);

export function boardCommands(send: SendMutation, readBoard: () => BoardState | undefined) {
  const emit = (message: Draft): Sent => (send({ ...message, mutationId: crypto.randomUUID() } as ClientMessage) ? "sent" : "not-sent");
  /** Runs `fn` against the latest cache; no board yet means nothing can be sent. */
  const withBoard = <R>(fn: (state: BoardState) => R): R | "not-sent" => {
    const state = readBoard();
    return state ? fn(state) : "not-sent";
  };
  const cardField = <K extends "assigneeId" | "priority" | "dueDate" | "taskType">(state: BoardState, id: string, key: K) => state.cards.find(card => card.id === id)?.[key];

  const empty: BoardState = { workflowRolesExplicit: false, columns: [], cards: [], archivedCards: [], checklistItems: [], attachments: [], comments: [], commentCounts: {}, relations: [], labels: [], cardLabels: [] };

  return {
    // Keys for authored creations, read from the latest unfiltered cache: a filter hides rows, it never reorders.
    placeNewCard: (columnId: string) => newCardPosition(readBoard() ?? empty, columnId),
    placeNewColumn: () => newColumnPosition(readBoard() ?? empty),
    placeNewChecklistItem: (cardId: string) => newChecklistPosition(readBoard() ?? empty, cardId),

    /** The only sender of `card.move`. Without `position` the card lands at the tail of its displayed peers (card-drop rules). */
    moveCard: (id: string, to: { columnId: string; position?: string }): MoveResult => withBoard<MoveResult>(state => {
      const card = state.cards.find(candidate => candidate.id === id);
      if (!card) return "no-op";
      let position = to.position;
      if (position === undefined) {
        if (to.columnId === card.columnId) return "no-op";
        const drop = resolveCardDrop(state, buildSubtaskHierarchy(state.cards, state.relations), id, `column-drop:${to.columnId}`);
        if (!drop) return "no-op";
        position = drop.position;
      }
      const entersCompleted = card.columnId !== to.columnId && state.columns.some(column => column.id === to.columnId && column.completed);
      if (entersCompleted && completionFamily(state, id).open.length > 0) return { needsFinish: { columnId: to.columnId, position } };
      return emit({ type: "card.move", id, columnId: to.columnId, position });
    }),
    /** A restored card lands at the flat tail of the column it is sent to. */
    restoreCard: (id: string, columnId: string): Sent => withBoard(state => {
      if (!state.archivedCards.some(card => card.id === id) || !state.columns.some(column => column.id === columnId)) return "no-op";
      return emit({ type: "card.restore", id, columnId, position: newCardPosition(state, columnId) });
    }),
    purgeCard: (id: string): Sent => withBoard(state => state.archivedCards.some(card => card.id === id) ? emit({ type: "card.purge", id }) : "no-op"),
    deleteCard: (id: string): Sent => emit({ type: "card.delete", id }),
    // Assignment is its own mutation, not a `card.update` field: `null` has to mean "unassign".
    assign: (id: string, assigneeId: string | null): Sent => withBoard(state => cardField(state, id, "assigneeId") === assigneeId ? "no-op" : emit({ type: "card.assign", id, assigneeId })),
    prioritize: (id: string, priority: Priority): Sent => withBoard(state => cardField(state, id, "priority") === priority ? "no-op" : emit({ type: "card.prioritize", id, priority })),
    retype: (id: string, taskType: Exclude<TaskType, "subtask">): Sent => withBoard(state => {
      const current = cardField(state, id, "taskType");
      return current === "subtask" || current === taskType ? "no-op" : emit({ type: "card.retype", id, taskType });
    }),
    schedule: (id: string, dueDate: string | null): Sent => withBoard(state => cardField(state, id, "dueDate") === dueDate ? "no-op" : emit({ type: "card.schedule", id, dueDate })),

    /** Moves a column to where `overColumnId` stands: after it when moving right, before it when moving left. */
    moveColumn: (id: string, overColumnId: string): Sent => withBoard(state => {
      const ordered = sortedColumns(state);
      const from = ordered.findIndex(column => column.id === id);
      const over = ordered.findIndex(column => column.id === overColumnId);
      if (from === -1 || over === -1 || from === over) return "no-op";
      const rest = ordered.filter(column => column.id !== id);
      const index = rest.findIndex(column => column.id === overColumnId) + (from < over ? 1 : 0);
      const prev = rest[index - 1]?.position ?? null;
      const next = rest[index]?.position ?? null;
      // Concurrent creates can tie (prev === next); bound by the first key above the tie so the column stays beside its neighbours instead of landing at the far right.
      const upper = prev !== null && prev === next ? rest.find(column => column.position > prev)?.position ?? null : next;
      return emit({ type: "column.move", id, position: generateKeyBetween(prev, upper) });
    }),
    renameColumn: (id: string, title: string): Sent => emit({ type: "column.rename", id, title }),
    /** The expected current roles let the board refuse a choice made against a stale view. */
    configureWorkflow: (startingColumnId: string, completedColumnId: string): Sent => withBoard(state => emit({
      type: "workflow.configure", startingColumnId, completedColumnId,
      expectedStartingColumnId: state.columns.find(column => column.starting)?.id ?? null,
      expectedCompletedColumnId: state.columns.find(column => column.completed)?.id ?? null,
    })),
    deleteColumn: (id: string): Sent => withBoard(state => state.columns.some(column => column.id === id) ? emit({ type: "column.delete", id }) : "no-op"),

    toggleLabel: (cardId: string, labelId: string): Sent => withBoard(state => {
      const join = cardLabelViews(state, cardId).find(view => view.label.id === labelId);
      if (!join) return emit({ type: "label.assign", id: crypto.randomUUID(), cardId, labelId });
      const results = join.assignmentIds.map(id => emit({ type: "label.unassign", id }));
      return results.includes("sent") ? "sent" : "not-sent";
    }),
    /**
     * Two mutations from one submit. "not-sent" only when the definition did not go
     * out; a dropped assign leaves an unassigned label one click from fixed (ADR 0019),
     * and reporting it as failed would invite a duplicate definition.
     */
    createAndAssignLabel: (cardId: string, name: string, color: LabelColor): Sent => {
      const labelId = crypto.randomUUID();
      if (emit({ type: "label.create", id: labelId, name, color }) === "not-sent") return "not-sent";
      emit({ type: "label.assign", id: crypto.randomUUID(), cardId, labelId });
      return "sent";
    },
    /** Partial by construction: only defined fields go out, so a peer's concurrent edit of the other survives. */
    updateLabel: (id: string, { name, color }: { name?: string; color?: LabelColor }): Sent =>
      name === undefined && color === undefined ? "no-op" : emit({ type: "label.update", id, ...(name !== undefined && { name }), ...(color !== undefined && { color }) }),
    deleteLabel: (id: string): Sent => emit({ type: "label.delete", id }),

    /** A duplicate pair is a no-op; the DO does no referential checks. */
    createRelation: (option: RelationOptionValue, cardId: string, otherCardId: string): Sent => withBoard(state => {
      const { sourceCardId, targetCardId, kind } = buildRelation(option, cardId, otherCardId);
      if (alreadyLinked(state.relations, kind, cardId, otherCardId)) return "no-op";
      return emit({ type: "relation.create", id: crypto.randomUUID(), sourceCardId, targetCardId, kind });
    }),
    deleteRelation: (id: string): Sent => emit({ type: "relation.delete", id }),
    setChecklistDone: (id: string, done: boolean): Sent => emit({ type: "checklist.update", id, done }),
    deleteChecklistItem: (id: string): Sent => emit({ type: "checklist.delete", id }),
    deleteAttachment: (id: string): Sent => emit({ type: "attachment.delete", id }),
    deleteComment: (id: string, cardId: string): Sent => emit({ type: "comment.delete", id, cardId }),
  };
}
export type BoardCommands = ReturnType<typeof boardCommands>;

/** `boardCommands` over this board's query cache, stable while `send` is. */
export function useBoardCommands(boardId: string, send: SendMutation): BoardCommands {
  const queryClient = useQueryClient();
  return useMemo(() => boardCommands(send, () => queryClient.getQueryData<BoardState>(boardQueryKey(boardId))), [boardId, queryClient, send]);
}

