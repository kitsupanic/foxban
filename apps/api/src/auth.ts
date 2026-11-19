import type { BoardAccessMode, BoardCapabilities, BoardColor, BoardIcon, WorkspaceRole } from "@foxban/shared";
import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { GITHUB_FETCH_TIMEOUT_MS } from "./github";

/** The signed-in user, as identified by the session cookie. */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  githubLogin: string | null;
  avatarVersion: string | null;
  timezone: string | null;
  /** False for an account made with GitHub that has not set one yet (`NO_PASSWORD_HASH`). */
  hasPassword: boolean;
};

/** The user as sent to the client: session identity plus the admin verdict. */
export type AuthUser = SessionUser & { isAdmin: boolean };

/** A board row from D1 (board *content* lives in the DO, never here). */
export type BoardRow = {
  id: string;
  name: string;
  key: string;
  ownerId: string;
  icon: BoardIcon;
  color: BoardColor;
  workspaceId: string;
  workspaceName: string;
  accessMode: BoardAccessMode;
  accessVersion: number;
  capabilities: BoardCapabilities;
  /**
   * True when the viewer opens this Private board only because they administer its
   * workspace: they are neither its owner nor a board member. The page uses it to
   * say so; it grants nothing.
   */
  viaWorkspaceAdmin: boolean;
};

export interface RawBoardRecord {
  id: string;
  name: string;
  key: string;
  ownerId: string;
  icon: BoardIcon;
  color: BoardColor;
  workspaceId: string;
  workspaceName: string;
  accessMode: BoardAccessMode;
  accessVersion: number;
  explicitRole?: "member" | "manager" | null;
  workspaceRole?: WorkspaceRole | null;
  operatorAccess?: number;
  ownerAccess?: number;
  pendingAccessOperationId?: string | null;
}

/**
 * A board row plus the one piece of live policy state a Worker read must answer
 * with rather than act through: while a reserved access change holds this board,
 * its protected surface is unavailable and its metadata answer is "retry", not a
 * grant. It comes from the same authorization-bearing query as the row itself, so
 * the two describe one instant instead of a read and a later fence.
 */
export type AccessibleBoard = BoardRow & { pendingAccessChange: boolean };

/**
 * What a board-access decision reads about one viewer and one board. `explicitRole`
 * is the viewer's board_members row and `workspaceRole` their membership of the
 * board's workspace; null or undefined means none.
 */
export type BoardAccessFacts = {
  operator: boolean;
  owner: boolean;
  accessMode: string;
  explicitRole: string | null | undefined;
  workspaceRole: string | null | undefined;
};

/** The board-open rule of ADR 0066, in TS. `boardOpenSql` is the same rule in SQL. */
export function canOpenBoard(f: BoardAccessFacts): boolean {
  return (
    f.operator ||
    f.owner ||
    f.explicitRole != null ||
    f.workspaceRole === "admin" ||
    (f.accessMode === "workspace" && f.workspaceRole != null)
  );
}

/**
 * Manage rights (ADR 0066), in TS. `boardManageSql` is the same rule in SQL. The creator
 * manages only while still a member of the board's workspace (`workspaceRole`): one who was
 * removed or left keeps the open right (`canOpenBoard`) but not the manage right.
 */
export function canManageBoard(f: BoardAccessFacts): boolean {
  return f.operator || (f.owner && f.workspaceRole != null) || f.explicitRole === "manager" || f.workspaceRole === "admin";
}

/**
 * The board-open rule of ADR 0066 as one SQL condition: the viewer owns `board`,
 * has a board_members row on it, is an admin of its workspace, or is a member of
 * its workspace while it is a Workspace board. Every query that decides who opens
 * a board builds its condition here, so the rule has one copy.
 *
 * `board` is the boards alias in scope. `viewer` is a SQL expression for the user
 * id (`?` or a column); it appears 3 times, so `?` takes 3 binds of the same id.
 * `operator` is an optional SQL term OR'd in first (its binds come first): sites
 * differ on purpose about when an instance Admin counts, so each passes its own.
 */
export function boardOpenSql(board: string, viewer: string, operator?: string): string {
  return `(${operator ? `${operator} OR ` : ""}${board}.owner_id=${viewer}
    OR EXISTS(SELECT 1 FROM board_members open_bm WHERE open_bm.board_id=${board}.id AND open_bm.user_id=${viewer})
    OR EXISTS(SELECT 1 FROM workspace_members open_wm WHERE open_wm.workspace_id=${board}.workspace_id AND open_wm.user_id=${viewer} AND (${board}.access_mode='workspace' OR open_wm.role='admin')))`;
}

