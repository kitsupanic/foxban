import { applyD1Migrations,env } from "cloudflare:test";
import { describe,expect,it } from "vitest";

/**
 * The 0012 creation triggers reject an owner or grant that does not exist, so
 * inconsistent legacy data can only be seeded before 0012 is applied. This file
 * owns that pre-migration fixture; `workspace-migration.test.ts` runs after the
 * schema is already in place.
 */
describe("workspace migration corruption",()=>{
  it("aborts atomically on inconsistent legacy ownership, naming the offending ids, and succeeds after repair",async()=>{
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(0,11));
    const now=Date.now();
    await env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES('real','real@example.test','Real','hash',?)`).bind(now).run();
    // A board whose recorded owner no longer exists, plus a grant pointing at a
    // deleted board: both abort the migration before it changes anything.
    await env.DB.prepare(`INSERT INTO boards(id,name,owner_id,created_at,board_key) VALUES('orphan','Orphan','ghost',?,'ORPHAN')`).bind(now).run();
    await env.DB.prepare(`INSERT INTO board_members(board_id,user_id) VALUES('missing-board','real')`).run();

    // SQLite reports the failing `json()` as "malformed JSON" without echoing the
    // message, so the ids come from the same diagnostic the migration runs.
    await expect(applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(11))).rejects.toThrow(/malformed JSON/);
    const orphanIds=await env.DB.prepare(
      `SELECT group_concat(b.id || ':' || b.owner_id) AS offenders FROM boards b LEFT JOIN users u ON u.id=b.owner_id WHERE u.id IS NULL`,
    ).first<{offenders:string}>();
    expect(orphanIds?.offenders).toBe("orphan:ghost");
    const tablesAfterAbort=await env.DB.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='workspaces'`).first<{n:number}>();
    expect(tablesAfterAbort?.n).toBe(0);
    const ledger=await env.DB.prepare(`SELECT COUNT(*) AS n FROM d1_migrations WHERE name LIKE '0012%'`).first<{n:number}>();
    expect(ledger?.n).toBe(0);

    // The dangling grant is reported on its own once the owner is authoritative.
    await env.DB.prepare(`UPDATE boards SET owner_id='real' WHERE id='orphan'`).run();
    await expect(applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(11))).rejects.toThrow(/malformed JSON/);
    const grantIds=await env.DB.prepare(
      `SELECT group_concat(bm.board_id || ':' || bm.user_id) AS offenders FROM board_members bm LEFT JOIN boards b ON b.id=bm.board_id LEFT JOIN users u ON u.id=bm.user_id WHERE b.id IS NULL OR u.id IS NULL`,
    ).first<{offenders:string}>();
    expect(grantIds?.offenders).toBe("missing-board:real");

    await env.DB.prepare(`DELETE FROM board_members WHERE board_id='missing-board'`).run();
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS.slice(11));
    expect(await env.DB.prepare(`SELECT workspace_id AS workspaceId,access_mode AS accessMode FROM boards WHERE id='orphan'`).first()).toEqual({workspaceId:"personal_real",accessMode:"restricted"});
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE role='admin'`).first<{n:number}>())?.n).toBe(1);
  });
});
