import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, GitBranch, Link2Off } from "lucide-react";
import type { CardDevelopment as CardDevelopmentInfo, DevelopmentBranch, DevelopmentPullRequest } from "@foxban/shared";
import { api } from "../lib/api";
import {
  DEVELOPMENT_STATE_META,
  boardDevelopmentQueryKey,
  cardDevelopmentQueryKey,
  connectedReposQueryOptions,
  refusalMessage,
  type PullRequestLinkController,
} from "../lib/card-development";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * A card's Development section (ADR 0064): the pull requests and branches webhooks
 * linked to it by task key, and the three things a member can do from here: create a
 * branch or pull request in a connected repository they pick, link a pull request that
 * names no key (by number or URL), and unlink a pull request or branch that does not belong.
 */
export function CardDevelopment({
  boardId,
  cardId,
  pullRequests,
  branches,
  link,
  onEdit,
}: {
  boardId: string;
  cardId: string;
  pullRequests: readonly DevelopmentPullRequest[];
  branches: readonly DevelopmentBranch[];
  link: PullRequestLinkController;
  /** Called on every keystroke so the card modal can drop a stale discard strip. */
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const repos = useQuery(connectedReposQueryOptions(boardId)).data ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string; href?: string } | null>(null);

  // The card's own repository is the likely choice: a card with a branch or PR there works in it.
  const known = [...branches, ...pullRequests].map((item) => item.repositoryId);
  const repo = repos.find((candidate) => candidate.id === picked) ?? repos.find((candidate) => known.includes(candidate.id)) ?? repos[0];
  const hasBranchHere = repo !== undefined && branches.some((branch) => branch.repositoryId === repo.id);

  const base = api.boards[":id"].cards[":cardId"].development;
  const param = { id: boardId, cardId };

  // Both unlinks answer with the card's development info afterwards, which replaces what the card shows.
  const unlinked = {
    onSuccess: (development: CardDevelopmentInfo) => {
      queryClient.setQueryData(cardDevelopmentQueryKey(boardId, cardId), development);
      void queryClient.invalidateQueries({ queryKey: boardDevelopmentQueryKey(boardId) });
    },
    onError: (err: Error) => setNotice({ kind: "error", text: err.message }),
  };

  const unlink = useMutation({
    mutationFn: async (pr: DevelopmentPullRequest) => {
      setNotice(null);
      const response = await base["pull-requests"][":repositoryId"][":number"].$delete({
        param: { ...param, repositoryId: String(pr.repositoryId), number: String(pr.number) },
      });
      if (!response.ok) throw new Error(await refusalMessage(response, "Could not unlink the pull request."));
      return (await response.json()) as CardDevelopmentInfo;
    },
    ...unlinked,
  });

  const unlinkBranch = useMutation({
    mutationFn: async (branch: DevelopmentBranch) => {
      setNotice(null);
      const response = await base.branches[":repositoryId"][":name"].$delete({
        // The client does not encode path params, and a branch name may hold slashes.
        param: { ...param, repositoryId: String(branch.repositoryId), name: encodeURIComponent(branch.name) },
      });
      if (!response.ok) throw new Error(await refusalMessage(response, "Could not unlink the branch."));
      return (await response.json()) as CardDevelopmentInfo;
    },
    ...unlinked,
  });

  const createBranch = useMutation({
    mutationFn: async (repositoryId: number) => {
      setNotice(null);
      const response = await base["create-branch"].$post({ param, json: { repositoryId } });
      if (!response.ok) throw new Error(await refusalMessage(response, "Could not create the branch."));
      return (await response.json()) as { name: string; url: string };
    },
    // The branch reaches the card through GitHub's own `create` event, like any other.
    onSuccess: (branch) => setNotice({ kind: "info", text: `Created branch ${branch.name}. It shows here once GitHub reports it.`, href: branch.url }),
    onError: (err) => setNotice({ kind: "error", text: err.message }),
  });

  const createPullRequest = useMutation({
    mutationFn: async (repositoryId: number) => {
      setNotice(null);
      const response = await base["create-pull-request"].$post({ param, json: { repositoryId } });
      if (!response.ok) throw new Error(await refusalMessage(response, "Could not create the pull request."));
      return (await response.json()) as { number: number; url: string };
    },
    onSuccess: (pr) => setNotice({ kind: "info", text: `Opened pull request #${pr.number}. It shows here once GitHub reports it.`, href: pr.url }),
    onError: (err) => setNotice({ kind: "error", text: err.message }),
  });

  return (
    <div className="flex flex-col gap-2 text-sm">
      {pullRequests.length > 0 && (
        <ul aria-label="Pull requests" className="flex flex-col gap-2">
          {pullRequests.map((pr) => {
            const { icon: Icon, color, label } = DEVELOPMENT_STATE_META[pr.state];
            return (
              <li key={`${pr.repositoryId}#${pr.number}`} className="flex items-start gap-1">
                <a href={pr.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-start gap-1.5 hover:underline" title={pr.title}>
                  <Icon className="mt-0.5 size-3.5 shrink-0" style={{ color }} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block break-words font-medium text-foreground">{pr.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {pr.repository}#{pr.number} · {label}
                    </span>
                  </span>
                  <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                </a>
                <button
                  type="button"
                  aria-label={`Unlink pull request #${pr.number}`}
                  title="Unlink from this card"
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate(pr)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                >
                  <Link2Off className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {branches.length > 0 && (
        <ul aria-label="Branches" className="flex flex-col gap-2">
          {branches.map((branch) => (
            <li key={`${branch.repositoryId}/${branch.name}`} className="flex items-start gap-1">
              <a href={branch.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-start gap-1.5 hover:underline" title={branch.name}>
                <GitBranch className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block break-all font-medium text-foreground">{branch.name}</span>
                  <span className="block break-words text-xs text-muted-foreground">
                    {branch.repository} · {branch.sha.slice(0, 7)} {branch.message}
                  </span>
                </span>
                <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              </a>
              <button
                type="button"
                aria-label={`Unlink branch ${branch.name}`}
                title="Unlink from this card"
                disabled={unlinkBranch.isPending}
                onClick={() => unlinkBranch.mutate(branch)}
                className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                <Link2Off className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {pullRequests.length === 0 && branches.length === 0 && (
        <p className="text-xs text-muted-foreground">Branches and pull requests that name this card&rsquo;s task key show here.</p>
      )}

      {repos.length === 0 ? (
        <p className="text-xs text-muted-foreground">No repository is connected. An Admin connects repositories from the GitHub page.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-foreground" htmlFor={`development-repo-${cardId}`}>
            Repository
            <select
              id={`development-repo-${cardId}`}
              value={repo?.id ?? ""}
              onChange={(event) => setPicked(Number(event.target.value))}
              className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-base font-normal sm:text-sm pointer-coarse:min-h-11"
            >
              {repos.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.fullName}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={repo === undefined || createBranch.isPending}
              onClick={() => repo && createBranch.mutate(repo.id)}
              className="pointer-coarse:min-h-11 pointer-coarse:px-3"
            >
              {createBranch.isPending ? "Creating branch…" : "Create branch"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={repo === undefined || !hasBranchHere || createPullRequest.isPending}
              onClick={() => repo && createPullRequest.mutate(repo.id)}
              className="pointer-coarse:min-h-11 pointer-coarse:px-3"
            >
              {createPullRequest.isPending ? "Creating pull request…" : "Create pull request"}
            </Button>
          </div>
          {!hasBranchHere && <p className="text-xs text-muted-foreground">Create a branch in this repository before creating a pull request.</p>}
        </div>
      )}

      {notice !== null && (
        <p role={notice.kind === "error" ? "alert" : "status"} className={notice.kind === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {notice.text}
          {notice.href !== undefined && (
            <>
              {" "}
              <a href={notice.href} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                Open on GitHub
              </a>
            </>
          )}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <div>
          <Button
            ref={link.triggerRef}
            type="button"
            variant="outline"
            size="xs"
            data-testid="pr-link-trigger"
            onClick={link.start}
            className="pointer-coarse:min-h-11 pointer-coarse:px-3"
          >
            Link pull request
          </Button>
        </div>

        {link.announcement !== null && (
          <p role="status" className="text-xs text-muted-foreground">
            {link.announcement}
          </p>
        )}

        {link.open && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground" htmlFor={`pr-link-${cardId}`}>
              Pull request URL or number
            </label>
            <Input
              id={`pr-link-${cardId}`}
              value={link.draft}
              readOnly={link.phase === "pending"}
              aria-invalid={link.error !== null}
              aria-describedby={`pr-link-help-${cardId}`}
              placeholder="https://github.com/owner/repo/pull/123 or #123"
              onChange={(event) => {
                onEdit();
                link.change(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                link.submit(repo?.id ?? null);
              }}
              className="text-base sm:text-sm pointer-coarse:min-h-11"
            />
            <p id={`pr-link-help-${cardId}`} className="text-xs text-muted-foreground">
              A number means a pull request in {repo?.fullName ?? "the repository above"}. A URL can name any connected repository.
            </p>
            {link.error !== null && (
              <p role="alert" className="text-xs text-destructive">
                {link.error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                disabled={link.draft.trim() === "" || link.phase === "pending"}
                onClick={() => link.submit(repo?.id ?? null)}
                className="pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                {link.phase === "pending" ? "Linking pull request…" : "Link pull request"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={link.phase === "pending"}
                onClick={link.cancel}
                className="pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
