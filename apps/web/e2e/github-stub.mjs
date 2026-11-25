// Stands in for github.com + api.github.com during e2e and local dev (ADR 0064).
//
// It plays one GitHub App with one installation: the manifest conversion that hands
// the instance its App (with a real RSA key, so the Worker's App JWT can be checked),
// the App and installation reads, repositories, branches and pull requests, the OAuth
// hop for linking an account, and signed webhook deliveries to the Worker
// (`/_test/deliver`, plus the `create` and `pull_request` events GitHub itself sends
// when the Worker creates a branch or a pull request).
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.GITHUB_STUB_PORT ?? 8788);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("GITHUB_STUB_PORT must be a valid TCP port");
}
const API_ORIGIN = process.env.API_ORIGIN || `http://localhost:${process.env.API_PORT || "8787"}`;

const APP_ID = 424242;
const OWNER = "example-org";
const INSTALLATION_ID = 12345;
/** What the manifest conversion hands over, and what signs every webhook. Public: this is a stub. */
const WEBHOOK_SECRET = "stub-webhook-secret";

/**
 * GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"); the Worker wraps it before signing App JWTs.
 * The pair is kept in the temp directory: a dev Worker's D1 outlives this process, and the App it
 * stored must still verify after a restart. Shards share it, which is harmless (a stub's key).
 */
function loadAppKey() {
  const file = join(tmpdir(), "foxban-github-stub-key.json");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    try {
      writeFileSync(file, JSON.stringify(pair), { flag: "wx", mode: 0o600 });
    } catch {
      /* another shard wrote it first: read theirs below */
    }
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return pair;
    }
  }
}
const appKey = loadAppKey();

let repositories = new Map(); // key: `${owner}/${repo}` (lower case) -> repository
let branches = new Map(); // key: `${owner}/${repo}/${branch}` (lower case) -> { name, sha, url }
let branchCommits = new Map(); // same key -> commits pushed to the branch, oldest first
let pullRequests = []; // every PR the stub knows, across repositories and heads
let nextPrNumber = 100;
let nextPrCreatedAt = 1_700_000_000_000;
let nextCommitIndex = 1;
/**
 * The numeric id of the next GitHub account an OAuth approval signs in as. Kept across
 * resets, and started from the clock: the dev Worker's D1 outlives the stub, so a
 * restarted stub must not hand out an id an earlier run already linked.
 */
let nextGitHubUserId = Date.now();

function resetState() {
  repositories.clear();
  branches.clear();
  branchCommits.clear();
  pullRequests = [];
  nextPrNumber = 100;
  nextPrCreatedAt = 1_700_000_000_000;
  nextCommitIndex = 1;
  addRepository({ owner: OWNER, name: "example-repo", id: 987654 });
}

function repositoryKey(owner, repo) {
  return `${String(owner || "").toLowerCase()}/${String(repo || "").toLowerCase()}`;
}

function addRepository({ owner, name, id, defaultBranch = "main" }) {
  repositories.set(repositoryKey(owner, name), {
    id,
    name,
    owner: { login: owner },
    full_name: `${owner}/${name}`,
    private: false,
    html_url: `https://github.com/${owner}/${name}`,
    default_branch: defaultBranch,
  });
  branches.set(`${repositoryKey(owner, name)}/${defaultBranch}`, {
    name: defaultBranch,
    sha: "b".repeat(40),
    url: `https://github.com/${owner}/${name}/tree/${defaultBranch}`,
  });
}

resetState();

/**
 * GitHub reports a merged pull request as `closed` with `merged_at` set, and a
 * draft as `open`: the stub keeps that shape so the app's mapping is what the
 * tests exercise.
 */
function pullRequestPayload(pr) {
  const repository = repositories.get(repositoryKey(pr.owner, pr.repo));
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    html_url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
    merged_at: pr.mergedAt,
    draft: Boolean(pr.draft),
    // Same-repo PRs, as GitHub sends them: key matching skips a fork's (ADR 0088).
    head: { ref: pr.head, label: pr.head, repo: { id: repository ? repository.id : 0 } },
    base: { ref: pr.base, repo: { id: repository ? repository.id : 0 } },
    created_at: new Date(pr.createdAt).toISOString(),
    updated_at: new Date(pr.updatedAt).toISOString(),
    closed_at: pr.state === "closed" ? new Date(pr.updatedAt).toISOString() : null,
    user: { login: "foxban[bot]" },
  };
}

