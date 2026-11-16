import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Storage is shared by every test in a file, so a migration that has to run on a
 * pre-migration database owns its file, as `workspace-migration-corruption.test.ts`
 * does for 0012. The happy path is in `workspace-roles-migration.test.ts`.
 */
const now = Date.now();
const user = (id: string) =>
  env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`)
    .bind(id, `${id}@example.test`, id, now)
    .run();
const workspace = (id: string, ownerId: string) =>
  env.DB.prepare(
    `INSERT INTO workspaces(id,name,owner_id,default_board_access,created_at,updated_at) VALUES(?,?,?,'workspace',?,?)`,
  )
    .bind(id, id, ownerId, now, now)
    .run();
const member = (workspaceId: string, userId: string, role: string) =>
  env.DB.prepare(
    `INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)`,
  )
    .bind(workspaceId, userId, role, now, now)
    .run();
const memberRows = async () =>
  (
    await env.DB.prepare(
      `SELECT workspace_id AS workspaceId,user_id AS userId,role FROM workspace_members ORDER BY workspace_id,user_id`,
    ).all()
  ).results;

describe("workspace roles migration 0022 corruption", () => {
  it("fails loudly, changing nothing, when a workspace has no owner or admin, and succeeds after repair", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS.filter((m) => m.name < "0022"),
    );
    for (const id of ["c1", "c2"]) await user(id);
    // One workspace whose only person is a member, one with nobody at all: neither
    // could satisfy "a workspace always has at least one admin" once the old
    // triggers are gone, so converting around them would hide a broken workspace.
    await workspace("only-member", "c1");
    await member("only-member", "c2", "member");
    await workspace("empty", "c1");
    const before = await memberRows();
    const rest = env.TEST_MIGRATIONS.filter((m) => m.name >= "0022");

    await expect(applyD1Migrations(env.DB, rest)).rejects.toThrow(/malformed JSON/);

    // Atomic: the owners are still owners, the old triggers still guard them, and
    // the ledger does not list the migration.
    expect(await memberRows()).toEqual(before);
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM d1_migrations WHERE name LIKE '0022%'`).first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name='workspace_owner_membership_update'`,
        ).first<{ n: number }>()
      )?.n,
    ).toBe(1);
    // SQLite reports the failing `json()` as "malformed JSON" without echoing the
    // message, so the ids come from the same diagnostic the migration runs.
    expect(
      (
        await env.DB.prepare(
          `SELECT group_concat(id) AS offenders FROM (SELECT w.id FROM workspaces w
            WHERE NOT EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.role IN ('owner','admin'))
            ORDER BY w.id)`,
        ).first<{ offenders: string }>()
      )?.offenders,
    ).toBe("empty,only-member");

    // Repaired, the same migration goes through.
    await member("empty", "c1", "owner");
    await member("only-member", "c1", "owner");
    await applyD1Migrations(env.DB, rest);
    expect((await memberRows()).filter((row) => row.role === "owner")).toEqual([]);
  });
});
