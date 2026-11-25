import { Ellipsis, Inbox, Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card, Column, SubtaskHierarchy } from "@foxban/shared";
import type { Member } from "../lib/api";
import { boardAncestors, type BoardIndex, type BoardState } from "../lib/apply-mutation";
import type { BoardCommands } from "../lib/board-commands";
import { CardView, getCardFaceProps } from "./CardView";
import { CardSubtaskFamily } from "./SubtaskList";
import type { CardPullRequestBadge } from "../lib/card-development";
import { cn } from "../lib/utils";
import { restoreFocusSoon } from "../lib/focus";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** `cards` arrives sorted by position. Columns drag by their own handle and open card creation by a trigger. */
export function ColumnView({
  column,
  canManageColumns,
  cards,
  totalCardCount,
  matchingCardCount,
  isFilterActive,
  index,
  state,
  hierarchy,
  collapsedSubtasks,
  visibleCardIds: visibleCards,
  membersById,
  boardKey,
  pullRequestBadges,
  commands,
  onOpenCard,
  onToggleSubtasks,
  onRequestDelete,
  onAddCard,
  dropHint,
}: {
  dropHint: { cardId: string; placement: "before" | "after" | "inside" } | null;
  column: Column;
  canManageColumns: boolean;
  /** The rendered roots in this column, in position order. */
  cards: Card[];
  /** Every active card that actually appears in this column, matched or not. */
  totalCardCount: number;
  /** Direct matches in this column; a context ancestor is not one of them. */
  matchingCardCount: number;
  isFilterActive: boolean;
  /** The board's card lookup and per-card face aggregates, built once per board state. */
  index: BoardIndex;
  /** Read by the subtask families; the cards themselves arrive in `cards`. */
  state: BoardState;
  /** The board's shared subtask forest, so each card renders its own family. */
  hierarchy: SubtaskHierarchy;
  /** Families the reader closed; everything else is open. */
  collapsedSubtasks: ReadonlySet<string>;
  /** The per-card filter predicate, or null when no filter is active. */
  visibleCardIds: ReadonlySet<string> | null;
  membersById: Record<string, Member | undefined>;
  boardKey?: string;
  /** The board's live pull request badges, by card id; absent ids show none. */
  pullRequestBadges: ReadonlyMap<string, CardPullRequestBadge>;
  commands: BoardCommands;
  onOpenCard: (cardId: string) => void;
  onToggleSubtasks: (cardId: string) => void;
  onRequestDelete: (trigger: HTMLButtonElement) => void;
  /** Opens the board's create dialog for this column, from the control that was used. */
  onAddCard: (trigger: HTMLButtonElement) => void;
}) {
  const renderChild = (child: Card): ReactNode => <CardView key={child.id} dropPlacement={dropHint?.cardId === child.id ? dropHint.placement : undefined} {...getCardFaceProps(index, child, membersById, boardKey, pullRequestBadges.get(child.id) ?? null)} subtaskContent={<CardSubtaskFamily state={state} hierarchy={hierarchy} cardId={child.id} visibleCardIds={visibleCards} disclosure={{ collapsed: collapsedSubtasks, onToggle: onToggleSubtasks }} renderChild={renderChild} />} onOpen={onOpenCard} />;
  const localContext = new Set<string>();
  if (visibleCards !== null) for (const id of visibleCards) {
    if (index.cardsById.get(id)?.columnId !== column.id) continue;
    for (const parent of boardAncestors(state, hierarchy, id, index.cardsById)) localContext.add(parent);
  }
  const collectIds = (card: Card): string[] => [card.id, ...(!collapsedSubtasks.has(card.id) ? (hierarchy.childrenByParent.get(card.id) ?? []).flatMap(id => {
    const child = index.cardsById.get(id);
    return child?.columnId === column.id && (visibleCards === null || visibleCards.has(id) || localContext.has(id)) ? collectIds(child) : [];
  }) : [])];
  const renderedIds = cards.flatMap(collectIds);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const addCardButtonRef = useRef<HTMLButtonElement>(null);
  const [pendingFocusRename, setPendingFocusRename] = useState(false);
  // The column body is a droppable of its own so empty columns accept cards.
  const { setNodeRef: setDropNodeRef, isOver } = useDroppable({ id: `column-drop:${column.id}` });

  const {
    attributes: sortableAttributes,
    listeners: sortableListeners,
    setNodeRef: setSortableNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: column.id,
    data: { type: "column" },
  });

  // Select whole title only when entering edit mode (when titleDraft transitions to non-null), not on every keystroke
  const wasEditingRef = useRef(false);
  useEffect(() => {
    const isEditing = titleDraft !== null;
    if (isEditing && !wasEditingRef.current) {
      titleInputRef.current?.select();
    }
    wasEditingRef.current = isEditing;
  }, [titleDraft]);

  useEffect(() => {
    if (canManageColumns && pendingFocusRename && titleDraft === null) {
      setPendingFocusRename(false);
      restoreFocusSoon(renameButtonRef.current);
    }
  }, [canManageColumns, pendingFocusRename, titleDraft]);

  const closeTitleEditor = (shouldRestoreFocus = true) => {
    setTitleDraft(null);
    setPendingFocusRename(shouldRestoreFocus);
  };

  // A lost capability closes the editor and hands focus to the control that is
  // still there: the footer Add card, not the rename trigger that just vanished.
  useEffect(() => {
    if (!canManageColumns && (titleDraft !== null || pendingFocusRename)) {
      closeTitleEditor(false);
      restoreFocusSoon(addCardButtonRef.current);
    }
  }, [canManageColumns, titleDraft, pendingFocusRename]);

  const commitTitle = () => {
    if (!canManageColumns) {
      closeTitleEditor(false);
      restoreFocusSoon(addCardButtonRef.current);
      return;
    }
    const title = titleDraft?.trim();
    if (!title || title === column.title) {
      closeTitleEditor(true);
      return;
    }
    if (commands.renameColumn(column.id, title) === "sent") closeTitleEditor(true);
  };

  return (
    <section
      ref={setSortableNodeRef}
      style={{
        transform: isDragging ? undefined : CSS.Translate.toString(transform),
        transition: isDragging ? undefined : transition,
      }}
      data-column-id={column.id}
      data-column-title={column.title}
      className={cn("board-column", isDragging && "board-column-dragging")}
    >
      <header className="board-column-header">
        {canManageColumns ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Move column ${column.title}`}
            className="board-column-grip"
            {...sortableAttributes}
            {...sortableListeners}
          >
            <span className="board-column-dot" aria-hidden="true" />
          </Button>
        ) : (
          <span className="board-column-dot" aria-hidden="true" />
        )}
        <div className="board-column-heading">
          {!canManageColumns ? (
            <h2 className="board-column-title">{column.title}</h2>
          ) : titleDraft === null ? (
            <h2 className="board-column-title">
              <Button
                ref={renameButtonRef}
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Rename column ${column.title}`}
                title="Click or press Enter to rename"
                onClick={() => setTitleDraft(column.title)}
                className="board-column-rename"
              >
                <span className="truncate">{column.title}</span>
              </Button>
            </h2>
          ) : (
            <Input
              autoFocus
              ref={titleInputRef}
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => {
                // On blur, commit if non-empty and changed; otherwise cancel
                const title = titleDraft?.trim();
                if (title && title !== column.title) {
                  commitTitle();
                } else {
                  closeTitleEditor(false);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitTitle();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeTitleEditor(true);
                }
              }}
              className="board-column-title-input"
            />
          )}
          <span className="board-column-count">
            <span aria-hidden="true">
              {isFilterActive ? `${matchingCardCount} / ${totalCardCount}` : totalCardCount}
            </span>
            <span className="sr-only">
              {isFilterActive
                ? `${matchingCardCount} of ${totalCardCount} cards shown`
                : `${totalCardCount} ${totalCardCount === 1 ? "card" : "cards"}`}
            </span>
          </span>
        </div>
        <div className="board-column-actions">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Add card to ${column.title}`}
            onClick={(event) => onAddCard(event.currentTarget)}
            className="board-column-icon-button"
          >
            <Plus aria-hidden="true" />
          </Button>
          {canManageColumns && titleDraft === null && (
            <ColumnActionsMenu
              columnTitle={column.title}
              onRename={() => setTitleDraft(column.title)}
              onDelete={onRequestDelete}
            />
          )}
        </div>
      </header>

      <SortableContext items={renderedIds} strategy={verticalListSortingStrategy}>
        <ul
          ref={setDropNodeRef}
          className={cn(
            "board-column-cards",
            cards.length === 0 && "board-column-cards-empty",
            isOver && "board-column-cards-over",
          )}
        >
          {cards.map((card) => {
            const faceProps = getCardFaceProps(
              index,
              card,
              membersById,
              boardKey,
              pullRequestBadges.get(card.id) ?? null,
            );
            return (
              <CardView
                key={card.id}
                dropPlacement={dropHint?.cardId === card.id ? dropHint.placement : undefined}
                {...faceProps}
                // A card outside every family has nothing to show, and an absent slot keeps its props stable for memo.
                subtaskContent={!hierarchy.parentByChild.has(card.id) && !hierarchy.childrenByParent.get(card.id)?.length ? undefined : (
                  <>
                  {hierarchy.parentByChild.has(card.id) && <button type="button" className="w-full truncate border-t px-2 py-1 text-left text-xs text-muted-foreground" onClick={() => onOpenCard(hierarchy.parentByChild.get(card.id)!)}>Parent: {index.cardsById.get(hierarchy.parentByChild.get(card.id)!)?.title}</button>}
                  <CardSubtaskFamily
                    renderChild={renderChild}
                    state={state}
                    hierarchy={hierarchy}
                    cardId={card.id}
                    visibleCardIds={visibleCards}
                    disclosure={{ collapsed: collapsedSubtasks, onToggle: onToggleSubtasks }}
                  />
                  </>
                )}
                onOpen={onOpenCard}
              />
            );
          })}
        </ul>
      </SortableContext>

      {/* A column with nothing to show says which kind of nothing it is, and the
          list above it keeps its droppable height. */}
      {cards.length === 0 && (
        <div className="board-column-empty">
          <Inbox aria-hidden="true" className="board-column-empty-icon" />
          <span>{isFilterActive && totalCardCount > 0 ? "No matching cards" : "No cards yet"}</span>
        </div>
      )}

      <Button
        ref={addCardButtonRef}
        type="button"
        variant="ghost"
        size="sm"
        onClick={(event) => onAddCard(event.currentTarget)}
        className="board-column-add-card"
      >
        <Plus aria-hidden="true" />
        Add card
      </Button>
    </section>
  );
}

/**
 * The column's own Rename/Delete menu. It is local to the column header — the
 * board's menu owns boards, not columns — and copies the shared menu's
 * outside-click, Escape and arrow-focus behaviour rather than inventing one.
 */
function ColumnActionsMenu({
  columnTitle,
  onRename,
  onDelete,
}: {
  columnTitle: string;
  onRename: () => void;
  onDelete: (trigger: HTMLButtonElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = `Column actions for ${columnTitle}`;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (!open) return;
      event.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (!open) {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      setOpen(true);
      return;
    }
    event.preventDefault();
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : index === -1
            ? 0
            : (index + step + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="board-column-icon-button"
      >
        <Ellipsis aria-hidden="true" />
      </Button>
      {open && (
        <div role="menu" aria-label={label} className="board-column-menu">
          <Button
            type="button"
            role="menuitem"
            variant="ghost"
            size="sm"
            autoFocus
            onClick={() => {
              close();
              onRename();
            }}
            className="board-column-menu-item"
          >
            Rename
          </Button>
          <Button
            type="button"
            role="menuitem"
            variant="ghost"
            size="sm"
            onClick={() => {
              const trigger = triggerRef.current;
              setOpen(false);
              // Delete hands its own trigger along, so the confirmation dialog
              // returns focus to this ellipsis when it closes.
              if (trigger) onDelete(trigger);
            }}
            className="board-column-menu-item board-column-menu-danger"
          >
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}
