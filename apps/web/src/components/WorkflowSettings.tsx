import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ClientMessage } from "@foxban/shared";
import type { BoardState } from "../lib/apply-mutation";
import { Button } from "./ui/button";

/** Which column starts new subtasks and which means done. No column title is interpreted as workflow semantics. */
export function WorkflowSettings({ state, send, connected, onClose }: { state: BoardState; send: (message: ClientMessage) => void; connected: boolean; onClose: () => void }) {
  const titleId = useId();
  const startId = useId();
  const doneId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLSelectElement>(null);
  const currentStart = state.columns.find(c => c.starting)?.id ?? "";
  const currentDone = state.columns.find(c => c.completed)?.id ?? "";
  const [start, setStart] = useState(currentStart);
  const [done, setDone] = useState(currentDone);
  const same = start !== "" && start === done;
  const valid = start !== "" && done !== "" && !same;
  const toComplete = state.cards.filter(c => c.columnId === done && !c.subtaskDone).length;
  const toReopen = state.cards.filter(c => c.columnId !== done && c.subtaskDone).length;
  const options = state.columns.map(c => <option key={c.id} value={c.id}>{c.title}</option>);

  useEffect(() => { startRef.current?.focus(); }, []);

  // Same Escape + focus-trap shell as the other board dialogs.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled])")).filter(node => node.offsetParent !== null);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panelRef.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || !connected) return;
    send({ type: "workflow.configure", mutationId: crypto.randomUUID(), startingColumnId: start, completedColumnId: done, expectedStartingColumnId: currentStart || null, expectedCompletedColumnId: currentDone || null });
    onClose();
  };

  return (
    <div className="boards-dialog-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="boards-dialog-panel">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close dialog" onClick={onClose} className="boards-dialog-close"><X aria-hidden="true" /></Button>
        <h2 id={titleId}>Workflow settings</h2>
        <p>Each subtask keeps its own status. Pick where new subtasks start and which column means done.</p>
        <form onSubmit={save} className="boards-dialog-form">
          <label htmlFor={startId}>Starting status</label>
          <select ref={startRef} id={startId} value={start} onChange={e => setStart(e.target.value)}><option value="">Choose column</option>{options}</select>
          <span className="boards-dialog-hint">New subtasks land here.</span>
          <label htmlFor={doneId}>Completed status</label>
          <select id={doneId} value={done} onChange={e => setDone(e.target.value)}><option value="">Choose column</option>{options}</select>
          <span className="boards-dialog-hint">Subtasks in this column count as done.</span>
          {same && <p role="alert" className="boards-dialog-error">Pick two different columns.</p>}
          {valid && done !== currentDone && (
            <p role="status" className="boards-dialog-hint">
              {toComplete + toReopen === 0 ? "No subtask changes status." : `${toComplete} subtask${toComplete === 1 ? "" : "s"} will be marked done and ${toReopen} reopened.`} No cards move.
            </p>
          )}
          {!connected && <p role="status" className="boards-dialog-hint">Reconnecting… you can save once the board is live.</p>}
          <div className="boards-dialog-actions">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!valid || !connected}>Save workflow columns</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
