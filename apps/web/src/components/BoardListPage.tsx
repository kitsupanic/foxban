import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BoardColor, BoardIcon } from "@foxban/shared";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import {
  AccessRequestError,
  accessScope,
  accessSubjectPrefix,
  clearAccessAttempt,
  requestAccessChange,
  sendAccessChange,
  useAccessAttemptOutcomes,
  useAccessAttempts,
} from "../lib/access-attempt";
import { clearBoardAccessCaches } from "../lib/board-cache";
import { meQuery } from "../lib/auth";
import { boardsQuery, createBoardRequest, type Board } from "../lib/boards";
import { BOARD_ACCESS, boardAccessChoice, workspaceQuery, type BoardAccessMode } from "../lib/workspaces";
import { restoreFocusSoon } from "../lib/focus";
import { AppShell } from "./AppShell";
import { BoardAppearanceIcon } from "./BoardAppearanceFields";
import { BoardActionsMenu } from "./BoardActionsMenu";
import { BoardAddMemberDialog } from "./BoardAddMemberDialog";
import { BoardCreateDialog } from "./BoardCreateDialog";
import { BoardMoveDialog } from "./BoardMoveDialog";
import { BoardDeleteDialog } from "./BoardDeleteDialog";
import { BoardEditDialog } from "./BoardEditDialog";
import { Button, buttonVariants } from "./ui/button";

