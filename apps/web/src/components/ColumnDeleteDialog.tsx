import { useEffect, useId, useRef } from "react";
import { Button } from "./ui/button";

export interface ColumnDeleteDialogProps {
  columnTitle: string;
  cardCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ColumnDeleteDialog({
  columnTitle,
  cardCount,
  onCancel,
  onConfirm,
}: ColumnDeleteDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel]);

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
          {`Delete “${columnTitle}”?`}
        </h2>
        <p id={descriptionId} className="mt-2 text-sm text-muted-foreground">
          {cardCount === 0
            ? "This empty column will be permanently deleted."
            : cardCount === 1
              ? "The column will be deleted. Its card will be kept in Archived cards for 90 days."
              : `The column will be deleted. Its ${cardCount} cards will be kept in Archived cards for 90 days.`}
        </p>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            ref={cancelButtonRef}
            type="button"
            variant="outline"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
          >
            Delete column
          </Button>
        </div>
      </div>
    </div>
  );
}
