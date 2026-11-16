import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Pencil } from "lucide-react";
import { DESCRIPTION_MAX_BYTES, descriptionByteLength } from "@foxban/shared";
import { MarkdownContent, MarkdownEditor, ToolbarButton } from "./MarkdownEditor";
import { Button } from "./ui/button";
import { APP_UPDATE_PROMPT_ACTIVE_ATTR } from "../lib/app-update";
const numberFormat = new Intl.NumberFormat("en-US");
export const SKIP_DESCRIPTION_EDIT_CONFIRMATION_KEY =
  "foxban-skip-description-edit-confirmation";

/**
 * The card description: a Markdown string (ADR 0013) shown rendered, Trello
 * style, and swapped for the shared MarkdownEditor on explicit Edit button,
 * or triple-clicking non-interactive rendered text with confirmation.
 *
 * The draft itself stays in CardModal — this component only owns the view/edit
 * split, so leaving edit mode ("Preview", or Escape) previews the *draft*;
 * committing it is still the modal's Save.
 */
export function DescriptionEditor({
  value,
  onChange,
  onSave,
  onUploadImage,
  previewImages,
  onOpenImage,
  readOnly,
  onPendingClose,
  heading,
  notice,
}: {
  heading?: ReactNode;
  notice?: ReactNode;
  /** The modal's draft. */
  value: string;
  readOnly?: boolean;
  onChange: (next: string) => void;
  /** The modal's save(): commits the draft AND closes the modal. */
  onSave: () => void;
  /**
   * Uploads one image and resolves with what to embed. The editor stays
   * board-agnostic: the modal owns the request and the attachment metadata.
   */
  onUploadImage: (file: File) => Promise<{ url: string; alt: string }>;
  /**
   * Previewable images currently attached to the card, keyed by canonical URL.
   */
  previewImages?: ReadonlyMap<string, { id: string; fileName: string }>;
  onOpenImage?: (attachmentId: string, trigger?: HTMLElement | null) => void;
  /** When CardModal has an active pendingClose, Escape should execute it. */
  onPendingClose?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [hasEverEdited, setHasEverEdited] = useState(() => value.trim() !== "");
  const [confirmingEdit, setConfirmingEdit] = useState(false);
  const [skipFutureConfirmation, setSkipFutureConfirmation] = useState(false);

  const prevEditingRef = useRef(editing);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const editButtonTriggerRef = useRef<HTMLButtonElement | null>(null);
  const parentCardDialogRef = useRef<HTMLElement | null>(null);
  const priorInertRef = useRef(false);
  const pressedBackdropRef = useRef(false);

  const restoreParentInertAndFocus = () => {
    if (parentCardDialogRef.current) {
      if (priorInertRef.current) {
        parentCardDialogRef.current.setAttribute("inert", "");
      } else {
        parentCardDialogRef.current.removeAttribute("inert");
      }
      parentCardDialogRef.current = null;
    }
    editButtonTriggerRef.current?.focus();
  };

  const closeConfirmation = () => {
    setConfirmingEdit(false);
    setSkipFutureConfirmation(false);
    restoreParentInertAndFocus();
  };

  const handleConfirmEdit = () => {
    if (skipFutureConfirmation) {
      try {
        localStorage.setItem(SKIP_DESCRIPTION_EDIT_CONFIRMATION_KEY, "true");
      } catch {
        // Ignore localStorage write failures.
      }
    }
    setSkipFutureConfirmation(false);
    setConfirmingEdit(false);
    if (parentCardDialogRef.current) {
      if (priorInertRef.current) {
        parentCardDialogRef.current.setAttribute("inert", "");
      } else {
        parentCardDialogRef.current.removeAttribute("inert");
      }
      parentCardDialogRef.current = null;
    }
    setHasEverEdited(true);
    setEditing(true);
  };

  useEffect(() => {
    if (!confirmingEdit) return;

    const trigger = editButtonTriggerRef.current;
    const parentDialog = trigger?.closest<HTMLElement>('[role="dialog"]');
    if (parentDialog) {
      parentCardDialogRef.current = parentDialog;
      priorInertRef.current = parentDialog.hasAttribute("inert");
      parentDialog.setAttribute("inert", "");
    }

    cancelButtonRef.current?.focus();

    return () => {
      if (parentCardDialogRef.current) {
        if (priorInertRef.current) {
          parentCardDialogRef.current.setAttribute("inert", "");
        } else {
          parentCardDialogRef.current.removeAttribute("inert");
        }
        parentCardDialogRef.current = null;
      }
    };
  }, [confirmingEdit]);

  useEffect(() => {
    if (!confirmingEdit) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (document.documentElement.hasAttribute(APP_UPDATE_PROMPT_ACTIVE_ATTR)) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeConfirmation();
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

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [confirmingEdit]);

  const handleRenderedClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.detail !== 3) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest("a, button")) {
      return;
    }

    let shouldSkip = false;
    try {
      shouldSkip =
        localStorage.getItem(SKIP_DESCRIPTION_EDIT_CONFIRMATION_KEY) === "true";
    } catch {
      shouldSkip = false;
    }

    if (shouldSkip) {
      setHasEverEdited(true);
      setEditing(true);
    } else {
      setSkipFutureConfirmation(false);
      setConfirmingEdit(true);
    }
  };

  useEffect(() => {
    if (prevEditingRef.current && !editing) {
      // Exited editing (via Preview or Escape) -> restore focus to preview trigger or container
      editButtonTriggerRef.current?.focus();
    }
    prevEditingRef.current = editing;
  }, [editing]);

  const usedBytes = descriptionByteLength(value);
  const isOverLimit = usedBytes > DESCRIPTION_MAX_BYTES;

  return (
    <div className="card-description-editor flex flex-col gap-1.5">
      <div className="card-description-heading">
        {heading}
        {!editing && (hasEverEdited || value.trim() !== "") && (<Button
            ref={editButtonTriggerRef}
            type="button"
            aria-label="Edit description"
            variant="outline"
            size="xs"
            disabled={readOnly}
            aria-disabled={readOnly}
            onClick={() => {
              if (!readOnly) {
                setHasEverEdited(true);
                setEditing(true);
              }
            }}
            className="pointer-coarse:min-h-11 pointer-coarse:px-3"
          >
            <Pencil aria-hidden="true" className="size-3.5" />Edit
          </Button>)}
      </div>
      {notice}
      {!editing && !hasEverEdited && value.trim() === "" && (
        <Button
          type="button"
          variant="secondary"
          disabled={readOnly}
          aria-disabled={readOnly}
          onClick={() => {
            if (!readOnly) {
              setHasEverEdited(true);
              setEditing(true);
            }
          }}
          className="h-auto justify-start px-2 py-2 text-left font-normal text-muted-foreground hover:text-foreground"
        >
          Add a description…
        </Button>
      )}
      {!editing && (hasEverEdited || value.trim() !== "") && (
        <div className="flex min-w-0 flex-col items-start gap-2">
          <div
            data-testid="description-view"
            onClick={(e) => {
              if (!readOnly) handleRenderedClick(e);
            }}
            className="prose prose-sm min-w-0 max-w-none self-stretch"
          >
            <MarkdownContent
              value={value}
              embedYouTube
              previewImages={previewImages}
              onOpenImage={onOpenImage}
            />
          </div>
          {confirmingEdit &&
            typeof document !== "undefined" &&
            createPortal(
              <div
                className="fixed inset-0 z-30 flex items-center justify-center bg-overlay p-4"
                onMouseDown={(event) => {
                  pressedBackdropRef.current = event.target === event.currentTarget;
                }}
                onClick={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (!pressedBackdropRef.current) return;
                  if (event.detail > 1) return;
                  closeConfirmation();
                }}
              >
                <div
                  ref={dialogRef}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby={titleId}
                  className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-dialog"
                >
                  <h2 id={titleId} className="text-base font-semibold">
                    Edit description?
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    You triple-clicked the description. Would you like to edit it?
                  </p>
                  <label className="mt-4 flex items-center gap-2 text-sm cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={skipFutureConfirmation}
                      onChange={(e) => setSkipFutureConfirmation(e.target.checked)}
                      className="rounded border-border"
                    />
                    <span>Don’t ask again</span>
                  </label>
                  <div className="mt-6 flex justify-end gap-2">
                    <Button
                      ref={cancelButtonRef}
                      type="button"
                      variant="outline"
                      onClick={closeConfirmation}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="default"
                      onClick={handleConfirmEdit}
                    >
                      Edit
                    </Button>
                  </div>
                </div>
              </div>,
              document.body,
            )}
        </div>
      )}
      {(editing || hasEverEdited || value.trim() !== "") && (
        <MarkdownEditor
          value={value}
          readOnly={readOnly}
          onChange={onChange}
          onSubmit={onSave}
          onEscape={
            onPendingClose
              ? onPendingClose
              : () => setEditing(false)
          }
          onUploadImage={onUploadImage}
          ariaLabel="Card description"
          rows={8}
          imageInputTestId="image-input"
          allowSvgPaste={true}
          active={editing}

          trailing={
            <ToolbarButton
              label="Preview description"
              disabled={readOnly}
              onClick={() => setEditing(false)}
            >
              Preview
            </ToolbarButton>
          }
        />
      )}
      {editing && (
        <p className="text-xs text-muted-foreground">Preview doesn’t save your edits.</p>
      )}
      {editing && (
        <div
          data-testid="description-byte-count"
          className={`text-right text-xs ${isOverLimit ? "text-destructive" : "text-muted-foreground"}`}
        >
          {numberFormat.format(usedBytes)} / {numberFormat.format(DESCRIPTION_MAX_BYTES)} bytes
        </div>
      )}
    </div>
  );
}