/**
 * Manage rights (ADR 0066) as one SQL condition: an explicit board manager, or a member
 * of the board's workspace who administers it or created the board (`canManageBoard`).
 * Arguments and binds as in `boardOpenSql`.
 */
export function boardManageSql(board: string, viewer: string, operator?: string): string {
  return `(${operator ? `${operator} OR ` : ""}EXISTS(SELECT 1 FROM board_members manage_bm WHERE manage_bm.board_id=${board}.id AND manage_bm.user_id=${viewer} AND manage_bm.role='manager')
    OR EXISTS(SELECT 1 FROM workspace_members manage_wm WHERE manage_wm.workspace_id=${board}.workspace_id AND manage_wm.user_id=${viewer} AND (manage_wm.role='admin' OR ${board}.owner_id=${viewer})))`;
}

/**
 * Effective board membership as one SQL condition: `member` has a board_members
 * row on `board`, or is a member of its workspace while it is a Workspace board.
 * The member list, assignee eligibility and transfer assignee preservation all
 * read this relation. Unlike `boardOpenSql`, an admin of the workspace is not a
 * member of a Restricted board, and owner and operator do not count.
 *
 * `board` is the boards alias in scope. `member` is a SQL expression for the user
 * id (`?` or a column); it appears 2 times, so `?` takes 2 binds of the same id.
 */
export function boardMemberSql(board: string, member: string): string {
  return `(EXISTS(SELECT 1 FROM board_members member_bm WHERE member_bm.board_id=${board}.id AND member_bm.user_id=${member})
    OR (${board}.access_mode='workspace' AND EXISTS(SELECT 1 FROM workspace_members member_wm WHERE member_wm.workspace_id=${board}.workspace_id AND member_wm.user_id=${member})))`;
}

/**
 * The same relation as `boardMemberSql`, as a subquery of the member ids of `board`.
 * Use it to list members (`users.id IN (...)`): it reads the board's own membership
 * rows by primary key instead of testing every user.
 */
export function boardMemberIdsSql(board: string): string {
  return `SELECT member_bm.user_id FROM board_members member_bm WHERE member_bm.board_id=${board}.id
    UNION SELECT member_wm.user_id FROM workspace_members member_wm WHERE ${board}.access_mode='workspace' AND member_wm.workspace_id=${board}.workspace_id`;
}

export function toBoardRow(raw: RawBoardRecord): BoardRow {
  const canManage = canManageBoard({
    operator: raw.operatorAccess === 1,
    owner: raw.ownerAccess === 1,
    accessMode: raw.accessMode,
    explicitRole: raw.explicitRole,
    workspaceRole: raw.workspaceRole,
  });
  return {
    id: raw.id,
    name: raw.name,
    key: raw.key,
    ownerId: raw.ownerId,
    icon: raw.icon,
    color: raw.color,
    workspaceId: raw.workspaceId,
    workspaceName: raw.workspaceName,
    accessMode: raw.accessMode,
    accessVersion: raw.accessVersion,
    capabilities: {
      canManageBoard: canManage,
      canManageColumns: canManage,
      canManageMembers: true,
    },
    viaWorkspaceAdmin:
      raw.accessMode === "restricted" &&
      raw.workspaceRole === "admin" &&
      raw.explicitRole == null &&
      raw.ownerAccess !== 1,
  };
}

export const BOARD_SELECT_COLS = `
  boards.id AS id,
  boards.name AS name,
  boards.board_key AS key,
  boards.owner_id AS ownerId,
  boards.icon AS icon,
  boards.color AS color,
  boards.workspace_id AS workspaceId,
  (SELECT name FROM workspaces WHERE workspaces.id=boards.workspace_id) AS workspaceName,
  boards.access_mode AS accessMode,
  boards.access_version AS accessVersion,
  boards.pending_access_operation_id AS pendingAccessOperationId
`;
export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; board: AccessibleBoard };
};

export const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * PBKDF2 over WebCrypto: the Workers runtime has no bcrypt/argon2, and pulling
 * a JS implementation in would be both slower and unaudited.
 */
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const encoder = new TextEncoder();

