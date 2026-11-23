import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("creator seat migration 0028 (ADR 0087)", () => {
  it("deletes a creator's own row once they are outside the board's workspace, and nothing else", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < "0028"));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users(id,email,name,password_hash,created_at) VALUES ('admin','a@x.test','a','h',1), ('in','i@x.test','i','h',1), ('gone','g@x.test','g','h',1), ('friend','f@x.test','f','h',1)`,
      ),
      env.DB.prepare(`INSERT INTO workspaces(id,name,owner_id,created_at,updated_at) VALUES ('w','W','admin',1,1)`),
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES ('w','admin','admin',1,1), ('w','in','member',1,1)`),
      // b-in: creator still in W. b-out: creator removed earlier. b-out also has a guest 'friend' and the admin, who stay.
      env.DB.prepare(
        `INSERT INTO boards(id,name,board_key,owner_id,workspace_id,access_mode,created_at)
         VALUES ('b-in','B','BIN','in','w','workspace',1), ('b-out','B','BOUT','gone','w','workspace',1)`,
      ),
      env.DB.prepare(
        `INSERT INTO board_members(board_id,user_id,role) VALUES ('b-in','in','member'), ('b-out','gone','member'), ('b-out','friend','member'), ('b-out','admin','member')`,
      ),
    ]);

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const { results } = await env.DB.prepare("SELECT board_id AS b, user_id AS u FROM board_members ORDER BY board_id, user_id").all();
    expect(results).toEqual([
      { b: "b-in", u: "in" },
      { b: "b-out", u: "admin" },
      { b: "b-out", u: "friend" },
    ]);
  });
});
