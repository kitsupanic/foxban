import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, PanelLeft } from "lucide-react";
import { meQuery } from "../lib/auth";
import { allBoardsQuery, boardsQuery } from "../lib/boards";
import { accessMarker, type AccessMarker } from "../lib/access-marker";
import { workspacesQuery, type WorkspaceSummary } from "../lib/workspaces";
import { AppHeader } from "./AppHeader";
import { CreateWorkspaceDialog } from "./WorkspacePages";
import { Button } from "./ui/button";
import { NavigationHint } from "./NavigationHint";

export interface AppShellProps {
  breadcrumb: "Home" | "Boards" | "Members" | "Settings" | "Profile" | "MCP server" | "Account invites" | "GitHub" | "All workspaces";
  workspace?: WorkspaceSummary;
  board?: { id: string; name: string; workspaceId: string; workspaceName: string };
  overlayOpen?: boolean;
  overlays?: ReactNode;
  children: ReactNode;
}

export function AppShell({ breadcrumb, workspace, board, overlayOpen = false, overlays, children }: AppShellProps) {
  const [navigationExpanded, setNavigationExpanded] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  // The sidebar expands the workspace the route names or the open board belongs
  // to. Home and Account pages name none, and nothing is remembered between visits.
  const expandedWorkspaceId = workspace?.id ?? board?.workspaceId;
  const boards = useQuery({ ...boardsQuery(expandedWorkspaceId ?? ""), enabled: expandedWorkspaceId !== undefined });
  const boardVariant = board !== undefined;
  const marker = useAccessMarker(workspace, board);
  return <div className={`app-shell-page${boardVariant ? " board-app-shell-page" : ""}`}><div className={`app-shell${boardVariant ? " board-app-shell" : ""}`}><div className="boards-shell" data-navigation={boardVariant ? (navigationExpanded ? "expanded" : "rail") : undefined} inert={overlayOpen || creatingWorkspace}><AppHeader expandedWorkspaceId={expandedWorkspaceId} boardCount={boards.isSuccess ? boards.data.length : null} compact={boardVariant && !navigationExpanded} onCreateWorkspace={() => setCreatingWorkspace(true)} /><main className="boards-main"><div className={`boards-breadcrumb${boardVariant ? " board-workspace-breadcrumb" : ""}`}>{boardVariant && <NavigationHint label={navigationExpanded ? "Collapse navigation" : "Expand navigation"}>{(hint) => <Button {...hint} type="button" variant="ghost" size="icon-sm" className="board-navigation-toggle" aria-label={navigationExpanded ? "Collapse navigation" : "Expand navigation"} aria-expanded={navigationExpanded} onClick={() => setNavigationExpanded((value) => !value)}><PanelLeft /></Button>}</NavigationHint>}{(workspace ?? board) && <><span>{workspace?.name ?? board?.workspaceName}</span>{marker && <b className="board-access-label" title={MARKER_TITLE[marker]}>{marker}</b>}<ChevronRight /></>}{boardVariant ? <><Link to="/w/$workspaceId" params={{ workspaceId: board.workspaceId }}>Boards</Link><ChevronRight /><span>{board.name}</span></> : <span>{breadcrumb}</span>}</div>{children}</main></div>{overlays}{creatingWorkspace && <CreateWorkspaceDialog onClose={() => setCreatingWorkspace(false)} />}</div></div>;
}

const MARKER_TITLE = { Operator: "Operator access: you are an instance Admin, and this is open to you only through that power", Guest: "Guest: you were added to a board here, you are not a member of this workspace" };

/** The marker for the page's workspace or board, from the lists the viewer's own session already holds. */
function useAccessMarker(workspace: WorkspaceSummary | undefined, board: AppShellProps["board"]): AccessMarker | null {
  const { data: user } = useQuery(meQuery);
  const workspaces = useQuery({ ...workspacesQuery, enabled: board !== undefined });
  const mine = useQuery({ ...allBoardsQuery, enabled: board !== undefined });
  return accessMarker({ workspace, board, workspaces: workspaces.data, heldBoards: mine.data, isAdmin: user?.isAdmin === true });
}
