import { useEffect, useId, useRef, useState } from "react";
import type { BoardColor, BoardIcon } from "@foxban/shared";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { BoardAppearanceFields } from "./BoardAppearanceFields";

export interface BoardEditDialogProps {
  board: { id: string; name: string; key: string; ownerId: string; icon: BoardIcon; color: BoardColor };
  isPending: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (name: string, key: string, icon: BoardIcon, color: BoardColor) => void;
}

export function BoardEditDialog({
  board,
  isPending,
  error,
  onCancel,
  onSave,
}: BoardEditDialogProps) {
  const titleId = useId();
  const nameId = useId();
  const keyId = useId();
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState(board.name);
  const [key, setKey] = useState(board.key);
  const [icon, setIcon] = useState<BoardIcon>(board.icon);
  const [color, setColor] = useState<BoardColor>(board.color);

  useEffect(() => {
    setName(board.name);
    setKey(board.key);
    setIcon(board.icon);
    setColor(board.color);
  }, [board.id, board.name, board.key, board.icon, board.color]);

  useEffect(() => {
    if (nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
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

  const trimmedName = name.trim();
  const normalizedKey = key.trim().toUpperCase();
  const isUnchanged =
    trimmedName === board.name.trim() &&
    normalizedKey === board.key.trim().toUpperCase() &&
    icon === board.icon &&
    color === board.color;
  const isSaveDisabled = isPending || !trimmedName || !normalizedKey || isUnchanged;

  const handleSubmit = (event?: React.SyntheticEvent) => {
    if (event) {
      event.preventDefault();
    }
    if (isSaveDisabled) return;
    onSave(trimmedName, normalizedKey, icon, color);
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-dialog"
      >
        <h2 id={titleId} className="text-base font-semibold [overflow-wrap:anywhere]">
          Edit board
        </h2>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor={nameId} className="block text-sm font-medium">
              Board name
            </label>
            <Input
              ref={nameInputRef}
              id={nameId}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={isPending}
              autoComplete="off"
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor={keyId} className="block text-sm font-medium">
              Board key
            </label>
            <Input
              id={keyId}
              type="text"
              value={key}
              maxLength={10}
              onChange={(event) => setKey(event.target.value.toUpperCase())}
              disabled={isPending}
              autoComplete="off"
              className="mt-1 uppercase"
            />
          </div>

          <BoardAppearanceFields
            name={name}
            boardKey={key}
            icon={icon}
            color={color}
            disabled={isPending}
            onIconChange={setIcon}
            onColorChange={setColor}
          />

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSaveDisabled}
            >
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
