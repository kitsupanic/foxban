import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, newPasswordProblem } from "@foxban/shared";
import {
  adminEmails,
  appOrigin,
  createUserWithInvite,
  endSession,
  fetchGitHubUser,
  hashPassword,
  isAdminEmail,
  NO_PASSWORD_HASH,
  rateLimitAuth,
  requireAuth,
  SESSION_COOKIE,
  sha256Hex,
  signUpWithGitHub,
  startSession,
  toAuthUser,
  underAccountLimit,
  verifyPassword,
  verifyUserPassword,
  revokeRealtimeSessions,
  type AppEnv,
  type SessionUser,
} from "./auth";
import { getInstanceGitHubAppSummary, loadInstanceGitHubApp } from "./github-app";

/**
 * Every string is bounded — an unbounded body reaches PBKDF2 and D1 otherwise.
 */
const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const PasswordSchema = z.string().max(PASSWORD_MAX_LENGTH);
const NewPasswordSchema = PasswordSchema.min(PASSWORD_MIN_LENGTH).refine(
  (password) => newPasswordProblem(password) === null,
  { message: "password is too predictable" },
);


export const NameSchema = z.string().trim().min(1).max(200);

const SignupSchema = z.object({
  email: EmailSchema,
  password: NewPasswordSchema,
  name: NameSchema,
  // Bounded well above a 43-character base64url token; the value is only ever
  // compared against a stored one, never parsed.
  invite: z.string().max(256).optional(),
});
const LoginSchema = z.object({ email: EmailSchema, password: PasswordSchema.min(1) });
const EmailChangeSchema = z.object({
  email: EmailSchema,
  currentPassword: PasswordSchema.min(1),
});
const PasswordChangeSchema = z.object({
  // Absent only for an account with no password yet (ADR 0065); the route decides which accounts may omit it.
  currentPassword: PasswordSchema.min(1).optional(),
  newPassword: NewPasswordSchema,
});

/** A GitHub round trip (state cookie, and the stored link state) is good for ten minutes. */
const GITHUB_FLOW_TTL_SECONDS = 600;
/** A reauthorization the account's own GitHub id approved lets a password-less account set its first password, once, within this long (ADR 0081). */
const GITHUB_REAUTH_TTL_MS = 600_000;
/** Absent only for an account with no password (ADR 0065); the route decides which accounts may omit it (ADR 0081). */
const GitHubLinkSchema = z.object({ currentPassword: PasswordSchema.min(1).optional() });

const GITHUB_STATE_COOKIE = "github_oauth_state";
const GITHUB_LOGIN_STATE_COOKIE = "github_login_state";
/** The signup invite the person holds, kept across the GitHub round trip next to the state. */
const GITHUB_LOGIN_INVITE_COOKIE = "github_login_invite";
/** The workspace invitation (`<workspaceId>.<token>`) the login page holds in its `#workspaceInvite=`, which a full-page GitHub round trip would lose. */
const GITHUB_LOGIN_WORKSPACE_INVITE_COOKIE = "github_login_workspace_invite";
/** Both halves are ids or base64url tokens, so a match is safe to put in a redirect as it is. */
const WORKSPACE_CONTINUATION = /^([\w-]{1,64})\.([\w-]{1,128})$/;

/**
 * Verified against when the email is unknown, so a login attempt costs the same
 * PBKDF2 work either way. Fixed bytes with the production iteration count — it
 * is not a hash of any password, and no input can match it.
 */
const DUMMY_PASSWORD_HASH =
  "pbkdf2:100000:WlpaWlpaWlpaWlpaWlpaWg==:paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU=";

/**
 * Every invite failure answers with this, so signup cannot be used to probe
 * whether a token exists, is spent, or was never minted.
 */
const INVITE_REQUIRED = { error: "a valid invite is required to sign up" } as const;

/** An account made with GitHub has no password until it sets one (ADR 0065); what needs a password to prove itself is refused until then. */
export const passwordRequired = (error: string) => ({ error, code: "PASSWORD_REQUIRED" }) as const;

