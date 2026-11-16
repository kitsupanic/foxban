import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Member } from "../lib/api";
import { usePickerMenuStyle } from "../lib/picker-menu";
import { Avatar, AVATAR_CLASS } from "./Avatar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const ROW_CLASS =
  "h-8 pointer-coarse:h-11 w-full justify-start px-2 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none";

/**
 * Jira-style assignee combobox: a bordered trigger showing the member's
 * initials circle and name, opening a panel with a type-to-search filter over
 * name and email, an always-pinned Unassigned row, and a check on the current
 * choice.
 *
 * `onChange` takes a member id or `""` for unassign — CardModal's `assign`
 * contract, since `null` is a value a partial update could not express.
 *
 * The open/close shell (outside pointerdown, the Escape rung, roving arrows)
 * is deliberately duplicated from PriorityPicker: see the note there.
 */
export function AssigneePicker({
  assigneeId,
  members,
  onChange,
}: {
  assigneeId: string | null;
  members: Member[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuStyle = usePickerMenuStyle(open, triggerRef);

  // Pointer, not blur: Safari buttons take no focus, so a blur-based close
  // would drop the very click that picked a member.
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
    setQuery("");
    triggerRef.current?.focus();
  };

  const pick = (value: string) => {
    onChange(value);
    close();
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
    // Roving focus over the search box and the rows in DOM order, clamped at
    // both ends rather than wrapping.
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

  // Members arrive name-sorted from the api; the filter keeps that order and
  // caps nothing — a board's membership is small.
  const needle = query.trim().toLowerCase();
  const matches = members.filter(
    (member) =>
      member.name.toLowerCase().includes(needle) || member.email.toLowerCase().includes(needle),
  );

  // An id with no row means the members query is in flight or failed, the same
  // degradation the card front shows.
  const assignee = assigneeId === null ? null : (members.find((m) => m.id === assigneeId) ?? null);
  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-label="Assignee"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-8 w-full min-w-0 justify-start px-2 font-normal text-foreground"
      >
        {assigneeId === null ? (
          <>
            <span
              aria-hidden
              className="size-5 shrink-0 rounded-full border border-dashed border-muted-foreground"
            />
            <span className="min-w-0 truncate text-muted-foreground">Unassigned</span>
          </>
        ) : (
          <>
            {assignee ? (
              <Avatar
                name={assignee.name}
                githubLogin={assignee.githubLogin}
                avatarVersion={assignee.avatarVersion}
                userId={assignee.id}
              />
            ) : (
              <span aria-hidden className={AVATAR_CLASS}>
                ?
              </span>
            )}
            {assignee && <span className="min-w-0 truncate">{assignee.name}</span>}
          </>
        )}
        <ChevronDown aria-hidden className="ml-auto size-4 text-muted-foreground" />
      </Button>
      {open && (
        <div
          style={menuStyle}
          className="flex flex-col gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-popover"
        >
          <Input
            autoFocus
            aria-label="Search members"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            // Runs before the root handler, so the two-stage Escape lives here:
            // clear the query first, close only once it is empty.
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches.length > 0) pick(matches[0].id);
              if (event.key === "Escape") {
                event.stopPropagation();
                if (query !== "") setQuery("");
                else close();
              }
            }}
            placeholder="Search members…"
          className="h-8 px-2 py-1 text-base sm:text-sm"
          />
          <ul role="listbox">
            {/* Pinned above the matches regardless of the query: unassigning
                stays a predictable escape hatch. */}
            <li>
              <Button
                type="button"
                role="option"
                variant="ghost"
                size="sm"
                aria-selected={assigneeId === null}
                onClick={() => pick("")}
          className={ROW_CLASS}
        >
                <span
                  aria-hidden
          className="size-5 shrink-0 rounded-full border border-dashed border-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">Unassigned</span>
                {assigneeId === null && (
                  <Check aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                )}
              </Button>
            </li>
            {matches.map((member) => (
              <li key={member.id}>
                {/* Avatar and check are aria-hidden so a row's accessible name is
                    exactly the member's name. */}
                <Button
                  type="button"
                  role="option"
                  variant="ghost"
                  size="sm"
                  aria-selected={member.id === assigneeId}
                  title={member.email}
                  onClick={() => pick(member.id)}
          className={ROW_CLASS}
        >
                  <Avatar
                    name={member.name}
                    githubLogin={member.githubLogin}
                    avatarVersion={member.avatarVersion}
                    userId={member.id}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{member.name}</span>
                  {member.id === assigneeId && (
                    <Check aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
          {matches.length === 0 && (
            <div className="px-2 py-1 text-sm text-muted-foreground">No matching members</div>
          )}
        </div>
      )}
    </div>
  );
}
