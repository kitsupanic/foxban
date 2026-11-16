import { useBlocker } from "@tanstack/react-router";
import { useInfiniteQuery, useIsMutating, useMutation, useQuery, useQueryClient, type InfiniteData, type UseQueryResult } from "@tanstack/react-query";
import { Copy, KeyRound, Plug, RotateCcw, Search, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { agentCredentialsKey, agentCredentialsMutationKey, agentCredentialsQuery, fetchAgentCredentialsPage, type AgentScope, type CredentialMetadata, type CredentialPage, type IssueCredentialInput, type IssuedCredential } from "../lib/agent-credentials";
import { api } from "../lib/api";
import { meQuery } from "../lib/auth";
import { allBoardsQuery, type Board } from "../lib/boards";
import { restoreFocusSoon } from "../lib/focus";
import { AppShell } from "./AppShell";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const scopeOptions: { value: AgentScope; label: string }[] = [
  { value: "boards:read", label: "Read boards and tasks" },
  { value: "tasks:write", label: "Create, edit and move tasks" },
  { value: "comments:write", label: "Post comments" },
];
const scopeLabels = Object.fromEntries(scopeOptions.map(({ value, label }) => [value, label])) as Record<AgentScope, string>;
const ambiguousIssueMessage = "The request may have created a token, but its secret could not be retrieved. Check Your tokens and revoke the unused entry before generating another.";
const visibleDate = (value: number) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(value);

type Draft = { name: string; boardIds: string[]; scopes: AgentScope[]; expiresInDays: string };
const initialDraft = (): Draft => ({ name: "", boardIds: [], scopes: ["boards:read"], expiresInDays: "30" });

export function McpServerPage() {
  const queryClient = useQueryClient();
  const { data: user } = useQuery(meQuery);
  const userId = user?.id ?? "";
  const credentials = useInfiniteQuery({ ...agentCredentialsQuery(userId), enabled: Boolean(user) });
  const boards = useQuery(allBoardsQuery);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [saved, setSaved] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [missingBoardsNotice, setMissingBoardsNotice] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expiryTick, setExpiryTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const issuingRef = useRef(false);
  const mountedRef = useRef(true);
  const identityRef = useRef(userId);
  const generationRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const unsavedReveal = issued !== null && !saved;
  const protectedState = issuing || unsavedReveal;
  const endpoint = new URL("/mcp", window.location.origin).toString();
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      refreshGenerationRef.current += 1;
      issuingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (identityRef.current === userId) return;
    identityRef.current = userId;
    generationRef.current += 1;
    refreshGenerationRef.current += 1;
    issuingRef.current = false;
    setRefreshing(false);
    setRefreshError(null);
    setIssuing(false);
    setIssued(null);
    setSaved(false);
    setDialogOpen(false);
  }, [userId]);
  useEffect(() => {
    if (!protectedState) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [protectedState]);
  const blocker = useBlocker({ shouldBlockFn: () => protectedState, withResolver: true, enableBeforeUnload: false });
  useEffect(() => { if (blocker.status === "blocked") blocker.reset?.(); }, [blocker]);

  useEffect(() => {
    const update = () => {
      setNow(Date.now());
      setExpiryTick((tick) => tick + 1);
    };
    const current = Date.now();
    setNow(current);
    window.addEventListener("focus", update);
    const activeExpiries = credentials.data?.pages.flatMap((page) => page.credentials)
      .filter((credential) => credential.revokedAt === null && credential.expiresAt > current)
      .map((credential) => credential.expiresAt) ?? [];
    const nextExpiry = activeExpiries.length > 0 ? Math.min(...activeExpiries) : null;
    const timer = nextExpiry === null ? null : window.setTimeout(update, Math.min(nextExpiry - current + 1, 2_147_483_647));
    return () => { window.removeEventListener("focus", update); if (timer !== null) window.clearTimeout(timer); };
  }, [credentials.data, expiryTick]);
  const refresh = useCallback(async () => {
    if (!userId) return;
    const generation = ++refreshGenerationRef.current;
    setRefreshing(true);
    await queryClient.cancelQueries({ queryKey: agentCredentialsKey(userId), exact: true });
    try {
      const page = await fetchAgentCredentialsPage(null);
      if (refreshGenerationRef.current !== generation || identityRef.current !== userId) return;
      await queryClient.cancelQueries({ queryKey: agentCredentialsKey(userId), exact: true });
      queryClient.setQueryData<InfiniteData<CredentialPage, string | null>>(
        agentCredentialsKey(userId),
        { pages: [page], pageParams: [null] },
      );
      setRefreshError(null);
    } catch {
      if (refreshGenerationRef.current === generation && identityRef.current === userId) {
        setRefreshError("Could not refresh tokens. Existing entries are retained.");
      }
    } finally {
      if (refreshGenerationRef.current === generation && identityRef.current === userId) setRefreshing(false);
    }
  }, [queryClient, userId]);
  const closeDialog = useCallback(() => {
    if (issuingRef.current) return;
    if (issued && !saved) {
      document.getElementById("mcp-token-saved")?.focus();
      return;
    }
    setIssued(null);
    setSaved(false);
    setDialogOpen(false);
    setIssueError(null);
    restoreFocusSoon(triggerRef.current);
  }, [issued, saved]);
  const openDialog = () => {
    setDraft(initialDraft()); setIssued(null); setSaved(false); setIssueError(null); setMissingBoardsNotice(false); setDialogOpen(true);
  };

  const issue = async (input: IssueCredentialInput) => {
    if (issuingRef.current || !userId) return;
    issuingRef.current = true; setIssuing(true); setIssueError(null);
    const identity = userId;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    let definitiveFailure = false;
    const deadline = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await api.me["agent-credentials"].$post({ json: input }, { init: { signal: controller.signal } });
      if (!response.ok) {
        definitiveFailure = response.status < 500;
        if (response.status === 400) throw new Error("Review the token fields and try again.");
        if (response.status === 403) throw new Error("One or more selected boards are no longer available.");
        throw new Error(`Could not generate token (${response.status}).`);
      }
      let result: IssuedCredential;
      try { result = await response.json(); }
      catch { throw new Error(ambiguousIssueMessage); }
      if (!result.token || !result.credential?.id) throw new Error(ambiguousIssueMessage);
      if (!mountedRef.current || identityRef.current !== identity || generationRef.current !== generation) return;
      setIssued(result); setSaved(false);
    } catch (error) {
      if (!mountedRef.current || identityRef.current !== identity || generationRef.current !== generation) return;
      const message = definitiveFailure && error instanceof Error ? error.message : ambiguousIssueMessage;
      setIssueError(message);
    } finally {
      window.clearTimeout(deadline);
      if (mountedRef.current && identityRef.current === identity && generationRef.current === generation) { issuingRef.current = false; setIssuing(false); void refresh(); }
    }
  };

  const pages = credentials.data?.pages ?? [];
  const credentialRows = useMemo(() => {
    const byId = new Map<string, CredentialMetadata>();
    for (const page of pages) for (const credential of page.credentials) if (!byId.has(credential.id)) byId.set(credential.id, credential);
    return [...byId.values()];
  }, [pages]);

  return (
    <AppShell breadcrumb="MCP server" overlayOpen={dialogOpen} overlays={dialogOpen ? (
      <TokenDialog boards={boards} draft={draft} setDraft={setDraft} issued={issued} saved={saved} setSaved={setSaved} issuing={issuing} issueError={issueError} setIssueError={setIssueError} missingBoardsNotice={missingBoardsNotice} setMissingBoardsNotice={setMissingBoardsNotice} endpoint={endpoint} onIssue={issue} onClose={closeDialog} />
    ) : null}>
      <div className="boards-heading mcp-server-heading"><div><h1>MCP server</h1><p>Connect your coding tools to your Foxban boards.</p></div><Button ref={triggerRef} type="button" onClick={openDialog}><KeyRound aria-hidden="true" />Generate token</Button></div>
      <section className="mcp-server-connection" aria-labelledby="mcp-connection-heading">
        <div><h2 id="mcp-connection-heading">Connection</h2><p>Use this endpoint with a Foxban MCP token.</p></div>
        <CopyField label="MCP endpoint" value={endpoint} actionLabel="Copy endpoint" />
        <ol><li>Copy the endpoint.</li><li>Generate a token scoped to the boards and permissions your tool needs.</li><li>Supply it in the client’s <code>Authorization: Bearer &lt;your-token&gt;</code> header.</li></ol>
        <p>Tokens expire or revoke independently of browser logout. MCP does not automatically run agents or claim tasks.</p>
      </section>
      <section className="mcp-server-tokens" aria-labelledby="mcp-tokens-heading">
        <div className="mcp-server-section-heading"><h2 id="mcp-tokens-heading">Your tokens</h2>{credentials.data && <Button type="button" variant="ghost" size="xs" disabled={credentials.isFetching || refreshing} onClick={() => void refresh()}><RotateCcw aria-hidden="true" />{refreshing ? "Refreshing…" : "Refresh"}</Button>}</div>
        {credentials.isPending && !credentials.data && <p role="status" className="mcp-server-state">Loading tokens…</p>}
        {credentials.isError && !credentials.data && <LoadError message="Could not load tokens." retry={() => void credentials.refetch()} />}
        {credentials.data && credentialRows.length === 0 && <div className="mcp-server-empty"><Plug aria-hidden="true" /><div><strong>No tokens yet</strong><p>Generate a scoped token when a coding tool needs access.</p></div></div>}
        {credentialRows.length > 0 && <ul className="mcp-server-token-list">{credentialRows.map((credential) => <CredentialCard key={credential.id} credential={credential} boards={boards.data ?? []} now={now} userId={userId} onChanged={refresh} />)}</ul>}
        {refreshError && credentials.data && <LoadError message={refreshError} retry={() => void refresh()} />}
        {!refreshError && credentials.isError && credentials.data && <LoadError message="Could not refresh tokens. Existing entries are retained." retry={() => void credentials.refetch()} />}
        {credentials.hasNextPage && <div className="mcp-server-load-more"><Button type="button" variant="outline" disabled={credentials.isFetchingNextPage} onClick={() => void credentials.fetchNextPage()}>{credentials.isFetchingNextPage ? "Loading…" : "Load more"}</Button>{credentials.isFetchNextPageError && <p role="alert">Could not load more tokens. Try again.</p>}</div>}
      </section>
    </AppShell>
  );
}

