/**
 * The D1 routing table (ADR 0064): `(repo id, PR number, board id)` pointers that
 * let a webhook for an already-linked pull request find its boards. No card data
 * lives here. A BoardDO keeps its own rows current, through `syncPullRequestRoute`,
 * whenever it links, unlinks or loses the cards that hold a pull request. Pointers
 * to a deleted board are skipped by joining `boards`.
 */

/** Boards that currently link the pull request. */
export async function routedBoardIds(env: Env, repoId: number, prNumber: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.board_id AS boardId FROM github_pr_routes r JOIN boards b ON b.id = r.board_id
      WHERE r.repo_id = ? AND r.pr_number = ?`,
  )
    .bind(repoId, prNumber)
    .all<{ boardId: string }>();
  return results.map((row) => row.boardId);
}

/** Records that `boardId` links the pull request (`linked`), or that it no longer does. */
export async function syncPullRequestRoute(env: Env, boardId: string, repoId: number, prNumber: number, linked: boolean): Promise<void> {
  await env.DB.prepare(
    linked
      ? "INSERT OR IGNORE INTO github_pr_routes (repo_id, pr_number, board_id) VALUES (?1, ?2, ?3)"
      : "DELETE FROM github_pr_routes WHERE repo_id = ?1 AND pr_number = ?2 AND board_id = ?3",
  )
    .bind(repoId, prNumber, boardId)
    .run();
}
