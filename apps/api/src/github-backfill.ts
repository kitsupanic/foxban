import { z } from "zod";
import { GitHubApiError, createInstallationToken, getBranchHead, listBranchNamesPage, listPullRequestsPage } from "./github";
import { loadInstanceGitHubApp } from "./github-app";
import { writeBranch } from "./github-branches";
import { boardsByKey, handlePullRequestEvent, namedBoards } from "./github-development";
import { findConnectedRepo } from "./github-repos";
import { extractTaskKeys } from "./task-keys";

/**
 * Backfill on connect (ADR 0064): when repos are connected, their existing open PRs,
 * all their branches and the PRs closed in the last 30 days are loaded onto cards,
 * through the same matcher and board writes as webhooks, so running it again changes
 * nothing.
 *
 * How it runs. The repo is the unit of work and a row in `github_backfill_queue` is the
 * work: the webhook that connects repos enqueues them (`enqueueBackfill`, in github-repos.ts)
 * and drains the queue in `ctx.waitUntil` (never inside the 10 s GitHub allows the delivery),
 * and the every-minute cron drains whatever is left, including repos the Admin page's re-read
 * enqueued after a missed webhook. A drain claims one due repo at a time with
 * a lease (`run_after`), and stops claiming when it has used up its wall-clock or
 * subrequest budget, so one Worker invocation stays far under the 1000-subrequest limit
 * however many repos wait. A GitHub rate limit holds the repo, and stops the drain, until
 * `Retry-After` has passed; any other failure, and a repo too big for one drain's subrequests,
 * retries with growing delay and then gives up. Re-running a repo after a partial run is safe because every write is idempotent.
 */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PER_PAGE = 100;
const LEASE_MS = 2 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** A drain stops claiming repos after this long (waitUntil work is cut off around 30 s). */
const TIME_BUDGET_MS = 20_000;
/** ...or after this many subrequests (GitHub calls, D1 queries, board writes), counted roughly; the limit is 1000. */
const OPS_BUDGET = 300;
/**
 * No single repo may spend more than this (the real limit is 1000). A repo that would cross it stops and is held with the
 * same growing delay as any failure, so the rest of the queue gets its turns; the claim counted an attempt, so one that never fits is dropped after MAX_ATTEMPTS.
 */
const OPS_CEILING = 900;
/** Worst case for one PR: two D1 reads and a board call for each of the up to 20 boards its keys name. */
const MAX_PR_COST = 2 + 20;
/** Hard caps per repo (pages per list, and keyed PRs or branches loaded), so one repo's worst case stays inside the budget's headroom. shortcut: past these the oldest items are skipped, upgrade to a resumable cursor if real repos hit them. */
const MAX_PAGES = 10;
const MAX_KEYED = 100;

/** A drain's running subrequest count and its ceiling (a parameter of `drainBackfill` so a test can make it small). */
type Budget = { ops: number; ceiling: number };
/** Thrown inside a repo's run when its next step could cross the ceiling. */
class BudgetSpent extends Error {}
function reserve(budget: Budget, worst: number): void {
  if (budget.ops + worst > budget.ceiling) throw new BudgetSpent();
}

type Claimed = { repoId: number; attempts: number; fullName: string; installationId: number } | "gone" | null;

/**
 * Takes the oldest due repo and leases it. The claim itself counts as an attempt (`attempts` is the new count).
 * A run that is killed (time limit, hung fetch) never reaches `afterFailure`, so the claim is also where a repo
 * gives up: a due row that already used `MAX_ATTEMPTS` claims is dropped, never claimed again. (A row whose lease
 * is still running is not due, so its last attempt is not cut short.) "gone" means it was disconnected since it was queued (and is dropped). */
