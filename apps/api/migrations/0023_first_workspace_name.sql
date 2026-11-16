-- Migration number: 0023 	 2026-11-14T00:00:00.000Z
-- The first workspace is an ordinary workspace named "<name>'s workspace" (ADR 0066).
-- Only the signup trigger changes: existing workspaces keep their name and id.
--
-- Rollout safety: the Worker deployed before this release still reads
-- `personal_user_id` to place a board created without a workspace, and the
-- `boards_legacy_workspace` trigger (0012) still places legacy inserts by the
-- `personal_<userId>` id. So a new account keeps both, derived exactly as before;
-- they are inert data now, and nothing in the current Worker reads either.
--
-- The name must fit workspaces.name (1-40 characters, no edge spaces): 28 characters
-- of the account name plus the 12-character suffix.
DROP TRIGGER IF EXISTS users_create_personal_workspace;
CREATE TRIGGER users_create_personal_workspace
AFTER INSERT ON users
BEGIN
  INSERT INTO workspaces(id,name,owner_id,personal_user_id,default_board_access,created_at,updated_at)
  VALUES('personal_' || NEW.id,trim(substr(trim(NEW.name),1,28)) || '''s workspace',NEW.id,NEW.id,'restricted',NEW.created_at,NEW.created_at);
  INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at)
  VALUES('personal_' || NEW.id,NEW.id,'admin',NEW.created_at,NEW.created_at);
END;
