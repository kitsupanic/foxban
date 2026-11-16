import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface BoardDeleteDialogProps {
  boardName: string;
  /** A delete request is in flight, so the controls are disabled. */
  isPending: boolean;
  /** The server has not confirmed the outcome yet; retrying replays the same attempt. */
  retainedPending?: boolean;
  /** True when the last status check failed, so the outcome is still unknown. */
  statusUnknown?: boolean;
  /** Re-checks the retained deletion instead of starting a new one. */
  onCheckStatus?: () => void;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function BoardDeleteDialog({
  boardName,
  isPending,
  retainedPending,
  statusUnknown,
  onCheckStatus,
  error,
  onCancel,
  onConfirm,
}: BoardDeleteDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const confirmationId = useId();
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    setConfirmation("");
  }, [boardName]);

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isPending) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isPending, onCancel]);

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-dialog"
      >
        <h2 id={titleId} className="text-base font-semibold [overflow-wrap:anywhere]">
          {`Delete “${boardName}”?`}
        </h2>
        <p id={descriptionId} className="mt-2 text-sm text-muted-foreground">
          This permanently deletes every column, card, comment, attachment, and member connection on this board. This cannot be undone.
        </p>
        <label htmlFor={confirmationId} className="mt-4 block text-sm font-medium">
          Type <span className="font-semibold">{boardName}</span> to confirm
        </label>
        <Input
          id={confirmationId}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          disabled={isPending}
          autoComplete="off"
          className="mt-2"
        />
        {retainedPending && !isPending && (
          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span role="status">
              {statusUnknown
                ? "The deletion is still being applied and its status could not be checked."
                : "The server has not confirmed the deletion yet."}
            </span>
            {onCheckStatus && <Button type="button" variant="outline" size="xs" onClick={onCheckStatus}>Check status</Button>}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            ref={cancelButtonRef}
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isPending || confirmation !== boardName}
            onClick={onConfirm}
          >
            {isPending ? "Deleting…" : "Delete board"}
          </Button>
        </div>
      </div>
    </div>
  );
}
