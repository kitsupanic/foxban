-- Migration number: 0012 	 2026-09-14T00:00:00.000Z
-- Abort before schema changes when legacy ownership or grants are inconsistent.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM boards b LEFT JOIN users u ON u.id = b.owner_id WHERE u.id IS NULL
) THEN json('error: boards have missing owners: ' || (
  SELECT group_concat(b.id || ':' || b.owner_id) FROM boards b LEFT JOIN users u ON u.id=b.owner_id WHERE u.id IS NULL
)) ELSE 1 END;
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM board_members bm LEFT JOIN boards b ON b.id=bm.board_id LEFT JOIN users u ON u.id=bm.user_id
  WHERE b.id IS NULL OR u.id IS NULL
) THEN json('error: dangling board grants: ' || (
  SELECT group_concat(bm.board_id || ':' || bm.user_id) FROM board_members bm LEFT JOIN boards b ON b.id=bm.board_id LEFT JOIN users u ON u.id=bm.user_id WHERE b.id IS NULL OR u.id IS NULL
)) ELSE 1 END;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 40 AND name = trim(name)),
  owner_id TEXT NOT NULL,
  personal_user_id TEXT UNIQUE,
  default_board_access TEXT NOT NULL DEFAULT 'workspace' CHECK(default_board_access IN ('workspace','restricted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE workspace_invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('member','admin')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE access_change_operations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('workspace-member-role','workspace-member-remove','workspace-invite-accept','board-member-add','board-member-remove','board-move','board-delete')),
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
CREATE TABLE access_change_scopes (workspace_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
CREATE TABLE access_change_boards (
  operation_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  next_version INTEGER NOT NULL,
  prepared INTEGER NOT NULL DEFAULT 0 CHECK(prepared IN (0,1)),
  released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0,1)),
  PRIMARY KEY(operation_id,board_id)
);

ALTER TABLE boards ADD COLUMN workspace_id TEXT;
ALTER TABLE boards ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'restricted' CHECK(access_mode IN ('workspace','restricted'));
ALTER TABLE boards ADD COLUMN access_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE boards ADD COLUMN pending_access_operation_id TEXT;
ALTER TABLE board_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','manager'));

INSERT OR IGNORE INTO workspaces(id,name,owner_id,personal_user_id,default_board_access,created_at,updated_at)
SELECT 'personal_' || id, 'Personal', id, id, 'restricted', created_at, created_at FROM users;
INSERT OR IGNORE INTO workspace_members(workspace_id,user_id,role,created_at,updated_at)
SELECT w.id,w.owner_id,'owner',w.created_at,w.updated_at FROM workspaces w;
UPDATE boards SET workspace_id='personal_' || owner_id, access_mode='restricted' WHERE workspace_id IS NULL;
INSERT OR IGNORE INTO board_members(board_id,user_id,role)
SELECT id,owner_id,'member' FROM boards;

SELECT CASE WHEN EXISTS (
 SELECT 1 FROM boards b LEFT JOIN workspaces w ON w.id=b.workspace_id LEFT JOIN users u ON u.id=b.owner_id
 WHERE w.id IS NULL OR u.id IS NULL
) THEN json('error: invalid workspace placement') ELSE 1 END;
SELECT CASE WHEN EXISTS (
 SELECT 1 FROM workspaces w LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=w.owner_id AND wm.role='owner'
 WHERE wm.user_id IS NULL
) THEN json('error: workspace missing owner membership') ELSE 1 END;

CREATE INDEX workspace_members_user ON workspace_members(user_id,workspace_id);
CREATE INDEX board_members_user ON board_members(user_id,board_id);
CREATE INDEX boards_workspace_access ON boards(workspace_id,access_mode,created_at);
CREATE INDEX workspace_invites_active ON workspace_invites(workspace_id,revoked_at,expires_at);
CREATE INDEX access_change_operations_unfinished ON access_change_operations(phase,notified,updated_at);
CREATE INDEX access_change_boards_board ON access_change_boards(board_id,operation_id);

CREATE TRIGGER workspace_owner_membership_insert
BEFORE INSERT ON workspace_members WHEN NEW.role='owner'
BEGIN
  SELECT RAISE(ABORT,'owner membership must match workspace owner')
    WHERE NOT EXISTS(SELECT 1 FROM workspaces WHERE id=NEW.workspace_id AND owner_id=NEW.user_id);
END;
CREATE TRIGGER workspace_owner_membership_update
BEFORE UPDATE ON workspace_members WHEN OLD.role='owner' OR NEW.role='owner'
BEGIN
  SELECT RAISE(ABORT,'workspace owner membership is immutable');
END;
CREATE TRIGGER workspace_owner_membership_delete
BEFORE DELETE ON workspace_members WHEN OLD.role='owner'
BEGIN
  SELECT RAISE(ABORT,'workspace owner membership is immutable');
END;
CREATE TRIGGER workspace_owner_id_immutable
BEFORE UPDATE OF owner_id ON workspaces WHEN NEW.owner_id <> OLD.owner_id
BEGIN
  SELECT RAISE(ABORT,'workspace owner is immutable');
END;

CREATE TRIGGER users_create_personal_workspace
AFTER INSERT ON users
BEGIN
  INSERT INTO workspaces(id,name,owner_id,personal_user_id,default_board_access,created_at,updated_at)
  VALUES('personal_' || NEW.id,'Personal',NEW.id,NEW.id,'restricted',NEW.created_at,NEW.created_at);
  INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at)
  VALUES('personal_' || NEW.id,NEW.id,'owner',NEW.created_at,NEW.created_at);
END;
CREATE TRIGGER boards_validate_owner
BEFORE INSERT ON boards
BEGIN
  SELECT RAISE(ABORT,'board owner does not exist')
    WHERE NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_id);
END;
-- Placement only. The pre-workspace Worker creates a board as one transaction of
-- two statements: the board INSERT (which lands here with no workspace) followed
-- by the owner's own board_members INSERT. Inserting that same grant here as well
-- made the second statement collide with the composite key for the whole additive
-- rollout window, rolling back every board creation. Owner access is preserved
-- because that caller writes the grant itself, exactly as this migration's
-- backfill does for boards that already existed.
CREATE TRIGGER boards_legacy_workspace
AFTER INSERT ON boards WHEN NEW.workspace_id IS NULL
BEGIN
  UPDATE boards SET workspace_id='personal_' || NEW.owner_id,access_mode='restricted' WHERE id=NEW.id;
END;
CREATE TRIGGER boards_workspace_required_update
BEFORE UPDATE OF workspace_id ON boards WHEN NEW.workspace_id IS NULL OR NOT EXISTS(SELECT 1 FROM workspaces WHERE id=NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'board workspace does not exist');
END;
CREATE TRIGGER boards_workspace_valid_insert
BEFORE INSERT ON boards WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'board workspace does not exist');
END;
