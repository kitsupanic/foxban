import { useRef } from "react";
import { ArrowUpRight, Plus, SquareCheck, X } from "lucide-react";
import type { Card, ChecklistItem } from "@foxban/shared";
import type { BoardCommands } from "../lib/board-commands";
import type { Checklist } from "../lib/checklist";
import { restoreFocusSoon } from "../lib/focus";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * The card's checklist (ADR 0062). Conversion to a subtask is the modal's: the section only
 * renders its Convert actions and its error / recovery strip.
 */
export type ChecklistConversion = {
  /** The lane is single-slot: while it is pending or holds a recovery, every Convert action is off. */
  busy: boolean;
  convert(item: ChecklistItem): void;
  error: string | null;
  recovery: { error: string } | null;
  pendingItemId: string | null;
  uncertain: boolean;
  retry(): void;
  discard(): void;
};

// A `div`, not a `section`: the e2e helpers locate board columns by
// `section`, and the modal must not add one.
export function CardChecklist({
  checklist,
  items,
  taskType,
  commands,
  conversion,
}: {
  checklist: Checklist;
  items: ChecklistItem[];
  taskType: Card["taskType"];
  commands: Pick<BoardCommands, "setChecklistDone" | "deleteChecklistItem">;
  conversion: ChecklistConversion;
}) {
  const checklistInputRef = useRef<HTMLInputElement | null>(null);
  const checklistAddButtonRef = useRef<HTMLButtonElement | null>(null);
  const doneCount = items.filter((item) => item.done).length;
  const checklistPercent = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;
  return (
    <div data-testid="card-checklist-section" data-empty={items.length === 0} className="card-checklist-section flex flex-col gap-1 py-4 first:pt-0 last:pb-0">
      <div className="card-checklist-heading">
      <h3 className="card-section-title text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <SquareCheck aria-hidden="true" className="card-section-icon" />Checklist{items.length > 0 && ` ${doneCount}/${items.length}`}
      </h3>
      {items.length === 0 && !checklist.adding && checklist.newItem === "" && (
        <Button
          ref={checklistAddButtonRef}
          type="button"
          variant="outline"
          size="sm"
          className="card-checklist-reveal"
          onClick={() => {
            checklist.revealAdd();
            requestAnimationFrame(() => checklistInputRef.current?.focus());
          }}
        >
          <Plus aria-hidden="true" className="size-4" />Add item
        </Button>
      )}
      </div>
      {items.length > 0 && (
        <div className="flex items-center gap-2 py-1">
          <span className="text-xs font-medium text-muted-foreground w-8 text-right">
            {checklistPercent}%
          </span>
          <div
            role="progressbar"
            aria-label="Checklist progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={checklistPercent}
            className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${checklistPercent}%` }}
            />
          </div>
        </div>
      )}
      <ul className="card-checklist-items flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id} className="group flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              aria-label={item.text}
              checked={item.done}
              disabled={checklist.editingId === item.id && checklist.edit.pending}
              onChange={() => commands.setChecklistDone(item.id, !item.done)}
              className="size-4 rounded border-input text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
            {checklist.editingId === item.id ? (
              <Input
                autoFocus
                // The modal's Escape listener sits on `window`; React dispatches
                // from the root container, so stopping propagation here keeps a
                // cancelled item edit from also closing the modal.
                data-checklist-edit
                aria-label="Edit checklist item text"
                readOnly={checklist.edit.pending}
                value={checklist.editText}
                onChange={(event) => {
                  checklist.setEditText(event.target.value);
                  checklist.clearError("edit");
                }}
                onBlur={() => { if (!checklist.edit.error) checklist.commitEdit(item); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    checklist.commitEdit(item);
                  }
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    checklist.cancelEdit();
                  }
                }}
                className="h-7 flex-1 bg-background px-2 py-0.5 text-base sm:text-sm"
              />
            ) : (
              <button
                type="button"
                data-checklist-item-edit={item.id}
                disabled={checklist.edit.pending || checklist.editingId !== null}
                aria-label={`Edit checklist item ${item.text}`}
                className={`flex-1 cursor-text break-words text-left ${
                  item.done ? "text-muted-foreground line-through" : "text-foreground"
                }`}
                onClick={() => checklist.startEdit(item)}
              >
                {item.text}
              </button>
            )}
            {taskType !== "subtask" && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Convert to card ${item.text}`}
                title="Convert to card"
                // The conversion lane is single-slot: while a conversion is pending
                // or a recovery is unresolved, its retry/discard pair is the only
                // conversion action any checklist item offers.
                disabled={conversion.busy || (checklist.editingId === item.id && checklist.edit.pending)}
                onClick={() => conversion.convert(item)}
                className="opacity-0 pointer-coarse:opacity-100 size-7 pointer-coarse:size-11 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-foreground"
              >
                <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete item ${item.text}`}
              disabled={checklist.editingId === item.id && checklist.edit.pending}
              onClick={() => commands.deleteChecklistItem(item.id)}
              className="opacity-0 pointer-coarse:opacity-100 size-7 pointer-coarse:size-11 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-destructive"
            >
              <X aria-hidden className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      {checklist.editedItemDeleted && <div className="flex flex-col gap-2">
        <p role="alert" className="text-xs text-destructive">This item was deleted. Your draft is preserved.</p>
        <Input aria-label="Preserved checklist edit" value={checklist.editText} readOnly={checklist.edit.pending} onChange={(event) => checklist.setEditText(event.target.value)} />
        <Button type="button" size="xs" disabled={checklist.edit.pending} onClick={checklist.saveEditAsNew}>Save as new item</Button>
        <Button type="button" size="xs" variant="ghost" disabled={checklist.edit.pending} onClick={checklist.discardEdit}>Discard checklist edit</Button>
      </div>}
      {checklist.edit.pending && <p role="status" className="text-xs text-muted-foreground">{checklist.edit.uncertain ? "Checking whether checklist edit completed…" : "Saving checklist edit…"}</p>}
      {checklist.editingId !== null && checklist.edit.error && <p role="alert" className="text-xs text-destructive">{checklist.edit.error}</p>}
      {(items.length > 0 || checklist.adding || checklist.newItem !== "") && <form className="card-checklist-add"
        onSubmit={(event) => {
          event.preventDefault();
          checklist.addItem();
        }}
      >
        <Input
          ref={checklistInputRef}
          value={checklist.newItem}
          readOnly={checklist.add.pending}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (items.length > 0 || checklist.newItem !== "") return;
            event.preventDefault();
            checklist.hideAdd();
            restoreFocusSoon(() => checklistAddButtonRef.current);
          }}
          onChange={(event) => {
            checklist.setNewItem(event.target.value);
            checklist.clearError("add");
          }}
          aria-label="Add checklist item"
          placeholder="Add an item…"
          className="h-8 bg-card text-base sm:text-sm"
        />
        <Button type="submit" size="sm" aria-label="Add checklist item" disabled={checklist.add.pending || checklist.newItem.trim() === ""}>
          <Plus aria-hidden="true" className="size-4" />Add item
        </Button>
      </form>}
      {checklist.add.pending && <p role="status" className="text-xs text-muted-foreground">{checklist.add.uncertain ? "Checking whether checklist item was added…" : "Adding checklist item…"}</p>}
      {checklist.add.error && <p role="alert" className="text-xs text-destructive">{checklist.add.error}</p>}
      {conversion.error !== null && conversion.recovery === null && (
        // The item is still here (the refused conversion never removed it), so
        // the error sits with the checklist it belongs to.
        <p role="alert" className="text-xs text-destructive">
          {conversion.error}
        </p>
      )}
      {conversion.recovery !== null && (
        <div
          role="alert"
          className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
        >
          <div className="flex items-center justify-between gap-2 font-medium">
            <span>{conversion.recovery.error}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={conversion.retry}
                disabled={conversion.pendingItemId !== null || conversion.uncertain}
                className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                {conversion.pendingItemId !== null ? "Retrying…" : "Retry conversion"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={conversion.pendingItemId !== null || conversion.uncertain}
                onClick={() => {
                  if (conversion.pendingItemId !== null || conversion.uncertain) return;
                  conversion.discard();
                }}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                Discard conversion attempt
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
