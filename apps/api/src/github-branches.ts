import { DEVELOPMENT_TEXT_MAX } from "@foxban/shared";
import { z } from "zod";
import { BRANCH_WRITE_PATH, type BranchWrite } from "./development-info";
import { createInstallationToken, getBranchHead, type GitHubBranchHead } from "./github";
import type { loadInstanceGitHubApp } from "./github-app";
import { routedBranchBoardIds } from "./github-branch-routes";
import { boardsNamedByKeys, writeToBoard } from "./github-development";
import { findConnectedRepo } from "./github-repos";
import { extractTaskKeys } from "./task-keys";

type InstanceApp = NonNullable<Awaited<ReturnType<typeof loadInstanceGitHubApp>>>;

/**
 * `push` names the ref (`refs/heads/x`); `create` and `delete` name the bare ref and
 * its kind. None of them carries a usable clock (`create` and `delete` have none, and
 * `push` has only committer-supplied commit times), so none is trusted for state.
 */
const BranchEventSchema = z.object({
  ref: z.string(),
  ref_type: z.string().optional(),
  repository: z.object({ id: z.number().int(), full_name: z.string().min(1) }),
});

function branchName(event: string, ref: string, refType: string | undefined): string | null {
  if (event === "push") return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  return refType === "branch" ? ref : null;
}

/**
 * Turns a `push`, `create` or `delete` event from a connected repo into development
 * info (ADR 0064). A board is told when the branch name holds one of its keys, or when
 * it already links the branch through the routing table, which is how a branch keeps
 * updating (and a delete still applies) after its board's key is edited or its card moves
 * to another board. Only then is the branch worth a GitHub call: it is re-read with an
 * installation token, so the card shows what GitHub says now (the new tip, or no branch
 * at all) whatever order the events arrive in. Returns whether any card changed.
 */
export async function handleBranchEvent(env: Env, app: InstanceApp, event: string, payload: unknown): Promise<boolean> {
  const { ref, ref_type, repository } = BranchEventSchema.parse(payload);
  const name = branchName(event, ref, ref_type);
  if (name === null) return false;
  const boards = await boardsNamedByKeys(env, extractTaskKeys([name]));
  for (const boardId of await routedBranchBoardIds(env, repository.id, name)) {
    if (!boards.has(boardId)) boards.set(boardId, []);
  }
  if (boards.size === 0) return false;
  // The caller has checked the repo is connected; the installation that reaches it is in the same row.
  const connected = await findConnectedRepo(env, { id: repository.id });
  if (!connected) return false;

  const observedAt = Date.now();
  const token = await createInstallationToken(env.GITHUB_API_BASE, app.appId, app.privateKey, connected.installationId);
  const head = await getBranchHead(env.GITHUB_API_BASE, token, repository.full_name, name);
  return writeBranch(env, { id: repository.id, fullName: repository.full_name }, name, head, observedAt, boards);
}

/**
 * Writes one branch's re-read (`head`, or null when it is gone) to each board that
 * names it. `observedAt` must be taken before the read, as it orders writes. Shared by
 * webhook events and the backfill, so both land the same way. True when any card changed.
 */
export async function writeBranch(
  env: Env,
  repository: { id: number; fullName: string },
  name: string,
  head: GitHubBranchHead | null,
  observedAt: number,
  boards: Map<string, number[]>,
): Promise<boolean> {
  const results = await Promise.all(
    [...boards].map(([boardId, taskNumbers]) => {
      const write: BranchWrite = {
        repositoryId: repository.id,
        repository: repository.fullName,
        name,
        head: head && { ...head, message: (head.message.split("\n", 1)[0] ?? "").slice(0, DEVELOPMENT_TEXT_MAX) },
        observedAt,
        taskNumbers,
      };
      return writeToBoard(env, boardId, BRANCH_WRITE_PATH, write);
    }),
  );
  return results.some(Boolean);
}
