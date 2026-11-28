import { SELF, applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { loadInstanceGitHubApp } from "../src/github-app";

/**
 * The instance GitHub App (ADR 0064), driven through the real Worker like
 * auth.test.ts. GitHub is faked at fetch: `GITHUB_API_BASE` is
 * https://api.github.example and `GITHUB_OAUTH_BASE` https://github.example.
 * A signup on `@foxban.test` is an admin (admin-signups.ts).
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// The pool shares D1 across the file, and the instance has at most one App.
beforeEach(async () => {
  await env.DB.exec("DELETE FROM github_app");
});

const PASSWORD = "correct horse battery";
const ORIGIN = "https://foxban.test";
// vitest.config.ts pins APP_ORIGIN, so that is the origin the manifest names.
const APP_ORIGIN = "https://app.example";

function request(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let counter = 0;
/** Signs up a fresh user (an admin when `admin`, else through a minted invite) and returns the session cookie. */
async function session(admin: boolean): Promise<string> {
  const n = ++counter;
  const signup = (email: string, invite?: string) =>
    request("POST", "/auth/signup", { email, name: "Test User", password: PASSWORD, ...(invite ? { invite } : {}) });
  const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;
  const adminResponse = await signup(`gh-admin-${n}@foxban.test`);
  expect(adminResponse.status).toBe(200);
  if (admin) return cookieOf(adminResponse);
  const invite = await request("POST", "/invites", undefined, cookieOf(adminResponse));
  const { token } = await invite.json<{ token: string }>();
  const response = await signup(`gh-user-${n}@user.test`, token);
  expect(response.status).toBe(200);
  return cookieOf(response);
}

type Manifest = {
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
};
type ManifestStart = { url: string; manifest: Manifest };

/** The state GitHub will echo back, taken from the form target the Admin posts the manifest to. */
const stateOf = (start: ManifestStart) => new URL(start.url).searchParams.get("state")!;

describe("starting the GitHub App creation", () => {
  it("hands an admin a manifest built for this instance and the state to carry through GitHub", async () => {
    const admin = await session(true);
    const response = await request("POST", "/github-app/manifest", {}, admin);
    expect(response.status).toBe(200);
    const start = await response.json<ManifestStart>();

    expect(start.url.startsWith("https://github.example/settings/apps/new?state=")).toBe(true);
    expect(response.headers.get("set-cookie")).toContain(`github_app_manifest_state=${stateOf(start)}`);

    expect(start.manifest).toMatchObject({
      url: APP_ORIGIN,
      // GitHub lets only the owner's side authorize a private App, which would lock everyone else out of Log in with GitHub.
      public: true,
      hook_attributes: { url: `${APP_ORIGIN}/webhooks/github`, active: true },
      redirect_url: `${APP_ORIGIN}/auth/github-app/manifest/callback`,
      setup_url: `${APP_ORIGIN}/account-github`,
      default_permissions: { contents: "write", pull_requests: "write", emails: "read" },
    });
    expect(start.manifest.callback_urls).toContain(`${APP_ORIGIN}/auth/github/callback`);
    expect(start.manifest.default_events).toEqual([
      "pull_request",
      "push",
      "create",
      "delete",
    ]);
  });

  it("creates the App under an organization when one is named", async () => {
    const admin = await session(true);
    const response = await request("POST", "/github-app/manifest", { organization: "Fork-Org" }, admin);
    const start = await response.json<ManifestStart>();
    expect(start.url.startsWith("https://github.example/organizations/Fork-Org/settings/apps/new?state=")).toBe(true);

    expect((await request("POST", "/github-app/manifest", { organization: "../evil" }, admin)).status).toBe(400);
  });

  it("is refused for regular users and signed-out visitors", async () => {
    const user = await session(false);
    expect((await request("POST", "/github-app/manifest", {}, user)).status).toBe(403);
    expect((await request("POST", "/github-app/manifest", {})).status).toBe(401);
  });
});

const SECRETS = {
  pem: "-----BEGIN RSA PRIVATE KEY-----\nFAKE-PRIVATE-KEY-BODY-7f3a\n-----END RSA PRIVATE KEY-----\n",
  webhook_secret: "fake-webhook-secret-9c1d",
  client_secret: "fake-client-secret-4b8e",
};
const conversion = (overrides: Record<string, unknown> = {}) => ({
  id: 424242,
  slug: "foxban-test",
  client_id: "Iv1.fakeclientid",
  ...SECRETS,
  ...overrides,
});

/**
 * Fakes GitHub's manifest conversion at api.github.example: "good-code" converts
 * to `conversion()`, "other-code" to a second App, and any other code is a 404 like
 * GitHub's. Every other request passes through.
 */
function fakeGitHub(overrides: Record<string, unknown> = {}) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const match = url.origin === "https://api.github.example" && url.pathname.match(/^\/app-manifests\/([^/]+)\/conversions$/);
    if (!match) return original(input, init);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method !== "POST") return Response.json({ message: "Not Found" }, { status: 404 });
    if (match[1] === "good-code") return Response.json(conversion(overrides), { status: 201 });
    if (match[1] === "other-code") return Response.json(conversion({ id: 7, slug: "second-app" }), { status: 201 });
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