/** A password-less account sets its first password only after approving its own GitHub account on this session (ADR 0081); the web says so and offers the GitHub step again. */
const GITHUB_REAUTH_REQUIRED = { error: "confirm with GitHub first", code: "GITHUB_REAUTH_REQUIRED" } as const;

/** A fresh instance with no `ADMIN_EMAILS` can never admit its first user; say so. */
const ADMIN_NOT_CONFIGURED = { error: "no admin is configured", code: "ADMIN_NOT_CONFIGURED" } as const;

/** A cookie that lives for the GitHub round trip. Lax, so it comes back on GitHub's redirect to the callback. */
function githubFlowCookie(c: Context<AppEnv>) {
  return { httpOnly: true, sameSite: "Lax", path: "/", secure: new URL(c.req.url).protocol === "https:", maxAge: GITHUB_FLOW_TTL_SECONDS } as const;
}

/** Keeps `value` in a flow cookie for the round trip; with none, clears what an abandoned attempt left behind. */
function carryInFlowCookie(c: Context<AppEnv>, name: string, value: string | undefined) {
  if (value) setCookie(c, name, value, githubFlowCookie(c));
  else if (getCookie(c, name)) deleteCookie(c, name, { path: "/" });
}

/** Reads a flow cookie and clears it, so it is good for one callback. */
function takeFlowCookie(c: Context<AppEnv>, name: string): string | undefined {
  const value = getCookie(c, name);
  if (value !== undefined) deleteCookie(c, name, { path: "/" });
  return value;
}

