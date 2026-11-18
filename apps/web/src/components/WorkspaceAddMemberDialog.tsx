import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { AccessAttempt } from "../lib/access-attempt";
import {
  workspaceMembershipCandidatesQuery,
  type WorkspaceMemberCandidate,
} from "../lib/workspaces";
import { useDebounced } from "../lib/use-debounced";
import { Avatar } from "./Avatar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** A full email address; the server finds an exact match only, so this only decides when to ask. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROW_CLASS =
  "h-9 w-full justify-start gap-2 rounded-sm px-2 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none";

export type WorkspaceMemberDraft = { userId: string; name: string; role: "member" | "admin" };

export interface WorkspaceAddMemberDialogProps {
  workspaceId: string;
  workspaceName: string;
  /** The add request currently on the wire: the form stays locked while it is. */
  isPending: boolean;
  error: string | null;
  /** Adds this workspace is still applying, whichever surface started them. */
  pending: readonly AccessAttempt[];
  /** No retained add could be checked, so only a retry can settle it. */
  statusUnavailable: boolean;
  onAdd: (member: WorkspaceMemberDraft) => void;
  onRetry: (attempt: AccessAttempt) => void;
  onClose: () => void;
}

/**
 * Adding an existing account to the workspace directly, without an invitation
 * link. It creates nothing until submitted: the search, the selection and the
 * role are a draft that Cancel, X, backdrop and Escape discard. A submitted add
 * is the caller's operation, not this dialog's — the operation id, its captured
 * role and its outcome are owned by the page, so unmounting the dialog cannot
 * lose the attempt the server is already applying.
 */