async function claim(env: Env, now: number): Promise<Claimed> {
  const spent = await env.DB.prepare("DELETE FROM github_backfill_queue WHERE run_after <= ?1 AND attempts >= ?2 RETURNING repo_id AS repoId")
    .bind(now, MAX_ATTEMPTS)
    .all<{ repoId: number }>();
  for (const { repoId } of spent.results) console.warn(`[github-backfill] repo ${repoId} dropped after ${MAX_ATTEMPTS} attempts`);
  const row = await env.DB.prepare(
    `UPDATE github_backfill_queue SET run_after = ?2, attempts = attempts + 1
      WHERE repo_id = (SELECT repo_id FROM github_backfill_queue WHERE run_after <= ?1 ORDER BY queued_at, repo_id LIMIT 1)
      RETURNING repo_id AS repoId, attempts`,
  )
    .bind(now, now + LEASE_MS)
    .first<{ repoId: number; attempts: number }>();
  if (!row) return null;
  const repo = await findConnectedRepo(env, { id: row.repoId });
  if (!repo) {
    await finish(env, row.repoId);
    return "gone";
  }
  return { ...row, fullName: repo.fullName, installationId: repo.installationId };
}

const finish = (env: Env, repoId: number) => env.DB.prepare("DELETE FROM github_backfill_queue WHERE repo_id = ?").bind(repoId).run();
/** Makes the repo due again at `at`; `refund` takes back the attempt its claim counted (a rate limit is not a failure). */
const holdUntil = (env: Env, repoId: number, at: number, refund = false) =>
  env.DB.prepare("UPDATE github_backfill_queue SET run_after = ?2, attempts = attempts - ?3 WHERE repo_id = ?1").bind(repoId, at, refund ? 1 : 0).run();