function CopyField({ label, value, actionLabel }: { label: string; value: string; actionLabel: string }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const copy = async () => {
    try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(value); setFeedback(actionLabel === "Copy token" ? "Token copied" : "Endpoint copied"); }
    catch { setFeedback("Could not copy. Select the value and copy it manually."); }
  };
  return <div className="mcp-server-copy"><label>{label}<Input id={actionLabel === "Copy token" ? "mcp-token-value" : undefined} readOnly value={value} onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} /></label><Button type="button" variant="outline" onClick={() => void copy()}><Copy aria-hidden="true" />{actionLabel}</Button>{feedback && <p role={feedback.startsWith("Could not") ? "alert" : "status"}>{feedback}</p>}</div>;
}

function ConfigCopyActions({ endpoint, token }: { endpoint: string; token: string }) {
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const copyConfig = async (format: "generic" | "vscode") => {
    const authorization = `Bearer ${token}`;
    const config = format === "generic"
      ? { mcpServers: { foxban: { url: endpoint, headers: { Authorization: authorization } } } }
      : { servers: { foxban: { type: "http", url: endpoint, headers: { Authorization: authorization } } } };
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
      setFeedback({
        kind: "success",
        message: format === "generic" ? "Generic MCP config copied" : "VS Code MCP config copied",
      });
    } catch {
      setFeedback({
        kind: "error",
        message: "Could not copy config. Copy the token manually and add it to your client.",
      });
    }
  };
  return (
    <div className="mcp-server-config-copy">
      <div>
        <strong>Copy MCP config</strong>
        <p>Includes this one-time token. Paste it only into a trusted client configuration.</p>
      </div>
      <div className="mcp-server-config-actions">
        <Button type="button" variant="outline" onClick={() => void copyConfig("generic")}><Copy aria-hidden="true" />Copy generic config</Button>
        <Button type="button" variant="outline" onClick={() => void copyConfig("vscode")}><Copy aria-hidden="true" />Copy VS Code config</Button>
      </div>
      {feedback && <p role={feedback.kind === "error" ? "alert" : "status"}>{feedback.message}</p>}
    </div>
  );
}