export function BoardListPage({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const [success, setSuccess] = useState<string | null>(null);
  // The board is created in the workspace the dialog was opened from: a draft
  // that outlives a context change must not target the new context.
  const [creatingBoard, setCreatingBoard] = useState<{
    workspaceId: string;
    defaultAccessMode: BoardAccessMode | undefined;
  } | null>(null);
  const [deletingBoard, setDeletingBoard] = useState<Board | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [movingBoard, setMovingBoard] = useState<Board | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [addingMemberBoard, setAddingMemberBoard] = useState<Board | null>(null);
  const boardActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newBoardButtonRef = useRef<HTMLButtonElement | null>(null);
  const [pendingFocusBoardId, setPendingFocusBoardId] = useState<string | null>(null);
  const { data: user } = useQuery(meQuery);
  const workspace = useQuery(workspaceQuery(workspaceId));
  const boards = useQuery(boardsQuery(workspaceId));
  const createBoard = useMutation({
    mutationFn: createBoardRequest,
    onSuccess: async (created) => {
      setCreatingBoard(null);
      setSuccess("Board created.");
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["boards", created.workspaceId] }), queryClient.invalidateQueries({ queryKey: ["boards", "all"] }), queryClient.invalidateQueries({ queryKey: ["workspaces"] })]);
      restoreFocusSoon(newBoardButtonRef.current);
    },
    onError: () => setSuccess(null),
  });

  /** Drops everything the client holds about a board the server has deleted. */
  const forgetDeletedBoard = (boardId: string, boardKey: string | undefined) => {
    queryClient.setQueryData<Board[]>(["boards", workspaceId], (old) =>
      old ? old.filter((b) => b.id !== boardId) : [],
    );
    clearBoardAccessCaches(queryClient, { boardId, boardKey });
    setDeletingBoard(null);
    setDeleteError(null);
    boardActionsTriggerRef.current = null;
    setSuccess("Board deleted.");
    restoreFocusSoon(newBoardButtonRef.current);
    void Promise.all([queryClient.invalidateQueries({ queryKey: ["boards", workspaceId] }), queryClient.invalidateQueries({ queryKey: ["boards", "all"] }), queryClient.invalidateQueries({ queryKey: ["workspaces"] })]);
  };

  const deleteBoard = useMutation({
    mutationFn: (board: Board) =>
      requestAccessChange(
        // Board inside workspace: a page polls the workspace segment of the scope.
        accessScope("board-delete", board.workspaceId, board.id),
        "board-delete",
        { boardId: board.id, boardKey: board.key, workspaceId: board.workspaceId, name: board.name },
        (attempt) =>
          sendAccessChange(`/boards/${encodeURIComponent(board.id)}?operationId=${encodeURIComponent(attempt.operationId)}`, "DELETE"),
      ),
    onError: (error) => {
      // A refusal is worth naming; a server or transport failure leaves the
      // outcome unknown and is reported as a retryable failure.
      if (error instanceof AccessRequestError && error.status === 403) setDeleteError("You no longer have permission to delete this board.");
      else if (error instanceof AccessRequestError && error.status === 404) setDeleteError("That board no longer exists.");
      else setDeleteError("Could not delete the board. Try again.");
    },
  });
  // Deletion is journalled and may answer 202: the row is only dropped once the
  // server reports the committed outcome. The scope is this workspace's boards,
  // so a page for another workspace never installs the outcome of this one.
  const deletePrefix = accessSubjectPrefix("board-delete", workspaceId);
  const pendingDeletes = useAccessAttempts(deletePrefix);
  const pendingDeleteIds = new Set(pendingDeletes.filter((attempt) => attempt.state === "pending").map((attempt) => attempt.context.boardId ?? ""));
  const deleteTracking = useAccessAttemptOutcomes(deletePrefix, (attempt) => {
    clearAccessAttempt(attempt.scopeKey, attempt.operationId);
    if (attempt.state === "aborted") {
      setDeletingBoard(null);
      setDeleteError("The board was not deleted.");
      return;
    }
    forgetDeletedBoard(attempt.context.boardId ?? "", attempt.context.boardKey);
  });
  const updateBoard = useMutation({
    mutationFn: async ({
      id,
      name: nextName,
      key: nextKey,
      icon,
      color,
    }: {
      id: string;
      name: string;
      key: string;
      icon: BoardIcon;
      color: BoardColor;
    }) => {
      const response = await api.boards[":id"].$patch({
        param: { id },
        json: { name: nextName, key: nextKey, icon, color },
      });
      if (!response.ok) {
        if (response.status === 409) throw new Error("That board key is already in use.");
        const rawJson: unknown = await response.json().catch(() => null);
        let detail = "Could not update the board. Try again.";
        if (rawJson && typeof rawJson === "object") {
          if ("issues" in rawJson && Array.isArray(rawJson.issues) && rawJson.issues.length > 0) {
            const first = rawJson.issues[0];
            if (first && typeof first === "object" && "message" in first && typeof first.message === "string") {
              detail = first.message;
            }
          } else if (
            "error" in rawJson &&
            rawJson.error &&
            typeof rawJson.error === "object" &&
            "issues" in rawJson.error &&
            Array.isArray(rawJson.error.issues) &&
            rawJson.error.issues.length > 0
          ) {
            const first = rawJson.error.issues[0];
            if (first && typeof first === "object" && "message" in first && typeof first.message === "string") {
              detail = first.message;
            }
          }
        }
        throw new Error(detail);
      }
      return (await response.json()) as Board;
    },
    onSuccess: async (updatedBoard) => {
      queryClient.setQueryData<Board[]>(["boards", updatedBoard.workspaceId], (old) =>
        old ? old.map((board) => (board.id === updatedBoard.id ? updatedBoard : board)) : [updatedBoard],
      );
      queryClient.setQueryData<Board>(["board-meta", updatedBoard.id], updatedBoard);
      const boardId = updatedBoard.id;
      setEditingBoard(null);
      setEditError(null);
      boardActionsTriggerRef.current = null;
      setPendingFocusBoardId(boardId);
      setSuccess("Board updated.");
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["boards", updatedBoard.workspaceId] }), queryClient.invalidateQueries({ queryKey: ["boards", "all"] })]);
    },
    onError: (err) => {
      setEditError(err.message || "Could not update the board. Try again.");
    },
  });

  const handleRequestEdit = (board: Board, trigger: HTMLButtonElement) => {
    if (deletingBoard) return;
    boardActionsTriggerRef.current = trigger;
    setEditError(null);
    setEditingBoard(board);
  };

  const handleCancelEdit = () => {
    if (updateBoard.isPending) return;
    const trigger = boardActionsTriggerRef.current;
    setEditingBoard(null);
    setEditError(null);
    boardActionsTriggerRef.current = null;
    restoreFocusSoon(trigger);
  };

  const handleSaveEdit = (nextName: string, nextKey: string, icon: BoardIcon, color: BoardColor) => {
    if (!editingBoard || updateBoard.isPending) return;
    updateBoard.mutate({ id: editingBoard.id, name: nextName, key: nextKey, icon, color });
  };

  useEffect(() => {
    if (!pendingFocusBoardId || editingBoard || addingMemberBoard || deletingBoard || creatingBoard) return;
    const selector = `[data-board-actions-id="${CSS.escape(pendingFocusBoardId)}"]`;
    const liveTrigger = document.querySelector<HTMLButtonElement>(selector);
    if (liveTrigger && document.activeElement !== liveTrigger) {
      liveTrigger.focus();
      if (document.activeElement === liveTrigger) setPendingFocusBoardId(null);
    }
  }, [pendingFocusBoardId, editingBoard, addingMemberBoard, deletingBoard, creatingBoard, boards.data]);

  const handleRequestAddMember = (board: Board, trigger: HTMLButtonElement) => {
    if (deletingBoard || editingBoard) return;
    boardActionsTriggerRef.current = trigger;
    setAddingMemberBoard(board);
  };

  const handleCloseAddMember = () => {
    const trigger = boardActionsTriggerRef.current;
    setAddingMemberBoard(null);
    boardActionsTriggerRef.current = null;
    restoreFocusSoon(trigger);
  };

  const handleAddMemberSuccess = (candidateName: string) => {
    const boardId = addingMemberBoard?.id ?? null;
    const trigger = boardActionsTriggerRef.current;
    setAddingMemberBoard(null);
    boardActionsTriggerRef.current = null;
    if (boardId) {
      setPendingFocusBoardId(boardId);
    }
    setSuccess(`Added ${candidateName} as member.`);
    restoreFocusSoon(trigger);
  };

  const handleRequestDelete = (board: Board, trigger: HTMLButtonElement) => {
    if (editingBoard || addingMemberBoard) return;
    boardActionsTriggerRef.current = trigger;
    setDeleteError(null);
    setDeletingBoard(board);
  };

  const handleCancelDelete = () => {
    if (deleteBoard.isPending) return;
    const trigger = boardActionsTriggerRef.current;
    setDeletingBoard(null);
    setDeleteError(null);
    boardActionsTriggerRef.current = null;
    restoreFocusSoon(trigger);
  };

  const handleConfirmDelete = () => {
    if (!deletingBoard || deleteBoard.isPending) return;
    deleteBoard.mutate(deletingBoard);
  };

  return (
    <AppShell
      breadcrumb="Boards"
      workspace={workspace.data}
      overlayOpen={Boolean(deletingBoard || editingBoard || addingMemberBoard || movingBoard || creatingBoard)}
      overlays={<>
        {creatingBoard && <BoardCreateDialog workspaceName={workspace.data?.name} defaultAccessMode={creatingBoard.defaultAccessMode} isPending={createBoard.isPending} error={createBoard.error?.message ?? null} onCancel={() => { if (createBoard.isPending) return; setCreatingBoard(null); createBoard.reset(); restoreFocusSoon(newBoardButtonRef.current); }} onCreate={(name, key, icon, color, accessMode) => { if (!createBoard.isPending) createBoard.mutate({ targetWorkspaceId: creatingBoard.workspaceId, name, key, icon, color, accessMode }); }} />}
        {deletingBoard && <BoardDeleteDialog boardName={deletingBoard.name} isPending={deleteBoard.isPending} retainedPending={pendingDeleteIds.has(deletingBoard.id)} statusUnknown={deleteTracking.statusUnavailable || deleteTracking.unreachable} onCheckStatus={deleteTracking.unreachable ? undefined : deleteTracking.checkStatus} error={deleteError} onCancel={handleCancelDelete} onConfirm={handleConfirmDelete} />}
        {editingBoard && <BoardEditDialog board={editingBoard} isPending={updateBoard.isPending} error={editError} onCancel={handleCancelEdit} onSave={handleSaveEdit} />}
        {addingMemberBoard && <BoardAddMemberDialog board={addingMemberBoard} currentUserId={user?.id} onClose={handleCloseAddMember} onSuccess={({ name }) => handleAddMemberSuccess(name)} />}
        {movingBoard && <BoardMoveDialog board={movingBoard} onClose={() => setMovingBoard(null)} />}
      </>}
    >
      <div className="boards-heading">
        <div><h1>Boards</h1><p>{workspace.data ? `Projects in ${workspace.data.name}.` : ""}</p></div>
        {workspace.data?.access === "member" && <Button ref={newBoardButtonRef} type="button" onClick={() => { setSuccess(null); createBoard.reset(); setCreatingBoard({ workspaceId, defaultAccessMode: workspace.data?.defaultBoardAccess }); }}><Plus aria-hidden="true" />New board</Button>}
      </div>
      <div className="boards-section-heading"><strong>All boards</strong>{boards.isSuccess && <span>{boards.data.length}</span>}</div>
      {success && <p role="status" className="boards-page-success">{success}</p>}
      {boards.isPending ? <p role="status" className="boards-list-state">loading boards…</p> : boards.isError ? <div className="boards-list-state"><p role="alert">Could not load boards in this workspace.</p><Button type="button" variant="outline" size="xs" onClick={() => void boards.refetch()}>Try again</Button></div> : boards.data.length > 0 ? (
        <ul className="boards-list" aria-label="Available boards">{boards.data.map((board) => <BoardRow key={board.id} board={board} actions={<BoardActions board={board} deleting={pendingDeleteIds.has(board.id)} onRequestMove={(target) => setMovingBoard(target)} onRequestAddMember={handleRequestAddMember} onRequestEdit={handleRequestEdit} onRequestDelete={handleRequestDelete} />} />)}</ul>
      ) : <div className="boards-empty"><strong>No boards yet.</strong><p>{workspace.data?.access === "member" ? "Use New board to create the first project." : "No boards are shared with you here."}</p></div>}
    </AppShell>
  );
}

