import { useEffect, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";
import { Button } from "./ui/button";

export interface BoardActionsMenuProps {
  board: {
    id: string;
    name: string;
  };
  canEdit: boolean;
  canDelete: boolean;
  canMove?: boolean;
  onAddMember: (trigger: HTMLButtonElement) => void;
  onEdit: (trigger: HTMLButtonElement) => void;
  onDelete: (trigger: HTMLButtonElement) => void;
  onMove?: (trigger: HTMLButtonElement) => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function BoardActionsMenu({
  board,
  canEdit,
  canDelete,
  canMove = false,
  onAddMember,
  onEdit,
  onDelete,
  onMove,
  triggerRef: externalTriggerRef,
}: BoardActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;

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
  }, [open, triggerRef]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: {
    key: string;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (event.key === "Escape") {
      if (!open) return;
      event.stopPropagation();
      close();
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
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
    let next = 0;
    if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    } else {
      const step = event.key === "ArrowDown" ? 1 : -1;
      next =
        index === -1
          ? step === 1
            ? 0
            : items.length - 1
          : (index + step + items.length) % items.length;
    }
    items[next].focus();
  };

  const handleAction = (callback: (trigger: HTMLButtonElement) => void) => {
    const trigger = triggerRef.current;
    setOpen(false);
    if (trigger) {
      callback(trigger);
    }
  };

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        data-board-actions-id={board.id}
        aria-label={`Board settings for ${board.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="boards-row-menu-trigger text-muted-foreground hover:text-foreground"
      >
        <Ellipsis aria-hidden="true" className="size-4" />
      </Button>
      {open && (
        <div
          role="menu"
          className="boards-row-menu absolute right-0 top-full z-20 mt-1 min-w-36 overflow-hidden rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-popover"
        >
          <Button
            type="button"
            role="menuitem"
            variant="ghost"
            size="sm"
            autoFocus
            onClick={() => handleAction(onAddMember)}
            className="h-8 w-full justify-start px-2 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
          >
            Add member
          </Button>
          {canEdit && (
            <Button
              type="button"
              role="menuitem"
              variant="ghost"
              size="sm"
              onClick={() => handleAction(onEdit)}
              className="h-8 w-full justify-start px-2 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
            >
              Edit
            </Button>
          )}
          {canMove && onMove && (
            <Button type="button" role="menuitem" variant="ghost" size="sm" onClick={() => handleAction(onMove)} className="h-8 w-full justify-start px-2 font-normal text-popover-foreground hover:bg-accent">
              Move workspace
            </Button>
          )}
          {canDelete && (
            <Button
              type="button"
              role="menuitem"
              variant="ghost"
              size="sm"
              onClick={() => handleAction(onDelete)}
              className="h-8 w-full justify-start px-2 font-normal text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive focus:outline-none"
            >
              Delete
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