function LoadError({ message, retry }: { message: string; retry: () => void }) { return <div className="mcp-server-load-error"><p role="alert">{message}</p><Button type="button" variant="outline" size="xs" onClick={retry}>Retry</Button></div>; }

function CredentialCard({ credential, boards, now, userId, onChanged }: { credential: CredentialMetadata; boards: Board[]; now: number; userId: string; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mutationKey = [...agentCredentialsMutationKey(userId), "revoke"];
  const revoke = useMutation({ mutationKey, mutationFn: async () => { const response = await api.me["agent-credentials"][":credentialId"].$delete({ param: { credentialId: credential.id } }); if (response.status !== 204) throw new Error(`Could not revoke token (${response.status}).`); }, onSuccess: async () => { setConfirming(false); setError(null); await onChanged(); }, onError: (reason: Error) => setError(reason.message) });
  const busy = useIsMutating({ mutationKey: agentCredentialsMutationKey(userId) }) > 0;
  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);
  const status = credential.revokedAt !== null ? "Revoked" : credential.expiresAt <= now ? "Expired" : "Active";
  const boardById = new Map(boards.map((board) => [board.id, board]));
  return <li className="mcp-server-token-card"><div className="mcp-server-token-top"><div><strong>{credential.name}</strong><span>Created {visibleDate(credential.createdAt)}</span></div><span className={`mcp-server-status mcp-server-status-${status.toLowerCase()}`}>{status}</span></div><dl><div><dt>Boards</dt><dd>{credential.boardIds.map((id: string) => { const board = boardById.get(id); return <span key={id}>{board ? `${board.name} (${board.key})` : `Unavailable board (${id})`}</span>; })}</dd></div><div><dt>Permissions</dt><dd>{credential.scopes.map((scope: AgentScope) => <span key={scope}>{scopeLabels[scope]}</span>)}</dd></div><div><dt>Expires</dt><dd>{visibleDate(credential.expiresAt)}</dd></div></dl>{status === "Active" && !confirming && <Button type="button" variant="ghost" size="xs" disabled={busy} aria-label={`Revoke token ${credential.name}`} onClick={() => { setError(null); setConfirming(true); }}>Revoke</Button>}{confirming && <div className="mcp-server-revoke-confirm"><p>Revoke <strong>{credential.name}</strong>? Connected tools will lose access on their next request.</p><div><Button ref={cancelRef} type="button" variant="outline" disabled={revoke.isPending} onClick={() => setConfirming(false)}>Cancel</Button><Button type="button" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>{revoke.isPending ? "Revoking…" : "Revoke token"}</Button></div></div>}{error && <p role="alert" className="boards-dialog-error">{error} You can retry.</p>}</li>;
}

