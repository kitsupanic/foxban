/**
 * The D1 routing table for branches (ADR 0064), the counterpart of `github_pr_routes`:
 * `(repo id, branch name, board id)` pointers that let a push or delete for an
 * already-linked branch find its boards even when its name no longer holds one of their
 * board keys. No card data lives here. A BoardDO keeps its own rows current, through
 * `syncBranchRoute`, whenever it links, unlinks or loses the cards that hold a branch.
 * Pointers to a deleted board are skipped by joining `boards`.
 */

/** Boards that currently link the branch. */
export async function routedBranchBoardIds(env: Env, repoId: number, branchName: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.board_id AS boardId FROM github_branch_routes r JOIN boards b ON b.id = r.board_id
      WHERE r.repo_id = ? AND r.branch_name = ?`,
  )
    .bind(repoId, branchName)
    .all<{ boardId: string }>();
  return results.map((row) => row.boardId);
}

/** Records that `boardId` links the branch (`linked`), or that it no longer does. */
export async function syncBranchRoute(env: Env, boardId: string, repoId: number, branchName: string, linked: boolean): Promise<void> {
  await env.DB.prepare(
    linked
      ? "INSERT OR IGNORE INTO github_branch_routes (repo_id, branch_name, board_id) VALUES (?1, ?2, ?3)"
      : "DELETE FROM github_branch_routes WHERE repo_id = ?1 AND branch_name = ?2 AND board_id = ?3",
  )
    .bind(repoId, branchName, boardId)
    .run();
}
