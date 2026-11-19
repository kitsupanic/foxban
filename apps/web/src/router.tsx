import { useEffect, useRef } from "react";
import { Link, Outlet, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BoardListPage } from "./components/BoardListPage";
import { HomePage } from "./components/HomePage";
import { ProfilePage } from "./components/ProfilePage";
import { AccountGitHubPage } from "./components/AccountGitHubPage";
import { AccountInvitesPage } from "./components/AccountInvitesPage";
import { AllWorkspacesPage } from "./components/AllWorkspacesPage";
import { McpServerPage } from "./components/McpServerPage";
import { BoardView } from "./components/BoardView";
import { LoginPage, type GitHubLoginProblem } from "./components/LoginPage";
import { SignupPage } from "./components/SignupPage";
import { JoinWorkspacePage, WorkspaceMembersPage, WorkspaceSettingsPage } from "./components/WorkspacePages";
import { meQuery } from "./lib/auth";
import { AccessChangePendingError, isAccessChangePending } from "./lib/access-attempt";
import { clearBoardAccessCaches } from "./lib/board-cache";
import { usePresenceSocket } from "./lib/presence";
import { queryClient } from "./lib/query-client";
import { type Board } from "./lib/boards";
import { workspaceQuery } from "./lib/workspaces";
import { buttonVariants, Button } from "./components/ui/button";

function workspaceContinuation(): { workspaceId: string; token: string } | null {
  if (typeof location === "undefined") return null;
  const raw = new URLSearchParams(location.hash.slice(1)).get("workspaceInvite");
  if (!raw) return null;
  const split = raw.indexOf(".");
  if (split < 1 || split === raw.length - 1) return null;
  return { workspaceId: raw.slice(0, split), token: raw.slice(split + 1) };
}

const rootRoute = createRootRoute({ beforeLoad: async ({ location }) => { if (location.pathname === "/login" || location.pathname === "/signup" || location.pathname.startsWith("/join-workspace/")) return; const user = await queryClient.query(meQuery); if (!user) throw redirect({ to: "/login" }); }, component: Root });
function Root() { const { data: user } = useQuery(meQuery); usePresenceSocket(user); return <Outlet />; }

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

const workspaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/w/$workspaceId", component: WorkspaceBoardsRoute });
// `key` isolates workspace-local view state (open dialogs and their drafts,
// banners, edited settings) so switching workspaces cannot carry them across.
function WorkspaceBoardsRoute() { const { workspaceId } = workspaceRoute.useParams(); return <BoardListPage key={workspaceId} workspaceId={workspaceId} />; }
const membersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/w/$workspaceId/members", beforeLoad: async ({ params }) => { const workspace = await queryClient.ensureQueryData(workspaceQuery(params.workspaceId)); if (workspace.access !== "member") throw redirect({ to: "/w/$workspaceId", params }); }, component: () => { const { workspaceId } = membersRoute.useParams(); return <WorkspaceMembersPage key={workspaceId} workspaceId={workspaceId} />; } });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/w/$workspaceId/settings", beforeLoad: async ({ params }) => { const workspace = await queryClient.ensureQueryData(workspaceQuery(params.workspaceId)); if (workspace.role !== "admin") throw redirect({ to: "/w/$workspaceId", params }); }, component: () => { const { workspaceId } = settingsRoute.useParams(); return <WorkspaceSettingsPage key={workspaceId} workspaceId={workspaceId} />; } });
const joinRoute = createRoute({ getParentRoute: () => rootRoute, path: "/join-workspace/$workspaceId", component: () => { const { workspaceId } = joinRoute.useParams(); return <JoinWorkspacePage key={workspaceId} workspaceId={workspaceId} />; } });
const profileRoute = createRoute({ getParentRoute: () => rootRoute, path: "/profile", validateSearch: (search: Record<string, unknown>): { github?: "error" | "taken" | "reauthed" | "reauth-error" } => search.github === "error" || search.github === "taken" || search.github === "reauthed" || search.github === "reauth-error" ? { github: search.github } : {}, component: ProfilePage });
const mcpServerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/mcp-server", component: McpServerPage });
const accountInvitesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/account-invites", beforeLoad: async () => { const user = await queryClient.query(meQuery); if (!user?.isAdmin) throw redirect({ to: "/" }); }, component: AccountInvitesPage });
const allWorkspacesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/all-workspaces", beforeLoad: async () => { const user = await queryClient.query(meQuery); if (!user?.isAdmin) throw redirect({ to: "/" }); }, component: AllWorkspacesPage });
const accountGitHubRoute = createRoute({ getParentRoute: () => rootRoute, path: "/account-github", validateSearch: (search: Record<string, unknown>): { githubApp?: "created" | "error" } => search.githubApp === "created" || search.githubApp === "error" ? { githubApp: search.githubApp } : {}, beforeLoad: async () => { const user = await queryClient.query(meQuery); if (!user?.isAdmin) throw redirect({ to: "/" }); }, component: AccountGitHubPage });
const authGuard = async () => { const user = await queryClient.query(meQuery); if (user) { const continuation = workspaceContinuation(); if (continuation) throw redirect({ to: "/join-workspace/$workspaceId", params: { workspaceId: continuation.workspaceId }, hash: `invite=${continuation.token}` }); throw redirect({ to: "/" }); } };
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", validateSearch: (search: Record<string, unknown>): { github?: GitHubLoginProblem } => search.github === "error" || search.github === "cancelled" || search.github === "unlinked" || search.github === "exists" || search.github === "unavailable" ? { github: search.github } : {}, beforeLoad: authGuard, component: LoginRoute });
function LoginRoute() { const continuation = workspaceContinuation(); return <LoginPage workspaceContinuation={continuation} githubProblem={loginRoute.useSearch().github} />; }
const signupRoute = createRoute({ getParentRoute: () => rootRoute, path: "/signup", validateSearch: (search: Record<string, unknown>): { invite?: string } => typeof search.invite === "string" && search.invite ? { invite: search.invite } : {}, beforeLoad: authGuard, component: SignupRoute });
function SignupRoute() { const continuation = workspaceContinuation(); return <SignupPage invite={signupRoute.useSearch().invite ?? null} workspaceContinuation={continuation} />; }

