import { applyD1Migrations,env } from "cloudflare:test";
import { describe,expect,it } from "vitest";

describe("workspace migration",()=>{
  it("backfills deterministic personal placement without changing board identity or grants",async()=>{
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(0,11));
    const now=Date.now();
    await env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES('owner','owner@example.test','Owner','hash',?)`).bind(now).run();
    await env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES('guest','guest@example.test','Guest','hash',?)`).bind(now+1).run();
    await env.DB.prepare(`INSERT INTO boards(id,name,owner_id,created_at,board_key,icon,color) VALUES('board','Legacy','owner',?,'LEGACY','rocket','teal')`).bind(now).run();
    await env.DB.prepare(`INSERT INTO board_members(board_id,user_id) VALUES('board','guest')`).run();
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(11));
    expect(await env.DB.prepare(`SELECT id,owner_id AS ownerId,workspace_id AS workspaceId,access_mode AS accessMode,board_key AS key,icon,color FROM boards WHERE id='board'`).first()).toEqual({id:"board",ownerId:"owner",workspaceId:"personal_owner",accessMode:"restricted",key:"LEGACY",icon:"rocket",color:"teal"});
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE personal_user_id IN ('owner','guest')`).first<{n:number}>())?.n).toBe(2);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE role='admin'`).first<{n:number}>())?.n).toBe(2);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM board_members WHERE board_id='board'`).first<{n:number}>())?.n).toBe(2);
    await env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES('later','later@example.test','Later','hash',?)`).bind(now+2).run();
    expect(await env.DB.prepare(`SELECT personal_user_id AS userId FROM workspaces WHERE id='personal_later'`).first()).toEqual({userId:"later"});
    await env.DB.prepare(`INSERT INTO boards(id,name,owner_id,created_at,board_key) VALUES('legacy-later','Later board','later',?,'LATER')`).bind(now+2).run();
    expect(await env.DB.prepare(`SELECT workspace_id AS workspaceId,access_mode AS accessMode FROM boards WHERE id='legacy-later'`).first()).toEqual({workspaceId:"personal_later",accessMode:"restricted"});
  });

  it("reruns the backfill without duplicating placements or losing a rename or a move",async()=>{
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(0,11));
    const now=Date.now();
    await env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES('rerun-owner','rerun-owner@example.test','Rerun Owner','hash',?)`).bind(now).run();
    await env.DB.prepare(`INSERT INTO boards(id,name,owner_id,created_at,board_key) VALUES('rerun-board','Rerun legacy','rerun-owner',?,'RERUN')`).bind(now).run();
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(11));

    // A rename and a move happen after the migration; a recovery rerun of the
    // backfill must not undo either.
    const destination=crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO workspaces(id,name,owner_id,default_board_access,created_at,updated_at) VALUES(?,'Destination','rerun-owner','workspace',?,?)`).bind(destination,now,now).run();
    await env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES(?,'rerun-owner','admin',?,?)`).bind(destination,now,now).run();
    await env.DB.prepare(`UPDATE workspaces SET name='Renamed personal' WHERE id='personal_rerun-owner'`).run();
    await env.DB.prepare(`UPDATE boards SET workspace_id=? WHERE id='rerun-board'`).bind(destination).run();

    const backfill=env.TEST_MIGRATIONS[11]!.queries.filter((query)=>/^\s*(INSERT OR IGNORE INTO (workspaces|workspace_members|board_members)|UPDATE boards SET workspace_id)/i.test(query));
    expect(backfill.length).toBeGreaterThan(0);
    for(const query of backfill) await env.DB.prepare(query).run();

    expect(await env.DB.prepare(`SELECT name FROM workspaces WHERE id='personal_rerun-owner'`).first()).toEqual({name:"Renamed personal"});
    expect(await env.DB.prepare(`SELECT workspace_id AS workspaceId FROM boards WHERE id='rerun-board'`).first()).toEqual({workspaceId:destination});
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE personal_user_id='rerun-owner'`).first<{n:number}>())?.n).toBe(1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id='personal_rerun-owner'`).first<{n:number}>())?.n).toBe(1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM board_members WHERE board_id='rerun-board'`).first<{n:number}>())?.n).toBe(1);
  });

  it("keeps the pre-workspace board-creation batch working while the new Worker rolls out",async()=>{
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(0,11));
    const now=Date.now();
    await env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES('rollout-owner','rollout-owner@example.test','Rollout Owner','hash',?)`).bind(now).run();
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(11));

    // The additive window: 0012 is applied, the previously deployed Worker is still
    // answering requests. This is its exact board-creation transaction — the board
    // INSERT (which lands with no workspace) followed by the owner's own grant.
    // Inserting that grant in the trigger as well made the second statement collide
    // with the composite key and rolled back every board creation.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO boards (id, name, board_key, owner_id, icon, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind('rollout-board','Rollout Board','ROLLOUT','rollout-owner','rocket','teal',now+1),
      env.DB.prepare(`INSERT INTO board_members (board_id, user_id) VALUES (?, ?)`).bind('rollout-board','rollout-owner'),
    ]);

    // Placement and the single owner grant both survived the batch.
    expect(await env.DB.prepare(`SELECT workspace_id AS workspaceId,access_mode AS accessMode FROM boards WHERE id='rollout-board'`).first()).toEqual({workspaceId:"personal_rollout-owner",accessMode:"restricted"});
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n,MIN(role) AS role FROM board_members WHERE board_id='rollout-board'`).first()).toEqual({n:1,role:"member"});
    // And the board still resolves to a manageable, discoverable place.
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=w.owner_id WHERE w.id='personal_rollout-owner' AND wm.role='admin'`).first<{n:number}>()).toEqual({n:1});
  });
});
