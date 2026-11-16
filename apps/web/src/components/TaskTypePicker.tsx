import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { EditableTaskType } from "../lib/task-type";
import { TASK_TYPES, TASK_TYPE_META } from "../lib/task-type";
import { usePickerMenuStyle } from "../lib/picker-menu";
import { Button } from "./ui/button";

export function TaskTypePicker({
  value,
  onChange,
}: {
  value: EditableTaskType;
  onChange: (t: EditableTaskType) => void;
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

  const meta = TASK_TYPE_META[value];
  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-label="Type"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-8 w-full min-w-0 justify-start px-2 font-normal text-foreground"
      >
        <span aria-hidden="true" className={`size-3 rounded-full shrink-0 ${meta.swatch}`} />
        {meta.label}
        <ChevronDown aria-hidden className="ml-auto size-4 text-muted-foreground" />
      </Button>
      {open && (
        <ul
          style={menuStyle}
          role="listbox"
          className="rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-popover"
        >
          {TASK_TYPES.map((t) => {
            const selected = t === value;
            const itemMeta = TASK_TYPE_META[t];
            return (
              <li key={t}>
                <Button
                  type="button"
                  role="option"
                  variant="ghost"
                  size="sm"
                  aria-selected={selected}
                  autoFocus={selected}
                  onClick={() => {
                    onChange(t);
                    close();
                  }}
          className="h-8 pointer-coarse:h-11 w-full justify-start px-2 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
        >
                  <span
                    aria-hidden="true"
          className={`size-3 rounded-full shrink-0 ${itemMeta.swatch}`}
                  />
                  {itemMeta.label}
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
