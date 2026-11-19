import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { firstWorkspaceId } from "./first-workspace";

/** Small hardening fixes from the ponytail audit: CSRF origin check (ADR 0083), bounded uploads, candidate scope, GitHub disconnect. */

const ORIGIN = "https://foxban.test";
const PASSWORD = "correct horse battery";
const request = (path: string, method: string, body?: unknown, cookie?: string, extra?: HeadersInit) =>
  SELF.fetch(ORIGIN + path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function signup(email: string, invite?: string) {
  const response = await request("/auth/signup", "POST", { email, name: "Person", password: PASSWORD, ...(invite ? { invite } : {}) });
  expect(response.status).toBe(200);
  const cookie = cookieOf(response);
  return { cookie, email, id: (await (await request("/me", "GET", undefined, cookie)).json<{ id: string }>()).id };
}
const admin = () => signup(`admin-${crypto.randomUUID()}@foxban.test`);
async function ordinary(owner: { cookie: string }) {
  const { token } = await (await request("/invites", "POST", {}, owner.cookie)).json<{ token: string }>();
  return signup(`person-${crypto.randomUUID()}@example.test`, token);
}

describe("CSRF origin check", () => {
  it("refuses a cross-origin text/plain write and accepts the same-origin JSON one", async () => {
    const { cookie } = await admin();
    const cross = await SELF.fetch(`${ORIGIN}/workspaces`, {
      method: "POST",
      headers: { cookie, "content-type": "text/plain", origin: "https://evil.test", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ name: "Forged" }),
    });
    expect(cross.status).toBe(403);
    const same = await request("/workspaces", "POST", { name: "Real" }, cookie, { origin: ORIGIN, "sec-fetch-site": "same-origin" });
    expect(same.status).toBe(201);
  });

  it("refuses a cross-site write whatever its content type, and an opaque origin", async () => {
    const { cookie } = await admin();
    const ping = await SELF.fetch(`${ORIGIN}/auth/logout`, { method: "POST", headers: { cookie, "content-type": "text/ping", "sec-fetch-site": "same-site", origin: "https://sibling.foxban.test" } });
    expect(ping.status).toBe(403);
    const opaque = await request("/workspaces", "POST", { name: "Forged" }, cookie, { origin: "null" });
    expect(opaque.status).toBe(403);
    expect((await request("/me", "GET", undefined, cookie)).status).toBe(200);
  });

  it("refuses a socket upgrade from another origin", async () => {
    const { cookie } = await admin();
    const upgrade = await SELF.fetch(`${ORIGIN}/presence/ws`, { headers: { cookie, upgrade: "websocket", origin: "https://sibling.foxban.test" } });
    expect(upgrade.status).toBe(403);
  });
});

describe("bounded uploads", () => {
  it("refuses an avatar over the limit that declares no content-length", async () => {
    const { cookie } = await admin();
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 11) controller.enqueue(chunk); else controller.close(); } });
    const response = await SELF.fetch(`${ORIGIN}/me/avatar`, { method: "POST", headers: { cookie, "content-type": "image/png" }, body, duplex: "half" } as RequestInit);
    expect(response.status).toBe(413);
  });
});

describe("membership candidates", () => {
  it("lists workspace members for a workspace member but not for a Guest", async () => {
    const owner = await admin();
    const colleague = await ordinary(owner);
    const guest = await ordinary(owner);
    const workspaceId = await firstWorkspaceId(owner.cookie);
    const board = await (await request("/boards", "POST", { name: "Private", key: `P${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, workspaceId, accessMode: "restricted" }, owner.cookie)).json<{ id: string }>();
    await env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,'member',0,0)").bind(workspaceId, colleague.id).run();
    await env.DB.prepare("INSERT INTO board_members(board_id,user_id,role) VALUES(?,?,'member')").bind(board.id, guest.id).run();

    const asOwner = await request(`/boards/${board.id}/membership-candidates`, "GET", undefined, owner.cookie);
    expect((await asOwner.json<{ candidates: { id: string }[] }>()).candidates.map((c) => c.id)).toContain(colleague.id);
    const asGuest = await request(`/boards/${board.id}/membership-candidates`, "GET", undefined, guest.cookie);
    expect(asGuest.status).toBe(200);
    expect((await asGuest.json<{ candidates: unknown[] }>()).candidates).toEqual([]);
  });
});

describe("disconnecting GitHub", () => {
  it("ends the account's other sessions", async () => {
    const owner = await admin();
    await env.DB.prepare("UPDATE users SET github_login='octo', github_user_id=4242 WHERE id=?").bind(owner.id).run();
    const other = cookieOf(await request("/auth/login", "POST", { email: owner.email, password: PASSWORD }));
    expect((await request("/me", "GET", undefined, other)).status).toBe(200);

    expect((await request("/me", "PATCH", { githubLogin: null }, owner.cookie)).status).toBe(200);
    expect((await request("/me", "GET", undefined, other)).status).toBe(401);
    expect((await request("/me", "GET", undefined, owner.cookie)).status).toBe(200);
  });
});
