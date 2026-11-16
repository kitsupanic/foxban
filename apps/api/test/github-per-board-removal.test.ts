import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { firstWorkspaceId } from "./first-workspace";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The per-board GitHub integration (ADR 0041) is gone (ADR 0064): its routes are no
 * longer part of the Worker, and a board carries no repository of its own. Everything
 * goes through the real Worker, as a signed-in board owner would.
 */
const ORIGIN = "https://foxban.test";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

let counter = 0;
async function signedInBoard() {
  const n = ++counter;
  const signup = await SELF.fetch(`${ORIGIN}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `owner${n}@foxban.test`, name: "Owner", password: "correct horse battery" }),
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  const created = await SELF.fetch(`${ORIGIN}/boards`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Old board", key: `OLD${n}`, workspaceId: await firstWorkspaceId(cookie) }),
  });
  expect(created.status).toBe(200);
  return { cookie, board: await created.json<Record<string, unknown> & { id: string }>() };
}

describe("the per-board GitHub routes", () => {
  it("are removed: each answers as a path the Worker does not have", async () => {
    const { cookie, board } = await signedInBoard();
    const card = crypto.randomUUID();
    const json = { "content-type": "application/json", cookie };
    const removed: Array<[string, string, string?]> = [
      ["GET", `/boards/${board.id}/github/connect?repository=Fork-Org/api`],
      ["GET", "/auth/github-app/setup?installation_id=1&state=x"],
      ["GET", "/auth/github-app/callback?code=x&state=y"],
      ["DELETE", `/boards/${board.id}/github`],
      ["GET", `/boards/${board.id}/cards/${card}/github`],
      ["POST", `/boards/${board.id}/cards/${card}/github/branch`, "{}"],
      ["POST", `/boards/${board.id}/cards/${card}/github/pull-request`, "{}"],
      ["GET", `/boards/${board.id}/cards/${card}/github/pull-request`],
      ["PUT", `/boards/${board.id}/cards/${card}/github/pull-request`, JSON.stringify({ pullRequest: "5" })],
      ["GET", `/boards/${board.id}/github/pull-requests?cardId=${card}`],
    ];
    for (const [method, path, body] of removed) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, { method, headers: json, body, redirect: "manual" });
      expect({ path, status: response.status, body: await response.text() }).toEqual({ path, status: 404, body: "404 Not Found" });
    }
  });
});

describe("a board", () => {
  it("carries no GitHub repository of its own", async () => {
    const { cookie, board } = await signedInBoard();
    expect(board).not.toHaveProperty("githubRepository");

    const listed = await (await SELF.fetch(`${ORIGIN}/boards`, { headers: { cookie } })).json<Array<Record<string, unknown>>>();
    expect(listed.length).toBeGreaterThan(0);
    for (const row of listed) expect(row).not.toHaveProperty("githubRepository");
  });
});
