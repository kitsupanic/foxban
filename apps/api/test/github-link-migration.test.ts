import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://foxban.test";

describe("GitHub link migration 0016", () => {
  it("clears links made under the old OAuth App, so people link again once", async () => {
    // The database as it was before the instance GitHub App: a user with a link and no GitHub id.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < "0016"));
    const signup = await SELF.fetch(`${ORIGIN}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "linked@foxban.test", name: "Linked", password: "correct horse battery" }),
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    await env.DB.prepare("UPDATE users SET github_login = 'octocat' WHERE email = 'linked@foxban.test'").run();
    expect(await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie } })).json()).toMatchObject({ githubLogin: "octocat" });

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    // Migration 0026 ends every session (ADR 0084): the old cookie is refused, and one sign-in brings the account back.
    expect((await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie } })).status).toBe(401);
    const login = await SELF.fetch(`${ORIGIN}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "linked@foxban.test", password: "correct horse battery" }),
    });
    expect(login.status).toBe(200);
    const fresh = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(await (await SELF.fetch(`${ORIGIN}/me`, { headers: { cookie: fresh } })).json()).toMatchObject({ githubLogin: null });
  });
});
