import type { WorkspaceSummary } from "./workspaces";

export type AccessMarker = "Operator" | "Guest";

type HeldWorkspace = Pick<WorkspaceSummary, "id" | "access">;

/**
 * How the viewer holds the workspace or board the page names, when it is not as a
 * member. The default workspace and board lists carry only what the viewer has as a
 * member, Guest or workspace admin, so a board missing from them is open to an Admin
 * only through instance-Admin power: an Operator, whether or not they belong to the
 * board's workspace. `null` while either list is still loading.
 */
export function accessMarker({ workspace, board, workspaces, heldBoards, isAdmin }: {
  workspace?: Pick<WorkspaceSummary, "access">;
  board?: { id: string; workspaceId: string };
  workspaces?: HeldWorkspace[];
  heldBoards?: Array<{ id: string }>;
  isAdmin: boolean;
}): AccessMarker | null {
  if (workspace) return workspace.access === "operator" ? "Operator" : workspace.access === "guest" ? "Guest" : null;
  if (!board || !workspaces || !heldBoards) return null;
  if (!heldBoards.some((item) => item.id === board.id)) return isAdmin ? "Operator" : null;
  return workspaces.some((item) => item.id === board.workspaceId && item.access === "member") ? null : "Guest";
}
