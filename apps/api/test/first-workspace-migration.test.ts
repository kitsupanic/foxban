import { applyD1Migrations,env } from "cloudflare:test";
import { describe,expect,it } from "vitest";

const FIRST_WORKSPACE="0023";

describe("first-workspace migration",()=>{
  it("names new signups' workspace after them and leaves existing workspaces alone",async()=>{
    const index=env.TEST_MIGRATIONS.findIndex((migration)=>migration.name.startsWith(FIRST_WORKSPACE));
    expect(index).toBeGreaterThan(0);
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(0,index));
    const now=Date.now();
    await env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES('before','before@example.test','Before','hash',?)`).bind(now).run();
    await env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES('renamed','renamed@example.test','Renamed','hash',?)`).bind(now).run();
    await env.DB.prepare(`UPDATE workspaces SET name='My renamed space' WHERE id='personal_renamed'`).run();
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(index));

    expect((await env.DB.prepare(`SELECT id,name FROM workspaces WHERE id IN ('personal_before','personal_renamed') ORDER BY id`).all()).results).toEqual([{id:"personal_before",name:"Personal"},{id:"personal_renamed",name:"My renamed space"}]);

    // The Worker from before this release is still answering while the schema is
    // ahead of it: it reads `personal_user_id` and relies on the placement trigger,
    // so a new account must keep both, with the id derived as before.
    await env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES('later','later@example.test','Ada Lovelace','hash',?)`).bind(now+1).run();
    expect(await env.DB.prepare(`SELECT w.id,w.name,w.owner_id AS ownerId,w.personal_user_id AS personalUserId,w.default_board_access AS access,wm.role FROM workspaces w JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id='later' WHERE w.owner_id='later'`).first()).toEqual({id:"personal_later",name:"Ada Lovelace's workspace",ownerId:"later",personalUserId:"later",access:"restricted",role:"admin"});
    await env.DB.prepare(`INSERT INTO boards(id,name,owner_id,created_at,board_key) VALUES('legacy-later','Later board','later',?,'LATER')`).bind(now+2).run();
    expect(await env.DB.prepare(`SELECT workspace_id AS workspaceId FROM boards WHERE id='legacy-later'`).first()).toEqual({workspaceId:"personal_later"});
  });

  it("fits a long name into the 40-character workspace name limit",async()=>{
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
    const long="Bartholomew ".repeat(10).trim();
    await env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES('long','long@example.test',?,'hash',?)`).bind(long,Date.now()).run();
    const row=await env.DB.prepare(`SELECT name FROM workspaces WHERE id='personal_long'`).first<{name:string}>();
    expect(row?.name).toBe("Bartholomew Bartholomew Bart's workspace");
  });
});
