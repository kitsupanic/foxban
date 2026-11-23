import { queryOptions } from "@tanstack/react-query";
import type { BoardColor, BoardIcon } from "@foxban/shared";
import type { BoardAccessMode } from "./workspaces";

export type Board = {
  id: string;
  name: string;
  key: string;
  ownerId: string;
  icon: BoardIcon;
  color: BoardColor;
  workspaceId: string;
  workspaceName: string;
  accessMode: BoardAccessMode;
  accessVersion: number;
  capabilities: {
    canManageBoard: boolean;
  };
  /** The viewer is on this Private board only as an admin of its workspace (not added to it). */
  viaWorkspaceAdmin: boolean;
};

async function loadBoards(workspaceId?: string): Promise<Board[]> {
  const suffix = workspaceId === undefined ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`;
  const response = await fetch(`/boards${suffix}`);
  if (!response.ok) throw new Error(`GET /boards failed with ${response.status}`);
  const body = (await response.json()) as { boards: Board[] } | Board[];
  return Array.isArray(body) ? body : body.boards;
}

/** Boards in exactly one workspace. Never use this key for account-wide consumers. */
export const boardsQuery = (workspaceId: string) => queryOptions({
  queryKey: ["boards", workspaceId] as const,
  queryFn: () => loadBoards(workspaceId),
});

/** Every board currently authorized to this account (MCP and callback resolution). */
export const allBoardsQuery = queryOptions({
  queryKey: ["boards", "all"] as const,
  queryFn: () => loadBoards(),
});

/** Creates a board in the named workspace; shared by the workspace page and Home. */
export async function createBoardRequest({ targetWorkspaceId, name, key, icon, color, accessMode }: { targetWorkspaceId: string; name: string; key: string; icon: BoardIcon; color: BoardColor; accessMode: BoardAccessMode }): Promise<Board> {
  const response = await fetch("/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, key, icon, color, workspaceId: targetWorkspaceId, accessMode }) });
  if (!response.ok) {
    if (response.status === 409) throw new Error("That board key is already in use.");
    const rawJson: unknown = await response.json().catch(() => null);
    let detail = "Could not create the board.";
    if (rawJson && typeof rawJson === "object") {
      if ("issues" in rawJson && Array.isArray(rawJson.issues) && rawJson.issues.length > 0) {
        const first = rawJson.issues[0];
        if (first && typeof first === "object" && "message" in first && typeof first.message === "string") detail = first.message;
      } else if ("error" in rawJson && typeof rawJson.error === "string") {
        detail = rawJson.error;
      } else if ("error" in rawJson && rawJson.error && typeof rawJson.error === "object" && "issues" in rawJson.error && Array.isArray(rawJson.error.issues) && rawJson.error.issues.length > 0) {
        const first = rawJson.error.issues[0];
        if (first && typeof first === "object" && "message" in first && typeof first.message === "string") detail = first.message;
      }
    }
    throw new Error(detail);
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") {
    throw new Error("The server returned an invalid board.");
  }
  return result as Board;
}
