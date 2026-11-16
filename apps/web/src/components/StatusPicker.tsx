import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Column } from "@foxban/shared";
import { usePickerMenuStyle } from "../lib/picker-menu";
import { Button } from "./ui/button";

/**
 * Jira-style status listbox: a bordered trigger showing the card's current
 * column title, opening a panel of the board's columns with a check on the current one.
 *
 * The value renders straight off the prop (or current column) — no local mirror —
 * so a broadcast from another client moves the trigger while the panel is open.
 *
 * The open/close shell (outside pointerdown, Escape rung, roving arrows)
 * matches PriorityPicker directly.
 */
export function StatusPicker({
  columnId,
  columns,
  onChange,
}: {
  columnId: string;
  columns: Column[];
  onChange: (columnId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuStyle = usePickerMenuStyle(open, triggerRef);

  // Pointer, not blur: Safari buttons take no focus, so a blur-based close
  // would drop the very click that picked an option.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
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
      // The modal's Escape listener sits on `window`: one rung of the ladder,
      // the panel, must swallow the key before the modal sees it.
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!open) {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      setOpen(true);
      return;
    }
    // Roving focus in DOM order, clamped at both ends rather than wrapping.
    event.preventDefault();
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('input, [role="option"]') ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = index === -1 ? 0 : Math.min(Math.max(index + step, 0), items.length - 1);
    items[next].focus();
  };

  const currentColumn = columns.find((c) => c.id === columnId);
  const label = currentColumn?.title ?? "Unknown";

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-label="Status"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-8 w-full min-w-0 justify-start px-2 font-normal text-foreground"
      >
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden className="ml-auto size-4 shrink-0 text-muted-foreground" />
      </Button>
      {open && (
        <ul
          style={menuStyle}
          role="listbox"
          className="max-h-60 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-popover"
        >
          {columns.map((col) => {
            const selected = col.id === columnId;
            return (
              <li key={col.id}>
                {/* Check is aria-hidden so an option's accessible name
                    is exactly the column title. */}
                <Button
                  type="button"
                  role="option"
                  variant="ghost"
                  size="sm"
                  aria-selected={selected}
                  autoFocus={selected}
                  onClick={() => {
                    onChange(col.id);
                    close();
                  }}
          className="h-8 pointer-coarse:h-11 w-full justify-start px-2 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
        >
                  <span className="truncate">{col.title}</span>
                  {selected && (
                    <Check aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      )}
              </Button>
            </li>
          );
        })}
        </ul>
      )}
    </div>
  );
}
