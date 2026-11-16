import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash2, UserMinus, UserPlus } from "lucide-react";
import { meQuery } from "../lib/auth";
import { restoreFocusSoon } from "../lib/focus";
import {
  AccessRequestError,
  accessScope,
  accessSubjectPrefix,
  clearAccessAttempt,
  readAccessAttempt,
  requestAccessChange,
  sendAccessChange,
  useAccessAttemptOutcomes,
  useAccessAttempts,
  type AccessAttempt,
} from "../lib/access-attempt";
import {
  workspaceInvitesQuery,
  workspaceMembersQuery,
  workspaceQuery,
  workspaceRequest,
  workspacesQuery,
  boardAccessChoice,
  type WorkspaceInvite,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "../lib/workspaces";
import { WorkspaceAddMemberDialog } from "./WorkspaceAddMemberDialog";
import { AppShell } from "./AppShell";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function canManage(role: WorkspaceRole | null): boolean {
  return role === "admin";
}

export function CreateWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: () => workspaceRequest<{ workspace: { id: string } }>("/workspaces", "POST", { name: name.trim() }),
    onSuccess: async ({ workspace }) => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      onClose();
      await navigate({ to: "/w/$workspaceId", params: { workspaceId: workspace.id } });
    },
  });
  return <div className="boards-dialog-overlay"><div role="dialog" aria-modal="true" aria-labelledby="create-workspace-title" className="boards-dialog-panel">
    <h2 id="create-workspace-title">Create workspace</h2><p>Group boards and people in a shared space.</p>
    <form className="boards-dialog-form" onSubmit={(event) => { event.preventDefault(); if (!mutation.isPending && name.trim()) mutation.mutate(); }}>
      <label htmlFor="workspace-name">Workspace name</label><Input id="workspace-name" autoFocus required maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />
      {mutation.error && <p role="alert" className="boards-dialog-error">{mutation.error.message}</p>}
      <div className="boards-dialog-actions"><Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>Cancel</Button><Button type="submit" disabled={mutation.isPending || !name.trim()}>{mutation.isPending ? "Creating…" : "Create workspace"}</Button></div>
    </form>
  </div></div>;
}