/** Starts the flow and has GitHub send the Admin's browser back with `code`, as it does after "Create GitHub App". */
async function finishCreation(admin: string, code = "good-code", cookieState?: string): Promise<Response> {
  const start = await (await request("POST", "/github-app/manifest", {}, admin)).json<ManifestStart>();
  const state = stateOf(start);
  return request(
    "GET",
    `/auth/github-app/manifest/callback?code=${code}&state=${state}`,
    undefined,
    `${admin}; github_app_manifest_state=${cookieState ?? state}`,
  );
}

const status = async (cookie: string) => (await request("GET", "/github-app", undefined, cookie)).json<{ app: Record<string, unknown> | null; canCreate: boolean }>();

describe("creating the GitHub App", () => {
  it("stores the App GitHub made, encrypted, and never shows its secrets", async () => {
    const admin = await session(true);
    const github = fakeGitHub();
    try {
      const callback = await finishCreation(admin);
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(`${APP_ORIGIN}/account-github?githubApp=created`);
      expect(github.calls).toEqual(["POST /app-manifests/good-code/conversions"]);
    } finally {
      github.restore();
    }

    const shown = await request("GET", "/github-app", undefined, admin);
    const body = await shown.text();
    expect(JSON.parse(body)).toMatchObject({
      canCreate: true,
      app: {
        appId: "424242",
        slug: "foxban-test",
        clientId: "Iv1.fakeclientid",
        installUrl: "https://github.example/apps/foxban-test/installations/new",
      },
    });
    for (const secret of Object.values(SECRETS)) expect(body).not.toContain(secret);

    // At rest: D1 holds no plaintext secret, yet the Worker can read them back.
    const row = await env.DB.prepare("SELECT * FROM github_app").first<Record<string, unknown>>();
    for (const secret of Object.values(SECRETS)) expect(JSON.stringify(row)).not.toContain(secret.slice(5, 20));
    expect(await loadInstanceGitHubApp(env)).toEqual({
      appId: "424242",
      slug: "foxban-test",
      clientId: "Iv1.fakeclientid",
      privateKey: SECRETS.pem,
      webhookSecret: SECRETS.webhook_secret,
      clientSecret: SECRETS.client_secret,
    });
  });
});