function seedPullRequest(body) {
  const number = Number.isInteger(body.number) ? body.number : nextPrNumber++;
  const pr = {
    owner: String(body.owner || OWNER),
    repo: String(body.repo || "example-repo"),
    number,
    head: String(body.head || `pr-${number}`),
    base: String(body.base || "main"),
    state: "open",
    mergedAt: null,
    draft: false,
    title: String(body.title || `Stub pull request #${number}`),
    body: String(body.body || ""),
    createdAt: nextPrCreatedAt++,
    updatedAt: Date.now(),
  };
  pullRequests.push(pr);
  return pr;
}

function findPullRequest(owner, repo, number) {
  const key = repositoryKey(owner, repo);
  return pullRequests.find((candidate) => repositoryKey(candidate.owner, candidate.repo) === key && candidate.number === number);
}

/** The `pull_request` event GitHub would send for this PR as it stands. */
function pullRequestEvent(pr, action) {
  const repository = repositories.get(repositoryKey(pr.owner, pr.repo));
  return {
    action,
    number: pr.number,
    repository: { id: repository.id, full_name: repository.full_name },
    pull_request: { ...pullRequestPayload(pr), merged: pr.mergedAt !== null },
  };
}

/** Sends a webhook to the Worker, signed the way GitHub signs it. Resolves with the Worker's status. */
async function deliver(event, payload, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  const response = await fetch(`${API_ORIGIN}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
  return response.status;
}

/** True when the Bearer value is an RS256 JWT for this App, signed by the key the conversion handed out. */
function validAppJwt(authorization) {
  const [header, payload, signature] = String(authorization ?? "").replace(/^Bearer /, "").split(".");
  if (!header || !payload || !signature) return false;
  const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`);
  if (!verifier.verify(appKey.publicKey, Buffer.from(signature, "base64url"))) return false;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  return claims.iss === String(APP_ID) && claims.exp > Date.now() / 1000;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ---- Test controls
  if (url.pathname === "/_test/reset") {
    resetState();
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/_test/repository" && req.method === "POST") {
    const body = await readBody(req);
    addRepository({ owner: String(body.owner), name: String(body.name), id: Number(body.id), defaultBranch: body.defaultBranch });
    return json(res, 200, { ok: true });
  }

  // Seeds a pull request GitHub knows about (it sends no event until `/_test/deliver` does).
  if (url.pathname === "/_test/pr" && req.method === "POST") {
    const pr = seedPullRequest(await readBody(req));
    return json(res, 200, { number: pr.number, url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}` });
  }

  // Moves a pull request, then tells the Worker with a signed `pull_request` event.
  if (url.pathname === "/_test/pr-state" && req.method === "POST") {
    const body = await readBody(req);
    const pr = findPullRequest(body.owner || OWNER, body.repo || "example-repo", Number(body.number));
    if (!pr) return json(res, 404, { error: "not found" });
    if (typeof body.title === "string") pr.title = body.title;
    if (body.state === "merged") Object.assign(pr, { state: "closed", mergedAt: new Date().toISOString() });
    else if (body.state === "closed") Object.assign(pr, { state: "closed", mergedAt: null });
    else if (body.state === "open") Object.assign(pr, { state: "open", mergedAt: null });
    if (typeof body.draft === "boolean") pr.draft = body.draft;
    pr.updatedAt = Math.max(Date.now(), pr.updatedAt + 1000);
    return json(res, 200, { status: await deliver("pull_request", pullRequestEvent(pr, body.state === "merged" || body.state === "closed" ? "closed" : "edited")) });
  }

  // Signs and sends any event: `{ event, payload, secret? }`. A wrong `secret` is a forged delivery.
  if (url.pathname === "/_test/deliver" && req.method === "POST") {
    const { event, payload, secret } = await readBody(req);
    return json(res, 200, { status: await deliver(String(event), payload, secret) });
  }

  // Pushes a commit to a branch, so a pull request from it has something to propose.
  if (url.pathname === "/_test/commit" && req.method === "POST") {
    const body = await readBody(req);
    const key = `${repositoryKey(body.owner || OWNER, body.repo || "example-repo")}/${String(body.branch || "").toLowerCase()}`;
    const index = nextCommitIndex++;
    const commit = { sha: String(body.sha || `${index}`.padStart(40, "c")), message: String(body.message || `Commit ${index}`), date: new Date().toISOString() };
    branchCommits.set(key, [...(branchCommits.get(key) ?? []), commit]);
    return json(res, 200, { ok: true, commit });
  }

  // ---- GitHub: the App's own reads (App JWT)
  // POST /app-manifests/{code}/conversions: the instance GitHub App an Admin creates (ADR 0064)
  if (/^\/app-manifests\/[^/]+\/conversions$/.test(url.pathname) && req.method === "POST") {
    return json(res, 201, {
      id: APP_ID,
      slug: "foxban-stub",
      client_id: "Iv1.stubclientid",
      client_secret: "stub-client-secret",
      webhook_secret: WEBHOOK_SECRET,
      pem: appKey.privateKey,
    });
  }

  if (url.pathname === "/app" || url.pathname.startsWith("/app/installations")) {
    if (req.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      if (!validAppJwt(req.headers.authorization)) return json(res, 401, { message: "Bad credentials" });
      return json(res, 201, { token: "ghs_stub_installation_token", expires_at: "2099-01-01T00:00:00Z" });
    }
    if (!validAppJwt(req.headers.authorization)) return json(res, 401, { message: "Bad credentials" });
    if (url.pathname === "/app") return json(res, 200, { id: APP_ID, slug: "foxban-stub", owner: { login: OWNER } });
    if (url.pathname === "/app/installations") return json(res, 200, [{ id: INSTALLATION_ID, account: { login: OWNER }, suspended_at: null }]);
  }

  // ---- GitHub: installation token reads
  if (url.pathname === "/installation/repositories") {
    const list = [...repositories.values()].map(({ id, name, full_name, private: isPrivate }) => ({ id, name, full_name, private: isPrivate }));
    return json(res, 200, { total_count: list.length, repositories: url.searchParams.get("page") === "1" || !url.searchParams.has("page") ? list : [] });
  }

  // GET /repos/{owner}/{repo}/git/ref/heads/{branch}
  const refMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/);
  if (refMatch && req.method === "GET") {
    const branch = branches.get(`${repositoryKey(refMatch[1], refMatch[2])}/${decodeURIComponent(refMatch[3]).toLowerCase()}`);
    if (!branch) return json(res, 404, { message: "Not Found" });
    return json(res, 200, { ref: `refs/heads/${branch.name}`, object: { sha: branch.sha, url: branch.url } });
  }

  // POST /repos/{owner}/{repo}/git/refs: creates a branch, then GitHub's own `create` event follows
  const createRefMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/);
  if (createRefMatch && req.method === "POST") {
    const repository = repositories.get(repositoryKey(createRefMatch[1], createRefMatch[2]));
    const body = await readBody(req);
    const name = String(body.ref || "").replace(/^refs\/heads\//, "");
    const key = `${repositoryKey(createRefMatch[1], createRefMatch[2])}/${name.toLowerCase()}`;
    if (!repository) return json(res, 404, { message: "Not Found" });
    if (branches.has(key)) return json(res, 422, { message: "Reference already exists" });
    branches.set(key, { name, sha: String(body.sha || "dummy-sha"), url: `https://github.com/${repository.full_name}/tree/${name}` });
    void deliver("create", { ref: name, ref_type: "branch", repository: { id: repository.id, full_name: repository.full_name } });
    return json(res, 201, { ref: `refs/heads/${name}`, object: { sha: body.sha, url: branches.get(key).url } });
  }

  // GET /repos/{owner}/{repo}/branches/{branch}: the re-read every branch event makes
  const branchHeadMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/);
  if (branchHeadMatch && req.method === "GET") {
    const key = `${repositoryKey(branchHeadMatch[1], branchHeadMatch[2])}/${decodeURIComponent(branchHeadMatch[3]).toLowerCase()}`;
    const branch = branches.get(key);
    if (!branch) return json(res, 404, { message: "Branch not found" });
    const tip = (branchCommits.get(key) ?? []).at(-1);
    return json(res, 200, {
      name: branch.name,
      commit: { sha: tip?.sha ?? branch.sha.padEnd(40, "0"), commit: { message: tip?.message ?? "Branch created", committer: { date: tip?.date ?? new Date().toISOString() } } },
      _links: { html: branch.url },
    });
  }

  // GET /repos/{owner}/{repo}/branches: names only
  const branchListMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/branches$/);
  if (branchListMatch && req.method === "GET") {
    const prefix = `${repositoryKey(branchListMatch[1], branchListMatch[2])}/`;
    return json(res, 200, [...branches.entries()].filter(([key]) => key.startsWith(prefix)).map(([, branch]) => ({ name: branch.name })));
  }

  // GET /repos/{owner}/{repo}/pulls: newest-created first, like GitHub's `sort=created&direction=desc`, filtered by head when asked
  const pullsMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
  if (pullsMatch && req.method === "GET") {
    const headParam = url.searchParams.get("head"); // owner:branch
    const branchName = headParam ? (headParam.includes(":") ? headParam.split(":")[1] : headParam) : null;
    const wanted = url.searchParams.get("state");
    const matches = pullRequests
      .filter((pr) => repositoryKey(pr.owner, pr.repo) === repositoryKey(pullsMatch[1], pullsMatch[2]))
      .filter((pr) => branchName === null || pr.head.toLowerCase() === branchName.toLowerCase())
      .filter((pr) => wanted === null || wanted === "all" || pr.state === wanted)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Number.parseInt(url.searchParams.get("per_page") || "30", 10))
      .map(pullRequestPayload);
    return json(res, 200, matches);
  }

  // GET /repos/{owner}/{repo}/pulls/{number}: one PR by number
  const pullByNumberMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
  if (pullByNumberMatch && req.method === "GET") {
    const pr = findPullRequest(pullByNumberMatch[1], pullByNumberMatch[2], Number(pullByNumberMatch[3]));
    return pr ? json(res, 200, pullRequestPayload(pr)) : json(res, 404, { message: "Not Found" });
  }

  // POST /repos/{owner}/{repo}/pulls: creates a PR from a pushed branch, then GitHub's own `pull_request` event follows
  if (pullsMatch && req.method === "POST") {
    const body = await readBody(req);
    const key = `${repositoryKey(pullsMatch[1], pullsMatch[2])}/${String(body.head || "").toLowerCase()}`;
    if (!branches.has(key)) return json(res, 422, { message: `Branch ${body.head} does not exist` });
    if ((branchCommits.get(key) ?? []).length === 0) {
      return json(res, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and head branch" }] });
    }
    const pr = seedPullRequest({ owner: pullsMatch[1], repo: pullsMatch[2], head: body.head, base: body.base, title: body.title, body: body.body });
    void deliver("pull_request", pullRequestEvent(pr, "opened"));
    return json(res, 201, pullRequestPayload(pr));
  }

  // GET /repos/{owner}/{repo}: repository metadata
  const repoMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repoMatch && req.method === "GET") {
    const existing = repositories.get(repositoryKey(repoMatch[1], repoMatch[2]));
    return existing ? json(res, 200, existing) : json(res, 404, { message: "Not Found" });
  }

  // ---- OAuth: linking a GitHub account (profile) and signing in
  // Every approval is a new GitHub account (own numeric id, login octocat), so one foxban
  // account per GitHub account (ADR 0064) never blocks a later test.
  if (url.pathname === "/login/oauth/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri") || "http://localhost:5173/profile");
    back.searchParams.set("code", `stub-code-${nextGitHubUserId++}`);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() }).end();
    return;
  }

  // The token carries the account's id
  if (url.pathname === "/login/oauth/access_token") {
    const { code } = await readBody(req);
    return json(res, 200, { access_token: `stub-token-${String(code).replace("stub-code-", "")}`, token_type: "bearer", scope: "" });
  }

  if (url.pathname === "/user") {
    const id = Number(String(req.headers.authorization ?? "").replace("Bearer stub-token-", ""));
    return json(res, 200, { login: "octocat", id: Number.isInteger(id) && id > 0 ? id : 583231 });
  }

  // Signup's address check: one verified primary address per account, never an existing foxban one
  if (url.pathname === "/user/emails") {
    const id = String(req.headers.authorization ?? "").replace("Bearer stub-token-", "");
    return json(res, 200, [{ email: `octocat-${id}@users.stub.test`, primary: true, verified: true, visibility: null }]);
  }

  res.writeHead(200).end("github stub");
}).listen(PORT);