/**
 * `timingSafeEqual` is a workerd extension to SubtleCrypto, so it is absent from
 * the standard type this file also gets checked against (the web app imports
 * `AppType` from here). Optional-with-fallback keeps both programs honest.
 */
const subtle: SubtleCrypto & {
  timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean;
} = crypto.subtle;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Invite tokens are 32 random bytes in base64url: URL-safe without escaping, so
 * a token survives being pasted into `/signup?invite=…` unchanged.
 */
export function createInviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The exact addresses in `ADMIN_EMAILS`, a comma-separated list, lower case. A `*@domain`
 * entry is skipped, never matched: nobody verifies an email, so a domain pattern would let
 * any stranger sign up as an admin (ADR 0071).
 */
export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS?.split(",") ?? []).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry && !entry.startsWith("*@"));
}

/**
 * Admins are configured, not stored: an address listed in `ADMIN_EMAILS`, matched
 * case-insensitively. Keeping it in the environment means the first account on a
 * fresh deployment can sign up without an invite that nobody could have minted yet.
 */
export function isAdminEmail(env: Env, email: string): boolean {
  const candidate = email.trim().toLowerCase();
  return candidate !== "" && adminEmails(env).includes(candidate);
}

/** Configured `APP_ORIGIN`, or the request's own origin when it is unset or empty. */
export function appOrigin(env: Env, requestUrl: string): string {
  return env.APP_ORIGIN?.trim() || new URL(requestUrl).origin;
}

/** `MCP_API_ORIGIN`, falling back to `appOrigin`. */
export function mcpOrigin(env: Env, requestUrl: string): string {
  // Optional and absent from the generated Env when the config leaves it out.
  return (env as { MCP_API_ORIGIN?: string }).MCP_API_ORIGIN?.trim() || appOrigin(env, requestUrl);
}

export function toAuthUser(env: Env, user: SessionUser): AuthUser {
  return { ...user, isAdmin: isAdminEmail(env, user.email) };
}

/** GitHub's join rule: alphanumeric with non-consecutive internal hyphens, max 39. */
export const GITHUB_LOGIN_RE =/^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

/** A GitHub account as the sign-in code identifies it. */
export type GitHubAccount = {
  id: number;
  login: string;
  /**
   * The account's verified e-mail addresses, lower case, the primary one first; null when GitHub would not
   * say (the App lacks "Email addresses: read", or the call failed). A separate call, so only signup pays
   * for it, and made with the user's token, which never leaves this function.
   */
  verifiedEmails: () => Promise<string[] | null>;
};

/**
 * The instance GitHub App's user sign-in code → the GitHub account behind it
 * (numeric id and login name), or null for any failure (bad code, network error,
 * malformed response). `redirectUri` must be the callback the code was issued for.
 * The bases are env so dev/e2e can point at a local stub; production values are
 * github.com / api.github.com.
 */
