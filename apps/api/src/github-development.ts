import { DEVELOPMENT_TEXT_MAX, type CardDevelopment, type DevelopmentPullRequest } from "@foxban/shared";
import { z } from "zod";
import { boardClient } from "./board-client";
import type { PullRequestWrite } from "./development-info";
import { GitHubApiError, createInstallationToken, getPullRequestPayload, pullRequestState } from "./github";
import { loadInstanceGitHubApp } from "./github-app";
import { routedBoardIds } from "./github-pr-routes";
import { findConnectedRepo } from "./github-repos";
import { extractTaskKeys } from "./task-keys";

/**
 * A `pull_request` event, down to the fields development info reads. `updated_at`
 * is on the pull request object itself (GitHub's PR schema), and every action
 * (opened, edited, closed, labeled, ...) carries the whole object, so one rule
 * covers them all. `merged` is only on the full object; `merged_at` backs it up.
 */
const PullRequestEventSchema = z.object({
  repository: z.object({ id: z.number().int(), full_name: z.string().min(1) }),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullish(),
    state: z.enum(["open", "closed"]),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    merged_at: z.string().nullish(),
    html_url: z.url({ protocol: /^https?$/ }),
    updated_at: z.string().transform((text) => Date.parse(text)).pipe(z.number().int().positive()),
    head: z.object({ ref: z.string(), repo: z.object({ id: z.number().int() }).nullish() }),
  }),
});

/** A pull request in the shape development info stores, from the fields both GitHub's event and its REST read carry. */
function toDevelopmentPullRequest(
  repo: { id: number; fullName: string },
  pr: Pick<z.infer<typeof PullRequestEventSchema>["pull_request"], "number" | "title" | "state" | "draft" | "merged" | "merged_at" | "html_url" | "updated_at">,
): DevelopmentPullRequest {
  return {
    repositoryId: repo.id,
    repository: repo.fullName,
    number: pr.number,
    title: pr.title.slice(0, DEVELOPMENT_TEXT_MAX),
    state: pullRequestState(pr),
    url: pr.html_url,
    updatedAt: pr.updated_at,
  };
}

/** The boards that carry any of these board keys, as `{id, boardKey}` rows. */
export async function boardsByKey(env: Env, boardKeys: string[]): Promise<Array<{ id: string; boardKey: string }>> {
  if (boardKeys.length === 0) return [];
  const { results } = await env.DB.prepare("SELECT id, board_key AS boardKey FROM boards WHERE board_key IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(boardKeys)]))
    .all<{ id: string; boardKey: string }>();
  return results;
}

/** Of these boards (from `boardsByKey`), the ones a task key names, with the task numbers named for each. */
export function namedBoards(boards: Array<{ id: string; boardKey: string }>, keys: ReturnType<typeof extractTaskKeys>): Map<string, number[]> {
  const named = new Map<string, number[]>();
  for (const { id, boardKey } of boards) {
    named.set(id, keys.filter((key) => key.boardKey === boardKey).map((key) => key.taskNumber));
  }
  return named;
}

/** The boards whose key one of the task keys names, with the task numbers named for each. */
export async function boardsNamedByKeys(env: Env, keys: ReturnType<typeof extractTaskKeys>): Promise<Map<string, number[]>> {
  return namedBoards(await boardsByKey(env, keys.map((key) => key.boardKey)), keys);
}

/**
 * Routes a pull request event from a connected repo (the caller has checked that) to
 * the boards that hold it. A board is told when the PR's branch, title or body names
 * one of its task keys (matched by board key, so unknown keys fall away) and the PR's
 * head is in the connected repo itself (a fork's, or one whose head repo is gone, is
 * stranger-written text and links nothing by key, ADR 0088), or when it
 * already links the PR through the routing table. Each board links and updates only
 * its own cards. Returns whether any card changed. A caller that budgets subrequests
 * passes `budget`, which gets what this cost: two D1 reads and one call per board.
 */
export async function handlePullRequestEvent(env: Env, payload: unknown, budget?: { ops: number }): Promise<boolean> {
  const { repository, pull_request: pr } = PullRequestEventSchema.parse(payload);
  const pullRequest = toDevelopmentPullRequest({ id: repository.id, fullName: repository.full_name }, pr);

  const boards = pr.head.repo?.id === repository.id ? await boardsNamedByKeys(env, extractTaskKeys([pr.head.ref, pr.title, pr.body])) : new Map<string, number[]>();
  for (const boardId of await routedBoardIds(env, repository.id, pr.number)) {
    if (!boards.has(boardId)) boards.set(boardId, []);
  }
  if (budget) budget.ops += 2 + boards.size;

  const results = await Promise.all(
    [...boards].map(([boardId, taskNumbers]) => boardClient(env, boardId).writePullRequest({ pullRequest, taskNumbers } satisfies PullRequestWrite)),
  );
  return results.some(Boolean);
}

/** A pull request as GitHub's REST API returns it: the fields a manual link stores, plus the repo its base proves. */
const PullRequestReadSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullish(),
  html_url: z.url({ protocol: /^https?$/ }),
  updated_at: z.string().transform((text) => Date.parse(text)).pipe(z.number().int().positive()),
  base: z.object({ repo: z.object({ id: z.number().int().positive() }) }),
});

