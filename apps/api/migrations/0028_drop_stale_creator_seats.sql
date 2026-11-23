-- ADR 0087: a board's creator opens it only while in its workspace. A creator removed before that rule still has the
-- board_members row written when they made the board, which would keep their access as a guest. Delete those rows.
DELETE FROM board_members
 WHERE EXISTS(SELECT 1 FROM boards b
               WHERE b.id=board_members.board_id AND b.owner_id=board_members.user_id
                 AND NOT EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=b.workspace_id AND wm.user_id=b.owner_id));
