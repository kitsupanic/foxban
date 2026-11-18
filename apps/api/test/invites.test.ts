import { SELF, applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";

/**
 * Invite-gated signup driven through the real Worker, like auth.test.ts: admin
 * status comes from the ADMIN_EMAILS binding that vitest.config.ts injects
 * (`*@wild.test, Mixed@Case.Test`): exact addresses only, so the wildcard counts
 * for nothing. @foxban.test accounts are admins because their signup lists them
 * (test/admin-signups.ts); anything on @user.test needs a token.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const PASSWORD = "correct horse battery";
const ORIGIN = "https://foxban.test";

type InviteRow = {
  token: string;
  createdAt: number;
  usedBy: string | null;
  usedAt: number | null;
};

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("response carried no Set-Cookie header");
  return header.split(";")[0]!;
}

function request(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Signs up `email`, optionally spending `invite`, and returns the raw response. */
function signup(email: string, invite?: string): Promise<Response> {
  return request("POST", "/auth/signup", {
    email,
    name: "Test User",
    password: PASSWORD,
    ...(invite === undefined ? {} : { invite }),
  });
}

/** An admin session, which is the only thing that can mint invites. */
async function adminSession(email: string): Promise<string> {
  const response = await signup(email);
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

async function mintInvite(cookie: string): Promise<string> {
  const response = await request("POST", "/invites", undefined, cookie);
  expect(response.status).toBe(201);
  return (await response.json<{ token: string }>()).token;
}

async function listInvites(cookie: string): Promise<InviteRow[]> {
  const response = await request("GET", "/invites", undefined, cookie);
  expect(response.status).toBe(200);
  return (await response.json<{ invites: InviteRow[] }>()).invites;
}

/**
 * The test pool shares D1 across a file, so every assertion about the table is
 * scoped to the tokens the test itself minted (same reason the suite uses unique
 * emails) rather than to the whole list.
 */
async function listOwn(cookie: string, ...tokens: string[]): Promise<InviteRow[]> {
  const invites = await listInvites(cookie);
  return invites.filter((row) => tokens.includes(row.token));
}

describe("admin identification", () => {
  it("reports isAdmin on signup, login and /me for a listed address", async () => {
    const signedUp = await signup("listed@foxban.test");
    expect(await signedUp.json()).toMatchObject({ email: "listed@foxban.test", isAdmin: true });

    const cookie = sessionCookie(signedUp);
    expect(await (await request("GET", "/me", undefined, cookie)).json()).toMatchObject({
      isAdmin: true,
    });

    const loggedIn = await request("POST", "/auth/login", {
      email: "listed@foxban.test",
      password: PASSWORD,
    });
    expect(await loggedIn.json()).toMatchObject({ isAdmin: true });
  });

  it("matches an exact entry regardless of case", async () => {
    // The binding spells this address `Mixed@Case.Test`.
    const response = await signup("MIXED@case.test");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: "mixed@case.test", isAdmin: true });
  });

  it("ignores a *@domain entry: nobody can sign up as an admin on that domain", async () => {
    // The binding lists `*@wild.test`. Anyone can type an address on a domain, so it grants nothing.
    const refused = await signup("stranger@wild.test");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "a valid invite is required to sign up" });
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind("stranger@wild.test").first()).toBeNull();

    // With an invite the account exists, as a plain user and with no admin power.
    const admin = await adminSession("wildcard-gate@foxban.test");
    const invited = await signup("member@wild.test", await mintInvite(admin));
    expect(await invited.json()).toMatchObject({ email: "member@wild.test", isAdmin: false });
    expect((await request("GET", "/invites", undefined, sessionCookie(invited))).status).toBe(403);
    expect((await request("GET", "/invites", undefined, admin)).status).toBe(200);
  });

  it("does not treat a lookalike domain or address as admin", async () => {
    const admin = await adminSession("gate@foxban.test");
    for (const email of ["nope@notfoxban.test", "mixed@case.test.evil.dev", "other@case.test"]) {
      const invited = await signup(email, await mintInvite(admin));
      expect(invited.status).toBe(200);
      expect(await invited.json()).toMatchObject({ email, isAdmin: false });
    }
  });
});