export function WorkspaceMembersPage({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useQuery(meQuery);
  const workspace = useQuery(workspaceQuery(workspaceId));
  const members = useQuery({ ...workspaceMembersQuery(workspaceId), enabled: workspace.data?.access === "member" });
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  // Both dialogs are handed to the shell as overlays, and closing one returns focus
  // to the control that opened it. The add trigger also outlives the removal one:
  // a removal is confirmed from a row button that is gone once it lands.
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Focus lands here when the control a dialog was opened from is gone: it is the one
  // surface on this page that survives every membership change, capability included.
  const pageHeadingRef = useRef<HTMLDivElement | null>(null);
  // Only a committed add is ever announced, and the statement outlives the dialog
  // that asked for it: a settled attempt is reported even after the dialog is gone.
  const [addedNotice, setAddedNotice] = useState<string | null>(null);
  // A committed membership change is the only thing that refreshes these reads: the
  // workspace view, the member list, the directory of accounts that may still be
  // added, and the boards whose access generations that change fenced.
  const refreshMembers = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-membership-candidates", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["boards", workspaceId] }),
    ]);
  const rolePrefix = accessSubjectPrefix("workspace-member-role", workspaceId);
  const removePrefix = accessSubjectPrefix("workspace-member-remove", workspaceId);
  const addPrefix = accessSubjectPrefix("workspace-member-add", workspaceId);
  // A change the server is still preparing is not a finished change: the attempt
  // keeps its operationId across remounts and is polled until it settles.
  const pending = [
    ...useAccessAttempts(rolePrefix),
    ...useAccessAttempts(removePrefix),
    ...useAccessAttempts(addPrefix),
  ].filter((attempt) => attempt.state === "pending");
  const pendingAdds = pending.filter((attempt) => attempt.kind === "workspace-member-add");
  const settle = (attempt: AccessAttempt) => {
    clearAccessAttempt(attempt.scopeKey, attempt.operationId);
    if (attempt.state === "aborted") {
      setChangeError("The change was refused, so the member list is unchanged.");
      return;
    }
    setRemoving(null);
    setChangeError(null);
    // Someone who left no longer has this page or this workspace in their lists.
    if (attempt.kind === "workspace-member-remove" && attempt.context.userId === me?.id) {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["boards"] });
      void navigate({ to: "/" });
      return;
    }
    void refreshMembers();
  };
  const roleTracking = useAccessAttemptOutcomes(rolePrefix, settle);
  const removeTracking = useAccessAttemptOutcomes(removePrefix, settle);
  const addTracking = useAccessAttemptOutcomes(addPrefix, (attempt) => {
    clearAccessAttempt(attempt.scopeKey, attempt.operationId);
    if (attempt.state === "aborted") {
      setChangeError("The server refused to add that member, so the workspace is unchanged.");
      return;
    }
    // Only a committed add closes the dialog — and only a committed outcome is
    // ever announced as one.
    setAdding(false);
    setChangeError(null);
    setAddedNotice(`Added ${attempt.context.name ?? "member"} to the workspace.`);
    void refreshMembers();
  });
  const change = useMutation({
    mutationFn: ({ userId, name, role }: { userId: string; name: string; role?: "admin" | "member" }) =>
      requestAccessChange(
        role
          ? accessScope("workspace-member-role", workspaceId, userId)
          : accessScope("workspace-member-remove", workspaceId, userId),
        role ? "workspace-member-role" : "workspace-member-remove",
        // The role is part of the payload the server hashed, so rejoining this
        // attempt replays it rather than whatever the row now offers.
        role ? { workspaceId, userId, name, role } : { workspaceId, userId, name },
        (attempt) =>
          sendAccessChange(
            `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
            role ? "PATCH" : "DELETE",
            role ? { role, operationId: attempt.operationId } : { operationId: attempt.operationId },
          ),
      ),
    onError: (err) => {
      setChangeError(err.message || "Could not change that member. Try again.");
    },
  });
  const addMember = useMutation({
    mutationFn: ({ userId, name, role }: { userId: string; name: string; role: "member" | "admin" }) =>
      requestAccessChange(
        accessScope("workspace-member-add", workspaceId, userId),
        "workspace-member-add",
        // The role is captured with the attempt: a retry must replay exactly the
        // payload the server hashed, and a different role under the same id is a
        // different operation.
        { workspaceId, userId, name, role },
        (attempt) =>
          sendAccessChange(`/workspaces/${encodeURIComponent(workspaceId)}/members`, "POST", {
            userId: attempt.context.userId,
            role: attempt.context.role,
            operationId: attempt.operationId,
          }),
      ),
    onError: (err) => {
      setChangeError(err.message || "Could not add that member. Try again.");
    },
  });
  // An unresolved attempt the status endpoint cannot answer for — no journal row
  // yet, or the poll itself failing — is only recoverable by replaying the exact
  // payload under the same operationId. The member rows stay disabled while a
  // change is unresolved, so the retry needs its own enabled control.
  const ambiguous =
    roleTracking.unreachable || roleTracking.statusUnavailable || removeTracking.unreachable || removeTracking.statusUnavailable || addTracking.unreachable || addTracking.statusUnavailable;
  const retryAttempt = (attempt: AccessAttempt) => {
    if (attempt.kind === "workspace-member-add") {
      addMember.mutate({
        userId: attempt.context.userId ?? "",
        name: attempt.context.name ?? "Member",
        role: attempt.context.role === "admin" ? "admin" : "member",
      });
      return;
    }
    const { userId, name, role } = attempt.context;
    change.mutate({ userId, name, role: role === "admin" || role === "member" ? role : undefined });
  };
  const busy = change.isPending || pending.length > 0;
  const manageable = canManage(workspace.data?.role ?? null);
  const changedMemberName = pending[0]?.context.name;
  // One predicate answers all three questions about the add dialog — does it render,
  // is the shell inert, has an overlay just closed. A change committed elsewhere can
  // take the capability away while the dialog is up, and a dialog that is not
  // rendered must never be the thing holding the whole page inert.
  const addDialogOpen = adding && manageable;
  const overlayOpen = addDialogOpen || removing !== null;
  // The draft goes with the capability: nothing that regains management later may
  // reopen a dialog the user never asked for again.
  useEffect(() => {
    if (!manageable) setAdding(false);
  }, [manageable]);
  // Closing an overlay hands focus back to the control that opened it — including a
  // committed outcome that closes it from here rather than from a click. The return
  // runs after the commit that removed `inert` from the shell, because a restore
  // scheduled while that attribute is still set is refused: the overlay is the only
  // surface that may hold the keyboard until it is gone.
  const returnTrigger = useRef<HTMLButtonElement | null>(null);
  // Which control takes the keyboard back is resolved inside the restore frame rather
  // than captured: by then the control the dialog was opened from may be gone. A
  // removal's row button disappears with the membership it removed, and the Add
  // trigger disappears with the capability a peer change can take away, so the page
  // heading — the one surface here that survives both — is what remains.
  const resolveReturnFocus = (): HTMLElement | null => {
    for (const element of [returnTrigger.current, addTriggerRef.current]) {
      if (
        element !== null &&
        element.isConnected &&
        element.offsetParent !== null &&
        !element.disabled &&
        element.closest("[inert]") === null
      )
        return element;
    }
    return pageHeadingRef.current;
  };
  const previousOverlayOpen = useRef(overlayOpen);
  useEffect(() => {
    if (overlayOpen === previousOverlayOpen.current) return;
    previousOverlayOpen.current = overlayOpen;
    if (overlayOpen) return;
    // The captured control is read when the restore frame runs, not here, so it is
    // left in place for that frame to resolve.
    restoreFocusSoon(resolveReturnFocus);
  }, [overlayOpen]);
  const openAddDialog = () => {
    setChangeError(null);
    setAddedNotice(null);
    returnTrigger.current = null;
    setAdding(true);
  };
  const closeAddDialog = () => {
    if (addMember.isPending) return;
    setAdding(false);
  };
  const openRemoveDialog = (member: { userId: string; name: string }, trigger: HTMLButtonElement) => {
    returnTrigger.current = trigger;
    setRemoving(member);
  };
  const closeRemoveDialog = () => {
    if (change.isPending) return;
    setChangeError(null);
    setRemoving(null);
  };
  // The shell holds the page inert behind the dialog, so the dialog itself must
  // carry the error and the way to continue this member's unresolved attempt.
  const removingAttempt = removing
    ? pending.find((attempt) => attempt.kind === "workspace-member-remove" && attempt.context.userId === removing.userId)
    : undefined;
  return <AppShell
    breadcrumb="Members"
    workspace={workspace.data}
    overlayOpen={overlayOpen}
    overlays={<>
      {addDialogOpen && <WorkspaceAddMemberDialog
        workspaceId={workspaceId}
        workspaceName={workspace.data?.name ?? "this workspace"}
        isPending={addMember.isPending}
        error={changeError}
        pending={pendingAdds}
        statusUnavailable={addTracking.unreachable || addTracking.statusUnavailable}
        onAdd={(member) => { setChangeError(null); setAddedNotice(null); addMember.mutate(member); }}
        onRetry={retryAttempt}
        onClose={closeAddDialog}
      />}
      {removing && <div className="boards-dialog-overlay"><div role="dialog" aria-modal="true" aria-labelledby="remove-member-title" className="boards-dialog-panel">{removing.userId === me?.id ? <><h2 id="remove-member-title">Leave workspace?</h2><p>You will lose access to this workspace and its Workspace boards. Boards you were added to stay open to you as a guest.</p></> : <><h2 id="remove-member-title">Remove workspace member?</h2><p>Explicit board grants remain, so this person may continue as a guest.</p></>}{changeError && <p role="alert">{changeError}</p>}{removingAttempt && <Button type="button" variant="outline" disabled={change.isPending || addMember.isPending} onClick={() => retryAttempt(removingAttempt)}>{`Retry change for ${removingAttempt.context.name || "this member"}`}</Button>}<div className="boards-dialog-actions"><Button variant="outline" disabled={change.isPending} onClick={closeRemoveDialog}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => { setChangeError(null); change.mutate(removing); }}>{removing.userId === me?.id ? "Leave workspace" : "Remove member"}</Button></div></div></div>}
    </>}
  >
    <div ref={pageHeadingRef} tabIndex={-1} className="boards-heading"><div><h1>Members</h1><p>People with access to {workspace.data?.name ?? "this workspace"}.</p></div>{manageable && <Button ref={addTriggerRef} type="button" onClick={openAddDialog}><UserPlus aria-hidden="true" />Add member</Button>}</div>
    {members.isPending ? <p>Loading members…</p> : members.isError ? <p role="alert">Could not load members.</p> : <ul className="workspace-member-list">{members.data?.map((member) => <li key={member.userId}><span><strong>{member.name}</strong><small>{member.email}</small></span><span className="workspace-member-actions">
      {manageable ? <select aria-label={`Role for ${member.name}`} value={member.role} disabled={busy} onChange={(event) => change.mutate({ userId: member.userId, name: member.name, role: event.target.value as "admin" | "member" })}><option value="member">Member</option><option value="admin">Admin</option></select> : <b>{member.role}</b>}
      {member.userId === me?.id
        ? <Button type="button" variant="outline" size="sm" aria-label="Leave workspace" disabled={busy} onClick={(event) => openRemoveDialog({ userId: member.userId, name: member.name }, event.currentTarget)}>Leave</Button>
        : manageable && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${member.name}`} disabled={busy} onClick={(event) => openRemoveDialog({ userId: member.userId, name: member.name }, event.currentTarget)}><UserMinus /></Button>}
    </span></li>)}</ul>}
    {addedNotice && <p role="status">{addedNotice}</p>}
    {pending.length > 0 && <p role="status">A membership change{changedMemberName ? ` for ${changedMemberName}` : ""} is still being applied. It cannot be reported as done until the server confirms the outcome.</p>}
    {ambiguous && !removing && <div className="workspace-inline"><span role="alert">The server has not confirmed a membership change yet. Retrying continues the same attempt.</span>{pending.map((attempt) => <Button key={attempt.operationId} type="button" variant="outline" disabled={change.isPending || addMember.isPending} onClick={() => retryAttempt(attempt)}>{`Retry change for ${attempt.context.name || "this member"}`}</Button>)}</div>}
    {changeError && !adding && !removing && <p role="alert">{changeError}</p>}
  </AppShell>;
}