export async function fetchGitHubUser(
  env: Env,
  app: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
): Promise<GitHubAccount | null> {
  try {
    const tokenResponse = await fetch(`${env.GITHUB_OAUTH_BASE}/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });
    if (!tokenResponse.ok) return null;
    const { access_token } = (await tokenResponse.json()) as { access_token?: string };
    if (!access_token) return null;
    const headers = {
      Authorization: `Bearer ${access_token}`,
      Accept: "application/vnd.github+json",
      // GitHub's API rejects requests without a User-Agent.
      "User-Agent": "foxban",
    };
    const userResponse = await fetch(`${env.GITHUB_API_BASE}/user`, { headers, signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) });
    if (!userResponse.ok) return null;
    const { id, login } = (await userResponse.json()) as { id?: unknown; login?: unknown };
    if (typeof login !== "string" || !GITHUB_LOGIN_RE.test(login) || !Number.isSafeInteger(id) || (id as number) <= 0) return null;
    const verifiedEmails = async () => {
      try {
        const response = await fetch(`${env.GITHUB_API_BASE}/user/emails`, { headers, signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) });
        if (!response.ok) return null;
        const list = (await response.json()) as unknown;
        if (!Array.isArray(list)) return null;
        const verified = list.filter(
          (item): item is { email: string; primary?: unknown } =>
            item?.verified === true && typeof item.email === "string" && item.email.length <= 254,
        );
        // Primary first: it is the address the new account keeps.
        return verified.sort((a, b) => Number(b.primary === true) - Number(a.primary === true)).map((item) => item.email.trim().toLowerCase());
      } catch {
        return null;
      }
    };
    return { id: id as number, login, verifiedEmails };
  } catch {
    return null;
  }
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** Stored form: `pbkdf2:<iterations>:<salt b64>:<hash b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toBase64(salt)}:${toBase64(hash)}`;
}

/**
 * Never throws: a stored hash that is not decodable base64 (hand-edited row, a
 * future scheme) is a failed verification, not a 500 on the login route.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split(":");
  if (scheme !== "pbkdf2" || !iterations || !salt || !hash) return false;
  const rounds = Number.parseInt(iterations, 10);
  if (!Number.isInteger(rounds) || rounds < 1) return false;

  let expected: Uint8Array<ArrayBuffer>;
  let actual: Uint8Array<ArrayBuffer>;
  try {
    expected = fromBase64(hash);
    actual = await derive(password, fromBase64(salt), rounds);
  } catch {
    return false;
  }

  if (expected.length !== actual.length) return false;
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(expected, actual);
  // Accumulate the difference instead of returning early, so the comparison
  // takes the same time whatever the mismatch is.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ actual[i]!;
  return diff === 0;
}

/**
 * Verifies `candidate` against `userId`'s stored password hash. Returns the exact
 * stored hash string on success so callers can use it in compare-and-set queries,
 * or `null` on any failure (missing user, malformed hash, mismatch). Never throws.
 */
export async function verifyUserPassword(
  env: Env,
  userId: string,
  candidate: string,
): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT password_hash AS passwordHash FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{ passwordHash: string }>();
    if (!row?.passwordHash) return null;
    const ok = await verifyPassword(candidate, row.passwordHash);
    return ok ? row.passwordHash : null;
  } catch {
    return null;
  }
}

/**
 * `users.password_hash` of an account created through GitHub and not yet given a password (ADR 0065): no PBKDF2
 * scheme, so `verifyPassword` never matches it and no password signs in. The marker for "has no password", kept
 * in the NOT NULL column rather than a nullable one, so nothing that reads the column has to learn a new case.
 */
export const NO_PASSWORD_HASH = "*";

/** The `users` columns of a `SessionUser`. D1 has no boolean: `hasPassword` comes back 0/1, so read rows through `toSessionUser`. */
export const SESSION_USER_COLS = `users.id AS id, users.email AS email, users.name AS name,
  users.github_login AS githubLogin, users.avatar_version AS avatarVersion, users.timezone AS timezone,
  users.password_hash != '${NO_PASSWORD_HASH}' AS hasPassword`;

export type SessionUserRow = Omit<SessionUser, "hasPassword"> & { hasPassword: number };

export function toSessionUser(row: SessionUserRow): SessionUser {
  return { ...row, hasPassword: row.hasPassword === 1 };
}

/** An unspent signup invite stops working this long after it was made, so a link that leaked long ago signs nobody up. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Spends `invite` and inserts the user in one D1 batch, so a token is never spent without its user nor a
 * user created without a token: the UPDATE claims the token only while it is unspent, and the INSERT's
 * EXISTS sees that claim only if it landed. Resolves false when the invite was not spendable. A failing
 * INSERT (duplicate email or GitHub id) throws, and the batch rolls the claim back with it.
 */
export async function createUserWithInvite(
  db: D1Database,
  invite: string,
  user: { id: string; email: string; name: string; passwordHash: string; githubLogin?: string; githubUserId?: number },
  now: number,
): Promise<boolean> {
  const [claim] = await db.batch([
    db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE token = ? AND used_at IS NULL AND created_at > ?").bind(user.id, now, invite, now - INVITE_TTL_MS),
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, created_at, github_login, github_user_id)
       SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM invites WHERE token = ? AND used_by = ? AND used_at = ?)`,
    ).bind(user.id, user.email, user.name, user.passwordHash, now, user.githubLogin ?? null, user.githubUserId ?? null, invite, user.id, now),
  ]);
  return claim?.meta.changes === 1;
}

/**
 * Signing up with GitHub (ADR 0065): email signup's invite gate, with the GitHub account standing in for the
 * email and password. Resolves the new user's id, or why there is none:
 * - `exists`: a verified GitHub address is already a foxban account's. Never linked automatically, since
 *   whoever controls that address on GitHub could otherwise take the account over.
 * - `unlinked`: no spendable invite (missing, unknown or spent, indistinguishably, like email signup).
 * - `error`: GitHub would not list the addresses, no non-Admin address is left for the account, or a concurrent signup won the same address or GitHub id.
 */
