import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Member, type MemberCandidate } from "../lib/api";
import {
  accessScope,
  accessSubjectPrefix,
  clearAccessAttempt,
  requestAccessChange,
  sendAccessChange,
  useAccessAttemptOutcomes,
  useAccessAttempts,
} from "../lib/access-attempt";
import { meQuery } from "../lib/auth";
import { useDebounced } from "../lib/use-debounced";
import { Avatar } from "./Avatar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/** A full email address; the server finds an exact match only, so this only decides when to ask. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROW_CLASS =
  "h-9 w-full justify-start px-2 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none";

export interface BoardAddMemberDialogProps {
  board: { id: string; name: string; ownerId: string; capabilities: { canManageBoard: boolean } };
  currentUserId?: string;
  onClose: () => void;
  /** Called once the server has committed the addition, never while it is pending. */
  onSuccess: (added: { id: string; name: string }) => void;
}
export function BoardAddMemberDialog({
  board,
  currentUserId,
  onClose,
  onSuccess,
}: BoardAddMemberDialogProps) {
  const titleId = useId();
  const searchId = useId();
  const listboxId = useId();
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const effectiveCurrentUserId = currentUserId ?? me.data?.id;

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmingRemoveMemberId, setConfirmingRemoveMemberId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState<string | null>(null);
  const [pendingFocusSearch, setPendingFocusSearch] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listboxRef = useRef<HTMLUListElement | null>(null);
  const removeTriggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const cancelRemoveButtonRef = useRef<HTMLButtonElement | null>(null);
  const membersQuery = useQuery({
    queryKey: ["board-members", board.id],
    queryFn: async (): Promise<Member[]> => {
      const response = await api.boards[":id"].members.$get({
        param: { id: board.id },
      });
      if (!response.ok) {
        throw new Error("Could not load board members.");
      }
      const data = await response.json();
      return data.members;
    },
    retry: false,
  });
  const candidatesQuery = useQuery({
    queryKey: ["board-membership-candidates", board.id],
    queryFn: async (): Promise<MemberCandidate[]> => {
      const response = await api.boards[":id"]["membership-candidates"].$get({
        param: { id: board.id },
        query: {},
      });
      if (!response.ok) {
        throw new Error("Could not load users.");
      }
      const data = await response.json();
      return data.candidates;
    },
    retry: false,
  });

  const refreshMembership = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["board-membership-candidates", board.id] }),
      queryClient.invalidateQueries({ queryKey: ["board-members", board.id] }),
      queryClient.invalidateQueries({ queryKey: ["boards"] }),
    ]).catch(() => {
      // Background invalidation errors do not disrupt the completed action.
    });

  const addPrefix = accessSubjectPrefix("board-member-add", board.id);
  const removePrefix = accessSubjectPrefix("board-member-remove", board.id);
  // A change the server is still applying is not a finished action: the attempt
  // is retained by operationId, so reopening this dialog rejoins it.
  const pendingAdd = useAccessAttempts(addPrefix).find((attempt) => attempt.state === "pending");
  const pendingRemove = useAccessAttempts(removePrefix).find((attempt) => attempt.state === "pending");

  const addMember = useMutation({
    mutationFn: (candidate: MemberCandidate) =>
      requestAccessChange(
        accessScope("board-member-add", board.id, candidate.id),
        "board-member-add",
        { boardId: board.id, userId: candidate.id, name: candidate.name },
        (attempt) =>
          sendAccessChange(`/boards/${encodeURIComponent(board.id)}/members`, "POST", {
            userId: candidate.id,
            operationId: attempt.operationId,
          }),
      ),
    onError: (err) => {
      setActionError(err.message || "Could not add the member. Try again.");
    },
  });
  const addTracking = useAccessAttemptOutcomes(addPrefix, (attempt) => {
    clearAccessAttempt(attempt.scopeKey, attempt.operationId);
    if (attempt.state === "aborted") {
      setActionError("The server refused to add that member. Try again.");
      return;
    }
    onSuccess({ id: attempt.context.userId ?? "", name: attempt.context.name ?? "Member" });
    void refreshMembership();
  });
  const removeMember = useMutation({
    mutationFn: (member: Member) =>
      requestAccessChange(
        accessScope("board-member-remove", board.id, member.id),
        "board-member-remove",
        { boardId: board.id, userId: member.id, name: member.name },
        (attempt) =>
          sendAccessChange(
            `/boards/${encodeURIComponent(board.id)}/members/${encodeURIComponent(member.id)}`,
            "DELETE",
            { operationId: attempt.operationId },
          ),
      ),
    onError: (err) => {
      setActionError(err.message || "Could not remove the member. Try again.");
    },
  });
  const removeTracking = useAccessAttemptOutcomes(removePrefix, (attempt) => {
    clearAccessAttempt(attempt.scopeKey, attempt.operationId);
    if (attempt.state === "aborted") {
      setActionError("The server refused to remove that member. Try again.");
      return;
    }
    setConfirmingRemoveMemberId(null);
    setLiveAnnouncement(`Removed ${attempt.context.name} from the board.`);
    setPendingFocusSearch(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    void refreshMembership();
  });

  // Only a request in flight blocks the dialog. A retained pending attempt keeps
  // running server-side, is announced by its own row/status line, and is
  // rejoined by a retry instead of silently blocked.
  const isBusy = addMember.isPending || removeMember.isPending;
  const statusUnavailable = addTracking.statusUnavailable || removeTracking.statusUnavailable || addTracking.unreachable || removeTracking.unreachable;

  const cancelRemove = (memberId: string) => {
    if (removeMember.isPending) return;
    setConfirmingRemoveMemberId(null);
    requestAnimationFrame(() => {
      removeTriggerRefs.current.get(memberId)?.focus();
    });
  };

  const startConfirmRemove = (memberId: string) => {
    if (isBusy) return;
    setActionError(null);
    setConfirmingRemoveMemberId(memberId);
    requestAnimationFrame(() => {
      cancelRemoveButtonRef.current?.focus();
    });
  };

  const handleConfirmRemove = (member: Member) => {
    if (isBusy) return;
    setActionError(null);
    removeMember.mutate(member);
  };


  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (pendingFocusSearch && !isBusy) {
      searchInputRef.current?.focus();
      setPendingFocusSearch(false);
    }
  }, [pendingFocusSearch, isBusy]);

  const isLoadingCandidates = candidatesQuery.isFetching;
  const candidates =
    !isLoadingCandidates && candidatesQuery.isSuccess ? (candidatesQuery.data ?? []) : [];

  const isLoadingMembers = membersQuery.isFetching;
  const members = !isLoadingMembers && membersQuery.isSuccess ? (membersQuery.data ?? []) : [];

  const needle = query.trim().toLowerCase();
  const filteredCandidates = useMemo(() => {
    if (!needle) return candidates;
    return candidates.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        c.email.toLowerCase().includes(needle),
    );
  }, [candidates, needle]);

  const filteredMembers = useMemo(() => {
    if (!needle) return members;
    return members.filter(
      (m) =>
        m.name.toLowerCase().includes(needle) ||
        m.email.toLowerCase().includes(needle),
    );
  }, [members, needle]);

  // The list is this board's workspace. Someone outside it is found only by their full email
  // address (ADR 0072): when the typed text is one and nobody in the list matches, ask the server.
  // Debounced: the lookup is rate limited per user, so typing must not spend a request per keystroke.
  const settledNeedle = useDebounced(needle, 400);
  const lookupEmail = filteredCandidates.length === 0 && settledNeedle === needle && EMAIL_PATTERN.test(needle) ? needle : null;
  const lookupQuery = useQuery({
    queryKey: ["board-membership-candidates", board.id, lookupEmail],
    enabled: lookupEmail !== null && candidatesQuery.isSuccess,
    queryFn: async (): Promise<MemberCandidate[]> => {
      const response = await api.boards[":id"]["membership-candidates"].$get({
        param: { id: board.id },
        query: { email: lookupEmail ?? "" },
      });
      if (!response.ok) {
        throw new Error("Could not look up that email.");
      }
      const data = await response.json();
      return data.candidates;
    },
    retry: false,
  });
  const lookedUp = lookupQuery.isSuccess && !lookupQuery.isFetching ? (lookupQuery.data ?? []) : [];
  const shownCandidates = filteredCandidates.length > 0 ? filteredCandidates : lookedUp;

  const selectedCandidate = useMemo(
    () => shownCandidates.find((c) => c.id === selectedId) ?? null,
    [shownCandidates, selectedId],
  );

  useEffect(() => {
    if (isLoadingCandidates) {
      if (selectedId !== null) {
        setSelectedId(null);
      }
      return;
    }
    if (selectedId && !shownCandidates.some((c) => c.id === selectedId)) {
      setSelectedId(null);
    }
  }, [isLoadingCandidates, shownCandidates, selectedId]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isBusy) return;
        event.preventDefault();
        event.stopPropagation();
        if (confirmingRemoveMemberId !== null) {
          cancelRemove(confirmingRemoveMemberId);
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
  }, [confirmingRemoveMemberId, isBusy, onClose]);
  const handleListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      listboxRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      currentIndex === -1
        ? step === 1
          ? 0
          : items.length - 1
        : Math.min(Math.max(currentIndex + step, 0), items.length - 1);
    items[nextIndex]?.focus();
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const firstOption = listboxRef.current?.querySelector<HTMLElement>('[role="option"]');
      firstOption?.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (confirmingRemoveMemberId !== null) return;
      if (selectedCandidate) {
        handleAdd();
      } else if (shownCandidates.length === 1) {
        setSelectedId(shownCandidates[0].id);
      }
    }
  };

  const handleSelect = (candidate: MemberCandidate) => {
    if (isBusy) return;
    setActionError(null);
    setSelectedId(candidate.id);
  };

  const handleAdd = () => {
    if (!selectedCandidate || isBusy) return;
    setActionError(null);
    addMember.mutate(selectedCandidate);
  };
  const handleRetryMembers = () => {
    searchInputRef.current?.focus();
    void membersQuery.refetch();
  };

  const handleRetryCandidates = () => {
    searchInputRef.current?.focus();
    void candidatesQuery.refetch();
  };

  const handleRetryLookup = () => {
    searchInputRef.current?.focus();
    void lookupQuery.refetch();
  };
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-sm flex-col rounded-lg border border-border bg-card p-6 text-card-foreground shadow-dialog"
      >
        <div aria-live="polite" className="sr-only">
          {liveAnnouncement}
        </div>
        <h2 id={titleId} className="text-base font-semibold [overflow-wrap:anywhere]">
          Add member to {board.name}
        </h2>

        <div className="mt-4 flex flex-col gap-3 min-h-0">
          <div>
            <label htmlFor={searchId} className="block text-xs font-medium text-muted-foreground">
              Find a person
            </label>
            <Input
              ref={searchInputRef}
              id={searchId}
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listboxId}
              value={query}
              onChange={(e) => {
                setActionError(null);
                setQuery(e.target.value);
              }}
              onKeyDown={handleSearchKeyDown}
              disabled={isBusy}
              placeholder="A name, or a full email address…"
              autoComplete="off"
              className="mt-1 h-8 text-xs"
            />
          </div>

          <div className="flex-1 min-h-0 max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground">
            <div className="mb-2">
              <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                Already added
              </div>
              {members.some((member) => member.explicitRole === null) && (
                <p className="px-2 pb-1 text-[11px] text-muted-foreground">
                  Members marked Workspace get access from this board's workspace; remove them on the workspace
                  Members page.
                </p>
              )}
              {isLoadingMembers ? (
                <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
                  Loading members…
                </p>
              ) : membersQuery.isError ? (
                <div role="alert" className="space-y-1.5 px-2 py-1 text-xs text-destructive">
                  <p>Could not load board members.</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={isBusy}
                    onClick={handleRetryMembers}
                  >
                    Retry
                  </Button>
                </div>
              ) : members.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">No current members.</p>
              ) : filteredMembers.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">No matching current members.</p>
              ) : (
                <ul aria-label="Already added members" className="space-y-1">
                  {filteredMembers.map((member) => {
                    const isOwner = member.id === board.ownerId;
                    const isSelf = member.id === effectiveCurrentUserId;
                    const isConfirmingRemove = confirmingRemoveMemberId === member.id;
                    const isRemovingThisMember =
                      removeMember.isPending && removeMember.variables?.id === member.id;
                    // Removal only ever drops an explicit board grant. A member
                    // who reaches the board through the workspace is removed on
                    // the workspace Members page instead. A board manager is
                    // removed only by someone who manages the board; the server
                    // refuses anyone else.
                    const canRemoveGrant =
                      !isOwner &&
                      !isSelf &&
                      member.explicitRole !== null &&
                      (member.explicitRole !== "manager" || board.capabilities.canManageBoard);

                    return (
                      <li
                        key={member.id}
                        className="rounded-sm px-2 py-1 text-popover-foreground transition-colors hover:bg-muted/30"
                      >
                        <div className="flex h-9 w-full items-center gap-2">
                          <Avatar
                            name={member.name}
                            githubLogin={member.githubLogin}
                            avatarVersion={member.avatarVersion}
                            userId={member.id}
                          />
                          <span className="min-w-0 flex-1 truncate text-left">
                            <span className="text-foreground">{member.name}</span>{" "}
                            <span className="text-xs text-muted-foreground">({member.email})</span>
                          </span>
                          <div className="flex shrink-0 items-center gap-1">
                            {isOwner && (
                              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                                Owner
                              </span>
                            )}
                            {member.isAdmin && (
                              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                                Admin
                              </span>
                            )}
                            {isSelf && !isOwner && !member.isAdmin && (
                              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                                You
                              </span>
                            )}
                            {member.explicitRole === null && (
                              <span
                                className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground"
                                title="Access comes from this board's workspace membership"
                              >
                                Workspace
                              </span>
                            )}
                            {isSelf && (isOwner || member.isAdmin) && (
                              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                                You
                              </span>
                            )}
                          </div>
                          {canRemoveGrant && pendingRemove?.context.userId === member.id && (
                            <span className="shrink-0 text-xs text-muted-foreground">Removing…</span>
                          )}
                          {canRemoveGrant && pendingRemove?.context.userId !== member.id && (
                            <Button
                              ref={(node) => {
                                if (node) {
                                  removeTriggerRefs.current.set(member.id, node);
                                } else {
                                  removeTriggerRefs.current.delete(member.id);
                                }
                              }}
                              type="button"
                              variant="ghost"
                              size="xs"
                              disabled={isBusy}
                              aria-label={`Remove member ${member.name}`}
                              onClick={() => startConfirmRemove(member.id)}
                              className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                        {isConfirmingRemove && (
                          <div
                            role="group"
                            aria-label={`Confirm removal of ${member.name}`}
                            className="mt-1 flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs"
                          >
                            <span className="text-destructive font-medium">
                              Remove <span className="font-semibold">{member.name}</span> from this board?
                            </span>
                            <div className="flex justify-end gap-1.5">
                              <Button
                                ref={cancelRemoveButtonRef}
                                 type="button"
                                variant="outline"
                                size="xs"
                                disabled={removeMember.isPending}
                                onClick={() => cancelRemove(member.id)}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                variant="destructive"
                                size="xs"
                                disabled={removeMember.isPending}
                                onClick={() => handleConfirmRemove(member)}
                              >
                                {isRemovingThisMember ? "Removing…" : "Remove member"}
                              </Button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="border-t border-border/50 pt-2">
              <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                Add someone
              </div>
              <div onKeyDown={handleListKeyDown}>
                {isLoadingCandidates ? (
                  <p role="status" className="p-3 text-xs text-muted-foreground">
                    Loading users…
                  </p>
                ) : candidatesQuery.isError ? (
                  <div role="alert" className="space-y-2 p-3 text-xs text-destructive">
                    <p>Could not load users.</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={isBusy}
                      onClick={handleRetryCandidates}
                    >
                      Retry
                    </Button>
                  </div>
                ) : lookupQuery.isFetching ? (
                  <p role="status" className="p-3 text-xs text-muted-foreground">
                    Looking up that email…
                  </p>
                ) : lookupQuery.isError ? (
                  <div role="alert" className="space-y-2 p-3 text-xs text-destructive">
                    <p>Could not look up that email.</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={isBusy}
                      onClick={handleRetryLookup}
                    >
                      Retry
                    </Button>
                  </div>
                ) : shownCandidates.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">
                    {candidates.length === 0 && !needle
                      ? "Everyone in this workspace is already on this board."
                      : "No matching users."}{" "}
                    To add someone from outside it, type their full email address.
                  </p>
                ) : (
                  <ul id={listboxId} ref={listboxRef} role="listbox" aria-label="Users">
                    {shownCandidates.map((candidate) => {
                      const isSelected = candidate.id === selectedId;
                      return (
                        <li key={candidate.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            disabled={isBusy}
                            onClick={() => handleSelect(candidate)}
                            onDoubleClick={() => {
                              handleSelect(candidate);
                              addMember.mutate(candidate);
                            }}
                            className={`${ROW_CLASS} flex items-center gap-2 rounded-sm ${
                              isSelected ? "bg-accent font-medium text-accent-foreground" : ""
                            }`}
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
                            {isSelected && (
                              <Check aria-hidden="true" className="size-3.5 shrink-0 text-foreground font-semibold" />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {actionError && (
            <p role="alert" className="text-xs text-destructive">
              {actionError}
            </p>
          )}

          {(pendingAdd || pendingRemove) && (
            <p role="status" className="text-xs text-muted-foreground">
              {pendingAdd
                ? `Adding ${pendingAdd.context.name} is still in progress.`
                : `Removing ${pendingRemove?.context.name} is still in progress.`}{" "}
              This is not finished until the server confirms it.
            </p>
          )}
          {statusUnavailable && (
            <div className="flex items-center justify-between gap-2 text-xs text-destructive">
              <span role="alert">Could not check the change status.</span>
              <Button type="button" variant="outline" size="xs" onClick={() => { addTracking.checkStatus(); removeTracking.checkStatus(); }}>
                Check status
              </Button>
            </div>
          )}

          {selectedCandidate && (
            <p className="text-xs text-muted-foreground truncate">
              Selected: <span className="font-medium text-foreground">{selectedCandidate.name}</span>
            </p>
          )}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={isBusy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!selectedCandidate || isBusy}
            onClick={handleAdd}
          >
            {addMember.isPending || pendingAdd ? "Adding…" : "Add member"}
          </Button>
        </div>
      </div>
    </div>
  );
}