/**
 * Reads a pull request of a connected repo from GitHub, in the shape development info
 * stores. Null when the instance has no App. Throws `GitHubApiError` when GitHub
 * refuses or answers with something that is not a pull request of that number.
 */
export async function readPullRequest(
  env: Env,
  repo: { id: number; fullName: string; installationId: number },
  number: number,
): Promise<{ pullRequest: DevelopmentPullRequest; baseRepositoryId: number } | null> {
  const app = await loadInstanceGitHubApp(env);
  if (!app) return null;
  const token = await createInstallationToken(env.GITHUB_API_BASE, app.appId, app.privateKey, repo.installationId, [repo.id]);
  const [owner = "", name = ""] = repo.fullName.split("/");
  const parsed = PullRequestReadSchema.safeParse(await getPullRequestPayload(env.GITHUB_API_BASE, token, owner, name, number));
  if (!parsed.success || parsed.data.number !== number) throw new GitHubApiError(502, "malformed pull request response from GitHub");
  return { baseRepositoryId: parsed.data.base.repo.id, pullRequest: toDevelopmentPullRequest(repo, parsed.data) };
}

/**
 * Pull requests an old per-board integration linked by hand (ADR 0041 section 6) are
 * read from GitHub and written back as ordinary links, once their repo is connected:
 * the write goes through the same path as a webhook, naming the card by its task number.
 * Best effort: one that cannot be read now is tried again on the next read.
 */
async function adoptLegacyLinks(env: Env, boardId: string, legacy: Array<{ repositoryId: number; number: number; taskNumber: number }>): Promise<boolean> {
  const results = await Promise.all(
    legacy.map(async ({ repositoryId, number, taskNumber }) => {
      try {
        const repo = await findConnectedRepo(env, { id: repositoryId });
        const read = repo && (await readPullRequest(env, repo, number));
        if (!read || read.baseRepositoryId !== repo.id) return false;
        return await boardClient(env, boardId).writePullRequest({ pullRequest: read.pullRequest, taskNumbers: [taskNumber] } satisfies PullRequestWrite);
      } catch (error) {
        console.warn("[github-development] could not adopt an old pull request link:", error instanceof Error ? error.message : error);
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

/** A card's development info, or null when the card is missing or archived. */
export async function readCardDevelopment(env: Env, boardId: string, cardId: string): Promise<CardDevelopment | null> {
  const board = boardClient(env, boardId);
  let read = await board.cardDevelopment(cardId);
  if (read && read.legacy.length > 0 && (await adoptLegacyLinks(env, boardId, read.legacy))) read = await board.cardDevelopment(cardId);
  return read && { pullRequests: read.pullRequests, branches: read.branches };
}
