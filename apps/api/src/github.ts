/**
 * GitHub App JWT signing and REST API helpers using WebCrypto (no Node APIs).
 */

export interface GitHubRepositoryRef {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
}

export interface GitHubBranchRef {
  name: string;
  url: string;
  sha: string;
}

export interface GitHubPullRequestRef {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  merged: boolean;
  draft: boolean;
  htmlUrl: string;
}

export class GitHubApiError extends Error {
  /** True when GitHub refused the request for quota reasons (403 with an exhausted limit, or 429). */
  readonly isRateLimited: boolean;
  /** Safe `Retry-After` from the response, capped at `MAX_RETRY_AFTER_MS`. */
  readonly retryAfterMs: number | null;

  constructor(
    public readonly status: number,
    message: string,
    public readonly data?: unknown,
    options: { rateLimited?: boolean; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.isRateLimited = options.rateLimited ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlEncodeString(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/\\n/g, "")
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** DER type-length-value; lengths under 64 KiB, which a 4096-bit RSA key (about 2.4 KB) is well inside. */
function derNode(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = content.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Uint8Array.from([tag, ...length, ...content]);
}

/**
 * GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY") but WebCrypto imports only
 * PKCS#8, the same key in an envelope: SEQUENCE { version 0, rsaEncryption + NULL, OCTET STRING(pkcs1) }.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = derNode(0x30, Uint8Array.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]));
  return derNode(0x30, Uint8Array.from([...version, ...rsaEncryption, ...derNode(0x04, pkcs1)]));
}

type ImportedKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

let cachedPrivateKey: { pem: string; key: ImportedKey } | null = null;

async function importPrivateKey(pem: string): Promise<ImportedKey> {
  if (cachedPrivateKey && cachedPrivateKey.pem === pem) {
    return cachedPrivateKey.key;
  }
  const keyBuffer = pemToArrayBuffer(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(new Uint8Array(keyBuffer)) : keyBuffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  cachedPrivateKey = { pem, key };
  return key;
}

/**
 * Creates a signed RS256 JWT for GitHub App authentication.
 * Payload: iat = now - 60s, exp = now + 540s (9 minutes), iss = appId.
 */
export async function createGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  };

  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const message = `${headerB64}.${payloadB64}`;

  const cryptoKey = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(message),
  );