export async function signUpWithGitHub(
  env: Env,
  account: GitHubAccount,
  invite: string | undefined,
): Promise<{ ok: true; userId: string } | { ok: false; problem: "exists" | "unlinked" | "error" }> {
  const emails = await account.verifiedEmails();
  if (emails === null) return { ok: false, problem: "error" };
  const taken = await env.DB.prepare("SELECT 1 FROM users WHERE email IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(emails))
    .first();
  if (taken) return { ok: false, problem: "exists" };
  if (!invite) return { ok: false, problem: "unlinked" };

  // Admin is derived from the address, and signing up with GitHub never grants it: an account whose address is
  // on the admin list (or with no verified address at all) gets GitHub's private no-reply address instead.
  const email = emails[0] !== undefined && !isAdminEmail(env, emails[0]) ? emails[0] : `${account.id}+${account.login}@users.noreply.github.com`;
  // A list that names the no-reply address itself leaves no safe address: refuse.
  if (isAdminEmail(env, email)) return { ok: false, problem: "error" };
  const userId = crypto.randomUUID();
  try {
    const created = await createUserWithInvite(
      env.DB,
      invite,
      { id: userId, email, name: account.login, passwordHash: NO_PASSWORD_HASH, githubLogin: account.login, githubUserId: account.id },
      Date.now(),
    );
    return created ? { ok: true, userId } : { ok: false, problem: "unlinked" };
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) return { ok: false, problem: "error" };
    throw error;
  }
}

/** Creates a session row for `userId` and puts its id in the response cookie. */
export async function startSession(
  c: Context<AppEnv>,
  userId: string,
  verifiedHash?: string,
): Promise<boolean> {
  const now = Date.now();
  const id = randomHex(32);
  const inserted = verifiedHash === undefined
    ? await c.env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(id, userId, now + SESSION_TTL_MS)
        .run()
    : await c.env.DB.prepare(
        `INSERT INTO sessions (id, user_id, expires_at)
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)`,
      )
        .bind(id, userId, now + SESSION_TTL_MS, userId, verifiedHash)
        .run();
  if (inserted.meta.changes !== 1) return false;
  // Expired rows are already rejected on read; sweeping them here keeps the table
  // from growing forever without a cron trigger. Cheap, and only on login.
  await c.env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    // Local development is plain http, where a Secure cookie would be dropped.
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return true;
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Resolves the session cookie to a user, or answers 401. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return c.json({ error: "unauthorized" } as const, 401);

  const row = await c.env.DB.prepare(
    `SELECT ${SESSION_USER_COLS}
       FROM sessions
       JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ? AND sessions.expires_at > ?`,
  )
    .bind(sessionId, Date.now())
    .first<SessionUserRow>();
  if (!row) return c.json({ error: "unauthorized" } as const, 401);

  c.set("user", toSessionUser(row));
  await next();
});

/** Gates the invite routes. Runs after `requireAuth`, so no session is a 401. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!isAdminEmail(c.env, c.get("user").email)) {
    return c.json({ error: "forbidden" } as const, 403);
  }
  await next();
});

/**
 * Callers that are this machine: `wrangler dev` fills `CF-Connecting-IP` in with
 * a loopback address, and the edge never reports one, so these are exactly the
 * requests that came from a local dev loop rather than a client on the internet.
 */
const LOOPBACK_IPS: Record<string, true> = {
  "127.0.0.1": true,
  "::1": true,
  "::ffff:127.0.0.1": true,
};

/**
 * Caps password attempts per client IP on the routes that verify one (login and
 * the authenticated email/password change routes).
 *
 * Both a binding and a non-local client are required. `CF-Connecting-IP` is set
 * by Cloudflare's edge on every request and cannot be forged from outside it, so
 * a missing or loopback value means the request never crossed the edge: a direct
 * `wrangler dev` hit or a `SELF.fetch` in the test pool. Throttling those would
 * only make the dev loop and the e2e suite fail, for no security gain.
 */
export const rateLimitAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await underAuthLimit(c, c.req.header("CF-Connecting-IP")))) return c.json({ error: "too many requests" } as const, 429);
  await next();
});

