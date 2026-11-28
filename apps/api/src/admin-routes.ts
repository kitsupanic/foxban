import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  appOrigin,
  createInviteToken,
  GITHUB_LOGIN_RE,
  INVITE_TTL_MS,
  requireAdmin,
  requireAuth,
  sha256Hex,
  type AppEnv,
} from "./auth";
import {
  GITHUB_ADMIN_PAGE_PATH,
  buildGitHubAppManifest,
  canCreateGitHubApp,
  createInstanceGitHubApp,
  getInstanceGitHubAppSummary,
  removeInstanceGitHubApp,
} from "./github-app";
import { listConnectedRepos, refreshConnectedRepos } from "./github-repos";

const GITHUB_APP_MANIFEST_STATE_COOKIE = "github_app_manifest_state";

export const adminRouter = new Hono<AppEnv>()
  // Invites are global signup grants, not board invitations (those live under
  // /boards/:id/members), and only an admin ever sees or mints one. The table holds each token's
  // hash (ADR 0085), so the raw token and its link exist only in the response that mints it; a row
  // is named by its hash (`id`).
  .get("/invites", requireAuth, requireAdmin, async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT token_hash AS id, created_at AS createdAt, created_at + ${INVITE_TTL_MS} AS expiresAt, used_by AS usedBy, used_at AS usedAt
         FROM invites
        WHERE used_at IS NOT NULL OR created_at > ?
        ORDER BY created_at DESC, rowid DESC`,
    ).bind(Date.now() - INVITE_TTL_MS).all<{ id: string; createdAt: number; expiresAt: number; usedBy: string | null; usedAt: number | null }>();
    return c.json({ invites: results });
  })
  .post("/invites", requireAuth, requireAdmin, async (c) => {
    const token = createInviteToken();
    const id = await sha256Hex(token);
    const createdAt = Date.now();
    await c.env.DB.prepare("INSERT INTO invites (token_hash, created_by, created_at) VALUES (?, ?, ?)")
      .bind(id, c.get("user").id, createdAt)
      .run();
    return c.json({ id, token, createdAt, expiresAt: createdAt + INVITE_TTL_MS }, 201);
  })
  // The instance GitHub App (ADR 0064): created once by an Admin through GitHub's
  // app-manifest flow. Nothing here ever returns the App's secrets.
  .get("/github-app", requireAuth, requireAdmin, async (c) => {
    const app = await getInstanceGitHubAppSummary(c.env);
    // Opening the page re-reads the install's repos, so a missed webhook heals here.
    const refresh = app ? await refreshConnectedRepos(c.env) : null;
    return c.json({
      app: app && {
        ...app,
        installUrl: `${c.env.GITHUB_OAUTH_BASE}/apps/${app.slug}/installations/new`,
        repos: await listConnectedRepos(c.env),
        reposRefreshed: refresh !== null,
        // Who owns the App and which installs foxban skips for not being theirs (null when GitHub could not be asked).
        owner: refresh?.owner ?? null,
        ignoredAccounts: refresh?.ignoredAccounts ?? [],
        // The App's Advanced settings, where its owner can transfer it to another account.
        settingsUrl: refresh
          ? `${c.env.GITHUB_OAUTH_BASE}${refresh.ownerIsOrganization ? `/organizations/${refresh.owner}` : ""}/settings/apps/${app.slug}/advanced`
          : null,
      },
      canCreate: await canCreateGitHubApp(c.env),
    });
  })
  // Forgets the App so a new one can be created; GitHub keeps it until its owner deletes it there.
  .delete("/github-app", requireAuth, requireAdmin, async (c) =>
    (await removeInstanceGitHubApp(c.env)) ? c.json({ ok: true }) : c.json({ error: "no GitHub App" }, 404),
  )
  // The browser posts the manifest to GitHub from a form, so the Admin page gets the
  // target URL (with the CSRF state) and the manifest, not a redirect.
  .post(
    "/github-app/manifest",
    requireAuth,
    requireAdmin,
    zValidator("json", z.object({ organization: z.string().regex(GITHUB_LOGIN_RE).optional() })),
    async (c) => {
      // No usable sealing key: the deploy script has not run since this feature shipped, or the key is not base64 of 32 bytes.
      if (!(await canCreateGitHubApp(c.env)))
        return c.json({ error: "GitHub App setup needs GITHUB_APP_ENCRYPTION_KEY (base64 of 32 bytes: openssl rand -base64 32); redeploy with pnpm run deploy" }, 503);
      if (await getInstanceGitHubAppSummary(c.env)) return c.json({ error: "this instance already has a GitHub App" }, 409);
      const state = crypto.randomUUID();
      setCookie(c, GITHUB_APP_MANIFEST_STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        secure: new URL(c.req.url).protocol === "https:",
        maxAge: 3600, // GitHub gives the whole manifest flow an hour
      });
      const { organization } = c.req.valid("json");
      const target = new URL(
        organization ? `/organizations/${organization}/settings/apps/new` : "/settings/apps/new",
        c.env.GITHUB_OAUTH_BASE,
      );
      target.searchParams.set("state", state);
      return c.json({ url: target.toString(), manifest: buildGitHubAppManifest(appOrigin(c.env, c.req.url)) });
    },
  )
  // GitHub sends the Admin's browser here after "Create GitHub App" (the manifest's
  // redirect_url). Both the Admin session and the state cookie must match.
  .get("/auth/github-app/manifest/callback", requireAuth, requireAdmin, async (c) => {
    const adminPage = `${appOrigin(c.env, c.req.url)}${GITHUB_ADMIN_PAGE_PATH}`;
    const fail = () => c.redirect(`${adminPage}?githubApp=error`);
    const state = c.req.query("state");
    const code = c.req.query("code");
    const expected = getCookie(c, GITHUB_APP_MANIFEST_STATE_COOKIE);
    deleteCookie(c, GITHUB_APP_MANIFEST_STATE_COOKIE, { path: "/" });
    if (!state || !code || !expected || state !== expected || !(await canCreateGitHubApp(c.env))) return fail();
    try {
      return (await createInstanceGitHubApp(c.env, code)) ? c.redirect(`${adminPage}?githubApp=created`) : fail();
    } catch {
      return fail();
    }
  })
  .delete("/invites/:id", requireAuth, requireAdmin, async (c) => {
    // A spent invite stays as the audit trail of who used it, so revoking one is
    // as much a 404 as an id that never existed.
    const { meta } = await c.env.DB.prepare(
      "DELETE FROM invites WHERE token_hash = ? AND used_at IS NULL",
    )
      .bind(c.req.param("id"))
      .run();
    if (meta.changes !== 1) return c.json({ error: "invite not found" }, 404);
    return c.json({ ok: true });
  });