  return `${message}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * The longest `Retry-After` this build will honour. Longer claims are still
 * honoured past a minute — the old five-minute cap silently shortened them —
 * but a single upstream header may not stop status polling for days.
 */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Default ceiling on a GitHub response body. */
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Executes a GitHub REST API request with standard headers and bounded JSON parsing.
 */
async function githubFetch<T>(
  url: string,
  options: {
    method?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "foxban",
    ...options.headers,
  };

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let body: string | undefined = undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body,
  });

  const text = await readBoundedText(response, DEFAULT_MAX_RESPONSE_BYTES);
  let parsed: unknown = null;
  let malformed = false;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      malformed = true;
      parsed = text.slice(0, 500);
    }
  }

  if (!response.ok) {
    const errorMsg =
      parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string"
        ? parsed.message.slice(0, 500)
        : `GitHub API error: ${response.status}`;
    const retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const retryAfterMs =
      Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
        : null;
    // A secondary rate limit arrives as 403 carrying a `Retry-After` or an
    // "abuse"/"rate limit" message while the remaining quota usually is not zero,
    // and a primary exhaustion as the 403 whose remaining quota reads zero. Both
    // are quota refusals; a lost installation is a 401/403 that signals neither.
    const refusalMessage =
      parsed !== null && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string"
        ? parsed.message.toLowerCase()
        : "";
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.get("retry-after") !== null ||
          refusalMessage.includes("rate limit") ||
          refusalMessage.includes("abuse detection")));
    throw new GitHubApiError(response.status, errorMsg, parsed, { rateLimited, retryAfterMs });
  }
  if (malformed) {
    throw new GitHubApiError(502, "malformed response from GitHub", parsed);
  }

  return parsed as T;
}

/**
 * Reads a response body as UTF-8 text, refusing (and cancelling) bodies larger than `maxBytes`.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GitHubApiError(502, "GitHub response exceeded the size limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** `GET /app` with the App JWT: the account that owns the App, or null if GitHub names none. */
export async function getAppOwner(apiBase: string, appId: string, privateKeyPem: string): Promise<{ login: string; isOrganization: boolean } | null> {
  const jwt = await createGitHubAppJwt(appId, privateKeyPem);
  const data = await githubFetch<{ owner?: { login?: string; type?: string } }>(`${apiBase}/app`, { token: jwt });
  return data.owner?.login ? { login: data.owner.login, isOrganization: data.owner.type === "Organization" } : null;
}

/** The login of the account that owns the App, or null if GitHub names none. */
export async function getAppOwnerLogin(apiBase: string, appId: string, privateKeyPem: string): Promise<string | null> {
  return (await getAppOwner(apiBase, appId, privateKeyPem))?.login ?? null;
}

const INSTALLATIONS_PAGE_SIZE = 100;
const MAX_INSTALLATION_PAGES = 10;

/** `GET /app/installations` with the App JWT: every account the App is installed on, suspended ones flagged. */
export async function listAppInstallations(
  apiBase: string,
  appId: string,
  privateKeyPem: string,
): Promise<Array<{ id: number; account: string; suspended: boolean }>> {
  const jwt = await createGitHubAppJwt(appId, privateKeyPem);
  const installations: Array<{ id: number; account: string; suspended: boolean }> = [];
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const items = await githubFetch<Array<{ id: number; account?: { login?: string } | null; suspended_at?: string | null }>>(
      `${apiBase}/app/installations?per_page=${INSTALLATIONS_PAGE_SIZE}&page=${page}`,
      { token: jwt },
    );
    for (const item of items) {
      // An enterprise account has no login; foxban cannot match it to the App's owner.
      if (item.account?.login) installations.push({ id: item.id, account: item.account.login, suspended: Boolean(item.suspended_at) });
    }
    if (items.length < INSTALLATIONS_PAGE_SIZE) break;
  }
  return installations;
}

const MAX_REPOSITORY_PAGES = 50;

/** `GET /installation/repositories` with an installation token: every repo the installation can reach. */
export async function listInstallationRepositories(
  apiBase: string,
  installationToken: string,
): Promise<Array<{ id: number; fullName: string; private: boolean }>> {
  const repos: Array<{ id: number; fullName: string; private: boolean }> = [];
  for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
    const data = await githubFetch<{ repositories?: Array<{ id: number; full_name: string; private?: boolean }> }>(
      `${apiBase}/installation/repositories?per_page=${INSTALLATIONS_PAGE_SIZE}&page=${page}`,
      { token: installationToken },
    );
    const items = data.repositories ?? [];
    repos.push(...items.map((item) => ({ id: item.id, fullName: item.full_name, private: item.private === true })));
    if (items.length < INSTALLATIONS_PAGE_SIZE) break;
  }
  return repos;
}

/**
 * Turns the `code` GitHub sent back after "Create GitHub App" into the App's
 * credentials (`POST /app-manifests/{code}/conversions`, unauthenticated). The
 * result carries secrets: parse it, store it sealed, never log or return it.
 */
export function convertAppManifest(apiBase: string, code: string): Promise<unknown> {
  return githubFetch<unknown>(`${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
}

/**
 * Mints an installation access token for the given installation ID and repository IDs.
 * Never persisted or returned to the client.
 */
export async function createInstallationToken(
  apiBase: string,
  appId: string,
  privateKeyPem: string,
  installationId: number,
  repositoryIds?: number[],
): Promise<string> {
  const jwt = await createGitHubAppJwt(appId, privateKeyPem);
  const url = `${apiBase}/app/installations/${installationId}/access_tokens`;
  const body: Record<string, unknown> = {};
  if (repositoryIds && repositoryIds.length > 0) {
    body.repository_ids = repositoryIds;
  }

  const data = await githubFetch<{ token: string }>(url, {
    method: "POST",
    token: jwt,
    body: Object.keys(body).length > 0 ? body : undefined,
  });

  return data.token;
}

/**
 * Fetches repository metadata given an installation token.
 */
export async function getRepository(
  apiBase: string,
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubRepositoryRef> {
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const data = await githubFetch<{
    id: number;
    name: string;
    full_name: string;
    html_url: string;
    default_branch: string;
    owner: { login: string };
  }>(url, { token });

  return {
    id: data.id,
    name: data.name,
    owner: data.owner.login,
    fullName: data.full_name,
    url: data.html_url,
    defaultBranch: data.default_branch,
  };
}

/**
 * Checks if a branch exists (`GET /repos/{owner}/{repo}/git/ref/heads/{branch}`).
 * Returns null if 404.
 */
export async function getBranch(
  apiBase: string,
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<GitHubBranchRef | null> {
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`;
  try {
    const data = await githubFetch<{
      ref: string;
      object: { sha: string; url: string };
    }>(url, { token });

    return {
      name: branch,
      sha: data.object.sha,
      url: `https://github.com/${owner}/${repo}/tree/${branch}`,
    };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/** A branch's tip as GitHub answers it. */
export type GitHubBranchHead = { sha: string; message: string; committedAt: number; url: string };

/**
 * Re-reads one branch (`GET /repos/{owner}/{repo}/branches/{branch}`): its tip commit's
 * sha, message and committer time, in one call. Returns null if the branch is gone (404).
 */
export async function getBranchHead(apiBase: string, token: string, fullName: string, branch: string): Promise<GitHubBranchHead | null> {
  const url = `${apiBase}/repos/${fullName}/branches/${encodeURIComponent(branch)}`;
  try {
    const data = await githubFetch<{
      commit: { sha: string; commit: { message: string; committer?: { date?: string } | null; author?: { date?: string } | null } };
      _links: { html: string };
    }>(url, { token });
    const date = data.commit.commit.committer?.date ?? data.commit.commit.author?.date;
    return { sha: data.commit.sha, message: data.commit.commit.message, committedAt: (date && Date.parse(date)) || 0, url: data._links.html };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return null;
    throw err;
  }
}

/** One page of `GET /repos/{repo}/pulls?state=…&sort=updated&direction=desc` (GitHub has no `since` here): the raw list items. */
export async function listPullRequestsPage(
  apiBase: string,
  token: string,
  fullName: string,
  state: "open" | "closed",
  page: number,
  perPage: number,
): Promise<unknown[]> {
  const data = await githubFetch<unknown>(`${apiBase}/repos/${fullName}/pulls?state=${state}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`, { token });
  if (!Array.isArray(data)) throw new GitHubApiError(502, "malformed pull request list from GitHub", data);
  return data;
}

/** One page of `GET /repos/{repo}/branches`: just the names (the list carries no commit dates). */
export async function listBranchNamesPage(apiBase: string, token: string, fullName: string, page: number, perPage: number): Promise<string[]> {
  const data = await githubFetch<unknown>(`${apiBase}/repos/${fullName}/branches?per_page=${perPage}&page=${page}`, { token });
  if (!Array.isArray(data)) throw new GitHubApiError(502, "malformed branch list from GitHub", data);
  return data.flatMap((item) => (typeof item?.name === "string" ? [item.name] : []));
}

/**
 * Creates a git reference for a new branch pointing to baseSha.
 * Returns ref details or existing ref if conflict (422).
 */
export async function createBranchRef(
  apiBase: string,
  token: string,
  owner: string,
  repo: string,
  branch: string,
  sha: string,
): Promise<GitHubBranchRef> {
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`;
  try {
    await githubFetch(url, {
      method: "POST",
      token,
      body: {
        ref: `refs/heads/${branch}`,
        sha,
      },
    });

    return {
      name: branch,
      sha,
      url: `https://github.com/${owner}/${repo}/tree/${branch}`,
    };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 422) {
      // Already exists or race condition; re-fetch existing branch
      const existing = await getBranch(apiBase, token, owner, repo, branch);
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Validates one pull request payload from GitHub. Only fields this feature acts
 * on are trusted, and the canonical URL must name the requested repository: a
 * payload that disagrees with the request is an upstream error, never a value
 * the caller may persist or present as this repository's pull request.
 */
function parsePullRequestPayload(
  raw: unknown,
  owner: string,
  repo: string,
  requestedNumber: number | null,
): GitHubPullRequestRef {
  if (raw === null || typeof raw !== "object") {
    throw new GitHubApiError(502, "malformed pull request response from GitHub", raw);
  }
  const number = "number" in raw ? raw.number : undefined;
  const state = "state" in raw ? raw.state : undefined;
  const mergedAt = "merged_at" in raw ? raw.merged_at : undefined;
  const htmlUrl = "html_url" in raw ? raw.html_url : undefined;
  const draft = "draft" in raw ? raw.draft : undefined;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    (requestedNumber !== null && number !== requestedNumber) ||
    (state !== "open" && state !== "closed") ||
    (mergedAt !== null && mergedAt !== undefined && typeof mergedAt !== "string") ||
    typeof htmlUrl !== "string" ||
    (draft !== undefined && typeof draft !== "boolean")
  ) {
    throw new GitHubApiError(502, "malformed pull request response from GitHub", raw);
  }

  const canonical = parsePullRequestReference(htmlUrl);
  const merged = typeof mergedAt === "string";
  if (
    !canonical ||
    canonical.owner === null ||
    canonical.repo === null ||
    canonical.number !== number ||
    canonical.owner.toLowerCase() !== owner.toLowerCase() ||
    canonical.repo.toLowerCase() !== repo.toLowerCase()
  ) {
    throw new GitHubApiError(
      502,
      "pull request response does not match the requested repository",
      raw,
    );
  }

  const url = `https://github.com/${canonical.owner}/${canonical.repo}/pull/${canonical.number}`;
  return {
    number,
    url,
    htmlUrl: url,
    state: normalizePullRequestState(state, merged ? mergedAt : null),
    merged,
    draft: draft === true,
  };
}

/**
 * Finds pull request for branch (`GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all`).
 * Returns newest matching PR or null. Only an HTTP 200 with an empty array means
 * "no pull request": a 404 or any other payload shape is an upstream failure,
 * not an absence.
 */
export async function getPullRequestForBranch(
  apiBase: string,
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<GitHubPullRequestRef | null> {
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&sort=created&direction=desc&per_page=1`;
  const data = await githubFetch<unknown>(url, { token });

  if (!Array.isArray(data)) {
    throw new GitHubApiError(502, "malformed pull request list from GitHub", data);
  }
  if (data.length === 0) {
    return null;
  }

  return parsePullRequestPayload(data[0], owner, repo, null);
}

/**
 * GitHub reports a merged pull request as `closed`, so `merged_at` decides the
 * state before `state` does. A draft stays `open`: this feature renders three
 * states, not four. One mapping for creation, discovery and by-number reads.
 */
export function normalizePullRequestState(
  state: string,
  mergedAt: string | null,
): "open" | "closed" | "merged" {
  if (mergedAt) return "merged";
  return state === "open" ? "open" : "closed";
}

/** A parsed pull request reference: bare numbers have no owner/repository of their own. */
export interface PullRequestReference {
  number: number;
  owner: string | null;
  repo: string | null;
}

/** GitHub owner/org: alphanumeric with single hyphens, 1–39 characters. */
const GITHUB_OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
/** GitHub repository: alphanumeric, hyphens, underscores and dots, 1–100 characters. */
const GITHUB_REPO_PATTERN = /^[a-zA-Z0-9_.-]{1,100}$/;

/**
 * Parses `#123`, `123`, or a github.com pull request URL. A URL never supplies
 * its number to another repository — the caller matches owner/repository against
 * the board's connected metadata and refuses a foreign URL. Query and fragment
 * are ignored; credentials, ports, other hosts/schemes, extra path segments and
 * nonpositive or unsafe numbers are rejected.
 */
export function parsePullRequestReference(input: string): PullRequestReference | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;

  const digits = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (/^\d+$/.test(digits)) {
    const number = Number(digits);
    return Number.isSafeInteger(number) && number > 0 ? { number, owner: null, repo: null } : null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname.toLowerCase() !== "github.com") return null;
  if (url.port !== "" || url.username !== "" || url.password !== "") return null;

  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return "";
      }
    });
  if (segments.length !== 4) return null;
  const [owner, repo, kind, numberText] = segments;
  if (kind !== "pull") return null;
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) return null;
  if (repo === "." || repo === "..") return null;
  if (!/^\d+$/.test(numberText)) return null;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  return { number, owner, repo };
}

/**
 * The raw `GET /repos/{owner}/{repo}/pulls/{number}` body, for a caller that validates
 * the fields it needs itself (a manual link stores the title and `updated_at`). A 404 is
 * thrown, never turned into absence.
 */
export async function getPullRequestPayload(apiBase: string, token: string, owner: string, repo: string, number: number): Promise<unknown> {
  return githubFetch<unknown>(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, { token });
}

/**
 * Creates a pull request against the default branch.
 */
export async function createPullRequest(
  apiBase: string,
  token: string,
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body: string,
): Promise<GitHubPullRequestRef> {
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
  const data = await githubFetch<unknown>(url, {
    method: "POST",
    token,
    body: {
      title,
      head,
      base,
      body,
      draft: false,
    },
  });

  return parsePullRequestPayload(data, owner, repo, null);
}