describe("a creation that must not store anything", () => {
  const failure = `${APP_ORIGIN}/account-github?githubApp=error`;

  it("ignores a callback whose state is missing or doesn't match the cookie", async () => {
    const admin = await session(true);
    const github = fakeGitHub();
    try {
      const forged = await finishCreation(admin, "good-code", "some-other-state");
      expect(forged.headers.get("location")).toBe(failure);

      const start = await (await request("POST", "/github-app/manifest", {}, admin)).json<ManifestStart>();
      const noCookie = await request("GET", `/auth/github-app/manifest/callback?code=good-code&state=${stateOf(start)}`, undefined, admin);
      expect(noCookie.headers.get("location")).toBe(failure);
      expect(github.calls).toEqual([]);
    } finally {
      github.restore();
    }
    expect((await status(admin)).app).toBeNull();
  });

  it("is refused for a regular user even with a valid state", async () => {
    const admin = await session(true);
    const user = await session(false);
    const github = fakeGitHub();
    try {
      const start = await (await request("POST", "/github-app/manifest", {}, admin)).json<ManifestStart>();
      const state = stateOf(start);
      const response = await request(
        "GET",
        `/auth/github-app/manifest/callback?code=good-code&state=${state}`,
        undefined,
        `${user}; github_app_manifest_state=${state}`,
      );
      expect(response.status).toBe(403);
      expect(github.calls).toEqual([]);
    } finally {
      github.restore();
    }
    expect((await status(admin)).app).toBeNull();
  });

  it("stores nothing when GitHub rejects the code or leaves out the webhook secret", async () => {
    const admin = await session(true);
    let github = fakeGitHub();
    try {
      expect((await finishCreation(admin, "expired-code")).headers.get("location")).toBe(failure);
    } finally {
      github.restore();
    }
    github = fakeGitHub({ webhook_secret: null });
    try {
      expect((await finishCreation(admin)).headers.get("location")).toBe(failure);
    } finally {
      github.restore();
    }
    expect((await status(admin)).app).toBeNull();
  });

  it("keeps the first App: a second creation is neither started nor finished", async () => {
    const admin = await session(true);
    const github = fakeGitHub();
    try {
      // Two flows started before either finishes, as with two open tabs.
      const first = await (await request("POST", "/github-app/manifest", {}, admin)).json<ManifestStart>();
      const second = await (await request("POST", "/github-app/manifest", {}, admin)).json<ManifestStart>();
      const finish = (start: ManifestStart, code: string) =>
        request(
          "GET",
          `/auth/github-app/manifest/callback?code=${code}&state=${stateOf(start)}`,
          undefined,
          `${admin}; github_app_manifest_state=${stateOf(start)}`,
        );
      expect((await finish(first, "good-code")).headers.get("location")).toBe(`${APP_ORIGIN}/account-github?githubApp=created`);
      expect((await finish(second, "other-code")).headers.get("location")).toBe(failure);
    } finally {
      github.restore();
    }
    expect((await status(admin)).app).toMatchObject({ slug: "foxban-test" });
    expect((await request("POST", "/github-app/manifest", {}, admin)).status).toBe(409);
  });

  it.each([
    ["has no encryption key", undefined],
    // 64 hex chars decode as base64 to 48 bytes, which AES-GCM refuses: GitHub's one-time code must not be spent.
    ["has a key that is not base64 of 32 bytes", "ab".repeat(32)],
  ])("is switched off when the instance %s", async (_, key) => {
    const admin = await session(true);
    const withoutKey = (method: string, path: string) =>
      worker.fetch!(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: { cookie: admin, "content-type": "application/json" },
          body: method === "POST" ? "{}" : undefined,
        }),
        { ...env, GITHUB_APP_ENCRYPTION_KEY: key } as unknown as typeof env,
        createExecutionContext(),
      );
    expect(await (await withoutKey("GET", "/github-app")).json()).toEqual({ app: null, canCreate: false });
    expect((await withoutKey("POST", "/github-app/manifest")).status).toBe(503);
  });
});

describe("GitHub App status", () => {
  it("tells an admin the instance has no GitHub App yet", async () => {
    const admin = await session(true);
    const response = await request("GET", "/github-app", undefined, admin);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ app: null, canCreate: true });
  });

  it("lets an admin remove the App, so a new one can be created", async () => {
    const admin = await session(true);
    const github = fakeGitHub();
    try {
      expect((await finishCreation(admin)).status).toBe(302);
    } finally {
      github.restore();
    }
    await env.DB.prepare("INSERT INTO github_repos (repo_id, installation_id, full_name, connected_at) VALUES (901, 1, 'org/r', 0)").run();
    await env.DB.prepare("INSERT INTO github_backfill_queue (repo_id, queued_at, run_after) VALUES (901, 0, 0)").run();

    expect((await request("DELETE", "/github-app", undefined, await session(false))).status).toBe(403);
    expect((await request("DELETE", "/github-app", undefined, admin)).status).toBe(200);
    expect(await (await request("GET", "/github-app", undefined, admin)).json()).toEqual({ app: null, canCreate: true });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM github_repos").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM github_backfill_queue").first("n")).toBe(0);
    expect((await request("DELETE", "/github-app", undefined, admin)).status).toBe(404);
  });

  it("shows the setup controls to admins only", async () => {
    const user = await session(false);
    expect((await request("GET", "/github-app", undefined, user)).status).toBe(403);
    expect((await request("GET", "/github-app")).status).toBe(401);
  });
});
