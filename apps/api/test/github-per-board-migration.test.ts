import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://foxban.test";

describe("per-board GitHub migration 0020", () => {
  it("drops the old bindings and connection states without touching the boards that held them", async () => {
    // The database as it was while boards owned a repository (ADR 0041).
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < "0020"));
    const signup = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bound@foxban.test", name: "Bound", password: "correct horse battery" }),
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const created = await SELF.fetch(`${ORIGIN}/boards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Bound board", key: "BND", workspaceId: await firstWorkspaceId(cookie) }),
    });
    const { id } = await created.json<{ id: string }>();
    await env.DB.prepare(
      `UPDATE boards SET github_installation_id = 7, github_repository_id = 101,
         github_repository_owner = 'Fork-Org', github_repository_name = 'api' WHERE id = ?`,
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      `INSERT INTO github_connection_states(state, user_id, board_id, repository_owner, repository_name, expires_at)
       VALUES ('pending', 'u', ?, 'Fork-Org', 'api', 1)`,
    )
      .bind(id)
      .run();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const columns = (await env.DB.prepare("SELECT name FROM pragma_table_info('boards')").all<{ name: string }>()).results.map((c) => c.name);
    expect(columns.filter((name) => name.startsWith("github_"))).toEqual([]);
    expect(columns).toContain("board_key");
    const leftover = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'github_connection_states'").first();
    expect(leftover).toBeNull();

    const boards = await (await SELF.fetch(`${ORIGIN}/boards`, { headers: { cookie } })).json<Array<{ id: string; name: string; key: string }>>();
    expect(boards.find((board) => board.id === id)).toMatchObject({ name: "Bound board", key: "BND" });
  });
});
