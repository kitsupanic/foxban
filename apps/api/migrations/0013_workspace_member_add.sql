-- Migration number: 0013 	 2026-09-15T00:00:00.000Z
-- Widens the access-change journal's closed kind set with `workspace-member-add`,
-- the direct addition of an existing account by a workspace Owner/Admin. SQLite
-- cannot alter a CHECK constraint, so the table is rebuilt: every column is copied
-- by name, the row count is asserted while both tables still exist, and the one
-- index is recreated after the rename. No foreign key points at this table and no
-- trigger or view reads it, so dropping and renaming cannot invalidate another
-- object. The migration runs as one transaction, so the previously deployed Worker
-- never observes an absent journal.
--
-- Rollout order: apply this migration before deploying the Worker that writes the
-- new kind. Widening is additive — the previously deployed Worker only ever writes
-- the seven kinds it already knew — so applying it first is safe, and the new
-- endpoint reserves nothing until the widened CHECK exists (the journal INSERT
-- fails the old constraint, which the route answers as a conflict rather than as a
-- half-applied change). Rollback is roll-forward only once the new kind has been
-- used: restoring 0012's narrower CHECK would have to copy a `workspace-member-add`
-- row into it, and that copy fails, so the journal must be narrowed again by a new
-- forward migration, never by reverting this one.
CREATE TABLE access_change_operations_next (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('workspace-member-add','workspace-member-role','workspace-member-remove','workspace-invite-accept','board-member-add','board-member-remove','board-move','board-delete')),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('preparing','committed','aborted','completed')),
  outcome TEXT CHECK(outcome IN ('committed','aborted')),
  result_json TEXT,
  notify_user_ids_json TEXT NOT NULL DEFAULT '[]',
  notified INTEGER NOT NULL DEFAULT 0 CHECK(notified IN (0,1)),
  effect_started INTEGER NOT NULL DEFAULT 0 CHECK(effect_started IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO access_change_operations_next
  (id,actor_id,kind,payload_json,payload_hash,phase,outcome,result_json,notify_user_ids_json,notified,effect_started,created_at,updated_at)
SELECT id,actor_id,kind,payload_json,payload_hash,phase,outcome,result_json,notify_user_ids_json,notified,effect_started,created_at,updated_at
  FROM access_change_operations;
SELECT CASE WHEN (SELECT COUNT(*) FROM access_change_operations)
              <> (SELECT COUNT(*) FROM access_change_operations_next)
  THEN json('error: access change journal rebuild lost rows') ELSE 1 END;
DROP TABLE access_change_operations;
ALTER TABLE access_change_operations_next RENAME TO access_change_operations;
CREATE INDEX access_change_operations_unfinished ON access_change_operations(phase,notified,updated_at);
SELECT CASE WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='access_change_operations_next')
  THEN json('error: access change journal rebuild left its staging table behind') ELSE 1 END;
