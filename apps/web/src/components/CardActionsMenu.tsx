import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "./ui/button";

export interface CardActionsMenuProps {
  onTransfer: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function CardActionsMenu({ onTransfer, triggerRef: externalTriggerRef }: CardActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        event.preventDefault();
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
      next = index === -1 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
    }
    items[next].focus();
  };

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Card actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-36 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-popover"
        >
          <Button
            type="button"
            role="menuitem"
            variant="ghost"
            size="sm"
            autoFocus
            onClick={() => {
              setOpen(false);
              onTransfer();
            }}
            className="h-8 w-full justify-start px-2 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
          >
            Transfer card
          </Button>
        </div>
      )}
    </div>
  );
}
