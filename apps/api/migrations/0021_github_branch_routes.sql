-- Migration number: 0021
-- Routing pointers for branches (ADR 0064), like github_pr_routes: which boards hold a
-- link to a branch, so a push or delete for an already-linked branch finds its boards
-- even when its name no longer holds one of their board keys (the key was edited, or
-- the card moved to another board). A pointer, not card data: no card id, title or
-- commit lives here. The BoardDO's link paths keep it current; a pointer to a deleted
-- board is ignored by joining boards.
CREATE TABLE github_branch_routes (
  repo_id INTEGER NOT NULL,
  branch_name TEXT NOT NULL,
  board_id TEXT NOT NULL,
  PRIMARY KEY (repo_id, branch_name, board_id)
) WITHOUT ROWID;
CREATE INDEX github_branch_routes_board ON github_branch_routes (board_id);