const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/board/$boardKey", validateSearch: (search: Record<string, unknown>): { card?: string; view?: "full"; attachment?: string; labels?: string; assignees?: string; q?: string } => { const out: { card?: string; view?: "full"; attachment?: string; labels?: string; assignees?: string; q?: string } = {}; if (typeof search.card === "string" && search.card) out.card = search.card; if (out.card && search.view === "full") out.view = "full"; if (out.card && typeof search.attachment === "string" && search.attachment) out.attachment = search.attachment; for (const key of ["labels", "assignees", "q"] as const) if (typeof search[key] === "string" && search[key]) out[key] = search[key]; return out; }, component: BoardRoute });
function BoardRoute() { const { boardKey } = boardRoute.useParams(); return <BoardRouteShell key={boardKey} boardKey={boardKey} />; }
function BoardRouteShell({ boardKey }: { boardKey: string }) {
  const queryClient = useQueryClient();
  const meta = useQuery({
    queryKey: ["board-meta-by-key", boardKey],
    queryFn: async (): Promise<Board | null> => {
      const response = await fetch(`/boards/by-key/${encodeURIComponent(boardKey)}`);
      if (response.status === 403 || response.status === 404) return null;
      if (response.status === 503) throw new AccessChangePendingError();
      if (!response.ok) throw new Error("board_load_failed");
      return response.json() as Promise<Board>;
    },
    // A pending access change is a wait for the server, not a failed read: it is
    // polled until the operation is released instead of giving up on a budget.
    retry: (_count, error) => isAccessChangePending(error),
    retryDelay: 2_000,
  });
  const accessChangePending = isAccessChangePending(meta.failureReason) || isAccessChangePending(meta.error);
  // The denial state has no board identity left in the response, so the last
  // readable board is remembered to key the removal of its private caches.
  const identityRef = useRef<{ boardId: string; boardKey: string } | null>(null);
  useEffect(() => {
    if (meta.data) identityRef.current = { boardId: meta.data.id, boardKey: meta.data.key };
  }, [meta.data]);
  const denied = meta.data === null;
  useEffect(() => {
    if (!denied) return;
    const identity = identityRef.current;
    identityRef.current = null;
    clearBoardAccessCaches(queryClient, identity ?? { boardKey });
  }, [denied, boardKey, queryClient]);
  // A pending read is not a denial: a board that already loaded stays mounted
  // with its drafts and hides its stale content until the server releases it,
  // because replacing the route here is what destroyed an unsent card draft.
  // Only a confirmed denial (or a board that never loaded) replaces the route.
  if (!meta.data) {
    if (accessChangePending)
      return <div className="route-state"><p role="status">Board access is changing…</p><p>Waiting for the change to finish before this board can load.</p><Button onClick={() => void meta.refetch()}>Check again</Button></div>;
    if (meta.isPending) return <div className="route-state">Loading board…</div>;
    if (denied) return <div className="route-state"><p>You no longer have access to this board.</p><Link to="/" className={buttonVariants({ variant: "link" })}>Back to Home</Link></div>;
    return <div className="route-state"><p role="alert">Could not load board.</p><Button onClick={() => void meta.refetch()}>Retry</Button></div>;
  }
  return <BoardView boardId={meta.data.id} boardMeta={meta.data} accessChangePending={accessChangePending} accessCheckedAt={meta.dataUpdatedAt} />;
}

export const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, workspaceRoute, membersRoute, settingsRoute, joinRoute, profileRoute, mcpServerRoute, accountInvitesRoute, accountGitHubRoute, allWorkspacesRoute, loginRoute, signupRoute, boardRoute]) });
declare module "@tanstack/react-router" { interface Register { router: typeof router; } }
