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
  signUpWithGitHub,
  startSession,
  toAuthUser,
  underAccountLimit,
  verifyPassword,
  verifyUserPassword,
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

/** A fresh instance with no `ADMIN_EMAILS` can never admit its first user; say so. */
const ADMIN_NOT_CONFIGURED = { error: "no admin is configured", code: "ADMIN_NOT_CONFIGURED" } as const;

/** A cookie that lives for the GitHub round trip. Lax, so it comes back on GitHub's redirect to the callback. */
function githubFlowCookie(c: Context<AppEnv>) {
  return { httpOnly: true, sameSite: "Lax", path: "/", secure: new URL(c.req.url).protocol === "https:", maxAge: 600 } as const;
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

/** Sends the browser to GitHub to approve the instance App, with a fresh `state` also kept in `stateCookie`: the pairing the callback checks. */
function redirectToGitHub(c: Context<AppEnv>, clientId: string, stateCookie: string, callbackPath: string) {
  const state = crypto.randomUUID();
  setCookie(c, stateCookie, state, githubFlowCookie(c));
  const url = new URL("/login/oauth/authorize", c.env.GITHUB_OAUTH_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${appOrigin(c.env, c.req.url)}${callbackPath}`);
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
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
    const stored = row?.passwordHash ?? DUMMY_PASSWORD_HASH;
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
      // An account with no password has nothing to prove: the session is enough, and the compare-and-set below
      // against the marker lets only one first password win. Anything else must present the current one.
      const verifiedHash = user.hasPassword
        ? currentPassword === undefined ? null : await verifyUserPassword(c.env, user.id, currentPassword)
        : NO_PASSWORD_HASH;
      if (!verifiedHash) {
        return c.json({ error: "invalid credentials" }, 401);
      }

      const newHash = await hashPassword(newPassword);
      const sessionId = getCookie(c, SESSION_COOKIE) ?? "";

      const [updateResult] = await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?",
        ).bind(newHash, user.id, verifiedHash),
        c.env.DB.prepare(
          `DELETE FROM sessions
            WHERE user_id = ?
              AND id != ?
              AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)`,
        ).bind(user.id, sessionId, user.id, newHash),
      ]);

      if (updateResult?.meta.changes !== 1) {
        return c.json({ error: "invalid credentials" }, 401);
      }

      return c.json({ ok: true });
    },
  )
  // The instance GitHub App's user sign-in flow, and the only writer of `users.github_login`.
  // Both links are navigated to by the browser, never called through `hc`.
  .get("/auth/github/start", requireAuth, async (c) => {
    // No App yet (an Admin creates it, ADR 0064): the feature is off, not broken.
    const githubApp = await getInstanceGitHubAppSummary(c.env);
    if (!githubApp) return c.json({ error: "GitHub is not configured" }, 503);
    return redirectToGitHub(c, githubApp.clientId, GITHUB_STATE_COOKIE, "/auth/github/callback");
  })
  .get("/auth/github/callback", requireAuth, async (c) => {
    const fail = (reason: "error" | "taken" = "error") => c.redirect(`${appOrigin(c.env, c.req.url)}/profile?github=${reason}`);
    const state = c.req.query("state");
    const code = c.req.query("code");
    const expected = getCookie(c, GITHUB_STATE_COOKIE);
    deleteCookie(c, GITHUB_STATE_COOKIE, { path: "/" });
    if (!state || !code || !expected || state !== expected) return fail();
    // A missing or unreadable App record is a misconfigured instance, not a server error to the person linking.
    const githubApp = await loadInstanceGitHubApp(c.env).catch(() => null);
    if (!githubApp) return fail();
    const account = await fetchGitHubUser(c.env, githubApp, code, `${appOrigin(c.env, c.req.url)}/auth/github/callback`);
    if (account === null) return fail();
    try {
      await c.env.DB.prepare("UPDATE users SET github_login = ?, github_user_id = ? WHERE id = ?")
        .bind(account.login, account.id, c.get("user").id)
        .run();
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
    return redirectToGitHub(c, githubApp.clientId, GITHUB_LOGIN_STATE_COOKIE, "/auth/github/login/callback");
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