/** The few fields of a list item that decide whether it is in the window or names a key; the rest is the event matcher's. */
const ListedPullRequestSchema = z.object({
  title: z.string(),
  body: z.string().nullish(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
  head: z.object({ ref: z.string() }),
});

async function backfillPullRequests(env: Env, token: string, repo: { id: number; fullName: string }, cutoff: number, budget: Budget): Promise<void> {
  let keyed = 0;
  for (const state of ["open", "closed"] as const) {
    let pastWindow = false;
    for (let page = 1; page <= MAX_PAGES && !pastWindow; page++) {
      reserve(budget, 1);
      const items = await listPullRequestsPage(env.GITHUB_API_BASE, token, repo.fullName, state, page, PER_PAGE);
      budget.ops += 1;
      for (const item of items) {
        const listed = ListedPullRequestSchema.safeParse(item);
        if (!listed.success) continue;
        const pr = listed.data;
        if (state === "closed") {
          // Newest update first, and a PR closes no later than it was last updated: nothing from here on is in the window.
          if (Date.parse(pr.updated_at) < cutoff) {
            pastWindow = true;
            break;
          }
          if (!(Date.parse(pr.closed_at ?? "") >= cutoff)) continue;
        }
        if (extractTaskKeys([pr.head.ref, pr.title, pr.body]).length === 0) continue;
        if (++keyed > MAX_KEYED) return;
        reserve(budget, MAX_PR_COST);
        try {
          await handlePullRequestEvent(env, { repository: { id: repo.id, full_name: repo.fullName }, pull_request: item }, budget);
        } catch (error) {
          // A list item the matcher cannot read is skipped, not fatal.
          if (!(error instanceof z.ZodError)) throw error;
        }
      }
      if (items.length < PER_PAGE) break;
    }
  }
}

async function backfillBranches(env: Env, token: string, repo: { id: number; fullName: string }, budget: Budget): Promise<void> {
  const names: string[] = [];
  for (let page = 1; page <= MAX_PAGES * 3; page++) {
    reserve(budget, 1);
    const listed = await listBranchNamesPage(env.GITHUB_API_BASE, token, repo.fullName, page, PER_PAGE);
    budget.ops += 1;
    names.push(...listed);
    if (listed.length < PER_PAGE) break;
  }
  // One D1 read for every board a branch name could mean, not one per branch.
  const mentions = names.map((name) => ({ name, keys: extractTaskKeys([name]) })).filter(({ keys }) => keys.length > 0);
  const boards = await boardsByKey(env, mentions.flatMap(({ keys }) => keys.map((key) => key.boardKey)));
  budget.ops += 1;
  let read = 0;
  for (const { name, keys } of mentions) {
    const named = namedBoards(boards.filter((board) => keys.some((key) => key.boardKey === board.boardKey)), keys);
    if (named.size === 0) continue;
    if (++read > MAX_KEYED) return;
    // One read of the branch, then one call to each board.
    reserve(budget, 1 + named.size);
    budget.ops += 1 + named.size;
    const observedAt = Date.now();
    await writeBranch(env, repo, name, await getBranchHead(env.GITHUB_API_BASE, token, repo.fullName, name), observedAt, named);
  }
}

/** Why a repo's run did not finish, and so when it may run again. `attempts` already counts this run (see `claim`). */
async function afterFailure(env: Env, repoId: number, attempts: number, opsAtClaim: number, error: unknown): Promise<"stop" | "next"> {
  if (error instanceof BudgetSpent && opsAtClaim > 0) {
    // Earlier repos in this drain spent the budget, so this repo may fit a fresh drain: not its failure, so refund the attempt.
    await holdUntil(env, repoId, Date.now(), true);
    return "stop";
  }
  if (error instanceof BudgetSpent) {
    // Out of subrequests: this drain is over, but the repo is held like any failure, so a repo too big to fit cannot starve the others and is dropped at MAX_ATTEMPTS.
    console.warn(`[github-backfill] repo ${repoId} needs more subrequests than one drain has (attempt ${attempts})`);
    if (attempts >= MAX_ATTEMPTS) await finish(env, repoId);
    else await holdUntil(env, repoId, Date.now() + RETRY_MS * attempts);
    return "stop";
  }
  if (error instanceof GitHubApiError && error.isRateLimited) {
    // The limit is GitHub's to name: wait out `Retry-After`, and ask for nothing else meanwhile.
    await holdUntil(env, repoId, Date.now() + (error.retryAfterMs ?? 60_000), true);
    return "stop";
  }
  console.warn(`[github-backfill] repo ${repoId} failed (attempt ${attempts}):`, error instanceof Error ? error.message : error);
  if (attempts >= MAX_ATTEMPTS) await finish(env, repoId);
  else await holdUntil(env, repoId, Date.now() + RETRY_MS * attempts);
  return "next";
}

/** Runs due repos from the queue until it is empty or this invocation's budget is spent. Never throws. */
export async function drainBackfill(env: Env, ceiling = OPS_CEILING): Promise<void> {
  try {
    const app = await loadInstanceGitHubApp(env);
    if (!app) return;
    const started = Date.now();
    const budget = { ops: 0, ceiling };
    const tokens = new Map<number, string>();
    while (Date.now() - started < TIME_BUDGET_MS && budget.ops < OPS_BUDGET) {
      const claimed = await claim(env, Date.now());
      if (claimed === null) return;
      if (claimed === "gone") continue;
      const opsAtClaim = budget.ops;
      try {
        let token = tokens.get(claimed.installationId);
        if (!token) {
          token = await createInstallationToken(env.GITHUB_API_BASE, app.appId, app.privateKey, claimed.installationId);
          budget.ops += 1;
          tokens.set(claimed.installationId, token);
        }
        const repo = { id: claimed.repoId, fullName: claimed.fullName };
        await backfillPullRequests(env, token, repo, Date.now() - WINDOW_MS, budget);
        await backfillBranches(env, token, repo, budget);
        await finish(env, claimed.repoId);
      } catch (error) {
        if ((await afterFailure(env, claimed.repoId, claimed.attempts, opsAtClaim, error)) === "stop") return;
      }
    }
  } catch (error) {
    console.warn("[github-backfill] drain failed:", error instanceof Error ? error.message : error);
  }
}
