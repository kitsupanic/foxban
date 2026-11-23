import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, OWNER, adminSession, deliver, github, installApp, installation, repo, request, signature, useFakeGitHub } from "./github-test-kit";

/**
 * Webhooks and connected repos (ADR 0064), driven through the real Worker, with the
 * fake GitHub and signed deliveries from github-test-kit.ts.
 */
useFakeGitHub();

type RepoView = { id: number; fullName: string; private: boolean };
/**
 * What opening the Admin page shows. Opening it re-reads the install from GitHub, so
 * by default GitHub's listing is down for the read: the page then shows what the webhooks built.
 */
async function adminView(admin: string, { listingDown = true } = {}) {
  github.listingDown = listingDown;
  const response = await SELF.fetch(`${ORIGIN}/github-app`, { headers: { cookie: admin } });
  expect(response.status).toBe(200);
  return response.json<{ app: { repos: RepoView[]; reposRefreshed: boolean; owner: string | null; ignoredAccounts: string[]; settingsUrl: string | null } }>();
}
/** The connected repos the Admin page lists, sorted. */
async function connectedRepos(admin: string, options?: { listingDown?: boolean }): Promise<string[]> {
  return (await adminView(admin, options)).app.repos.map((repo) => repo.fullName).sort();
}


describe("the webhook endpoint's signature check", () => {
  beforeEach(installApp);

  it("rejects an unsigned request", async () => {
    const response = await request("POST", "/webhooks/github", { body: "{}", headers: { "x-github-event": "ping" } });
    expect(response.status).toBe(401);
  });

  it("rejects a request signed with another secret, or with a malformed signature", async () => {
    expect((await deliver("ping", { zen: "x" }, "someone else's secret")).status).toBe(401);
    for (const header of ["", "sha256=", "sha256=zz", "sha1=abc", await signature("{}")]) {
      const response = await request("POST", "/webhooks/github", {
        body: JSON.stringify({ zen: "x" }),
        headers: { "x-github-event": "ping", "x-hub-signature-256": header },
      });
      expect(response.status).toBe(401);
    }
  });

  it("checks the signature before parsing: unparsable but correctly signed is a 400, unsigned is a 401", async () => {
    // GitHub's documented example: this secret and this body sign to this value.
    const documented = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    const signed = await request("POST", "/webhooks/github", {
      body: "Hello, World!",
      headers: { "x-github-event": "ping", "x-hub-signature-256": documented },
    });
    expect(signed.status).toBe(400);
    const unsigned = await request("POST", "/webhooks/github", { body: "Hello, World!", headers: { "x-github-event": "ping" } });
    expect(unsigned.status).toBe(401);
  });

  it("refuses a body over the 5 MB cap before reading it, however it is announced", async () => {
    const big = "a".repeat(5 * 1024 * 1024 + 1);
    const headers = { "x-github-event": "ping", "x-hub-signature-256": await signature(big) };
    // Declared: the Content-Length alone is enough.
    expect((await request("POST", "/webhooks/github", { body: big, headers: { ...headers, "content-length": String(big.length) } })).status).toBe(413);
    // Streamed with no length: the read stops at the cap.
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(big)); controller.close(); } });
    const streamed = await SELF.fetch(`${ORIGIN}/webhooks/github`, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
  });

  it("answers a signed ping", async () => {
    expect((await deliver("ping", { zen: "Keep it logically awesome." })).status).toBe(200);
  });
});

describe("a webhook before the instance has a GitHub App", () => {
  it("is not found, signed or not", async () => {
    expect((await deliver("ping", { zen: "x" })).status).toBe(404);
  });
});

