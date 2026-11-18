import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * The board snapshot cache. It is written exclusively by the board socket and
 * lives forever (`gcTime: Infinity`), so it must be dropped explicitly when
 * access is lost — nothing else will evict it.
 */
export function boardQueryKey(boardId: string): readonly [string, string] {
  return ["board", boardId];
}

/**
 * Every cache entry holding board-private data. Membership is by board id, so a
 * caller that only knows the routed key still clears the by-subject entries
 * named by a removal hint.
 */
export function boardPrivateCacheKeys(identity: { boardId?: string; boardKey?: string }): QueryKey[] {
  const keys: QueryKey[] = [];
  if (identity.boardId) {
    keys.push(
      boardQueryKey(identity.boardId),
      ["board-meta", identity.boardId],
      ["board-members", identity.boardId],
      ["board-membership-candidates", identity.boardId],
      ["board-transfer-options", identity.boardId],
      ["card-development", identity.boardId],
      ["card-activity", identity.boardId],
      ["board-development", identity.boardId],
      ["connected-repos", identity.boardId],
    );
  }
  if (identity.boardKey) keys.push(["board-meta-by-key", identity.boardKey]);
  return keys;
}

/**
 * A confirmed denial (403/404 from the board metadata route) must leave no
 * board-private data behind anywhere in the client cache. Reads are cancelled
 * before removal: `removeQueries` cancels the in-flight fetch behind each entry,
 * so a response that lands after the denial cannot reinstall what was removed.
 */
export function clearBoardAccessCaches(
  queryClient: QueryClient,
  identity: { boardId?: string; boardKey?: string },
): void {
  const keys = boardPrivateCacheKeys(identity);
  for (const key of keys) void queryClient.cancelQueries({ queryKey: key });
  for (const key of keys) queryClient.removeQueries({ queryKey: key });
  // Listings still advertise the board and its workspace until re-read.
  void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  void queryClient.invalidateQueries({ queryKey: ["boards"] });
}