export function WorkspaceSettingsPage({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const workspace = useQuery(workspaceQuery(workspaceId));
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"workspace" | "restricted">("workspace");
  const [deleting, setDeleting] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const save = useMutation({
    mutationFn: () => workspaceRequest(`/workspaces/${encodeURIComponent(workspaceId)}`, "PATCH", { name: name.trim(), defaultBoardAccess: access }),
    onSuccess: async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["workspaces"] }), queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId] })]); },
  });
  const remove = useMutation({
    mutationFn: () => workspaceRequest(`/workspaces/${encodeURIComponent(workspaceId)}`, "DELETE"),
    onSuccess: async () => {
      // Home must not list what is gone while the server's list loads, and this page's
      // own reads would only be refused now, so they go once the page has been left.
      queryClient.setQueryData<WorkspaceSummary[]>(workspacesQuery.queryKey, (list) => list?.filter((item) => item.id !== workspaceId));
      await navigate({ to: "/" });
      for (const key of ["workspace", "workspace-members", "workspace-invites", "workspace-membership-candidates", "boards"]) queryClient.removeQueries({ queryKey: [key, workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["boards"] });
    },
  });
  const closeDelete = () => { if (remove.isPending) return; setDeleting(false); remove.reset(); restoreFocusSoon(deleteTrigger.current); };
  // The save's own refetch must not overwrite what the form now holds.
  useEffect(() => { if (save.isPending) return; if (workspace.data) { setName(workspace.data.name); setAccess(workspace.data.defaultBoardAccess); } }, [workspace.data]);
  return <AppShell breadcrumb="Settings" workspace={workspace.data} overlayOpen={deleting} overlays={deleting && <DeleteWorkspaceDialog workspaceName={workspace.data?.name ?? "this workspace"} isPending={remove.isPending} error={remove.error?.message ?? null} onCancel={closeDelete} onConfirm={() => { if (!remove.isPending) remove.mutate(); }} />}><div className="boards-heading"><div><h1>Workspace settings</h1><p>Changes to default access affect future boards only.</p></div></div>
    <form className="workspace-settings" onSubmit={(event) => { event.preventDefault(); if (!save.isPending && name.trim()) save.mutate(); }}><label>Workspace name<Input required maxLength={40} value={name} disabled={save.isPending} onChange={(event) => setName(event.target.value)} /></label><label>Default access for new boards<select value={access} disabled={save.isPending} onChange={(event) => setAccess(event.target.value as typeof access)}><option value="workspace">{boardAccessChoice("workspace")}</option><option value="restricted">{boardAccessChoice("restricted")}</option></select></label><p>This does not change existing boards.</p>{save.error && <p role="alert">{save.error.message}</p>}<Button type="submit" disabled={save.isPending || !name.trim()}>{save.isPending ? "Saving…" : "Save changes"}</Button></form>
    <WorkspaceInvites workspaceId={workspaceId} enabled={canManage(workspace.data?.role ?? null)} />
    {canManage(workspace.data?.role ?? null) && <section className="mt-12 max-w-[680px] border-t border-border pt-7" aria-labelledby="delete-workspace-heading"><h2 id="delete-workspace-heading" className="text-lg font-semibold">Delete workspace</h2><p className="mb-4 mt-2 text-xs text-muted-foreground">A workspace can be deleted once it has no boards. Its members and invitation links are removed with it. This cannot be undone.</p><Button ref={deleteTrigger} type="button" variant="destructive" onClick={() => { remove.reset(); setDeleting(true); }}>Delete workspace</Button></section>}
  </AppShell>;
}

