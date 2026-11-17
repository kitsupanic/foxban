import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { boardMemberIdsSql, boardMemberSql } from "../src/auth";

/**
 * Effective board membership (`boardMemberSql`, and its listing form `boardMemberIdsSql`) over every access mode, workspace
 * role and explicit role, run against real D1 rows. The board's owner and a
 * workspace admin get no membership from those facts alone.
 */
const MODES = ["workspace", "restricted"] as const;
const WORKSPACE_ROLES = [null, "member", "admin"] as const;
const EXPLICIT_ROLES = [null, "member", "manager"] as const;
const WORKSPACE = "member-rule-ws";
const OWNER = "member-rule-owner";
const userId = (ws: string | null, ex: string | null) => `member-rule-${ws ?? "none"}-${ex ?? "none"}`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = Date.now();
  const users = [OWNER, ...WORKSPACE_ROLES.flatMap((ws) => EXPLICIT_ROLES.map((ex) => userId(ws, ex)))];
  await env.DB.batch([
    ...users.map((id) =>
      env.DB.prepare(`INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'hash',?)`).bind(id, `${id}@example.test`, id, now),
    ),
    env.DB.prepare(`INSERT INTO workspaces(id,name,owner_id,created_at,updated_at) VALUES(?,'Rule',?,?,?)`).bind(WORKSPACE, OWNER, now, now),
    ...MODES.map((mode) =>
      env.DB.prepare(`INSERT INTO boards(id,name,board_key,owner_id,workspace_id,access_mode,created_at) VALUES(?,?,?,?,?,?,?)`)
        .bind(`member-rule-${mode}`, mode, `MR${mode.slice(0, 1).toUpperCase()}`, OWNER, WORKSPACE, mode, now),
    ),
    ...WORKSPACE_ROLES.flatMap((ws) =>
      EXPLICIT_ROLES.map((ex) => ({ ws, ex })).filter(({ ws }) => ws !== null).map(({ ws, ex }) =>
        env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?)`).bind(WORKSPACE, userId(ws, ex), ws, now, now),
      ),
    ),
    ...MODES.flatMap((mode) =>
      WORKSPACE_ROLES.flatMap((ws) =>
        EXPLICIT_ROLES.filter((ex) => ex !== null).map((ex) =>
          env.DB.prepare(`INSERT INTO board_members(board_id,user_id,role) VALUES(?,?,?)`).bind(`member-rule-${mode}`, userId(ws, ex), ex),
        ),
      ),
    ),
  ]);
});

describe("effective board membership", () => {
  const cases = MODES.flatMap((mode) =>
    WORKSPACE_ROLES.flatMap((ws) =>
      EXPLICIT_ROLES.map((ex) => ({ mode, ws, ex, member: ex !== null || (mode === "workspace" && ws !== null) })),
    ),
  );

  it.each(cases)("$mode board, workspace $ws, explicit $ex → member $member", async ({ mode, ws, ex, member }) => {
    const bound = await env.DB.prepare(`SELECT 1 AS present FROM boards b WHERE b.id=? AND ${boardMemberSql("b", "?")}`)
      .bind(`member-rule-${mode}`, userId(ws, ex), userId(ws, ex))
      .first();
    expect(bound !== null).toBe(member);
  });

  it.each(MODES)("lists the same members through the id subquery, and not the owner, on a %s board", async (mode) => {
    const { results } = await env.DB.prepare(`SELECT u.id FROM boards b JOIN users u ON u.id IN (${boardMemberIdsSql("b")}) WHERE b.id=?`)
      .bind(`member-rule-${mode}`)
      .all<{ id: string }>();
    const expected = cases.filter((c) => c.mode === mode && c.member).map((c) => userId(c.ws, c.ex));
    expect(results.map((r) => r.id).sort()).toEqual(expected.sort());
  });
});