describe("invite-gated signup", () => {
  it("lets an admin sign up with no invite at all", async () => {
    const response = await signup("noinvite@foxban.test");
    expect(response.status).toBe(200);
    const user = await response.json<{ id: string }>();
    // No token was passed, so none can have been charged to this account.
    expect(
      await env.DB.prepare("SELECT token FROM invites WHERE used_by = ?").bind(user.id).first(),
    ).toBeNull();
  });

  it("ignores an invite an admin passes anyway, leaving it unspent", async () => {
    const admin = await adminSession("ignores@foxban.test");
    const token = await mintInvite(admin);

    expect((await signup("second.admin@foxban.test", token)).status).toBe(200);
    expect(await listOwn(admin, token)).toMatchObject([{ token, usedBy: null, usedAt: null }]);
  });

  it("refuses a non-admin with a missing, unknown or already spent token, identically", async () => {
    const admin = await adminSession("refuses@foxban.test");
    const token = await mintInvite(admin);

    const missing = await signup("nothing@user.test");
    expect(missing.status).toBe(403);
    const generic = await missing.json();
    // Generic on purpose: signup must not reveal whether a token exists.
    expect(generic).toEqual({ error: "a valid invite is required to sign up" });

    const unknown = await signup("unknown@user.test", "not-a-real-token");
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual(generic);

    const accepted = await signup("spends@user.test", token);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ email: "spends@user.test", isAdmin: false });

    const reused = await signup("reuses@user.test", token);
    expect(reused.status).toBe(403);
    expect(await reused.json()).toEqual(generic);
    // The second attempt created no user.
    expect(
      await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind("reuses@user.test").first(),
    ).toBeNull();
  });

  it("records who spent a token, and when", async () => {
    const admin = await adminSession("records@foxban.test");
    const token = await mintInvite(admin);
    const before = Date.now();

    const response = await signup("recorded@user.test", token);
    const user = await response.json<{ id: string }>();

    const [row] = await listOwn(admin, token);
    expect(row).toMatchObject({ token, usedBy: user.id });
    expect(row!.usedAt).toBeGreaterThanOrEqual(before);
  });

  it("leaves the token spendable when the signup itself fails", async () => {
    const admin = await adminSession("rollback@foxban.test");
    const token = await mintInvite(admin);
    expect((await signup("taken@user.test", token)).status).toBe(200);

    const second = await mintInvite(admin);
    // Consuming the token and creating the user are one transaction, so the
    // duplicate-email failure must roll the consumption back.
    const duplicate = await signup("taken@user.test", second);
    expect(duplicate.status).toBe(409);

    expect(await listOwn(admin, second)).toMatchObject([{ usedBy: null, usedAt: null }]);
  });
});

describe("signup with no usable admin configured", () => {
  const noAdmin = (env_: string | undefined) => worker.fetch!(new Request(`${ORIGIN}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "first@user.test", name: "First", password: PASSWORD }),
  }), { ...env, ADMIN_EMAILS: env_ } as unknown as typeof env, createExecutionContext());

  it("answers a no-invite signup with ADMIN_NOT_CONFIGURED when ADMIN_EMAILS is unset or blank", async () => {
    for (const value of [undefined, "", "  , "]) {
      const response = await noAdmin(value);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "ADMIN_NOT_CONFIGURED" });
    }
  });

  it("counts only exact addresses as an admin being configured: a list of wildcards alone is none", async () => {
    for (const value of ["*@user.test", " *@user.test , *@other.test"]) {
      const response = await noAdmin(value);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "ADMIN_NOT_CONFIGURED" });
    }
    // An exact entry is a configured admin, even next to a wildcard: the stranger now just needs an invite.
    const response = await noAdmin("*@user.test, someone@else.test");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "a valid invite is required to sign up" });
  });

  it("keeps a bad invite generic even then", async () => {
    const response = await worker.fetch!(new Request(`${ORIGIN}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "first@user.test", name: "First", password: PASSWORD, invite: "nope" }),
    }), { ...env, ADMIN_EMAILS: "" } as unknown as typeof env, createExecutionContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "a valid invite is required to sign up" });
  });
});

describe("the invite routes", () => {
  it("answers 401 without a session and 403 for a non-admin", async () => {
    const admin = await adminSession("acl@foxban.test");
    const token = await mintInvite(admin);
    const outsider = sessionCookie(await signup("outsider@user.test", await mintInvite(admin)));

    for (const [method, path] of [
      ["GET", "/invites"],
      ["POST", "/invites"],
      ["DELETE", `/invites/${token}`],
    ] as const) {
      const anonymous = await request(method, path);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ error: "unauthorized" });

      const nonAdmin = await request(method, path, undefined, outsider);
      expect(nonAdmin.status).toBe(403);
      expect(await nonAdmin.json()).toEqual({ error: "forbidden" });
    }

    // None of the refused calls minted or revoked anything.
    expect(await listOwn(admin, token)).toMatchObject([{ token, usedAt: null }]);
  });

  it("mints base64url tokens, lists them newest first and revokes unused ones", async () => {
    const admin = await adminSession("roundtrip@foxban.test");

    const first = await mintInvite(admin);
    const second = await mintInvite(admin);
    // 32 random bytes, base64url, unpadded.
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);

    // Newest first, and only these two are this test's business.
    expect((await listOwn(admin, first, second)).map((row) => row.token)).toEqual([second, first]);

    const revoked = await request("DELETE", `/invites/${first}`, undefined, admin);
    expect(revoked.status).toBe(200);
    expect((await listOwn(admin, first, second)).map((row) => row.token)).toEqual([second]);

    // A revoked token is gone for signup too.
    expect((await signup("revoked@user.test", first)).status).toBe(403);
  });

  it("404s a token that is unknown or already spent", async () => {
    const admin = await adminSession("delete404@foxban.test");
    const token = await mintInvite(admin);

    const unknown = await request("DELETE", "/invites/nope", undefined, admin);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "invite not found" });

    expect((await signup("spent@user.test", token)).status).toBe(200);
    // Spent rows are kept as the audit trail rather than deleted.
    expect((await request("DELETE", `/invites/${token}`, undefined, admin)).status).toBe(404);
    expect(await listOwn(admin, token)).toMatchObject([{ token, usedAt: expect.any(Number) }]);
  });
});
