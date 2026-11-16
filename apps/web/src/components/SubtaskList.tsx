import { ChevronDown, ChevronRight, Circle, CircleCheck, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Card, CardRelation, SubtaskHierarchy } from "@foxban/shared";
import { buildSubtaskNodes, directSubtaskCounts, type SubtaskNode } from "../lib/subtask-nodes";
import { cn } from "../lib/utils";
import { taskKey } from "../lib/task-key";
import { Button } from "./ui/button";

/** The rows of one family and, for the board tree, how open they are. */
export interface SubtaskDisclosure {
  /** Families the reader closed; everything else is open, as the board starts. */
  collapsed: ReadonlySet<string>;
  /** Absent in the drag preview: rows show their state but own no focus targets. */
  onToggle?: (cardId: string) => void;
}

/** Row controls. Absent renders the same rows as plain, non-interactive content. */
export interface SubtaskActions {
  onOpen: (cardId: string) => void;
  /** Absent on a board that cannot complete a subtask (no starting and completed columns). */
  onComplete?: (cardId: string, done: boolean) => void;
  /** Present only in the card's detail view. */
  onUnlink?: (relationId: string) => void;
}

/** The circular completion control: a real button, never a nested one. */
export function SubtaskCompletionButton({
  title,
  done,
  onToggle,
}: {
  title: string;
  done: boolean;
  onToggle: (done: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={done}
      aria-label={done ? `Reopen ${title}` : `Complete ${title}`}
      onClick={() => onToggle(!done)}
      className="flex size-6 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
    >
      {done ? (
        <CircleCheck aria-hidden="true" className="size-4 text-success" />
      ) : (
        <Circle aria-hidden="true" className="size-4 text-muted-foreground" />
      )}
    </button>
  );
}

/**
 * The board family block one parent card renders below its body: the full-width
 * disclosure footer (chevron, "Subtasks", done / total) and, under it, the
 * connected child rows. Nothing renders when the card has no direct children —
 * the footer exists only to disclose a family that is really there.
 */
export function CardSubtaskFamily({
  state,
  hierarchy,
  cardId,
  visibleCardIds,
  disclosure,
  renderChild,
}: {
  /** Renders one nested child, which is a card of its own. */
  renderChild: (card: Card) => ReactNode;
  state: { cards: readonly Card[]; relations: readonly CardRelation[] };
  hierarchy: SubtaskHierarchy;
  cardId: string;
  /** The board's per-card filter predicate, or null when no filter is active. */
  visibleCardIds: ReadonlySet<string> | null;
  disclosure: SubtaskDisclosure;
}) {
  const { done, total } = directSubtaskCounts(state.cards, hierarchy, cardId);
  if (total === 0) return null;
  // Only children in the parent's own column nest under it; the rest are cards of their own elsewhere.
  const nodes = buildSubtaskNodes(
    state,
    hierarchy,
    cardId,
    { sameColumn: true, ...(visibleCardIds === null ? {} : { includeCard: (id: string) => visibleCardIds.has(id) }) },
  );
  return (
    <CardSubtaskFamilyBlock
      renderChild={renderChild}
      parentCardId={cardId}
      nodes={nodes}
      done={done}
      total={total}
      disclosure={disclosure}
    />
  );
}

/** The footer and row list for a family that is known to exist. */
function CardSubtaskFamilyBlock({
  renderChild,
  parentCardId,
  nodes,
  done,
  total,
  disclosure,
}: {
  renderChild: (card: Card) => ReactNode;
  parentCardId: string;
  nodes: readonly SubtaskNode[];
  done: number;
  total: number;
  disclosure: SubtaskDisclosure;
}) {
  const listId = `subtask-family-${parentCardId}`;
  const open = !disclosure.collapsed.has(parentCardId);
  const footer = (
    <>
      {open ? (
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold uppercase tracking-wide">
        Subtasks
      </span>
      <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
        {done} / {total}
      </span>
    </>
  );

  return (
    <div className="w-full">
      {disclosure.onToggle === undefined ? (
        <span
          aria-hidden="true"
          className="flex w-full items-center gap-2 border-t border-border px-2 py-1.5 text-muted-foreground pointer-coarse:min-h-11"
        >
          {footer}
        </span>
      ) : (
        <button
          type="button"
          data-subtask-disclosure={parentCardId}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => disclosure.onToggle?.(parentCardId)}
          className="flex w-full items-center gap-2 rounded-b-[7px] border-t border-border px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
        >
          {footer}
        </button>
      )}
      {open && nodes.length > 0 && (
        <div id={listId} className="border-t border-border px-2 py-2">
          <ul className="flex flex-col gap-2">{nodes.map((node) => renderChild(node.card))}</ul>
        </div>
      )}
    </div>
  );
}

/**
 * Shared bordered-row presentation with a completion control beside a
 * title-over-task-ID button. Used inside board cards and task details so the
 * two surfaces remain visually and behaviorally consistent.
 */
export function SubtaskList({
  nodes,
  boardKey,
  depth = 0,
  disclosure,
  actions,
  statusLabel,
}: {
  nodes: readonly SubtaskNode[];
  boardKey?: string;
  depth?: number;
  disclosure?: SubtaskDisclosure;
  actions?: SubtaskActions;
  /** Detail rows only: the child's own status, as plain text. */
  statusLabel?: (card: Card) => string | undefined;
}) {
  return (
    <ul className="flex min-w-0 flex-col gap-2">
      {nodes.map((node) => (
        <SubtaskRow
          key={node.card.id}
          node={node}
          boardKey={boardKey}
          depth={depth}
          disclosure={disclosure}
          actions={actions}
          statusLabel={statusLabel}
        />
      ))}
    </ul>
  );
}

function SubtaskRow({
  node,
  boardKey,
  depth,
  disclosure,
  actions,
  statusLabel,
}: {
  node: SubtaskNode;
  boardKey?: string;
  depth: number;
  disclosure?: SubtaskDisclosure;
  actions?: SubtaskActions;
  statusLabel?: (card: Card) => string | undefined;
}) {
  const { card } = node;
  const hasChildren = node.children.length > 0;
  const open = disclosure === undefined || !disclosure.collapsed.has(card.id);
  const childListId = `subtask-children-${card.id}`;
  // Indentation stops after two nested levels so a deep family stays readable on
  // a 375px screen; deeper levels keep an explicit Subtasks header instead.
  const indented = depth < 2;
  const columnLabel = statusLabel?.(card);
  const title = (
    <>
      <span
        className={cn(
          "block break-words text-xs font-medium",
          card.subtaskDone && "text-muted-foreground line-through",
        )}
      >
        {card.title}
      </span>
      {boardKey !== undefined && card.taskNumber > 0 && (
        <span className="block text-[11px] text-muted-foreground">
          {taskKey(boardKey, card.taskNumber)}
        </span>
      )}
    </>
  );

  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-stretch">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[9px] border border-border bg-card p-2">
          {actions?.onComplete === undefined ? (
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              {card.subtaskDone ? (
                <CircleCheck className="size-4 text-success" />
              ) : (
                <Circle className="size-4 text-muted-foreground" />
              )}
            </span>
          ) : (
            <SubtaskCompletionButton
              title={card.title}
              done={card.subtaskDone}
              onToggle={(done) => actions.onComplete?.(card.id, done)}
            />
          )}
          {actions === undefined ? (
            <span className="min-w-0 flex-1">{title}</span>
          ) : (
            <button
              type="button"
              data-card-id={card.id}
              aria-label={`Open subtask ${card.title}`}
              onClick={() => actions.onOpen(card.id)}
              className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
            >
              {title}
            </button>
          )}
          {columnLabel !== undefined && (
            <span className="shrink-0 self-center text-[11px] text-muted-foreground">
              {columnLabel}
            </span>
          )}
          {hasChildren &&
            (disclosure?.onToggle === undefined || actions === undefined ? (
              <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                {open ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </span>
            ) : (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={open ? childListId : undefined}
                aria-label={
                  open
                    ? `Collapse subtasks of ${card.title}`
                    : `Expand subtasks of ${card.title}`
                }
                onClick={() => disclosure?.onToggle?.(card.id)}
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                {open ? (
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                ) : (
                  <ChevronRight aria-hidden="true" className="size-3.5" />
                )}
              </button>
            ))}
          {actions?.onUnlink !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove subtask ${card.title}`}
              onClick={() => actions.onUnlink?.(node.relationId)}
              className="shrink-0 self-center text-muted-foreground hover:text-destructive pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              <X aria-hidden="true" className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {hasChildren && open && (
        <div className={cn("mt-2", indented && "pl-[15px]")}>
          {!indented && (
            <p className="pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Subtasks
            </p>
          )}
          <SubtaskList
            nodes={node.children}
            boardKey={boardKey}
            depth={depth + 1}
            disclosure={disclosure}
            actions={actions}
            statusLabel={statusLabel}
          />
        </div>
      )}
    </li>
  );
}
