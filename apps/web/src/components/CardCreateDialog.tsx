import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Column, Priority } from "@foxban/shared";
import { X } from "lucide-react";
import type { Member } from "../lib/api";
import type { EditableTaskType } from "../lib/task-type";
import { AssigneePicker } from "./AssigneePicker";
import { PriorityPicker } from "./PriorityPicker";
import { StatusPicker } from "./StatusPicker";
import { TaskTypePicker } from "./TaskTypePicker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * One card's whole first draft. The board turns it into a single `card.create`,
 * so an accepted creation is already configured — never a card plus three
 * follow-up edits that can half-land.
 */
export interface CardCreateDraft {
  title: string;
  columnId: string;
  taskType: EditableTaskType;
  priority: Priority;
  assigneeId: string | null;
}

export interface CardCreateDialogProps {
  boardName: string;
  /** The board's columns, sorted: the destination picker's options. */
  columns: Column[];
  /** The column the dialog was opened from, or the first one. */
  initialColumnId: string;
  members: Member[];
  membersLoading: boolean;
  membersError: boolean;
  onRetryMembers: () => void;
  /** True while a submitted creation is still awaiting settlement. */
  isPending: boolean;
  error: string | null;
  connected: boolean;
  handshakeFailed: boolean;
  onRetryConnection: () => void;
  onCreate: (draft: CardCreateDraft) => void;
  onCancel: () => void;
}

/**
 * The Create a card form: title, destination, type, priority and assignee in one
 * draft. Every control is one of the app's existing pickers, so the panel adds
 * no rival interaction model — only the labels and the grid around them.
 */
export function CardCreateDialog({
  boardName,
  columns,
  initialColumnId,
  members,
  membersLoading,
  membersError,
  onRetryMembers,
  isPending,
  error,
  connected,
  handshakeFailed,
  onRetryConnection,
  onCreate,
  onCancel,
}: CardCreateDialogProps) {
  const titleId = useId();
  const titleInputId = useId();
  const typeGroupId = useId();
  const columnGroupId = useId();
  const priorityGroupId = useId();
  const assigneeGroupId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [columnId, setColumnId] = useState(initialColumnId);
  const [taskType, setTaskType] = useState<EditableTaskType>("task");
  const [priority, setPriority] = useState<Priority>("medium");
  const [assigneeId, setAssigneeId] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  // A destination or an assignee that left the board while the dialog was open
  // is never silently replaced: the draft keeps the choice and submit stops
  // until the reader makes a new one.
  const columnAvailable = columns.some((column) => column.id === columnId);
  const assigneeAvailable =
    assigneeId === null || members.some((member) => member.id === assigneeId);
  const canSubmit = trimmedTitle !== "" && columnAvailable && assigneeAvailable;

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

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
    if (isPending || !canSubmit) return;
    onCreate({ title: trimmedTitle, columnId, taskType, priority, assigneeId });
  };

  const memberNote = useMemo(() => {
    if (membersLoading) return "Loading board members…";
    if (membersError) return "Could not load board members.";
    return null;
  }, [membersLoading, membersError]);

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
        <h2 id={titleId}>Create a card</h2>
        <p>{`Add a card to ${boardName}.`}</p>
        <form onSubmit={submit} className="boards-dialog-form">
          <fieldset className="board-create-fieldset" disabled={isPending}>
            <label htmlFor={titleInputId}>Title</label>
            <Input
              ref={titleRef}
              id={titleInputId}
              required
              maxLength={200}
              disabled={isPending}
              value={title}
              placeholder="What needs to be done?"
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="board-create-fields">
              <div role="group" aria-labelledby={typeGroupId} className="board-create-field">
                <span id={typeGroupId} className="board-create-field-label">Type</span>
                <TaskTypePicker value={taskType} onChange={setTaskType} />
              </div>
              <div role="group" aria-labelledby={columnGroupId} className="board-create-field">
                <span id={columnGroupId} className="board-create-field-label">Column</span>
                <StatusPicker columnId={columnId} columns={columns} onChange={setColumnId} />
              </div>
              <div role="group" aria-labelledby={priorityGroupId} className="board-create-field">
                <span id={priorityGroupId} className="board-create-field-label">Priority</span>
                <PriorityPicker value={priority} onChange={setPriority} />
              </div>
              <div role="group" aria-labelledby={assigneeGroupId} className="board-create-field">
                <span id={assigneeGroupId} className="board-create-field-label">Assignee</span>
                <AssigneePicker
                  assigneeId={assigneeId}
                  members={members}
                  onChange={(value) => setAssigneeId(value === "" ? null : value)}
                />
                {memberNote !== null && (
                  <span role="status" className="boards-dialog-hint">{memberNote}</span>
                )}
                {membersError && (
                  <Button type="button" variant="outline" size="xs" onClick={onRetryMembers}>Retry members</Button>
                )}
              </div>
            </div>
          </fieldset>
          {!columnAvailable && (
            <p role="alert" className="boards-dialog-error">That column is no longer on the board. Choose another one.</p>
          )}
          {!assigneeAvailable && (
            <p role="alert" className="boards-dialog-error">The selected member is no longer on this board. Choose again.</p>
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
            <Button type="submit" disabled={isPending || !canSubmit}>{isPending ? "Creating…" : "Create card"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
