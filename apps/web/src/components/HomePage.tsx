import { useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { allBoardsQuery, createBoardRequest, type Board } from "../lib/boards";
import { restoreFocusSoon } from "../lib/focus";
import { workspacesQuery, type WorkspaceSummary } from "../lib/workspaces";
import { AppShell } from "./AppShell";
import { BoardCreateDialog } from "./BoardCreateDialog";
import { BoardRow } from "./BoardListPage";
import { CreateWorkspaceDialog } from "./WorkspacePages";
import { Button, buttonVariants } from "./ui/button";

/**
 * `/`: every board the viewer can open, grouped by the workspace they belong to,
 * built from the workspace list and the board list. The server returns only what
 * the viewer holds as a member or Guest, an instance Admin included (other
 * people's workspaces are on the All workspaces page), and boards reached by
 * explicit grant in a workspace the viewer is not a member of sit together under
 * one "Guest" heading.
 */
export function HomePage() {
  const queryClient = useQueryClient();
  const workspaces = useQuery(workspacesQuery);
  const boards = useQuery(allBoardsQuery);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  // The board is created in the workspace whose button opened the dialog.
  const [creatingBoard, setCreatingBoard] = useState<WorkspaceSummary | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const newBoardTrigger = useRef<HTMLButtonElement | null>(null);
  const createBoard = useMutation({
    mutationFn: createBoardRequest,
    onSuccess: async (created) => {
      setCreatingBoard(null);
      setSuccess("Board created.");
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["boards", created.workspaceId] }), queryClient.invalidateQueries({ queryKey: ["boards", "all"] }), queryClient.invalidateQueries({ queryKey: ["workspaces"] })]);
      restoreFocusSoon(newBoardTrigger.current);
    },
    onError: () => setSuccess(null),
  });
  const closeCreateBoard = () => {
    if (createBoard.isPending) return;
    setCreatingBoard(null);
    createBoard.reset();
    restoreFocusSoon(newBoardTrigger.current);
  };

  const members = workspaces.data?.filter((item) => item.access === "member") ?? [];
  const guestWorkspaceIds = new Set(workspaces.data?.filter((item) => item.access === "guest").map((item) => item.id));
  const guestBoards = boards.data?.filter((board) => guestWorkspaceIds.has(board.workspaceId)) ?? [];
  const loaded = workspaces.isSuccess && boards.isSuccess;

  return (
    <AppShell
      breadcrumb="Home"
      overlayOpen={creatingBoard !== null || creatingWorkspace}
      overlays={<>
        {creatingBoard && <BoardCreateDialog workspaceName={creatingBoard.name} defaultAccessMode={creatingBoard.defaultBoardAccess} isPending={createBoard.isPending} error={createBoard.error?.message ?? null} onCancel={closeCreateBoard} onCreate={(name, key, icon, color, accessMode) => { if (!createBoard.isPending) createBoard.mutate({ targetWorkspaceId: creatingBoard.id, name, key, icon, color, accessMode }); }} />}
        {creatingWorkspace && <CreateWorkspaceDialog onClose={() => setCreatingWorkspace(false)} />}
      </>}
    >
      <div className="boards-heading">
        <div><h1>Home</h1><p>Your boards, grouped by workspace.</p></div>
        <Button type="button" onClick={() => setCreatingWorkspace(true)}><Plus aria-hidden="true" />Create workspace</Button>
      </div>
      {success && <p role="status" className="boards-page-success">{success}</p>}
      {workspaces.isError || boards.isError ? (
        <div className="boards-list-state"><p role="alert">Could not load your boards.</p><Button type="button" variant="outline" size="xs" onClick={() => { void workspaces.refetch(); void boards.refetch(); }}>Try again</Button></div>
      ) : !loaded ? (
        <p role="status" className="boards-list-state">loading boards…</p>
      ) : members.length === 0 && guestBoards.length === 0 ? (
        <div className="boards-empty"><strong>No workspaces yet.</strong><p>Use Create workspace to get started.</p></div>
      ) : <>
        {members.map((workspace) => <HomeGroup key={workspace.id} workspace={workspace} boards={boards.data.filter((board) => board.workspaceId === workspace.id)} onNewBoard={(trigger) => { newBoardTrigger.current = trigger; setSuccess(null); createBoard.reset(); setCreatingBoard(workspace); }} />)}
        {guestBoards.length > 0 && <HomeGroup boards={guestBoards} />}
      </>}
    </AppShell>
  );
}

/** One workspace's boards, or the Guest group when no workspace is given. */
function HomeGroup({ workspace, boards, onNewBoard }: { workspace?: WorkspaceSummary; boards: Board[]; onNewBoard?: (trigger: HTMLButtonElement) => void }) {
  const headingId = useId();
  return <section className="home-group" aria-labelledby={headingId}>
    <div className="boards-section-heading">
      <h2 id={headingId}>{workspace ? <Link to="/w/$workspaceId" params={{ workspaceId: workspace.id }} className={buttonVariants({ variant: "link", className: "boards-board-name" })}>{workspace.name}</Link> : "Guest"}</h2>
      <span>{boards.length}</span>
      {workspace && onNewBoard && <Button type="button" size="sm" className="ml-auto" onClick={(event) => onNewBoard(event.currentTarget)}><Plus aria-hidden="true" />New board</Button>}
    </div>
    {boards.length > 0
      ? <ul className="boards-list" aria-label={workspace ? `Boards in ${workspace.name}` : "Boards shared with you"}>{boards.map((board) => <BoardRow key={board.id} board={board} workspaceName={workspace ? undefined : board.workspaceName} />)}</ul>
      : <div className="boards-empty"><strong>No boards yet.</strong><p>Use New board to create the first project.</p></div>}
  </section>;
}
