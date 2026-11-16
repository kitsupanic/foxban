import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { APP_UPDATE_PROMPT_ACTIVE_ATTR } from "../lib/app-update";
import { inertElements } from "../lib/inert";
import { Button } from "./ui/button";

export function FamilyCompletionDialog({ title, count, pending, error, disabled, onChoose, onCancel, onRetry }: {
  title: string; count: number; pending: boolean; error: string | null; disabled: boolean;
  onChoose: (scope: "family" | "parent") => void; onCancel: () => void; onRetry?: () => void;
}) {
  const headingId = useId(), descriptionId = useId();
  const layerRef = useRef<HTMLDivElement>(null), panelRef = useRef<HTMLDivElement>(null), cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const layer = layerRef.current!;
    const siblings = Array.from(document.body.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== layer && !node.hasAttribute("data-foxban-update-portal-host"));
    const restore = inertElements(siblings);
    cancelRef.current?.focus();
    return restore;
  }, []);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (document.documentElement.hasAttribute(APP_UPDATE_PROMPT_ACTIVE_ATTR)) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!pending) onCancel();
      } else if (event.key === "Tab") {
        const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
        const first = nodes[0], last = nodes.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        event.stopImmediatePropagation();
      } else event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [onCancel, pending]);
  return createPortal(<div ref={layerRef} className="fixed inset-0 z-[90] flex items-center justify-center bg-overlay p-4">
    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={descriptionId} className="max-h-[calc(100dvh-2rem)] overflow-y-auto w-full max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground shadow-dialog">
      <h2 id={headingId} className="text-lg font-semibold">Finish “{title}”?</h2>
      <p id={descriptionId} aria-live="polite" className="mt-3 text-sm text-muted-foreground">{pending ? `Checking completion of ${count} unfinished subtasks…` : `${count} unfinished ${count === 1 ? "subtask remains" : "subtasks remain"} in this family, across all columns.`} Finish all moves this parent and every unfinished subtask to the completed column. Finish only parent keeps their current statuses.</p>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button disabled={pending || disabled} onClick={() => onChoose("family")}>Finish all</Button>
        <Button variant="outline" disabled={pending || disabled} onClick={() => onChoose("parent")}>Finish only parent</Button>
        <Button ref={cancelRef} variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
        {onRetry && <Button variant="outline" onClick={onRetry}>Retry connection</Button>}
      </div>
    </div>
  </div>, document.body);
}
