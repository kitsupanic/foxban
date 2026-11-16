import { createInstallationToken, getAppOwner, listAppInstallations, listInstallationRepositories } from "./github";
import { loadInstanceGitHubApp } from "./github-app";

/**
 * The instance's connected repos (ADR 0064): repos the instance GitHub App is
 * installed on. D1 holds only which repos these are, never any card data.
 * Arrays go in as one JSON parameter and are unpacked with `json_each`, because
 * D1 caps bound parameters per statement at 100 and an install can hold hundreds.
 */
export type ConnectedRepo = { id: number; fullName: string; private: boolean };

export async function listConnectedRepos(env: Env): Promise<ConnectedRepo[]> {
  const { results } = await env.DB.prepare(
    "SELECT repo_id AS id, full_name AS fullName, is_private AS private FROM github_repos ORDER BY full_name COLLATE NOCASE",
  ).all<{ id: number; fullName: string; private: number }>();
  return results.map((repo) => ({ ...repo, private: repo.private === 1 }));
}

/** A connected repo with the installation that reads it: `by` is its id or its `owner/name` (any letter case). */
export function findConnectedRepo(env: Env, by: { id: number } | { fullName: string }) {
  return env.DB.prepare(
    `SELECT repo_id AS id, full_name AS fullName, installation_id AS installationId FROM github_repos
      WHERE ${"id" in by ? "repo_id = ?" : "full_name = ? COLLATE NOCASE"}`,
  )
    .bind("id" in by ? by.id : by.fullName)
    .first<{ id: number; fullName: string; installationId: number }>();
}

export async function isConnectedRepo(env: Env, repoId: number): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM github_repos WHERE repo_id = ?").bind(repoId).first()) !== null;
}

/** Drops every repo of an installation (it was uninstalled or suspended). */
export async function disconnectInstallation(env: Env, installationId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM github_repos WHERE installation_id = ?").bind(installationId).run();
}

/** Drops the named repos, but only ones this installation connected. */
export async function disconnectRepos(env: Env, installationId: number, repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) return;
  await env.DB.prepare("DELETE FROM github_repos WHERE installation_id = ?1 AND repo_id IN (SELECT value FROM json_each(?2))")
    .bind(installationId, JSON.stringify(repoIds))
    .run();
}

/** Adds the repos, or refreshes the ones already connected (a repo can move between installations). */
export async function connectRepos(env: Env, installationId: number, repos: ConnectedRepo[]): Promise<void> {
  if (repos.length === 0) return;
  await env.DB.prepare(
    // `WHERE true` keeps SQLite from reading ON CONFLICT as part of the SELECT's join.
    `INSERT INTO github_repos (repo_id, installation_id, full_name, is_private, connected_at)
     SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.fullName'), json_extract(value, '$.private'), ?2
     FROM json_each(?3) WHERE true
     ON CONFLICT(repo_id) DO UPDATE SET installation_id = excluded.installation_id, full_name = excluded.full_name, is_private = excluded.is_private`,
  )
    .bind(installationId, Date.now(), JSON.stringify(repos))
    .run();
}

/**
 * Queues repos for backfill (ADR 0064): the backfill drain loads their existing PRs and
 * branches onto cards. A repo already queued keeps its place and its hold-off. Lives here,
 * next to `connectRepos`, which every caller pairs it with.
 */
export async function enqueueBackfill(env: Env, repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) return;
  await env.DB.prepare("INSERT INTO github_backfill_queue (repo_id, queued_at, run_after) SELECT value, ?1, 0 FROM json_each(?2) WHERE true ON CONFLICT(repo_id) DO NOTHING")
    .bind(Date.now(), JSON.stringify(repoIds))
    .run();
}

/**
 * Re-reads the connected repos from GitHub and makes the table match: what GitHub
 * lists is added, what it no longer lists is dropped. This heals missed webhooks,
 * since GitHub does not retry them, so a repo that is new here is queued for backfill
 * as its missed `installation` event would have done (the minute cron drains it).
 * Only the App owner's active installations count; the others are returned as `ignoredAccounts`
 * so the Admin page can say why their repos are missing.
 * Returns null (changing nothing) when GitHub cannot be asked, so a caller shows the last known list.
 */
export async function refreshConnectedRepos(env: Env): Promise<{ owner: string; ownerIsOrganization: boolean; ignoredAccounts: string[] } | null> {
  try {
    const app = await loadInstanceGitHubApp(env);
    const appOwner = app && (await getAppOwner(env.GITHUB_API_BASE, app.appId, app.privateKey));
    // Without a known owner, an empty answer would wrongly drop everything.
    if (!app || !appOwner) return null;
    const owner = appOwner.login;
    const active = (await listAppInstallations(env.GITHUB_API_BASE, app.appId, app.privateKey)).filter((installation) => !installation.suspended);
    const isOwner = (installation: { account: string }) => installation.account.toLowerCase() === owner.toLowerCase();
    const installations = active.filter(isOwner);
    const ignoredAccounts = active.filter((installation) => !isOwner(installation)).map((installation) => installation.account);
    const known = new Set((await listConnectedRepos(env)).map((repo) => repo.id));
    const kept: number[] = [];
    for (const { id } of installations) {
      const token = await createInstallationToken(env.GITHUB_API_BASE, app.appId, app.privateKey, id);
      const repos = await listInstallationRepositories(env.GITHUB_API_BASE, token);
      await connectRepos(env, id, repos);
      await enqueueBackfill(env, repos.filter((repo) => !known.has(repo.id)).map((repo) => repo.id));
      kept.push(...repos.map((repo) => repo.id));
    }
    await env.DB.prepare("DELETE FROM github_repos WHERE repo_id NOT IN (SELECT value FROM json_each(?))").bind(JSON.stringify(kept)).run();
    return { owner, ownerIsOrganization: appOwner.isOrganization, ignoredAccounts };
  } catch (error) {
    console.warn("[github-repos] re-read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
