import { useEffect, useId, useRef, useState } from "react";
import type { BoardColor, BoardIcon } from "@foxban/shared";
import { boardAccessChoice, type BoardAccessMode } from "../lib/workspaces";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  BoardAppearanceFields,
  DEFAULT_BOARD_COLOR,
  DEFAULT_BOARD_ICON,
} from "./BoardAppearanceFields";

export interface BoardCreateDialogProps {
  workspaceName?: string;
  defaultAccessMode?: BoardAccessMode;
  isPending: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (name: string, key: string, icon: BoardIcon, color: BoardColor, accessMode: BoardAccessMode) => void;
}

export function BoardCreateDialog({ workspaceName, defaultAccessMode = "workspace", isPending, error, onCancel, onCreate }: BoardCreateDialogProps) {
  const titleId = useId();
  const nameId = useId();
  const keyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [icon, setIcon] = useState<BoardIcon>(DEFAULT_BOARD_ICON);
  const [color, setColor] = useState<BoardColor>(DEFAULT_BOARD_COLOR);
  const [accessMode, setAccessMode] = useState<BoardAccessMode>(defaultAccessMode);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isPending) return;
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((node) => node.offsetParent !== null);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panelRef.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isPending, onCancel]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (isPending) return;
    const trimmedName = name.trim();
    const normalizedKey = key.trim().toUpperCase();
    if (!trimmedName || !/^[A-Z][A-Z0-9]{1,9}$/.test(normalizedKey)) return;
    onCreate(trimmedName, normalizedKey, icon, color, accessMode);
  };

  return (
    <div className="boards-dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !isPending) onCancel(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="boards-dialog-panel boards-create-dialog">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close dialog" disabled={isPending} onClick={onCancel} className="boards-dialog-close"><X aria-hidden="true" /></Button>
        <h2 id={titleId}>Create a board</h2>
        <p>Create this board in {workspaceName ?? "your workspace"}.</p>
        <form onSubmit={submit} className="boards-dialog-form">
          <label htmlFor={nameId}>Board name</label>
          <Input ref={nameRef} id={nameId} required maxLength={200} disabled={isPending} value={name} placeholder="e.g. Product roadmap" onChange={(event) => setName(event.target.value)} />
          <label htmlFor={keyId}>Board key</label>
          <Input id={keyId} required minLength={2} maxLength={10} pattern="[A-Z][A-Z0-9]{1,9}" disabled={isPending} value={key} placeholder="ROAD" className="uppercase" onChange={(event) => setKey(event.target.value.toUpperCase())} />
          <span className="boards-dialog-hint">2–10 letters and numbers, starting with a letter.</span>
          <label htmlFor={`${keyId}-access`}>Board access</label>
          <select id={`${keyId}-access`} value={accessMode} disabled={isPending} onChange={(event) => setAccessMode(event.target.value as BoardAccessMode)}>
            <option value="workspace">{boardAccessChoice("workspace")}</option>
            <option value="restricted">{boardAccessChoice("restricted")}</option>
          </select>
          <BoardAppearanceFields
            name={name}
            boardKey={key}
            icon={icon}
            color={color}
            disabled={isPending}
            onIconChange={setIcon}
            onColorChange={setColor}
          />
          {error && <p role="alert" className="boards-dialog-error">{error}</p>}
          <div className="boards-dialog-actions"><Button type="button" variant="outline" disabled={isPending} onClick={onCancel}>Cancel</Button><Button type="submit" disabled={isPending || !name.trim() || !/^[A-Z][A-Z0-9]{1,9}$/.test(key.trim())}>{isPending ? "Creating…" : "Create board"}</Button></div>
        </form>
      </div>
    </div>
  );
}
