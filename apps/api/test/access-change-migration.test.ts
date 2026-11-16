import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** Every kind the closed CHECK 0012 shipped allowed. */
const LEGACY_KINDS = [
  "workspace-member-role",
  "workspace-member-remove",
  "workspace-invite-accept",
  "board-member-add",
  "board-member-remove",
  "board-move",
  "board-delete",
] as const;

/** Every column 0012 created, read back by name so a dropped column cannot pass. */
const COLUMNS = `id,actor_id AS actorId,kind,payload_json AS payloadJson,payload_hash AS payloadHash,
  phase,outcome,result_json AS resultJson,notify_user_ids_json AS notifyUserIds,notified,
  effect_started AS effectStarted,created_at AS createdAt,updated_at AS updatedAt`;

const JOURNAL_INSERT = `INSERT INTO access_change_operations
  (id,actor_id,kind,payload_json,payload_hash,phase,outcome,result_json,notify_user_ids_json,notified,effect_started,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`;

describe("access change journal migration 0013", () => {
  it("widens the closed kind set while preserving every journal row, column and index", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 12));
    const now = Date.now();
    for (const [index, kind] of LEGACY_KINDS.entries()) {
      const preparing = index === 0;
      await env.DB.prepare(JOURNAL_INSERT)
        .bind(
          `op-${index}`,
          `actor-${index}`,
          kind,
          `{"index":${index}}`,
          `hash-${index}`,
          preparing ? "preparing" : "completed",
          preparing ? null : "committed",
          preparing ? null : `{"ok":${index}}`,
          `[{"id":"recipient-${index}","workspaces":["workspace-${index}"],"boards":[]}]`,
          preparing ? 0 : 1,
          0,
          now + index,
          now + index,
        )
        .run();
    }
    // The unfinished attempt a recovery pass would have to pick up: its reserved
    // generation and its workspace lock live beside the journal row.
    await env.DB.prepare(
      `INSERT INTO access_change_boards(operation_id,board_id,expected_version,next_version,prepared,released)
       VALUES('op-0','board-1',3,4,1,0)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO access_change_scopes(workspace_id,operation_id) VALUES('workspace-0','op-0')`,
    ).run();

    const before = (
      await env.DB.prepare(`SELECT ${COLUMNS} FROM access_change_operations ORDER BY id`).all()
    ).results;
    expect(before).toHaveLength(LEGACY_KINDS.length);

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(12));

    // Rows are identical, read back through every column 0012 created.
    expect(
      (await env.DB.prepare(`SELECT ${COLUMNS} FROM access_change_operations ORDER BY id`).all())
        .results,
    ).toEqual(before);
    // The rebuild's staging table is gone; the surviving index is 0012's.
    expect(
      (
        await env.DB.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'access_change_operations%' ORDER BY name`,
        ).all<{ name: string }>()
      ).results,
    ).toEqual([{ name: "access_change_operations" }]);
    expect(
      (
        await env.DB.prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='access_change_operations'
             AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        ).all<{ name: string }>()
      ).results,
    ).toEqual([{ name: "access_change_operations_unfinished" }]);
    // No foreign key was introduced by the rebuild.
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM pragma_foreign_key_list('access_change_operations')`,
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    // The participants and the lock of the unfinished attempt are untouched, and it
    // is still the row recovery would resume.
    expect(
      await env.DB.prepare(
        `SELECT board_id AS boardId,expected_version AS expectedVersion,next_version AS nextVersion,prepared,released
           FROM access_change_boards WHERE operation_id='op-0'`,
      ).first(),
    ).toEqual({ boardId: "board-1", expectedVersion: 3, nextVersion: 4, prepared: 1, released: 0 });
    expect(
      await env.DB.prepare(
        `SELECT workspace_id AS workspaceId,operation_id AS operationId FROM access_change_scopes`,
      ).first(),
    ).toEqual({ workspaceId: "workspace-0", operationId: "op-0" });

    // The widened set accepts the direct add, and a kind outside it is still refused.
    await env.DB.prepare(JOURNAL_INSERT)
      .bind(
        "op-direct-add",
        "actor",
        "workspace-member-add",
        `{"workspaceId":"workspace-0","userId":"user","role":"member"}`,
        "hash",
        "preparing",
        null,
        null,
        "[]",
        0,
        0,
        now,
        now,
      )
      .run();
    expect(
      await env.DB.prepare(`SELECT kind FROM access_change_operations WHERE id='op-direct-add'`).first(),
    ).toEqual({ kind: "workspace-member-add" });
    await expect(
      env.DB.prepare(JOURNAL_INSERT)
        .bind("op-unknown", "actor", "workspace-member-transfer", "{}", "hash", "preparing", null, null, "[]", 0, 0, now, now)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });
});