function TokenDialog({ boards, draft, setDraft, issued, saved, setSaved, issuing, issueError, setIssueError, missingBoardsNotice, setMissingBoardsNotice, endpoint, onIssue, onClose }: { boards: UseQueryResult<Board[], Error>; draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft>>; issued: IssuedCredential | null; saved: boolean; setSaved: (value: boolean) => void; issuing: boolean; issueError: string | null; setIssueError: (value: string | null) => void; missingBoardsNotice: boolean; setMissingBoardsNotice: (value: boolean) => void; endpoint: string; onIssue: (input: IssueCredentialInput) => Promise<void>; onClose: () => void }) {
  const titleId = useId(); const panelRef = useRef<HTMLDivElement>(null); const firstRef = useRef<HTMLInputElement>(null); const [search, setSearch] = useState(""); const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { (issued ? document.getElementById("mcp-token-value") : firstRef.current)?.focus(); }, [issued]);
  useEffect(() => {
    if (!boards.data) return;
    const available = new Set(boards.data.map((board) => board.id));
    setDraft((current) => { const boardIds = current.boardIds.filter((id) => available.has(id)); if (boardIds.length === current.boardIds.length) return current; setMissingBoardsNotice(true); return { ...current, boardIds }; });
  }, [boards.data, setDraft, setMissingBoardsNotice]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((node) => node.offsetParent !== null);
      const first = nodes[0], last = nodes.at(-1); if (!first || !last) return;
      if (event.shiftKey ? document.activeElement === first : document.activeElement === last) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);
  const filteredBoards = (boards.data ?? []).filter((board) => { const query = search.trim().toLowerCase(); return !query || board.name.toLowerCase().includes(query) || board.key.toLowerCase().includes(query); });
  const submit = (event: FormEvent) => { event.preventDefault(); const next: Record<string, string> = {}; const name = draft.name.trim(); const days = Number(draft.expiresInDays); if (!name) next.name = "Enter a token name."; if (draft.boardIds.length === 0) next.boards = "Select at least one board."; if (draft.scopes.length === 0) next.scopes = "Select at least one permission."; if (!Number.isInteger(days) || days < 1 || days > 90) next.expires = "Enter a whole number from 1 to 90."; setErrors(next); if (Object.keys(next).length || !boards.isSuccess) return; void onIssue({ name, boardIds: draft.boardIds, scopes: draft.scopes, expiresInDays: days }); };
  return createPortal(<div className="boards-dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="boards-dialog-panel mcp-server-dialog"><Button type="button" variant="ghost" size="icon-sm" className="boards-dialog-close" aria-label="Close dialog" disabled={issuing} onClick={onClose}><X aria-hidden="true" /></Button>{issued ? <><h2 id={titleId}>Token generated</h2><p>Credential {issued.credential.name} expires {visibleDate(issued.credential.expiresAt)}.</p><div className="mcp-server-secret-warning"><ShieldCheck aria-hidden="true" /><strong>Copy this token now. You won’t be able to view it again.</strong></div><CopyField label="MCP token" value={issued.token} actionLabel="Copy token" /><><div className="mcp-server-reveal-help"><p><strong>MCP endpoint</strong> {endpoint}</p><p><strong>Header</strong> <code>Authorization: Bearer &lt;your-token&gt;</code></p></div><ConfigCopyActions endpoint={endpoint} token={issued.token} /></><label className="mcp-server-ack"><input id="mcp-token-saved" type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />I saved this token</label><div className="boards-dialog-actions"><Button type="button" disabled={!saved} onClick={onClose}>Done</Button></div></> : <><h2 id={titleId}>Generate MCP token</h2><p>Choose exactly what this coding-tool credential can access.</p><form className="mcp-server-form" noValidate onSubmit={submit}><label>Token name<Input ref={firstRef} maxLength={80} disabled={issuing} value={draft.name} onChange={(event) => { setIssueError(null); setDraft((current) => ({ ...current, name: event.target.value })); }} /></label>{errors.name && <p role="alert">{errors.name}</p>}<fieldset aria-disabled={issuing || !boards.isSuccess}><legend>Boards <span>{draft.boardIds.length} selected</span></legend>{boards.isPending && <p role="status">Loading boards…</p>}{boards.isError && <LoadError message="Could not load boards." retry={() => void boards.refetch()} />}{boards.isSuccess && boards.data.length === 0 && <p>No boards available. Join or create a board before generating a token.</p>}{boards.isSuccess && boards.data.length > 0 && <><label className="mcp-server-search"><Search aria-hidden="true" /><Input type="search" placeholder="Search boards" disabled={issuing} value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="mcp-server-board-options">{filteredBoards.map((board) => <label key={board.id}><input type="checkbox" disabled={issuing} checked={draft.boardIds.includes(board.id)} onChange={() => setDraft((current) => ({ ...current, boardIds: current.boardIds.includes(board.id) ? current.boardIds.filter((id) => id !== board.id) : current.boardIds.length < 100 ? [...current.boardIds, board.id] : current.boardIds }))} /><span>{board.name}<small>{board.key}</small></span></label>)}</div></>}</fieldset>{missingBoardsNotice && <p role="status">Boards you can no longer access were removed from the selection.</p>}{errors.boards && <p role="alert">{errors.boards}</p>}<fieldset disabled={issuing}><legend>Permissions</legend><p>Coding workflows usually need all three. Permissions do not imply one another.</p>{scopeOptions.map((scope) => <label key={scope.value} className="mcp-server-checkbox"><input type="checkbox" checked={draft.scopes.includes(scope.value)} onChange={() => setDraft((current) => ({ ...current, scopes: current.scopes.includes(scope.value) ? current.scopes.filter((value) => value !== scope.value) : [...current.scopes, scope.value] }))} />{scope.label}</label>)}</fieldset>{errors.scopes && <p role="alert">{errors.scopes}</p>}<label>Expires in (days)<Input type="number" min={1} max={90} step={1} disabled={issuing} value={draft.expiresInDays} onChange={(event) => setDraft((current) => ({ ...current, expiresInDays: event.target.value }))} /></label>{errors.expires && <p role="alert">{errors.expires}</p>}{issueError && <p role="alert" className="boards-dialog-error">{issueError}</p>}<div className="boards-dialog-actions"><Button type="button" variant="outline" disabled={issuing} onClick={onClose}>Cancel</Button><Button type="submit" disabled={issuing || !boards.isSuccess || boards.data.length === 0}>{issuing ? "Generating…" : "Generate token"}</Button></div></form></>}</div></div>, document.body);
}