/** A workspace has nothing left to lose but its members and links, so confirming is one click, with Cancel focused. */
function DeleteWorkspaceDialog({ workspaceName, isPending, error, onCancel, onConfirm }: { workspaceName: string; isPending: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key !== "Escape" || isPending) return; event.preventDefault(); event.stopPropagation(); onCancel(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isPending, onCancel]);
  return <div className="boards-dialog-overlay"><div role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="boards-dialog-panel">
    <h2 id={titleId} className="[overflow-wrap:anywhere]">{`Delete “${workspaceName}”?`}</h2>
    <p id={descriptionId}>This removes the workspace, its members and its invitation links. This cannot be undone.</p>
    {error && <p role="alert" className="boards-dialog-error">{error === "access change conflict" ? "A change to this workspace's access is still being applied. Try again in a moment." : error}</p>}
    <div className="boards-dialog-actions"><Button ref={cancelRef} type="button" variant="outline" disabled={isPending} onClick={onCancel}>Cancel</Button><Button type="button" variant="destructive" disabled={isPending} onClick={onConfirm}>{isPending ? "Deleting…" : "Delete workspace"}</Button></div>
  </div></div>;
}

function WorkspaceInvites({ workspaceId, enabled }: { workspaceId: string; enabled: boolean }) {
  const queryClient = useQueryClient();
  const invites = useQuery({ ...workspaceInvitesQuery(workspaceId), enabled });
  // The token is revealed once, and only for the workspace it was created in:
  // carrying it across a workspace change would render a link that cannot work.
  const [issued, setIssued] = useState<{ workspaceId: string; invite: WorkspaceInvite; token: string } | null>(null);
  const [role, setRole] = useState<"member" | "admin">("member");
  useEffect(() => {
    setIssued(null);
  }, [workspaceId]);
  const create = useMutation({ mutationFn: () => workspaceRequest<{ invite: WorkspaceInvite; token: string }>(`/workspaces/${encodeURIComponent(workspaceId)}/invites`, "POST", { role }), onSuccess: async (result) => { setIssued({ workspaceId, ...result }); await queryClient.cancelQueries({ queryKey: ["workspace-invites", workspaceId] }); await queryClient.invalidateQueries({ queryKey: ["workspace-invites", workspaceId] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => workspaceRequest(`/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(id)}`, "DELETE"), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["workspace-invites", workspaceId] }); } });
  if (!enabled) return null;
  const link = issued ? `${location.origin}/join-workspace/${issued.workspaceId}#invite=${issued.token}` : "";
  return <section className="workspace-invites"><h2>Invitation links</h2><p>Links can only be copied when created. Existing links can be revoked below.</p><div className="workspace-inline"><select aria-label="Invitation role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="member">Member</option><option value="admin">Admin</option></select><Button disabled={create.isPending} onClick={() => create.mutate()}><Plus />Create link</Button></div>
    {issued && <div className="workspace-issued-link"><Input aria-label="Workspace invitation link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} /><Button onClick={() => { void navigator.clipboard.writeText(link).catch(() => undefined); }}><Copy />Copy link</Button></div>}
    {create.error && <p role="alert">The invitation may have been created. Refresh the list and revoke unexpected metadata before trying again.</p>}
    {invites.isError && <div className="workspace-inline"><p role="alert">Could not load invitation links.</p><Button type="button" variant="outline" size="sm" onClick={() => void invites.refetch()}>Retry</Button></div>}
    {revoke.isError && <p role="alert">Could not revoke that invitation.</p>}
    <ul>{invites.data?.map((invite) => <li key={invite.id}><span>{invite.role} · expires {new Date(invite.expiresAt).toLocaleDateString()}</span><Button variant="ghost" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(invite.id)}><Trash2 />Revoke</Button></li>)}</ul>
  </section>;
}