/** The per-row menu on a workspace's board list: invite, edit, move or delete. */
function BoardActions({
  board,
  deleting,
  onRequestAddMember,
  onRequestEdit,
  onRequestDelete,
  onRequestMove,
}: {
  board: Board;
  /** A deletion for this board is retained and still being applied server-side. */
  deleting: boolean;
  onRequestAddMember: (board: Board, trigger: HTMLButtonElement) => void;
  onRequestEdit: (board: Board, trigger: HTMLButtonElement) => void;
  onRequestDelete: (board: Board, trigger: HTMLButtonElement) => void;
  onRequestMove: (board: Board) => void;
}) {
  if (deleting) return <span role="status" className="boards-page-success">Deleting…</span>;
  const { canManageBoard } = board.capabilities;
  return <BoardActionsMenu board={board} canEdit={canManageBoard} canDelete={canManageBoard} canMove={canManageBoard} onMove={() => onRequestMove(board)} onAddMember={(trigger) => onRequestAddMember(board, trigger)} onEdit={(trigger) => onRequestEdit(board, trigger)} onDelete={(trigger) => onRequestDelete(board, trigger)} />;
}

/** One board row, shared by a workspace's board list and Home. */
export function BoardRow({ board, workspaceName, actions }: { board: Board; workspaceName?: string; actions?: ReactNode }) {
  return <li className="boards-row">
    <span className="boards-board-tile" data-board-color={board.color}>
      <BoardAppearanceIcon icon={board.icon} color={board.color} />
    </span>
    <div className="boards-board-identity">
      <Link to="/board/$boardKey" params={{ boardKey: board.key }} className={buttonVariants({ variant: "link", className: "boards-board-name" })}>{board.name}</Link>
      <span>{board.key} <b className="board-access-label" title={boardAccessChoice(board.accessMode)}>{BOARD_ACCESS[board.accessMode].label}</b>{workspaceName && <> in {workspaceName}</>}</span>
    </div>
    <div className="boards-row-actions">{actions}</div>
  </li>;
}