describe("repository events", () => {
  beforeEach(installApp);

  const REPO_EVENTS: Array<[string, Record<string, unknown>]> = [
    ["pull_request", { action: "opened", number: 5 }],
    ["push", { ref: "refs/heads/main" }],
    ["create", { ref: "feature", ref_type: "branch" }],
    ["delete", { ref: "feature", ref_type: "branch" }],
  ];

  it("drops events from repos that aren't connected, with a 2xx so GitHub doesn't count a failure", async () => {
    await deliver("installation", { action: "created", installation: installation(), repositories: [repo(101, `${OWNER}/api`)] });
    for (const [event, payload] of REPO_EVENTS) {
      const response = await deliver(event, { ...payload, repository: repo(999, "Stranger/elsewhere") });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: "dropped" });
    }
  });

  // Pull request and branch events become development info; github-development.test.ts and github-branches.test.ts cover them.
  it("drops branch events that name no task key, without asking GitHub", async () => {
    await deliver("installation", { action: "created", installation: installation(), repositories: [repo(101, `${OWNER}/api`)] });
    for (const [event, payload] of REPO_EVENTS.filter(([event]) => event !== "pull_request")) {
      const response = await deliver(event, { ...payload, repository: repo(101, `${OWNER}/api`) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: "dropped" });
    }
    expect(github.calls.filter((call) => call.includes("/repos/") || call.includes("access_tokens"))).toEqual([]);
  });

  it("stores the new name when a connected repo was renamed", async () => {
    await deliver("installation", { action: "created", installation: installation(), repositories: [repo(101, `${OWNER}/api`)] });
    // A pull_request payload this bare is a 400 later in the handler; the name is stored before that, but push says it cleanly.
    for (const [event, payload] of REPO_EVENTS.filter(([event]) => event !== "pull_request")) {
      const response = await deliver(event, { ...payload, repository: repo(101, `${OWNER}/api-${event}`) });
      expect(response.status).toBe(200);
      expect(await connectedRepos(await adminSession())).toEqual([`${OWNER}/api-${event}`]);
    }
  });

  it("answers 2xx to events it has no use for", async () => {
    const response = await deliver("star", { action: "created", repository: repo(101, `${OWNER}/api`) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "ignored" });
  });
});

describe("installing the App", () => {
  beforeEach(installApp);

  it("connects the repos the owner installs it on, and the Admin page lists them", async () => {
    const admin = await adminSession();
    expect(await connectedRepos(admin)).toEqual([]);

    const response = await deliver("installation", {
      action: "created",
      installation: installation(),
      repositories: [repo(101, `${OWNER}/api`, true), repo(102, `${OWNER}/web`)],
    });
    expect(response.status).toBe(200);
    expect((await adminView(admin)).app.repos).toEqual([
      { id: 101, fullName: `${OWNER}/api`, private: true },
      { id: 102, fullName: `${OWNER}/web`, private: false },
    ]);
  });

  // The App is public (GitHub only lets the owner authorize a private one), so anyone can install it.
  it("ignores an installation on an account other than the App's owner", async () => {
    const admin = await adminSession();
    const response = await deliver("installation", {
      action: "created",
      installation: installation(8, "Stranger"),
      repositories: [repo(201, "Stranger/secrets")],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "ignored" });
    expect(await connectedRepos(admin)).toEqual([]);
  });

  it("matches the owner's login without regard to case", async () => {
    const admin = await adminSession();
    await deliver("installation", { action: "created", installation: installation(7, OWNER.toLowerCase()), repositories: [repo(101, `${OWNER}/api`)] });
    expect(await connectedRepos(admin)).toEqual([`${OWNER}/api`]);
  });

  it("disconnects an installation's repos when it is uninstalled or suspended, and reconnects them on unsuspend", async () => {
    const admin = await adminSession();
    const repositories = [repo(101, `${OWNER}/api`), repo(102, `${OWNER}/web`)];
    const other = [repo(301, `${OWNER}/other`)];
    await deliver("installation", { action: "created", installation: installation(7), repositories });
    await deliver("installation", { action: "created", installation: installation(9), repositories: other });

    // Removing needs no proof of ownership, so GitHub being down doesn't stop it.
    github.owner = null;
    expect((await deliver("installation", { action: "suspend", installation: installation(7) })).status).toBe(200);
    expect(await connectedRepos(admin)).toEqual([`${OWNER}/other`]);

    github.owner = OWNER;
    await deliver("installation", { action: "unsuspend", installation: installation(7), repositories });
    expect(await connectedRepos(admin)).toEqual([`${OWNER}/api`, `${OWNER}/other`, `${OWNER}/web`]);

    github.owner = null;
    await deliver("installation", { action: "deleted", installation: installation(7), repositories });
    expect(await connectedRepos(admin)).toEqual([`${OWNER}/other`]);
  });

  it("adds and removes repos as they are added to and removed from the installation", async () => {
    const admin = await adminSession();
    await deliver("installation", { action: "created", installation: installation(7), repositories: [repo(101, `${OWNER}/api`)] });
    await deliver("installation", { action: "created", installation: installation(9), repositories: [repo(301, `${OWNER}/other`)] });

    const added = await deliver("installation_repositories", {
      action: "added",
      installation: installation(7),
      repository_selection: "selected",
      repositories_added: [repo(102, `${OWNER}/web`, true)],
      repositories_removed: [],
    });
    expect(added.status).toBe(200);
    expect(await connectedRepos(admin)).toEqual([`${OWNER}/api`, `${OWNER}/other`, `${OWNER}/web`]);

    // Removing is keyed by the installation too: installation 7 cannot drop installation 9's repo.
    github.owner = null;
    await deliver("installation_repositories", {
      action: "removed",
      installation: installation(7),
      repository_selection: "selected",
      repositories_added: [],
      repositories_removed: [repo(101, `${OWNER}/api`), repo(301, `${OWNER}/other`)],
    });
    expect(await connectedRepos(admin)).toEqual([`${OWNER}/other`, `${OWNER}/web`]);
  });

  it("ignores repos added to an installation on someone else's account", async () => {
    const admin = await adminSession();
    await deliver("installation_repositories", {
      action: "added",
      installation: installation(8, "Stranger"),
      repository_selection: "all",
      repositories_added: [repo(201, "Stranger/secrets")],
      repositories_removed: [],
    });
    expect(await connectedRepos(admin)).toEqual([]);
  });

  it("connects nothing, and fails the delivery, when GitHub cannot say who owns the App", async () => {
    const admin = await adminSession();
    github.owner = null;
    const response = await deliver("installation", { action: "created", installation: installation(), repositories: [repo(101, `${OWNER}/api`)] });
    expect(response.status).toBe(502);
    expect(await connectedRepos(admin)).toEqual([]);
  });
});

