import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button";

export interface KeyboardShortcutsDialogProps {
  /** The Add column row exists only for a reader who can create one. */
  canManageColumns: boolean;
  onClose: () => void;
}

/**
 * The Keyboard shortcuts reference. It is a plain dialog rather than a popover:
 * help is reachable on every width, and every row is a real control-free line of
 * text so a screen reader reads the shortcut and its meaning together.
 */
export function KeyboardShortcutsDialog({ canManageColumns, onClose }: KeyboardShortcutsDialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const nodes = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.offsetParent !== null);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panelRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="boards-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="boards-dialog-panel board-create-dialog board-shortcuts-dialog"
      >
        <Button ref={closeRef} type="button" variant="ghost" size="icon-sm" aria-label="Close dialog" onClick={onClose} className="boards-dialog-close"><X aria-hidden="true" /></Button>
        <h2 id={titleId}>Keyboard shortcuts</h2>
        <p>Move around the board without leaving your keyboard.</p>
        <dl className="board-shortcut-rows">
          <div className="board-shortcut-row"><dt>Search cards</dt><dd><kbd>/</kbd></dd></div>
          <div className="board-shortcut-row"><dt>Add card to first column</dt><dd><kbd>N</kbd></dd></div>
          {canManageColumns && (
            <div className="board-shortcut-row"><dt>Add column</dt><dd><kbd>C</kbd></dd></div>
          )}
          <div className="board-shortcut-row"><dt>Assigned to me</dt><dd><kbd>M</kbd></dd></div>
          <div className="board-shortcut-row"><dt>Pick up focused card</dt><dd><kbd>Space</kbd></dd></div>
          <div className="board-shortcut-row"><dt>Move picked-up card</dt><dd><kbd>← → ↑ ↓</kbd></dd></div>
          <div className="board-shortcut-row"><dt>Close or cancel</dt><dd><kbd>Esc</kbd></dd></div>
        </dl>
      </div>
    </div>
  );
}
