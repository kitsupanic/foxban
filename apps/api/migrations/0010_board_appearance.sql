-- Migration number: 0010 	 2026-09-14T00:00:00.000Z
ALTER TABLE boards ADD COLUMN icon TEXT NOT NULL DEFAULT 'square-kanban'
  CHECK (icon IN ('square-kanban', 'fish', 'shuffle', 'briefcase', 'code', 'flask', 'rocket', 'target', 'book-open', 'palette', 'heart', 'star'));
ALTER TABLE boards ADD COLUMN color TEXT NOT NULL DEFAULT 'slate'
  CHECK (color IN ('amber', 'orange', 'rose', 'purple', 'blue', 'teal', 'green', 'slate'));
