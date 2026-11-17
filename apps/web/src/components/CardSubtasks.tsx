import { Network, Plus, X } from "lucide-react";
import type { Card, CardRelation, Column, SubtaskHierarchy } from "@foxban/shared";
import type { BoardCommands } from "../lib/board-commands";
import { cardTitle } from "../lib/relations";
import { buildSubtaskNodes, directSubtaskCounts } from "../lib/subtask-nodes";
import type { SubtaskComposer } from "../lib/subtask-composer";
import { SubtaskList } from "./SubtaskList";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * The card's subtasks (ADR 0067): its parent link, its direct children and the composer that
 * creates one. Checklist conversion shares the composer's state but renders in the checklist.
 */
// Also a `div`, for the same reason as the checklist. The section is always present:
// `Add subtask` is the only place a child can be created directly, so it cannot be
// hidden behind already having one.
export function CardSubtasks({
  subtasks,
  card,
  relations,
  hierarchy,
  cards,
  columns,
  boardKey,
  commands,
  navigate,
  onRequestMove,
  requestClose,
  cancelPendingClose,
}: {
  subtasks: SubtaskComposer;
  card: Pick<Card, "id" | "taskType">;
  relations: CardRelation[];
  hierarchy: SubtaskHierarchy;
  /** All board cards: the children's rows and the parent's title are read from them. */
  cards: Card[];
  columns: Column[];
  boardKey?: string;
  commands: Pick<BoardCommands, "deleteRelation">;
  /** Opens another card, behind the discard strip while a draft is unsaved. */
  navigate: (cardId: string) => void;
  onRequestMove: (id: string, columnId: string, trigger?: HTMLElement | null) => void;
  /** Parks an exit behind the discard strip while the modal has unsaved work (ADR 0020). */
  requestClose: (action: () => void) => void;
  cancelPendingClose: () => void;
}) {
  const { composer } = subtasks;
  // Without a starting and a completed column (fewer than two columns) there is
  // no completion to change.
  const hasWorkflowRoles = columns.some(column => column.starting) && columns.some(column => column.completed);
  /** Completion is an ordinary instant mutation: optimistic, with board-reported errors. */
  const completeSubtask = (cardId: string, done: boolean) => {
    const target = columns.find(c => done ? c.completed : c.starting);
    if (target) onRequestMove(cardId, target.id);
  };
  // The guarded forest decides whether this card is a subtask at all: a stored
  // child with two parents (or inside a cycle) is a root here, exactly as the
  // board and the server read it.
  const effectiveParentId = hierarchy.parentByChild.get(card.id);
  const parentLink =
    effectiveParentId === undefined
      ? undefined
      : relations.find(
          (relation) =>
            relation.kind === "subtask" &&
            relation.targetCardId === card.id &&
            relation.sourceCardId === effectiveParentId,
        );
  /** The card's direct children, with the link each row can unlink. */
  const childNodes = buildSubtaskNodes({ cards, relations }, hierarchy, card.id, {
    directOnly: true,
  });
  const subtaskCounts = directSubtaskCounts(cards, hierarchy, card.id);
  const subtaskPercent =
    subtaskCounts.total > 0
      ? Math.round((subtaskCounts.done / subtaskCounts.total) * 100)
      : 0;
  return (
    <div data-testid="card-subtasks-section" data-empty={subtaskCounts.total === 0 && parentLink === undefined && !subtasks.composing} className="card-subtasks-section flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="card-section-title text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Network aria-hidden="true" className="card-section-icon" />Subtasks
        </h3>
        {subtaskCounts.total > 0 && (
          <span className="text-xs text-muted-foreground">
            {subtaskCounts.done} of {subtaskCounts.total} done
          </span>
        )}
      </div>
      {parentLink !== undefined && (
        <div className="group flex items-center gap-2 text-sm text-foreground">
          <button
            type="button"
            aria-label={`Open parent ${cardTitle(cards, parentLink.sourceCardId)}`}
            onClick={() => navigate(parentLink.sourceCardId)}
            className="min-w-0 flex-1 truncate text-left hover:underline"
          >
            <span className="text-muted-foreground">Subtask of</span>{" "}
            <span className="font-medium text-foreground">{cardTitle(cards, parentLink.sourceCardId)}</span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove parent link ${cardTitle(cards, parentLink.sourceCardId)}`}
            onClick={() => commands.deleteRelation(parentLink.id)}
            className="opacity-0 pointer-coarse:opacity-100 size-7 pointer-coarse:size-11 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-destructive"
          >
            <X aria-hidden className="size-3.5" />
          </Button>
        </div>
      )}
      {subtaskCounts.total > 0 && (
        <div
          role="progressbar"
          aria-label="Subtask progress"
          aria-valuemin={0}
          aria-valuemax={subtaskCounts.total}
          aria-valuenow={subtaskCounts.done}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-success transition-[width] duration-200"
            style={{ width: `${subtaskPercent}%` }}
          />
        </div>
      )}
      {childNodes.length > 0 && (
        <SubtaskList
          nodes={childNodes}
          boardKey={boardKey}
          actions={{
            onOpen: navigate,
            onComplete: hasWorkflowRoles ? completeSubtask : undefined,
            onUnlink: (relationId: string) => commands.deleteRelation(relationId),
          }}
          // The child's own status, as plain text.
          statusLabel={(child: Card) =>
            columns.find((column) => column.id === child.columnId)?.title
          }
        />
      )}
      {card.taskType !== "subtask" && (
        subtasks.composing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            subtasks.add();
          }}
        >
          <Input
            autoFocus
            aria-label="Subtask title"
            maxLength={200}
            placeholder="Subtask title…"
            value={subtasks.draft}
            readOnly={composer.pending}
            onChange={(event) => {
              // A submitted draft is held read-only until it settles; the title
              // the server received must not drift while it is in flight.
              if (composer.pending) return;
              subtasks.setDraft(event.target.value);
              subtasks.clearError();
              cancelPendingClose();
            }}
            onKeyDown={(event) => {
              // The modal's Escape listener sits on `window`; stopping here keeps
              // a cancelled composer from also closing the card.
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (subtasks.draft.trim() === "" && !composer.pending) {
                  subtasks.cancel();
                } else if (!composer.pending) {
                  requestClose(() => subtasks.cancel(true));
                }
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                subtasks.add();
              }
            }}
            className="h-8 bg-background text-base sm:text-sm"
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={
                subtasks.draft.trim() === "" ||
                composer.pending ||
                composer.recovery !== null
              }
              className="pointer-coarse:min-h-11 pointer-coarse:px-4"
            >
              {composer.pending ? "Adding…" : "Add"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={composer.pending}
              onClick={() => subtasks.cancel()}
              className="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-4"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={composer.recovery !== null}
          onClick={() => subtasks.openComposer()}
          className="card-subtask-add self-start border-border text-foreground hover:bg-accent pointer-coarse:min-h-11 pointer-coarse:px-4"
        >
          <Plus aria-hidden="true" className="size-4" />Add subtask
        </Button>
        )
      )}
      {composer.recovery !== null && (
        <div
          role="alert"
          className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
        >
          <div className="flex items-center justify-between gap-2 font-medium">
            <span>{composer.recovery.error}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => subtasks.retry()}
                disabled={composer.pending}
                className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                {composer.pending ? "Retrying…" : "Retry unsent subtask"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={composer.pending}
                onClick={() => {
                  if (composer.pending) return;
                  subtasks.discardRecovery();
                }}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                Discard unsent subtask
              </Button>
            </div>
          </div>
          <div className="rounded border border-border/50 bg-background/50 p-2 font-mono text-[11px] whitespace-pre-wrap break-words text-foreground">
            <span className="font-semibold text-muted-foreground">Unsent subtask: </span>
            {composer.recovery.rawDraft}
          </div>
        </div>
      )}
      {composer.error !== null && (
        <div role="alert" className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>{composer.error}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => subtasks.add()}
            className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
