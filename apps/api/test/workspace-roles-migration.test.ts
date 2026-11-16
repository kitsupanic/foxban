import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** The schema as the previously deployed Worker knows it: owners still exist. */
const beforeRoles = () => env.TEST_MIGRATIONS.filter((m) => m.name < "0022");
const fromRoles = () => env.TEST_MIGRATIONS.filter((m) => m.name >= "0022");

const now = Date.now();

async function user(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`,
  )
    .bind(id, `${id}@example.test`, id, now)
    .run();
}

async function workspace(id: string, ownerId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspaces(id,name,owner_id,default_board_access,created_at,updated_at) VALUES(?,?,?,'workspace',?,?)`,
  )
    .bind(id, id, ownerId, now, now)
    .run();
}

async function member(workspaceId: string, userId: string, role: string, at = now): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)`,
  )
    .bind(workspaceId, userId, role, at, at)
    .run();
}

const memberRows = async () =>
  (
    await env.DB.prepare(
      `SELECT workspace_id AS workspaceId,user_id AS userId,role,created_at AS createdAt,updated_at AS updatedAt
         FROM workspace_members ORDER BY workspace_id,user_id`,
    ).all()
  ).results;

const snapshot = async (sql: string) => (await env.DB.prepare(sql).all()).results;

describe("workspace roles migration 0022", () => {
  it("turns every owner into an admin and changes nothing else", async () => {
    await applyD1Migrations(env.DB, beforeRoles());
    for (const id of ["u1", "u2", "u3", "u4"]) await user(id);
    // u1 created Team and is its owner; u2 is already an admin there, u3 a member.
    await workspace("team", "u1");
    await member("team", "u1", "owner", now + 1);
    await member("team", "u2", "admin", now + 2);
    await member("team", "u3", "member", now + 3);
    await env.DB.prepare(
      `INSERT INTO boards(id,name,board_key,owner_id,icon,color,workspace_id,access_mode,created_at)
       VALUES('b1','Shared','SHARED','u1','rocket','teal','team','workspace',?),
             ('b2','Hidden','HIDDEN','u1','rocket','teal','team','restricted',?)`,
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO workspace_invites(id,workspace_id,role,token_hash,invited_by,created_at,expires_at)
       VALUES('inv','team','admin','hash','u1',?,?)`,
    )
      .bind(now, now + 1000)
      .run();

    const before = {
      members: await memberRows(),
      workspaces: await snapshot(`SELECT * FROM workspaces ORDER BY id`),
      boards: await snapshot(`SELECT id,workspace_id,access_mode,access_version,owner_id FROM boards ORDER BY id`),
      grants: await snapshot(`SELECT board_id,user_id,role FROM board_members ORDER BY board_id,user_id`),
      invites: await snapshot(`SELECT * FROM workspace_invites ORDER BY id`),
    };
    // Four personal workspaces plus Team: five owners to convert.
    expect(before.members.filter((row) => row.role === "owner")).toHaveLength(5);

    await applyD1Migrations(env.DB, fromRoles());

    const after = await memberRows();
    expect(after).toEqual(before.members.map((row) => (row.role === "owner" ? { ...row, role: "admin" } : row)));
    expect(after.filter((row) => row.role === "owner")).toEqual([]);
    expect(after.find((row) => row.workspaceId === "team" && row.userId === "u1")).toMatchObject({
      role: "admin",
      updatedAt: now + 1,
    });
    expect(after.find((row) => row.workspaceId === "team" && row.userId === "u3")?.role).toBe("member");
    expect(await snapshot(`SELECT * FROM workspaces ORDER BY id`)).toEqual(before.workspaces);
    expect(
      await snapshot(`SELECT id,workspace_id,access_mode,access_version,owner_id FROM boards ORDER BY id`),
    ).toEqual(before.boards);
    expect(await snapshot(`SELECT board_id,user_id,role FROM board_members ORDER BY board_id,user_id`)).toEqual(
      before.grants,
    );
    expect(await snapshot(`SELECT * FROM workspace_invites ORDER BY id`)).toEqual(before.invites);
  });

  it("keeps a workspace's last admin in the database itself", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    for (const id of ["a1", "a2", "a3"]) await user(id);
    await workspace("guarded", "a1");
    await member("guarded", "a1", "admin");
    await member("guarded", "a2", "admin");
    await member("guarded", "a3", "member");
    const demote = (userId: string) =>
      env.DB.prepare(`UPDATE workspace_members SET role='member' WHERE workspace_id='guarded' AND user_id=?`).bind(userId);
    const remove = (userId: string) =>
      env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id='guarded' AND user_id=?`).bind(userId);
    const admins = async () =>
      (
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id='guarded' AND role='admin'`).first<{
          n: number;
        }>()
      )?.n;

    // Two admins demoting each other at once: whichever the database runs second
    // meets a workspace with one admin left and is refused.
    const settled = await Promise.allSettled([demote("a1").run(), demote("a2").run()]);
    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await admins()).toBe(1);

    // The sole admin cannot be demoted, removed, or demoted inside a batch.
    const sole = (await env.DB.prepare(`SELECT user_id AS id FROM workspace_members WHERE workspace_id='guarded' AND role='admin'`).first<{ id: string }>())!.id;
    await expect(demote(sole).run()).rejects.toThrow(/at least one admin/);
    await expect(remove(sole).run()).rejects.toThrow(/at least one admin/);
    await expect(env.DB.batch([demote(sole)])).rejects.toThrow(/at least one admin/);
    expect(await admins()).toBe(1);

    // A batch that would end with no admin rolls back as a whole.
    const other = sole === "a1" ? "a2" : "a1";
    await env.DB.prepare(`UPDATE workspace_members SET role='admin' WHERE workspace_id='guarded' AND user_id=?`).bind(other).run();
    expect(await admins()).toBe(2);
    await expect(env.DB.batch([demote(sole), demote(other)])).rejects.toThrow(/at least one admin/);
    expect(await admins()).toBe(2);

    // Members come and go freely, and so does an admin while another remains.
    await remove("a3").run();
    await remove(other).run();
    expect(await admins()).toBe(1);

    // A workspace being deleted takes its members with it: the guard only holds
    // while the workspace exists.
    await env.DB.prepare(`DELETE FROM workspaces WHERE id='guarded'`).run();
    await env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id='guarded'`).run();
    expect(await admins()).toBe(0);
  });

  it("keeps the previous Worker's workspace writes working, and never lets an owner row survive", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await user("old");

    // The window between this migration and the new Worker: the old code still
    // creates a workspace as owner (one batch of two statements) and signs people up.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspaces(id,name,owner_id,default_board_access,created_at,updated_at) VALUES('legacy-ws','Legacy','old','workspace',?,?)`,
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES('legacy-ws','old','owner',?,?)`,
      ).bind(now, now),
    ]);
    await user("late-signup");
    expect(
      await snapshot(
        `SELECT workspace_id,user_id,role FROM workspace_members WHERE user_id IN ('old','late-signup') AND workspace_id IN ('legacy-ws','personal_late-signup') ORDER BY workspace_id`,
      ),
    ).toEqual([
      { workspace_id: "legacy-ws", user_id: "old", role: "admin" },
      { workspace_id: "personal_late-signup", user_id: "late-signup", role: "admin" },
    ]);
    expect((await memberRows()).filter((row) => row.role === "owner")).toEqual([]);

    // Its role change and removal statements keep their meaning: the creator is no
    // longer immutable, but the last admin still is.
    await user("peer");
    await member("legacy-ws", "peer", "member");
    await env.DB.prepare(
      `UPDATE workspace_members SET role='admin' WHERE workspace_id='legacy-ws' AND user_id='peer' AND role<>'owner'`,
    ).run();
    await env.DB.prepare(
      `UPDATE workspace_members SET role='member' WHERE workspace_id='legacy-ws' AND user_id='old' AND role<>'owner'`,
    ).run();
    await expect(
      env.DB.prepare(
        `DELETE FROM workspace_members WHERE workspace_id='legacy-ws' AND user_id='peer' AND role<>'owner'`,
      ).run(),
    ).rejects.toThrow(/at least one admin/);
  });
});