/** Starts a GitHub round trip: a fresh `state` also kept in `stateCookie` (the pairing the callback checks), and the authorize URL that carries it. */
function beginGitHubFlow(c: Context<AppEnv>, clientId: string, stateCookie: string, callbackPath: string) {
  const state = crypto.randomUUID();
  setCookie(c, stateCookie, state, githubFlowCookie(c));
  const url = new URL("/login/oauth/authorize", c.env.GITHUB_OAUTH_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${appOrigin(c.env, c.req.url)}${callbackPath}`);
  url.searchParams.set("state", state);
  return { state, url: url.toString() };
}

/**
 * Keeps the flow's state hash, expiry and purpose on the caller's session. The state cookie alone is no proof:
 * anyone can set one in their own browser. This row is what the callback checks, and its purpose picks what the
 * one callback URL does, so a state started for a link never grants a reauthorization or the other way round.
 */
async function storeGitHubFlow(c: Context<AppEnv>, state: string, purpose: "link" | "reauth") {
  await c.env.DB.prepare("UPDATE sessions SET github_link_state_hash = ?, github_link_expires_at = ?, github_link_purpose = ? WHERE id = ?")
    .bind(await sha256Hex(state), Date.now() + GITHUB_FLOW_TTL_SECONDS * 1000, purpose, getCookie(c, SESSION_COOKIE) ?? "")
    .run();
}

export const authRouter = new Hono<AppEnv>()
  .post("/auth/signup", rateLimitAuth, zValidator("json", SignupSchema), async (c) => {
    const { email, password, name, invite } = c.req.valid("json");
    const user = toAuthUser(c.env, { id: crypto.randomUUID(), email, name, githubLogin: null, avatarVersion: null, timezone: null, hasPassword: true });
    const now = Date.now();
    const passwordHash = await hashPassword(password);
    try {
      if (user.isAdmin) {
        // ADMIN_EMAILS is the authorization; an invite passed anyway is ignored
        // and left unspent, so nobody has to mint one for the first account.
        await c.env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(user.id, email, name, passwordHash, now)
          .run();
      } else {
        if (!invite) {
          // Only for the no-invite case, so it reveals nothing about any token.
          const noAdmin = adminEmails(c.env).length === 0;
          return c.json(noAdmin ? ADMIN_NOT_CONFIGURED : INVITE_REQUIRED, 403);
        }
        // A failing INSERT (duplicate email) rolls the invite claim back with the batch.
        if (!(await createUserWithInvite(c.env.DB, invite, { id: user.id, email, name, passwordHash }, now))) {
          return c.json(INVITE_REQUIRED, 403);
        }
      }
    } catch (error) {
      // D1 surfaces the users.email uniqueness index as a constraint error.
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "email already registered" }, 409);
      }
      throw error;
    }
    await startSession(c, user.id);
    return c.json(user);
  })
  .post("/auth/login", rateLimitAuth, zValidator("json", LoginSchema), async (c) => {
    const { email, password } = c.req.valid("json");
    // The per-IP limit alone lets many addresses guess one account's password together.
    if (!(await underAccountLimit(c, email))) return c.json({ error: "too many requests" } as const, 429);
    const row = await c.env.DB.prepare(
      `SELECT id, email, name, github_login AS githubLogin, avatar_version AS avatarVersion, timezone, password_hash AS passwordHash
         FROM users WHERE email = ?`,
    )
      .bind(email)
      .first<{
        id: string;
        email: string;
        name: string;
        githubLogin: string | null;
        avatarVersion: string | null;
        timezone: string | null;
        passwordHash: string;
      }>();
    // An unknown email still pays for one PBKDF2 derivation, so the response time
    // does not reveal which accounts exist. Both failures answer the same 401.
    // A GitHub-only account has the marker, which verifies instantly; it pays for a derivation too.
    const stored = row && row.passwordHash !== NO_PASSWORD_HASH ? row.passwordHash : DUMMY_PASSWORD_HASH;
    const ok = await verifyPassword(password, stored);
    if (!row || !ok) {
      return c.json({ error: "invalid credentials" }, 401);
    }
    if (!(await startSession(c, row.id, stored))) {
      return c.json({ error: "invalid credentials" }, 401);
    }
    return c.json(
      toAuthUser(c.env, {
        id: row.id,
        email: row.email,
        name: row.name,
        githubLogin: row.githubLogin,
        avatarVersion: row.avatarVersion,
        timezone: row.timezone,
        // Only a stored password verifies, so this account has one.
        hasPassword: true,
      }),
    );
  })
  .post("/auth/logout", async (c) => {
    await endSession(c);
    return c.json({ ok: true });
  })
  .post(
    "/auth/email",
    requireAuth,
    rateLimitAuth,
    zValidator("json", EmailChangeSchema),
    async (c) => {
      const { email: nextEmail, currentPassword } = c.req.valid("json");
      const user = c.get("user");
      if (!(await underAccountLimit(c, user.email))) return c.json({ error: "too many requests" } as const, 429);
      // No password to prove ownership with (ADR 0065): refused before any admin or duplicate inspection too.
      if (!user.hasPassword) return c.json(passwordRequired("set a password before changing your email"), 403);
      // Current password must be verified before any admin or duplicate inspection,
      // so an invalid password cannot be used to probe whether an address is taken
      // or configured as an admin.
      const verifiedHash = await verifyUserPassword(c.env, user.id, currentPassword);
      if (!verifiedHash) {
        return c.json({ error: "invalid credentials" }, 401);
      }

      if (isAdminEmail(c.env, user.email) !== isAdminEmail(c.env, nextEmail)) {
        return c.json({ error: "email cannot change administrator access" }, 403);
      }

      try {
        const { meta } = await c.env.DB.prepare(
          "UPDATE users SET email = ? WHERE id = ? AND password_hash = ?",
        )
          .bind(nextEmail, user.id, verifiedHash)
          .run();
        if (meta.changes === 0) {
          return c.json({ error: "invalid credentials" }, 401);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
          return c.json({ error: "email already registered" }, 409);
        }
        throw error;
      }

      const updatedUser: SessionUser = { ...user, email: nextEmail };
      return c.json(toAuthUser(c.env, updatedUser));
    },
  )
  .post(
    "/auth/password",
    requireAuth,
    rateLimitAuth,
    zValidator("json", PasswordChangeSchema),
    async (c) => {
      const { currentPassword, newPassword } = c.req.valid("json");
      const user = c.get("user");
      if (!(await underAccountLimit(c, user.email))) return c.json({ error: "too many requests" } as const, 429);
      const sessionId = getCookie(c, SESSION_COOKIE) ?? "";
      // An account with no password has no secret to prove, and the session alone must not be enough: a first
      // password is a new sign-in credential. It has to have approved its own GitHub account on this session
      // just now (ADR 0081, amending 0065); the callback leaves that proof, and the batch below spends it.
      // The compare-and-set against the marker lets only one first password win. Anything else must present the current one.
      if (!user.hasPassword && !(await c.env.DB.prepare("SELECT 1 FROM sessions WHERE id = ? AND github_reauth_until > ?").bind(sessionId, Date.now()).first())) {
        return c.json(GITHUB_REAUTH_REQUIRED, 401);
      }
      const verifiedHash = user.hasPassword
        ? currentPassword === undefined ? null : await verifyUserPassword(c.env, user.id, currentPassword)
        : NO_PASSWORD_HASH;
      if (!verifiedHash) {
        return c.json({ error: "invalid credentials" }, 401);
      }

      const newHash = await hashPassword(newPassword);

      const [updateResult] = await c.env.DB.batch([
        // The marker case checks the proof again in the same statement, so it cannot expire or be spent between the read above and here.
        c.env.DB.prepare(
          `UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?
              AND (password_hash != ? OR EXISTS (SELECT 1 FROM sessions WHERE id = ? AND github_reauth_until > ?))`,
        ).bind(newHash, user.id, verifiedHash, NO_PASSWORD_HASH, sessionId, Date.now()),
        c.env.DB.prepare(
          `DELETE FROM sessions
            WHERE user_id = ?
              AND id != ?
              AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)`,
        ).bind(user.id, sessionId, user.id, newHash),
        c.env.DB.prepare("UPDATE sessions SET github_reauth_until = NULL WHERE id = ?").bind(sessionId),
      ]);

      if (updateResult?.meta.changes !== 1) {
        return c.json({ error: "invalid credentials" }, 401);
      }
      // The other sessions' rows are gone; their open sockets must go too (ADR 0082).
      revokeRealtimeSessions(c.env, c.executionCtx, user.id, { exceptSessionHash: await sha256Hex(sessionId) });

      return c.json({ ok: true });
    },
  )
  // The instance GitHub App's user sign-in flow, and the only writer of `users.github_login`.
  // A linked GitHub id is a sign-in credential (ADR 0065), so linking is proved twice (ADR 0081): the account's
  // current password before the flow starts, and a state the server stored against this session for the callback.
  // The callback is navigated to by the browser; the starts are JSON calls that answer the GitHub URL.
  // Both starts share the one callback URL, which the App's registered callback list already holds: what the callback does follows from the purpose stored with the state.
  .post("/auth/github/link", requireAuth, rateLimitAuth, zValidator("json", GitHubLinkSchema), async (c) => {
    const { currentPassword } = c.req.valid("json");
    const user = c.get("user");
    if (!(await underAccountLimit(c, user.email))) return c.json({ error: "too many requests" } as const, 429);
    // No App yet (an Admin creates it, ADR 0064): the feature is off, not broken.
    const githubApp = await getInstanceGitHubAppSummary(c.env);
    if (!githubApp) return c.json({ error: "GitHub is not configured" } as const, 503);
    // An account with no password has nothing to prove (ADR 0065); the callback only lets it fill an empty slot.
    if (user.hasPassword && (currentPassword === undefined || !(await verifyUserPassword(c.env, user.id, currentPassword)))) {
      return c.json({ error: "invalid credentials" } as const, 401);
    }
    const { state, url } = beginGitHubFlow(c, githubApp.clientId, GITHUB_STATE_COOKIE, "/auth/github/callback");
    await storeGitHubFlow(c, state, "link");
    return c.json({ url });
  })
  // The step before a password-less account's first password (ADR 0081): the same round trip as a link, but the
  // callback only checks that GitHub approved the account's own id. Refused for an account that has a password.
  .post("/auth/github/reauth", requireAuth, rateLimitAuth, async (c) => {
    const user = c.get("user");
    if (!(await underAccountLimit(c, user.email))) return c.json({ error: "too many requests" } as const, 429);
    if (user.hasPassword) return c.json({ error: "this account already has a password" } as const, 400);
    const githubApp = await getInstanceGitHubAppSummary(c.env);
    if (!githubApp) return c.json({ error: "GitHub is not configured" } as const, 503);
    const { state, url } = beginGitHubFlow(c, githubApp.clientId, GITHUB_STATE_COOKIE, "/auth/github/callback");
    await storeGitHubFlow(c, state, "reauth");
    return c.json({ url });
  })
  .get("/auth/github/callback", requireAuth, async (c) => {
    const fail = (reason: "error" | "taken" | "reauth-error" = "error") => c.redirect(`${appOrigin(c.env, c.req.url)}/profile?github=${reason}`);
    const state = c.req.query("state");
    const code = c.req.query("code");
    const expected = getCookie(c, GITHUB_STATE_COOKIE);
    deleteCookie(c, GITHUB_STATE_COOKIE, { path: "/" });
    const sessionId = getCookie(c, SESSION_COOKIE) ?? "";
    // The stored state is single use: the first callback spends it, whatever comes of the rest. The first statement
    // answers the purpose it was stored with only when it was this one that spent it (RETURNING shows the row after
    // the update, so it leaves the purpose for the second statement to clear).
    const [spent] = await c.env.DB.batch<{ purpose: string }>([
      c.env.DB.prepare(
        `UPDATE sessions SET github_link_state_hash = NULL, github_link_expires_at = NULL
          WHERE id = ? AND github_link_state_hash = ? AND github_link_expires_at > ?
          RETURNING github_link_purpose AS purpose`,
      ).bind(sessionId, await sha256Hex(state ?? ""), Date.now()),
      c.env.DB.prepare("UPDATE sessions SET github_link_state_hash = NULL, github_link_expires_at = NULL, github_link_purpose = NULL WHERE id = ?").bind(sessionId),
    ]);
    const purpose = spent?.results[0]?.purpose;
    if (purpose !== "link" && purpose !== "reauth") return fail();
    const failure = purpose === "reauth" ? "reauth-error" : "error";
    // The row was spent, so the purpose is known: from here a reauth failure is `reauth-error`. A state that does
    // not match the cookie is not this person's flow and stays `error`.
    if (!state || !expected || state !== expected) return fail();
    // No code: GitHub sent `error=access_denied` (the person pressed Cancel) or something else.
    if (!code) return fail(failure);
    // A missing or unreadable App record is a misconfigured instance, not a server error to the person linking.
    const githubApp = await loadInstanceGitHubApp(c.env).catch(() => null);
    if (!githubApp) return fail(failure);
    const account = await fetchGitHubUser(c.env, githubApp, code, `${appOrigin(c.env, c.req.url)}/auth/github/callback`);
    if (account === null) return fail(failure);
    if (purpose === "reauth") {
      // The proof is that GitHub approved the account this one signs in with. Nothing is linked or renamed here,
      // and an account with no stored id (nothing to match) never gets one.
      const { meta } = await c.env.DB.prepare(
        "UPDATE sessions SET github_reauth_until = ? WHERE id = ? AND EXISTS (SELECT 1 FROM users WHERE users.id = sessions.user_id AND users.github_user_id = ?)",
      )
        .bind(Date.now() + GITHUB_REAUTH_TTL_MS, sessionId, account.id)
        .run();
      return meta.changes === 1 ? c.redirect(`${appOrigin(c.env, c.req.url)}/profile?github=reauthed`) : fail("reauth-error");
    }
    try {
      // Fills an empty slot or follows a rename of the same account. It never replaces another GitHub id: that
      // needs an explicit disconnect first, which needs a password to exist (ADR 0081).
      const { meta } = await c.env.DB.prepare(
        "UPDATE users SET github_login = ?, github_user_id = ? WHERE id = ? AND (github_user_id IS NULL OR github_user_id = ?)",
      )
        .bind(account.login, account.id, c.get("user").id, account.id)
        .run();
      if (meta.changes === 0) return fail();
    } catch (error) {
      // The unique index on github_user_id: another foxban account already has this GitHub account.
      if (String(error).includes("UNIQUE constraint failed")) return fail("taken");
      throw error;
    }
    return c.redirect(`${appOrigin(c.env, c.req.url)}/profile`);
  })
  // Signing in with the instance GitHub App (ADR 0065): public, so both ends are rate limited like login.
  // Every outcome is a redirect to /login, where `?github=` carries the reason.
  // `?invite=` is the signup page's link: an unknown GitHub account may sign up with it (ADR 0065).
  // `?workspaceInvite=<workspaceId>.<token>` is the login or signup page's pending workspace invitation: the person lands on its join page once signed in.
  .get("/auth/github/login/start", rateLimitAuth, async (c) => {
    const queried = c.req.query("workspaceInvite");
    const workspaceInvite = queried !== undefined && WORKSPACE_CONTINUATION.test(queried) ? queried : undefined;
    const githubApp = await getInstanceGitHubAppSummary(c.env);
    if (!githubApp) return c.redirect(`${appOrigin(c.env, c.req.url)}/login?github=unavailable${workspaceInvite ? `#workspaceInvite=${workspaceInvite}` : ""}`);
    // Anything left behind by an abandoned attempt must not ride along with this one.
    carryInFlowCookie(c, GITHUB_LOGIN_INVITE_COOKIE, c.req.query("invite"));
    carryInFlowCookie(c, GITHUB_LOGIN_WORKSPACE_INVITE_COOKIE, workspaceInvite);
    return c.redirect(beginGitHubFlow(c, githubApp.clientId, GITHUB_LOGIN_STATE_COOKIE, "/auth/github/login/callback").url);
  })
  .get("/auth/github/login/callback", rateLimitAuth, async (c) => {
    const origin = appOrigin(c.env, c.req.url);
    const { state, code, error } = c.req.query();
    const expected = takeFlowCookie(c, GITHUB_LOGIN_STATE_COOKIE);
    const invite = takeFlowCookie(c, GITHUB_LOGIN_INVITE_COOKIE);
    const joining = WORKSPACE_CONTINUATION.exec(takeFlowCookie(c, GITHUB_LOGIN_WORKSPACE_INVITE_COOKIE) ?? "");
    // A failed round trip goes back to the login page holding the invitation again, so a retry keeps it.
    const fail = (reason: "error" | "cancelled" | "unlinked" | "exists" = "error") =>
      c.redirect(`${origin}/login?github=${reason}${joining ? `#workspaceInvite=${joining[0]}` : ""}`);
    const signedIn = () => c.redirect(joining ? `${origin}/join-workspace/${joining[1]}#invite=${joining[2]}` : `${origin}/`);
    if (!state || !expected || state !== expected) return fail();
    // GitHub sends `error=access_denied` when the person presses Cancel on its approval page.
    if (error) return fail(error === "access_denied" ? "cancelled" : "error");
    if (!code) return fail();
    // A missing or unreadable App record is a misconfigured instance, not a server error to the person signing in.
    const githubApp = await loadInstanceGitHubApp(c.env).catch(() => null);
    if (!githubApp) return fail();
    const account = await fetchGitHubUser(c.env, githubApp, code, `${origin}/auth/github/login/callback`);
    if (account === null) return fail();
    // The numeric id is the key: a login name can be renamed away and handed to someone else.
    const row = await c.env.DB.prepare("SELECT id, github_login AS githubLogin FROM users WHERE github_user_id = ?")
      .bind(account.id)
      .first<{ id: string; githubLogin: string | null }>();
    if (!row) {
      // Not linked to any account: signing up, which the invite (and no GitHub-side e-mail match) allows.
      const created = await signUpWithGitHub(c.env, account, invite);
      if (!created.ok) return fail(created.problem);
      await startSession(c, created.userId);
      return signedIn();
    }
    // Follow a rename, so the avatar stays the account owner's.
    if (row.githubLogin !== account.login) {
      await c.env.DB.prepare("UPDATE users SET github_login = ? WHERE id = ?").bind(account.login, row.id).run();
    }
    await startSession(c, row.id);
    return signedIn();
  });
