import { queryOptions, type QueryClient, type QueryKey } from "@tanstack/react-query";

export type WorkspaceRole = "admin" | "member";
export type BoardAccessMode = "workspace" | "restricted";
/** What people read for each stored access mode ("restricted" is stored, "Private" is shown). */
export const BOARD_ACCESS: Record<BoardAccessMode, { label: string; who: string }> = {
  workspace: { label: "Workspace", who: "every workspace member can open it" },
  restricted: { label: "Private", who: "only board members and workspace admins can open it" },
};
export const boardAccessChoice = (mode: BoardAccessMode) => `${BOARD_ACCESS[mode].label}: ${BOARD_ACCESS[mode].who}`;
export type WorkspaceAccess = "member" | "guest" | "operator";

export type WorkspaceSummary = {
  id: string;
  name: string;
  defaultBoardAccess: BoardAccessMode;
  role: WorkspaceRole | null;
  access: WorkspaceAccess;
  boardCount: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceMember = {
  userId: string;
  email: string;
  name: string;
  avatarVersion: string | null;
  role: WorkspaceRole;
};

/**
 * One row of `GET /workspaces/:id/membership-candidates?email=`: public identity only,
 * and never someone the workspace already has a membership for.
 */
export type WorkspaceMemberCandidate = {
  id: string;
  email: string;
  name: string;
  githubLogin: string | null;
  avatarVersion: string | null;
};

export type WorkspaceInvite = {
  id: string;
  role: "member" | "admin";
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${init?.method ?? "GET"} ${url} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const workspacesQuery = queryOptions({
  queryKey: ["workspaces"] as const,
  queryFn: async () => (await json<{ workspaces: WorkspaceSummary[] }>("/workspaces")).workspaces,
});

/** Every workspace in the instance: Admin only, the server refuses anyone else with a 403. */
export const allWorkspacesQuery = queryOptions({
  queryKey: ["workspaces", "all"] as const,
  // `createdBy` tells apart workspaces that share a name, such as everyone's "Personal".
  queryFn: async () => (await json<{ workspaces: (WorkspaceSummary & { createdBy: string | null })[] }>("/workspaces/all")).workspaces,
});

export const workspaceQuery = (id: string) => queryOptions({
  queryKey: ["workspace", id] as const,
  queryFn: async () => (await json<{ workspace: WorkspaceSummary }>(`/workspaces/${encodeURIComponent(id)}`)).workspace,
});

export const workspaceMembersQuery = (id: string) => queryOptions({
  queryKey: ["workspace-members", id] as const,
  queryFn: async () => (await json<{ members: WorkspaceMember[] }>(`/workspaces/${encodeURIComponent(id)}/members`)).members,
});

export const workspaceInvitesQuery = (id: string) => queryOptions({
  queryKey: ["workspace-invites", id] as const,
  queryFn: async () => (await json<{ invites: WorkspaceInvite[] }>(`/workspaces/${encodeURIComponent(id)}/invites`)).invites,
});

/** The account with exactly this address, if any and not yet a member (ADR 0072); the server lists nobody. */
export const workspaceMembershipCandidatesQuery = (id: string, email: string) => queryOptions({
  queryKey: ["workspace-membership-candidates", id, email] as const,
  queryFn: async () =>
    (await json<{ candidates: WorkspaceMemberCandidate[] }>(`/workspaces/${encodeURIComponent(id)}/membership-candidates?email=${encodeURIComponent(email)}`)).candidates,
});

export async function workspaceRequest<T>(url: string, method: string, body?: unknown): Promise<T> {
  return json<T>(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Re-reads the context a `workspace.invalidated` hint names. The hint carries
 * board ids while the board route is keyed by board key, and reads started under
 * the previous access are cancelled first so a late response cannot reinstate
 * what the change removed.
 */
export function invalidateWorkspaceContext(queryClient: QueryClient, workspaceIds: string[], boardIds: string[]): void {
  const boardScopedKeys: QueryKey[] = [];
  for (const id of boardIds) {
    boardScopedKeys.push(["board-meta", id], ["board-members", id], ["board-membership-candidates", id]);
  }
  for (const key of boardScopedKeys) void queryClient.cancelQueries({ queryKey: key });
  void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  for (const id of workspaceIds) {
    void queryClient.invalidateQueries({ queryKey: ["workspace", id] });
    void queryClient.invalidateQueries({ queryKey: ["workspace-members", id] });
    void queryClient.invalidateQueries({ queryKey: ["workspace-invites", id] });
    void queryClient.invalidateQueries({ queryKey: ["boards", id] });
  }
  for (const key of boardScopedKeys) void queryClient.invalidateQueries({ queryKey: key });
  // The routed board key is not derivable from an id, and only the mounted board
  // route is active, so the prefix refresh reaches exactly the visible board.
  void queryClient.invalidateQueries({ queryKey: ["board-meta-by-key"] });
  void queryClient.invalidateQueries({ queryKey: ["boards", "all"] });
}
