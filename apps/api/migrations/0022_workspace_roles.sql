-- Migration number: 0022 	 2026-11-14T00:00:00.000Z
-- Workspace roles become admin and member (ADR 0066). The permanent owner goes:
-- every owner row becomes an admin row, the four triggers that made the owner
-- immutable are replaced by a guard that a workspace always keeps an admin, and
-- nothing else changes (not `workspaces.owner_id`, which stays as the creator).
--
-- The `owner` value stays in `workspace_members`'s CHECK. SQLite cannot alter a
-- CHECK in place, and rebuilding the table that every access decision reads would
-- also make the previously deployed Worker's `POST /workspaces` (which inserts the
-- creator as 'owner') fail for the whole rollout window. So the constraint is left
-- alone and an AFTER INSERT trigger rewrites any 'owner' insert to 'admin' in the
-- same statement: no owner row survives a statement, and a reader never sees one.
-- Dropping the dead value is a later forward migration, once no Worker that writes
-- it can still be running.
--
-- Rollout order: apply this before deploying the Worker that no longer knows
-- 'owner'. While the previous Worker still runs against it, a former owner is an
-- admin (it already treats admins as managers), its workspace and signup writes
-- still succeed, and it can no longer protect the creator, which the new Worker
-- does not do either. What it cannot do is leave a workspace without an admin: the
-- guard below is in the database. Rollback is roll-forward only: restoring the old
-- triggers would need the owner rows this migration converted.

-- Abort before any change when a workspace could not keep an admin. The old
-- triggers guaranteed an owner row; a workspace without an owner or admin means
-- the data is already broken, and converting around it would hide that.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM workspaces w
   WHERE NOT EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.role IN ('owner','admin'))
) THEN json('error: workspaces without an owner or admin: ' || (
  SELECT group_concat(id) FROM (
    SELECT w.id FROM workspaces w
     WHERE NOT EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.role IN ('owner','admin'))
     ORDER BY w.id)
)) ELSE 1 END;

DROP TRIGGER workspace_owner_membership_insert;
DROP TRIGGER workspace_owner_membership_update;
DROP TRIGGER workspace_owner_membership_delete;
DROP TRIGGER workspace_owner_id_immutable;

UPDATE workspace_members SET role='admin' WHERE role='owner';

SELECT CASE WHEN EXISTS (SELECT 1 FROM workspace_members WHERE role='owner')
  THEN json('error: owner memberships remain') ELSE 1 END;
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM workspaces w
   WHERE NOT EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.role='admin')
) THEN json('error: workspace left without an admin') ELSE 1 END;

-- The previously deployed Worker creates a workspace by inserting its creator as
-- 'owner'. Rewritten here, in the same statement, so no owner row is ever readable.
CREATE TRIGGER workspace_members_legacy_owner
AFTER INSERT ON workspace_members WHEN NEW.role='owner'
BEGIN
  UPDATE workspace_members SET role='admin' WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id;
END;

-- A workspace always keeps at least one admin. Raised inside the statement, so two
-- admins demoting each other at once cannot both pass: the one the database runs
-- second finds no other admin left. A workspace that is itself gone has no one to
-- protect, which lets a later workspace deletion remove its members.
CREATE TRIGGER workspace_keeps_an_admin_update
BEFORE UPDATE OF role,workspace_id ON workspace_members
WHEN OLD.role='admin' AND (NEW.role<>'admin' OR NEW.workspace_id<>OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'a workspace must keep at least one admin')
    WHERE NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=OLD.workspace_id AND user_id<>OLD.user_id AND role='admin');
END;
CREATE TRIGGER workspace_keeps_an_admin_delete
BEFORE DELETE ON workspace_members
WHEN OLD.role='admin' AND EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'a workspace must keep at least one admin')
    WHERE NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=OLD.workspace_id AND user_id<>OLD.user_id AND role='admin');
END;

-- Signup creates the first workspace with its person as admin. Same body as 0012
-- apart from the role.
DROP TRIGGER users_create_personal_workspace;
CREATE TRIGGER users_create_personal_workspace
AFTER INSERT ON users
BEGIN
  INSERT INTO workspaces(id,name,owner_id,personal_user_id,default_board_access,created_at,updated_at)
  VALUES('personal_' || NEW.id,'Personal',NEW.id,NEW.id,'restricted',NEW.created_at,NEW.created_at);
  INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at)
  VALUES('personal_' || NEW.id,NEW.id,'admin',NEW.created_at,NEW.created_at);
END;