export function JoinWorkspacePage({ workspaceId }: { workspaceId: string }) {
  const { data: user } = useQuery(meQuery);
  const navigate = useNavigate();
  const tokenRef = useRef<string | null>(null);
  const [inspect, setInspect] = useState<{ workspaceName: string; role: string; expiresAt: number } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // A check that failed says nothing about the link, so it gets its own state
  // and its own retry instead of reading as an unusable invitation.
  const [inspectFailed, setInspectFailed] = useState(false);
  const [inspectAttempt, setInspectAttempt] = useState(0);
  if (tokenRef.current === null && typeof location !== "undefined") tokenRef.current = new URLSearchParams(location.hash.slice(1)).get("invite");
  const continuation = tokenRef.current ? `${workspaceId}.${tokenRef.current}` : "";
  useEffect(() => {
    if (!user || !tokenRef.current) return;
    void sendAccessChange(`/workspaces/${encodeURIComponent(workspaceId)}/invites/inspect`, "POST", { token: tokenRef.current })
      .then((body) => {
        setInspect(body as { workspaceName: string; role: string; expiresAt: number });
        setInspectFailed(false);
      })
      .catch((error: unknown) => {
        if (error instanceof AccessRequestError && error.status >= 400 && error.status < 500) setUnavailable(true);
        else setInspectFailed(true);
      });
  }, [user, workspaceId, inspectAttempt]);
  // The accepting account is the second subject segment: the workspace-wide
  // prefix this page observes still matches, while an exact replay of the join
  // stays this account's operation and never another session's.
  const acceptScopeKey = accessScope("workspace-invite-accept", workspaceId, user?.id ?? "");
  const attemptPrefix = accessSubjectPrefix("workspace-invite-accept", workspaceId);
  const pendingAccept = useAccessAttempts(attemptPrefix).find((attempt) => attempt.state === "pending");
  const tracking = useAccessAttemptOutcomes(attemptPrefix, (attempt) => {
    clearAccessAttempt(attempt.scopeKey, attempt.operationId);
    if (attempt.state === "aborted") {
      setUnavailable(true);
      return;
    }
    // Membership exists now: the fragment token is dropped only at this point,
    // so a pending join can still be resumed by a reload.
    const joinedWorkspaceId = attempt.context.workspaceId ?? workspaceId;
    history.replaceState(null, "", `/join-workspace/${joinedWorkspaceId}`);
    tokenRef.current = null;
    void navigate({ to: "/w/$workspaceId", params: { workspaceId: joinedWorkspaceId } });
  });
  const accept = useMutation({
    mutationFn: () =>
      requestAccessChange(
        acceptScopeKey,
        "workspace-invite-accept",
        // The token is the payload the server hashed, so a retry that rejoins
        // this attempt replays the retained one rather than re-reading the hash.
        { workspaceId, token: tokenRef.current ?? "" },
        (attempt) =>
          sendAccessChange(`/workspaces/${encodeURIComponent(workspaceId)}/invites/accept`, "POST", {
            token: attempt.context.token,
            operationId: attempt.operationId,
          }),
      ),
    onError: () => {
      // A refusal releases the retained attempt, which is what makes this
      // invitation unusable. A transport failure keeps it: the outcome is simply
      // unknown, so the page must not claim the link is bad.
      if (!readAccessAttempt(acceptScopeKey)) setUnavailable(true);
    },
  });
  if (!user) return <div className="join-workspace"><h1>Join a workspace</h1><p>Sign in or create an eligible account to accept this invitation.</p><div><a className="workspace-auth-link" href={`/login#workspaceInvite=${encodeURIComponent(continuation)}`}>Sign in</a><a className="workspace-auth-link" href={`/signup#workspaceInvite=${encodeURIComponent(continuation)}`}>Create account</a></div></div>;
  return <div className="join-workspace"><h1>{inspect ? `Join ${inspect.workspaceName}` : "Workspace invitation"}</h1>{unavailable || !tokenRef.current ? <><p role="alert">This workspace invitation is unavailable.</p><p>Ask a workspace manager for a fresh link.</p></> : inspect ? <>{pendingAccept ? <p role="status">The invitation is still being accepted. This is not finished until the server confirms it.</p> : <p>You will join as {inspect.role}.</p>}<Button disabled={accept.isPending || pendingAccept !== undefined} onClick={() => accept.mutate()}>{accept.isPending || pendingAccept ? "Joining…" : "Join workspace"}</Button>{(tracking.unreachable || tracking.statusUnavailable) && <Button variant="outline" disabled={accept.isPending} onClick={() => accept.mutate()}>Retry join</Button>}{tracking.statusUnavailable && <Button variant="outline" onClick={tracking.checkStatus}>Check status</Button>}</> : inspectFailed ? <><p role="alert">Could not check this invitation.</p><Button variant="outline" onClick={() => setInspectAttempt((attempt) => attempt + 1)}>Check invitation</Button></> : <p>Checking invitation…</p>}</div>;
}
