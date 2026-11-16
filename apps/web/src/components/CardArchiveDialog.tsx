import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { CARD_ARCHIVE_RETENTION_MS, type ArchivedCard, type Column } from "@foxban/shared";
import { byPosition } from "../lib/apply-mutation";
import { taskKey } from "../lib/task-key";
import { Button } from "./ui/button";
export interface CardArchiveDialogProps {
  archivedCards: ArchivedCard[];
  columns: Column[];
  boardKey?: string;
  onClose: () => void;
  onRestore: (cardId: string, columnId: string) => boolean;
  onPurge: (cardId: string) => boolean;
}

function getRetentionText(archivedAt: number): string {
  const days = Math.max(
    0,
    Math.ceil((archivedAt + CARD_ARCHIVE_RETENTION_MS - Date.now()) / 86_400_000),
  );
  if (days === 0) {
    return "Permanently deleting soon.";
  }
  return days === 1
    ? "Permanently deleted in 1 day."
    : `Permanently deleted in ${days} days.`;
}

export function CardArchiveDialog({
  archivedCards,
  columns,
  boardKey,
  onClose,
  onRestore,
  onPurge,
}: CardArchiveDialogProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const focusedCardIdRef = useRef<string | null>(null);
  const purgeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const isMountedRef = useRef(false);

  const [selectedColumns, setSelectedColumns] = useState<Record<string, string>>({});
  const [confirmingPurgeId, setConfirmingPurgeId] = useState<string | null>(null);

  const cancelPurge = useCallback((cardId: string) => {
    setConfirmingPurgeId(null);
    requestAnimationFrame(() => {
      purgeButtonRefs.current.get(cardId)?.focus();
    });
  }, []);

  const sortedCards = useMemo(() => {
    return [...archivedCards].sort((a, b) => {
      if (b.archivedAt !== a.archivedAt) {
        return b.archivedAt - a.archivedAt;
      }
      return a.title.localeCompare(b.title);
    });
  }, [archivedCards]);

  const sortedCols = useMemo(() => [...columns].sort(byPosition), [columns]);

  // Preserve valid destinations; if a peer deletes the chosen column, fall back to the first current column.
  useEffect(() => {
    if (sortedCols.length === 0) return;
    const validIds = new Set(sortedCols.map((col) => col.id));
    const firstId = sortedCols[0].id;
    setSelectedColumns((prev) => {
      let changed = false;
      const next: Record<string, string> = { ...prev };
      for (const [cardId, colId] of Object.entries(prev)) {
        if (!validIds.has(colId)) {
          next[cardId] = firstId;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sortedCols]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    isMountedRef.current = true;
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (confirmingPurgeId !== null) {
          cancelPurge(confirmingPurgeId);
          return;
        }
        onClose();
        return;
      }

      if (event.key === "Tab") {
        const dialogNode = dialogRef.current;
        if (!dialogNode) return;

        const focusableSelector =
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const focusableElements = Array.from(
          dialogNode.querySelectorAll<HTMLElement>(focusableSelector),
        ).filter(
          (element) =>
            !element.hasAttribute("disabled") &&
            element.getAttribute("aria-hidden") !== "true" &&
            element.offsetParent !== null,
        );

        if (focusableElements.length === 0) {
          event.preventDefault();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (event.shiftKey) {
          if (
            document.activeElement === firstElement ||
            !dialogNode.contains(document.activeElement)
          ) {
            event.preventDefault();
            lastElement.focus();
          }
        } else {
          if (
            document.activeElement === lastElement ||
            !dialogNode.contains(document.activeElement)
          ) {
            event.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancelPurge, confirmingPurgeId, onClose]);

  // If a peer restore or purge removes the currently focused row, move focus to Close so focus never falls behind.
  useEffect(() => {
    if (!isMountedRef.current) return;
    if (focusedCardIdRef.current !== null) {
      const cardStillExists = archivedCards.some((card) => card.id === focusedCardIdRef.current);
      if (!cardStillExists) {
        focusedCardIdRef.current = null;
        closeButtonRef.current?.focus();
        return;
      }
    }
    if (
      dialogRef.current &&
      (!document.activeElement || !dialogRef.current.contains(document.activeElement))
    ) {
      closeButtonRef.current?.focus();
    }
  }, [archivedCards]);

  const handleRestore = (cardId: string, columnId: string) => {
    const success = onRestore(cardId, columnId);
    if (success) {
      focusedCardIdRef.current = null;
      closeButtonRef.current?.focus();
    }
  };

  const handlePurge = (cardId: string) => {
    if (onPurge(cardId)) cancelPurge(cardId);
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col rounded-lg border border-border bg-card text-card-foreground shadow-dialog sm:max-h-[85vh]"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 id={titleId} className="text-base font-semibold">
            Archived cards
          </h2>
          <Button
            ref={closeButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close archived cards"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            <X aria-hidden className="size-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {archivedCards.length === 0 ? (
            <p className="text-sm text-muted-foreground">No archived cards.</p>
          ) : (
            <>
              {columns.length === 0 && (
                <p className="mb-4 text-sm text-muted-foreground">
                  A board owner or admin must add a column before archived cards can be restored.
                </p>
              )}
              <ul className="flex flex-col divide-y divide-border">
                {sortedCards.map((card) => {
                  const selectId = `restore-select-${card.id}`;
                  const effectiveColumnId =
                    selectedColumns[card.id] &&
                    sortedCols.some((col) => col.id === selectedColumns[card.id])
                      ? selectedColumns[card.id]
                      : (sortedCols[0]?.id ?? "");

                  return (
                    <li
                      key={card.id}
                      data-archived-card-id={card.id}
                      onFocusCapture={() => {
                        focusedCardIdRef.current = card.id;
                      }}
                      className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0"
                    >
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          {boardKey && card.taskNumber > 0 && (
                            <span className="shrink-0 font-mono text-xs text-muted-foreground select-none">
                              {taskKey(boardKey, card.taskNumber)}
                            </span>
                          )}
                          <h3 className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                            {card.title}
                          </h3>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>From {card.archivedColumnTitle}</span>
                          <span aria-hidden>·</span>
                          <span>{getRetentionText(card.archivedAt)}</span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                          <label
                            htmlFor={selectId}
                            className="text-xs font-medium text-muted-foreground"
                          >
                            Restore {card.title} to column
                          </label>
                          <select
                            id={selectId}
                            aria-label={`Restore ${card.title} to column`}
                            value={effectiveColumnId}
                            disabled={columns.length === 0}
                            onChange={(event) => {
                              setSelectedColumns((prev) => ({
                                ...prev,
                                [card.id]: event.target.value,
                              }));
                            }}
                            className="h-8 rounded-md border border-input bg-card px-2 py-1 text-sm text-card-foreground shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
                          >
                            {sortedCols.length === 0 ? (
                              <option value="" disabled>
                                No columns
                              </option>
                            ) : (
                              sortedCols.map((column) => (
                                <option key={column.id} value={column.id}>
                                  {column.title}
                                </option>
                              ))
                            )}
                          </select>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            aria-label={`Restore ${card.title}`}
                            disabled={columns.length === 0}
                            onClick={() =>
                              handleRestore(card.id, effectiveColumnId)
                            }
                            className="pointer-coarse:min-h-11 pointer-coarse:px-4"
                          >
                            Restore
                          </Button>
                          {confirmingPurgeId !== card.id && (
                            <Button
                              ref={(node) => {
                                if (node) purgeButtonRefs.current.set(card.id, node);
                                else purgeButtonRefs.current.delete(card.id);
                              }}
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={`Delete ${card.title} permanently`}
                              onClick={() => setConfirmingPurgeId(card.id)}
                              className="text-destructive hover:bg-destructive/10 hover:text-destructive pointer-coarse:min-h-11 pointer-coarse:px-4"
                            >
                              Delete permanently
                            </Button>
                          )}
                        </div>
                      </div>
                      {confirmingPurgeId === card.id && (
                        <div
                          role="group"
                          aria-label={`Confirm permanent deletion of ${card.title}`}
                          className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
                        >
                          <span className="text-destructive">
                            Permanently delete this card and everything on it? This cannot be
                            undone.
                          </span>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              onClick={() => handlePurge(card.id)}
                              className="pointer-coarse:min-h-11 pointer-coarse:px-4"
                            >
                              Delete permanently
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => cancelPurge(card.id)}
                              className="pointer-coarse:min-h-11 pointer-coarse:px-4"
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
