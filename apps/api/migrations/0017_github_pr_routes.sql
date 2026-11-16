-- Migration number: 0017
-- Routing pointers for development info (ADR 0064): which boards hold a link to a
-- pull request, so a webhook for an already-linked PR finds its boards even when
-- its text no longer names a task key. Like boards.board_key this is a pointer,
-- not card data: no card id, title or state lives here. The BoardDO's link paths
-- keep it current; a pointer to a deleted board is ignored by joining boards.
CREATE TABLE github_pr_routes (
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  board_id TEXT NOT NULL,
  PRIMARY KEY (repo_id, pr_number, board_id)
) WITHOUT ROWID;
CREATE INDEX github_pr_routes_board ON github_pr_routes (board_id);
