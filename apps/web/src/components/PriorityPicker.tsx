import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Priority } from "@foxban/shared";
import { PRIORITIES, PRIORITY_META } from "../lib/priority";
import { usePickerMenuStyle } from "../lib/picker-menu";
import { Button } from "./ui/button";
/**
 * Jira-style priority listbox: a bordered trigger showing the level's coloured
 * icon, opening a panel of the five levels with a check on the current one.
 *
 * A native `<select>` cannot colour its options, which is the whole point of
 * the icon. The value renders straight off the prop — no local mirror — so a
 * broadcast from another client moves the trigger while the panel is open.
 *
 * The ~15-line open/close shell below is duplicated in AssigneePicker rather
 * than abstracted: the two panels differ (search input vs plain list) and a
 * shared primitive would be all props and no behaviour.
 */
export function PriorityPicker({
  value,
  onChange,
}: {
  value: Priority;
  onChange: (p: Priority) => void;
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

  const meta = PRIORITY_META[value];
  const SelectedIcon = meta.icon;
  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-label="Priority"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-8 w-full min-w-0 justify-start px-2 font-normal text-foreground"
      >
        <SelectedIcon aria-hidden="true" className={`size-3.5 shrink-0 ${meta.className}`} />
        {meta.label}
        <ChevronDown aria-hidden className="ml-auto size-4 text-muted-foreground" />
      </Button>
      {open && (
        <ul
          style={menuStyle}
          role="listbox"
          className="rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-popover"
        >
          {PRIORITIES.map((p) => {
            const selected = p === value;
            return (
              <li key={p}>
                {/* Icon and check are aria-hidden so an option's accessible name
                    is exactly the level label: "High" must not read as
                    "High check" or collide with "Highest". */}
                <Button
                  type="button"
                  role="option"
                  variant="ghost"
                  size="sm"
                  aria-selected={selected}
                  autoFocus={selected}
                  onClick={() => {
                    onChange(p);
                    close();
                  }}
          className="h-8 pointer-coarse:h-11 w-full justify-start px-2 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
        >
                  {(() => {
                    const OptionIcon = PRIORITY_META[p].icon;
                    return (
                      <OptionIcon
                        aria-hidden="true"
          className={`size-3.5 shrink-0 ${PRIORITY_META[p].className}`}
                      />
                    );
                  })()}
                  {PRIORITY_META[p].label}
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