describe("opening the Admin page", () => {
  beforeEach(installApp);

  // GitHub does not retry a failed delivery, so a missed event must not stay missed.
  it("re-reads the install's repos from GitHub, healing events the instance never received", async () => {
    const admin = await adminSession();
    // The webhooks connected api and old; then deliveries were lost: old was removed and web was added.
    await deliver("installation", { action: "created", installation: installation(7), repositories: [repo(101, `${OWNER}/api`), repo(103, `${OWNER}/old`)] });
    github.installations = [{ id: 7, account: OWNER, repos: [{ id: 101, full_name: `${OWNER}/api` }, { id: 102, full_name: `${OWNER}/web`, private: true }] }];

    const view = await adminView(admin, { listingDown: false });
    expect(view.app.reposRefreshed).toBe(true);
    expect(view.app.repos).toEqual([
      { id: 101, fullName: `${OWNER}/api`, private: false },
      { id: 102, fullName: `${OWNER}/web`, private: true },
    ]);
    // It stays healed once GitHub is out of reach again.
    expect(await connectedRepos(admin)).toEqual([`${OWNER}/api`, `${OWNER}/web`]);
  });

  it("connects only the owner's active installations, and every repo however many pages GitHub needs", async () => {
    const admin = await adminSession();
    const many = Array.from({ length: 230 }, (_, i) => ({ id: 1000 + i, full_name: `${OWNER}/repo-${String(i).padStart(3, "0")}` }));
    github.installations = [
      { id: 7, account: OWNER.toLowerCase(), repos: many },
      { id: 8, account: "Stranger", repos: [{ id: 201, full_name: "Stranger/secrets" }] },
      { id: 9, account: OWNER, repos: [{ id: 301, full_name: `${OWNER}/paused` }], suspended: true },
    ];
    const view = await adminView(admin, { listingDown: false });
    expect(view.app.reposRefreshed).toBe(true);
    expect(view.app.repos).toHaveLength(230);
    expect(view.app.repos.map((r) => r.fullName)).not.toContain("Stranger/secrets");
    expect(view.app.repos.map((r) => r.fullName)).not.toContain(`${OWNER}/paused`);
    // The page says whose installs count and which ones it skipped (suspended ones are not listed).
    expect(view.app.owner).toBe(OWNER);
    expect(view.app.ignoredAccounts).toEqual(["Stranger"]);
    expect(view.app.settingsUrl).toMatch(/\/settings\/apps\/foxban-test\/advanced$/);
  });

  it("shows the last known repos, marked as not refreshed, when GitHub cannot be reached", async () => {
    const admin = await adminSession();
    await deliver("installation", { action: "created", installation: installation(), repositories: [repo(101, `${OWNER}/api`)] });
    const view = await adminView(admin, { listingDown: true });
    expect(view.app.reposRefreshed).toBe(false);
    expect(view.app.owner).toBeNull();
    expect(view.app.repos.map((r) => r.fullName)).toEqual([`${OWNER}/api`]);
  });

  it("drops every repo when GitHub says the owner has no active installation", async () => {
    const admin = await adminSession();
    await deliver("installation", { action: "created", installation: installation(), repositories: [repo(101, `${OWNER}/api`)] });
    expect(await connectedRepos(admin, { listingDown: false })).toEqual([]);
  });
});