export function WorkspaceAddMemberDialog({
  workspaceId,
  workspaceName,
  isPending,
  error,
  pending,
  statusUnavailable,
  onAdd,
  onRetry,
  onClose,
}: WorkspaceAddMemberDialogProps) {
  const titleId = useId();
  const searchId = useId();
  const listboxId = useId();
  const roleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listboxRef = useRef<HTMLUListElement | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [role, setRole] = useState<"member" | "admin">("member");

  // No list: the server answers only for one exact address (ADR 0072), so ask once the
  // typed text is a full email address.
  // Debounced: the lookup is rate limited per user (ADR 0072).
  const email = useDebounced(query.trim().toLowerCase(), 400);
  const lookupEmail = EMAIL_PATTERN.test(email) ? email : null;
  const candidates = useQuery({
    ...workspaceMembershipCandidatesQuery(workspaceId, lookupEmail ?? ""),
    enabled: lookupEmail !== null,
    retry: false,
  });
  // Only a settled, successful read is selectable: rows left over from a previous
  // failure must never be submitted as if the server had just offered them.
  const matches = useMemo<readonly WorkspaceMemberCandidate[]>(
    () => (lookupEmail === null || candidates.isFetching || !candidates.isSuccess ? [] : (candidates.data ?? [])),
    [lookupEmail, candidates.isFetching, candidates.isSuccess, candidates.data],
  );
  const selected = matches.find((candidate) => candidate.id === selectedId) ?? null;

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // A selection that the lookup no longer offers — refetched after an add, or
  // replaced by another address — cannot stay selected and be submitted later.
  useEffect(() => {
    if (selectedId === null) return;
    if (candidates.isFetching || !matches.some((candidate) => candidate.id === selectedId))
      setSelectedId(null);
  }, [candidates.isFetching, matches, selectedId]);

  const submit = () => {
    if (isPending || !selected) return;
    onAdd({ userId: selected.id, name: selected.name, role });
  };

  // Escape closes only while nothing has been sent, and Tab stays inside the
  // panel: the same contract the other workspace dialogs use.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isPending) return;
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
      if (
        event.shiftKey &&
        (document.activeElement === first || !panelRef.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panelRef.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isPending, onClose]);

  const moveSelection = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      listboxRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (selected) {
      submit();
      return;
    }
    // One remaining match is unambiguous: Enter takes it rather than adding
    // nothing because the user never clicked it.
    if (matches.length === 1) setSelectedId(matches[0]!.id);
  };

  const moveWithinList = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      listboxRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next =
      current === -1
        ? step === 1
          ? 0
          : items.length - 1
        : Math.min(Math.max(current + step, 0), items.length - 1);
    items[next]?.focus();
  };

  return (
    <div
      className="boards-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isPending) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="boards-dialog-panel boards-create-dialog"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close dialog"
          disabled={isPending}
          onClick={onClose}
          className="boards-dialog-close"
        >
          <X aria-hidden="true" />
        </Button>
        <h2 id={titleId}>Add member to {workspaceName}</h2>
        <p>Give an existing Foxban account access to this workspace.</p>
        <div className="boards-dialog-form">
          <label htmlFor={searchId}>Search existing users</label>
          <Input
            ref={searchRef}
            id={searchId}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            autoComplete="off"
            value={query}
            disabled={isPending}
            placeholder="A full email address…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={moveSelection}
          />
          <div
            className="max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground"
            onKeyDown={moveWithinList}
          >
            {candidates.isFetching ? (
              <p role="status">Loading users…</p>
            ) : candidates.isError ? (
              <div role="alert">
                <p>Could not load users.</p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={isPending}
                  onClick={() => {
                    searchRef.current?.focus();
                    void candidates.refetch();
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : lookupEmail === null ? (
              <p>Type the full email address of an existing account.</p>
            ) : matches.length === 0 ? (
              <p>No matching users.</p>
            ) : (
              <ul id={listboxId} ref={listboxRef} role="listbox" aria-label="Users">
                {matches.map((candidate) => {
                  const isSelected = candidate.id === selectedId;
                  const attempt = pending.find((entry) => entry.context.userId === candidate.id);
                  return (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        disabled={isPending}
                        className={`${ROW_CLASS} flex items-center`}
                        onClick={() => setSelectedId(candidate.id)}
                        onDoubleClick={() => {
                          setSelectedId(candidate.id);
                          if (!isPending) onAdd({ userId: candidate.id, name: candidate.name, role });
                        }}
                      >
                        <Avatar
                          name={candidate.name}
                          githubLogin={candidate.githubLogin}
                          avatarVersion={candidate.avatarVersion}
                          userId={candidate.id}
                        />
                        <span className="min-w-0 flex-1 truncate text-left">
                          <span className="text-foreground">{candidate.name}</span>{" "}
                          <span className="text-xs text-muted-foreground">({candidate.email})</span>
                        </span>
                        {attempt && <span className="shrink-0 text-xs text-muted-foreground">Adding…</span>}
                        {isSelected && <Check aria-hidden="true" className="size-3.5 shrink-0" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <label htmlFor={roleId}>Role</label>
          <select
            id={roleId}
            value={role}
            disabled={isPending}
            onChange={(event) => setRole(event.target.value as "member" | "admin")}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          {selected && (
            <p>
              Adding <span className="font-medium">{selected.name}</span> as {role}.
            </p>
          )}
          {error && (
            <p role="alert" className="boards-dialog-error">
              {error}
            </p>
          )}
          {pending.length > 0 && (
            <p role="status">
              An add is still being applied. This is not finished until the server confirms it.
            </p>
          )}
          {statusUnavailable && (
            <div role="alert" className="workspace-inline">
              <span>The server has not confirmed an add yet. Retrying continues the same attempt.</span>
              {pending.map((attempt) => (
                <Button
                  key={attempt.operationId}
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={isPending}
                  onClick={() => onRetry(attempt)}
                >
                  {`Retry add for ${attempt.context.name || "this user"}`}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="boards-dialog-actions">
          <Button type="button" variant="outline" disabled={isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={isPending || !selected} onClick={submit}>
            {isPending ? "Adding…" : "Add member"}
          </Button>
        </div>
      </div>
    </div>
  );
}
