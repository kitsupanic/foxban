import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Board } from "../lib/boards";
import { BOARD_ACCESS, workspacesQuery } from "../lib/workspaces";
import {
  accessScope,
  clearAccessAttempt,
  requestAccessChange,
  sendAccessChange,
  useAccessAttemptOutcomes,
  useAccessAttempts,
  type AccessAttempt,
} from "../lib/access-attempt";
import { Button } from "./ui/button";

/**
 * Moves a board between workspaces. The move is journalled server-side and can
 * answer `202` while it prepares, so the attempt is retained outside this
 * component: closing and reopening the dialog, or switching routes and coming
 * back, rejoins the same operationId instead of starting a second move.
 */
export function BoardMoveDialog({ board, onClose }: { board: Board; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const workspaces = useQuery(workspacesQuery);
  const choices = useMemo(() => workspaces.data?.filter((item) => item.access === "member" && item.id !== board.workspaceId) ?? [], [workspaces.data, board.workspaceId]);
  const [destination, setDestination] = useState("");
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const scopeKey = accessScope("board-move", board.id);
  const retained = useAccessAttempts(scopeKey).find((attempt) => attempt.state === "pending");

  /**
   * The route the dialog was opened from. A move that finishes after the user
   * has moved on must not drag them back to the destination workspace.
   */
  const openedPathRef = useRef(location.pathname);

  const finish = (attempt: AccessAttempt) => {
    const destinationId = attempt.context.destinationWorkspaceId ?? "";
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
      queryClient.invalidateQueries({ queryKey: ["boards", board.workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["boards", destinationId] }),
      queryClient.invalidateQueries({ queryKey: ["boards", "all"] }),
      queryClient.invalidateQueries({ queryKey: ["board-meta-by-key", board.key] }),
    ]).then(() => {
      clearAccessAttempt(scopeKey, attempt.operationId);
      onClose();
      if (destinationId !== "" && location.pathname === openedPathRef.current)
        void navigate({ to: "/w/$workspaceId", params: { workspaceId: destinationId } });
    });
  };

  const tracking = useAccessAttemptOutcomes(scopeKey, (attempt) => {
    if (attempt.state === "aborted") {
      clearAccessAttempt(scopeKey, attempt.operationId);
      setOutcomeError("The move was refused, so the board stayed in its source workspace.");
      return;
    }
    finish(attempt);
  });

  const move = useMutation({
    mutationFn: () => {
      // A retry of a live attempt must repeat the exact payload the server
      // hashed: the board's access version changes as the move progresses.
      const expectedAccessVersion = retained ? Number(retained.context.expectedAccessVersion) : board.accessVersion;
      const destinationWorkspaceId = retained?.context.destinationWorkspaceId ?? destination;
      return requestAccessChange(
        scopeKey,
        "board-move",
        {
          boardId: board.id,
          boardKey: board.key,
          workspaceId: board.workspaceId,
          destinationWorkspaceId,
          expectedAccessVersion: String(expectedAccessVersion),
        },
        (attempt) =>
          sendAccessChange(`/boards/${encodeURIComponent(board.id)}/move-workspace`, "POST", {
            destinationWorkspaceId,
            expectedWorkspaceId: board.workspaceId,
            expectedAccessVersion,
            operationId: attempt.operationId,
          }),
      );
    },
  });

  const pending = retained !== undefined;
  const selectedDestination = retained?.context.destinationWorkspaceId ?? destination;
  return <div className="boards-dialog-overlay"><div role="dialog" aria-modal="true" aria-labelledby="move-board-title" className="boards-dialog-panel"><h2 id="move-board-title">Move {board.name}</h2>{choices.length === 0 ? <><p>No eligible destination workspace is available.</p><p>Create a workspace from the workspace switcher first.</p></> : <><label>Destination workspace<select value={selectedDestination} disabled={pending} onChange={(event) => setDestination(event.target.value)}><option value="">Choose workspace</option>{choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="workspace-move-review"><p>The board becomes {BOARD_ACCESS.restricted.label} in its destination: {BOARD_ACCESS.restricted.who}.</p><ul><li>Destination members get no automatic access; its workspace admins can open it.</li><li>Source members and workspace admins who were not added to the board lose access.</li><li>Explicit members and the owner retain access.</li><li>An inherited moving administrator retains an explicit manager grant.</li></ul></div></>}
    {pending && <p role="status">Access is being updated. This cannot be reported as done until the server confirms the outcome.</p>}
    {pending && (tracking.statusUnavailable || tracking.unreachable) && <p role="alert">The server has not confirmed this move yet. Retry it to continue the same attempt.</p>}
    {move.error && <p role="alert">{move.error.message}</p>}
    {outcomeError && <p role="alert">{outcomeError}</p>}
    <div className="boards-dialog-actions">{pending && <Button variant="outline" onClick={tracking.checkStatus}>Check status</Button>}<Button variant="outline" disabled={move.isPending} onClick={onClose}>{pending ? "Close" : "Cancel"}</Button>{choices.length > 0 && <Button disabled={!selectedDestination || move.isPending} onClick={() => move.mutate()}>{move.isPending ? "Moving…" : pending ? "Retry move" : "Move board"}</Button>}</div></div></div>;
}
