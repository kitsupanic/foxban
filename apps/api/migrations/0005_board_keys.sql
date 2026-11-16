-- Migration number: 0005 	 2026-09-07T00:00:00.000Z
ALTER TABLE boards ADD COLUMN board_key TEXT;

WITH numbered_boards AS (
  SELECT id, 'FB' || ROW_NUMBER() OVER (ORDER BY created_at, id) AS assigned_key
    FROM boards
)
UPDATE boards
   SET board_key = (
     SELECT assigned_key
       FROM numbered_boards
      WHERE numbered_boards.id = boards.id
   );

CREATE UNIQUE INDEX boards_board_key ON boards(board_key);
