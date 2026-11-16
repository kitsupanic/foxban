import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TRANSFER_TERMINAL_CODE } from "@foxban/shared";
import { api } from "../lib/api";
import { Button } from "./ui/button";

/**
 * A terminal transfer conflict means the supplied operation id can never
 * commit, so the dialog must rotate to a fresh id instead of retrying.
 * Only explicit machine-readable signals qualify: the `transfer_terminal`
 * code, HTTP 410, or an explicit `aborted` flag.
 */
export function isTerminalTransferConflict(
  status: number,
  data?: { code?: string; aborted?: boolean } | null,
): boolean {
  if (data?.code === TRANSFER_TERMINAL_CODE) return true;
  return status === 410 || data?.aborted === true;
}

export interface TransferCardDialogProps {
  boardId: string;
  cardId: string;
  hasLinksOrSubtasks: boolean;
  isDirty: boolean;
  isAttachmentPending: boolean;
  onCancel: () => void;
  onSuccess: (destinationBoardId: string, destinationBoardKey: string, cardId: string, taskNumber: number) => void;
}

export function TransferCardDialog({
  boardId,
  cardId,
  hasLinksOrSubtasks,
  isDirty,
  isAttachmentPending,
  onCancel,
  onSuccess,
}: TransferCardDialogProps) {
  const titleId = useId();
  const boardSelectId = useId();
  const statusSelectId = useId();

  const [selectedBoardId, setSelectedBoardId] = useState("");
  const [selectedColumnId, setSelectedColumnId] = useState("");
  const [transferId, setTransferId] = useState(() => crypto.randomUUID());
  const transferIdRef = useRef(transferId);
  transferIdRef.current = transferId;
  const boundDestinationRef = useRef<{ boardId: string; columnId: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  const optionsQuery = useQuery({
    queryKey: ["board-transfer-options", boardId],
    queryFn: async () => {
      const res = await api.boards[":id"]["transfer-options"].$get({
        param: { id: boardId },
      });
      if (!res.ok) {
        throw new Error("could not load transfer options");
      }
      return await res.json();
    },
    retry: false,
  });

  const boards = optionsQuery.data?.boards ?? [];
  const selectedBoard = boards.find((b) => b.id === selectedBoardId);
  const columns = selectedBoard?.columns ?? [];

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isSubmitting) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
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
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, onCancel]);

  const handleBoardChange = (newBoardId: string) => {
    setSelectedBoardId(newBoardId);
    setSelectedColumnId("");
    setSubmitError(null);
    if (boundDestinationRef.current !== null && boundDestinationRef.current.boardId !== newBoardId) {
      const nextId = crypto.randomUUID();
      transferIdRef.current = nextId;
      setTransferId(nextId);
      boundDestinationRef.current = null;
    }
  };

  const handleColumnChange = (newColumnId: string) => {
    setSelectedColumnId(newColumnId);
    setSubmitError(null);
    if (boundDestinationRef.current !== null && boundDestinationRef.current.columnId !== newColumnId) {
      const nextId = crypto.randomUUID();
      transferIdRef.current = nextId;
      setTransferId(nextId);
      boundDestinationRef.current = null;
    }
  };

  const hasNoColumns = selectedBoard !== undefined && columns.length === 0;
  const isFormValid = selectedBoardId !== "" && selectedColumnId !== "";
  const isTransferBlocked =
    hasLinksOrSubtasks ||
    isDirty ||
    isAttachmentPending ||
    !isFormValid ||
    isSubmitting;

  const handleSubmit = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (isTransferBlocked) return;

    setIsSubmitting(true);
    setSubmitError(null);

    let activeTransferId = transferIdRef.current;
    if (
      boundDestinationRef.current !== null &&
      (boundDestinationRef.current.boardId !== selectedBoardId ||
        boundDestinationRef.current.columnId !== selectedColumnId)
    ) {
      activeTransferId = crypto.randomUUID();
      transferIdRef.current = activeTransferId;
      setTransferId(activeTransferId);
    }
    boundDestinationRef.current = {
      boardId: selectedBoardId,
      columnId: selectedColumnId,
    };

    try {
      const res = await api.boards[":id"].cards[":cardId"].transfer.$post({
        param: { id: boardId, cardId },
        json: {
          transferId: activeTransferId,
          destinationBoardId: selectedBoardId,
          destinationColumnId: selectedColumnId,
        },
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          code?: string;
          aborted?: boolean;
        } | null;

        if (isTerminalTransferConflict(res.status, data)) {
          const freshId = crypto.randomUUID();
          transferIdRef.current = freshId;
          setTransferId(freshId);
          boundDestinationRef.current = null;

          const baseMessage = data?.error ?? "Transfer operation was aborted or conflicted.";
          setSubmitError(
            `${baseMessage} A new transfer operation has been prepared. Please retry.`,
          );
        } else {
          setSubmitError(data?.error ?? "Transfer failed. Please retry.");
        }
        setIsSubmitting(false);
        return;
      }

      const result = (await res.json()) as {
        boardId: string;
        boardKey: string;
        cardId: string;
        taskNumber: number;
      };

      onSuccess(
        result.boardId,
        result.boardKey,
        result.cardId,
        result.taskNumber,
      );
    } catch {
      setSubmitError("Transfer failed. Please retry.");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-dialog"
      >
        <h2 id={titleId} className="text-base font-semibold [overflow-wrap:anywhere]">
          Transfer card
        </h2>

        {hasLinksOrSubtasks && (
          <div className="mt-3 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
            Remove this card’s links and subtasks before transferring.
          </div>
        )}

        {isDirty && !hasLinksOrSubtasks && (
          <div className="mt-3 rounded-md bg-warning/10 p-2.5 text-xs text-warning">
            Save or discard title and description changes before transferring.
          </div>
        )}

        {isAttachmentPending && !hasLinksOrSubtasks && !isDirty && (
          <div className="mt-3 rounded-md bg-warning/10 p-2.5 text-xs text-warning">
            Attachment deletion in progress. Please wait before transferring.
          </div>
        )}

        {submitError && (
          <div role="alert" className="mt-3 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
            {submitError}
          </div>
        )}

        {optionsQuery.isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Loading transfer options…
          </div>
        ) : optionsQuery.isError ? (
          <div className="space-y-3 py-4 text-center">
            <div role="alert" className="text-sm text-destructive">
              Could not load transfer options.
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void optionsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : boards.length === 0 ? (
          <div className="py-4 text-sm text-muted-foreground">
            No other boards available for transfer.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div>
              <label htmlFor={boardSelectId} className="block text-sm font-medium text-foreground">
                Board
              </label>
              <select
                id={boardSelectId}
                value={selectedBoardId}
                onChange={(e) => handleBoardChange(e.target.value)}
                disabled={isSubmitting}
                className="mt-1 block h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base sm:text-sm text-foreground shadow-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              >
                <option value="">Select destination board</option>
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.key})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor={statusSelectId} className="block text-sm font-medium text-foreground">
                Status
              </label>
              {hasNoColumns ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  This board has no statuses.
                </div>
              ) : (
                <select
                  id={statusSelectId}
                  value={selectedColumnId}
                  onChange={(e) => handleColumnChange(e.target.value)}
                  disabled={isSubmitting || selectedBoardId === "" || columns.length === 0}
                  className="mt-1 block h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base sm:text-sm text-foreground shadow-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                >
                  <option value="">Select status</option>
                  {columns.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.title}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button
                ref={cancelBtnRef}
                type="button"
                variant="outline"
                size="sm"
                autoFocus
                disabled={isSubmitting}
                onClick={onCancel}
                className="pointer-coarse:min-h-11 pointer-coarse:px-4"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="default"
                size="sm"
                disabled={isTransferBlocked}
                className="pointer-coarse:min-h-11 pointer-coarse:px-4"
              >
                {isSubmitting ? "Transferring…" : "Transfer"}
              </Button>
            </div>
          </form>
        )}

        {(optionsQuery.isLoading || optionsQuery.isError || boards.length === 0) && (
          <div className="mt-6 flex justify-end">
            <Button
              ref={cancelBtnRef}
              type="button"
              variant="outline"
              size="sm"
              autoFocus
              onClick={onCancel}
              className="pointer-coarse:min-h-11 pointer-coarse:px-4"
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