/**
 * Caps password attempts on one account across every IP (`ACCOUNT_RATE_LIMITER`, higher than the
 * per-IP limit so a single IP cannot lock the owner out). Login, email change and password change share it.
 */
export function underAccountLimit(c: Context<AppEnv>, email: string): Promise<boolean> {
  return underAuthLimit(c, `account:${email.trim().toLowerCase()}`, c.env.ACCOUNT_RATE_LIMITER);
}

/**
 * One more attempt against `key` on `limiter` (default `AUTH_RATE_LIMITER`), true while it is under the limit.
 * Local and test requests (no edge client address) are never limited.
 */
export async function underAuthLimit(
  c: Context<AppEnv>,
  key: string | undefined,
  limiter: RateLimit | undefined = c.env.AUTH_RATE_LIMITER,
): Promise<boolean> {
  const ip = c.req.header("CF-Connecting-IP");
  if (!limiter || !key || !ip || LOOPBACK_IPS[ip]) return true;
  return (await limiter.limit({ key })).success;
}

/**
 * Caps exact-email lookups (ADR 0072) per signed-in user, so the one-address-at-a-time
 * answer cannot be run down a list of guesses. Runs after `requireAuth`, only for a request that
 * carries `?email=`, and skips local and test requests the way `rateLimitAuth` does.
 */
export const rateLimitLookup = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.query("email") !== undefined && !(await underAuthLimit(c, `lookup:${c.get("user").id}`))) {
    return c.json({ error: "too many requests" } as const, 429);
  }
  await next();
});

async function findAccessibleBoardWhere(
  env: Env,
  user: SessionUser,
  column: "boards.id" | "boards.board_key",
  value: string,
): Promise<AccessibleBoard | null> {
  const operator = isAdminEmail(env, user.email);
  const raw = await env.DB.prepare(
    `SELECT ${BOARD_SELECT_COLS},
            bm.role AS explicitRole,
            wm.role AS workspaceRole,
            CASE WHEN boards.owner_id=? THEN 1 ELSE 0 END AS ownerAccess,
            ? AS operatorAccess
       FROM boards
       JOIN workspaces ON workspaces.id=boards.workspace_id
       LEFT JOIN board_members bm ON bm.board_id=boards.id AND bm.user_id=?
       LEFT JOIN workspace_members wm ON wm.workspace_id=boards.workspace_id AND wm.user_id=?
      WHERE ${column}=?
        AND ${boardOpenSql("boards", "?", "?=1")}`,
  )
    .bind(user.id, operator ? 1 : 0, user.id, user.id, value, operator ? 1 : 0, user.id, user.id, user.id)
    .first<RawBoardRecord>();
  if (!raw) return null;
  return { ...toBoardRow(raw), pendingAccessChange: raw.pendingAccessOperationId != null };
}

/**
 * Distinguishes "no such board" from "no access" for the routes that answer
 * 404, so a denial keeps the non-disclosure a missing row already had.
 */
export async function boardExists(env: Env, boardId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM boards WHERE id=?")
    .bind(boardId)
    .first<{ id: string }>();
  return row !== null;
}

/** Resolves explicit, workspace-inherited, owner, and configured-operator access. */
export function findAccessibleBoard(
  env: Env,
  user: SessionUser,
  boardId: string,
): Promise<AccessibleBoard | null> {
  return findAccessibleBoardWhere(env, user, "boards.id", boardId);
}

export function findAccessibleBoardByKey(
  env: Env,
  user: SessionUser,
  boardKey: string,
): Promise<AccessibleBoard | null> {
  return findAccessibleBoardWhere(env, user, "boards.board_key", boardKey);
}

/**
 * Requires the authenticated user to be a member of `:id`, and exposes the board
 * row so member routes need no second query. Membership is only ever checked
 * when a request arrives — for the WebSocket that means at connect time. A
 * change that takes someone's access away runs as an access change, which fences
 * the board and drops their open sockets (`access-changes.ts`). Account admins
 * bypass membership at request/connect time without writing membership rows.
 */
export const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  const boardId = c.req.param("id");
  if (!boardId) return c.json({ error: "forbidden" } as const, 403);
  const board = await findAccessibleBoard(c.env, user, boardId);
  if (!board) return c.json({ error: "forbidden" } as const, 403);

  c.set("board", board);
  await next();
});
