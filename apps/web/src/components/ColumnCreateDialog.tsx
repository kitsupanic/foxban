import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface ColumnCreateDialogProps {
  /**
   * True while a submitted creation is still awaiting settlement: the form is
   * locked, because the request is already on the wire.
   */
  isPending: boolean;
  error: string | null;
  connected: boolean;
  handshakeFailed: boolean;
  onRetryConnection: () => void;
  /** The capability can be lost while the dialog is open; submit explains it. */
  canManageColumns: boolean;
  onCancel: () => void;
  onCreate: (title: string) => void;
}

/**
 * The Add a column form. It creates nothing until submitted: the draft lives
 * here and is discarded by Cancel, X, backdrop or Escape.
 */
export function ColumnCreateDialog({
  isPending,
  error,
  connected,
  handshakeFailed,
  onRetryConnection,
  canManageColumns,
  onCancel,
  onCreate,
}: ColumnCreateDialogProps) {
  const titleId = useId();
  const nameId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const title = name.trim();

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Escape and Tab are the shell BoardCreateDialog uses: Escape closes only
  // while nothing has been sent, and the trap keeps focus inside the panel.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isPending) return;
        event.preventDefault();
        onCancel();
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
  }, [isPending, onCancel]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (isPending || !canManageColumns || title === "") return;
    onCreate(title);
  };

  return (
    <div
      className="boards-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isPending) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="boards-dialog-panel board-create-dialog"
      >
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close dialog" disabled={isPending} onClick={onCancel} className="boards-dialog-close"><X aria-hidden="true" /></Button>
        <h2 id={titleId}>Add a column</h2>
        <p>Give this stage of your workflow a name.</p>
        <form onSubmit={submit} className="boards-dialog-form">
          <fieldset className="board-create-fieldset" disabled={isPending}>
            <label htmlFor={nameId}>Column name</label>
            <Input
              ref={nameRef}
              id={nameId}
              required
              maxLength={200}
              disabled={isPending}
              value={name}
              placeholder="e.g. In review"
              onChange={(event) => setName(event.target.value)}
            />
          </fieldset>
          {!canManageColumns && (
            <p role="alert" className="boards-dialog-error">Only a board owner or an admin can add a column.</p>
          )}
          {!connected && (
            <div role="status" className="boards-dialog-connection">
              <span>{handshakeFailed ? "Could not connect." : "Reconnecting…"}</span>
              {handshakeFailed && (
                // Retry stays usable while a creation is pending: reconnecting and
                // re-reading the snapshot is exactly what settles an uncertain one.
                <Button type="button" variant="outline" size="xs" onClick={onRetryConnection}>Retry</Button>
              )}
            </div>
          )}
          {error && <p role="alert" className="boards-dialog-error">{error}</p>}
          <div className="boards-dialog-actions">
            <Button type="button" variant="outline" disabled={isPending} onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={isPending || !canManageColumns || title === ""}>Add column</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
