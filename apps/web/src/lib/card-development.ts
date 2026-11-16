import { useCallback, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from "lucide-react";
import type { BoardDevelopment, CardDevelopment, DevelopmentPullRequest } from "@foxban/shared";
import { api } from "./api";
import { restoreFocusSoon } from "./focus";

/**
 * Development info (ADR 0064): the pull requests and branches webhooks linked to a
 * card. Nothing polls. An accepted write on the server tells the board's sockets
 * which card changed, and the socket answers by invalidating these queries, so a
 * change on GitHub shows up without a reload and without a timer.
 */
export function cardDevelopmentQueryKey(boardId: string, cardId: string) {
  return ["card-development", boardId, cardId] as const;
}

export function cardDevelopmentQueryOptions(boardId: string, cardId: string) {
  return {
    queryKey: cardDevelopmentQueryKey(boardId, cardId),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<CardDevelopment> => {
      const response = await api.boards[":id"].cards[":cardId"].development.$get({ param: { id: boardId, cardId } }, { init: { signal } });
      if (!response.ok) throw new Error("Could not load development info.");
      return (await response.json()) as CardDevelopment;
    },
  };
}

/** Every card's pull requests on a board, in one read: what the card fronts show. */
export function boardDevelopmentQueryKey(boardId: string) {
  return ["board-development", boardId] as const;
}

export function boardDevelopmentQueryOptions(boardId: string) {
  return {
    queryKey: boardDevelopmentQueryKey(boardId),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<BoardDevelopment> => {
      const response = await api.boards[":id"].development.$get({ param: { id: boardId } }, { init: { signal } });
      if (!response.ok) throw new Error("Could not load development info.");
      return (await response.json()) as BoardDevelopment;
    },
  };
}

/** The repos a card may create a branch or pull request in: the instance's, not the board's. */
export type ConnectedRepo = { id: number; fullName: string; private: boolean };

export function connectedReposQueryOptions(boardId: string) {
  return {
    queryKey: ["connected-repos", boardId] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ConnectedRepo[]> => {
      const response = await api.boards[":id"]["connected-repos"].$get({ param: { id: boardId } }, { init: { signal } });
      if (!response.ok) throw new Error("Could not load the connected repositories.");
      return (await response.json()).repos;
    },
    staleTime: 60_000,
  };
}

/** Answers a card-scope `github.invalidated` hint: everything development info marks stale, and the next read installs the truth. */
export function invalidateDevelopmentQueries(queryClient: QueryClient, boardId: string): void {
  void queryClient.invalidateQueries({ queryKey: ["card-development", boardId] });
  void queryClient.invalidateQueries({ queryKey: boardDevelopmentQueryKey(boardId) });
}

/** GitHub's own state colors, like the pull request badge on the card front. */
export const DEVELOPMENT_STATE_META: Record<DevelopmentPullRequest["state"], { icon: LucideIcon; color: string; label: string }> = {
  open: { icon: GitPullRequest, color: "#1A7F37", label: "Open" },
  draft: { icon: GitPullRequestDraft, color: "#6E7781", label: "Draft" },
  merged: { icon: GitMerge, color: "#8250DF", label: "Merged" },
  closed: { icon: GitPullRequestClosed, color: "#CF222E", label: "Closed" },
};

/** The state a card front names when its pull requests disagree: the one still in play wins. */
const BADGE_PRIORITY: readonly DevelopmentPullRequest["state"][] = ["open", "draft", "merged", "closed"];

/** What a card front shows for its pull requests: null means nothing at all. */
export interface CardPullRequestBadge {
  state: DevelopmentPullRequest["state"];
  /** How many pull requests the card has. */
  count: number;
  label: string;
}

export function cardPullRequestBadge(pullRequests: readonly DevelopmentPullRequest[]): CardPullRequestBadge | null {
  if (pullRequests.length === 0) return null;
  const [headline] = [...pullRequests].sort(
    (a, b) => BADGE_PRIORITY.indexOf(a.state) - BADGE_PRIORITY.indexOf(b.state) || b.updatedAt - a.updatedAt || a.number - b.number,
  );
  const others = pullRequests.length - 1;
  return {
    state: headline!.state,
    count: pullRequests.length,
    label: `Pull request #${headline!.number}: ${DEVELOPMENT_STATE_META[headline!.state].label}${others > 0 ? `, and ${others} more` : ""}`,
  };
}

/** The `{ error }` a refused request carries, or the fallback. */
export async function refusalMessage(response: { json: () => Promise<unknown> }, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  return body !== null && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : fallback;
}

/** Where a link request stands: the composer is read-only while one is in flight. */
export type PullRequestLinkPhase = "idle" | "pending";

export interface PullRequestLinkController {
  open: boolean;
  draft: string;
  error: string | null;
  phase: PullRequestLinkPhase;
  announcement: string | null;
  hasWork: boolean;
  /** Attach to the Link trigger so a committed link returns focus there. */
  triggerRef: { current: HTMLButtonElement | null };
  start: () => void;
  change: (value: string) => void;
  cancel: () => void;
  /** Links the typed reference; a bare number needs the repository it is in. */
  submit: (repositoryId: number | null) => void;
  /** One Escape rung: clears text or error, then collapses an empty composer. */
  handleEscape: () => boolean;
}

/**
 * Owns the card's manual link draft and its request. The state lives with the card
 * modal so the draft takes part in the modal's dirty guard and its Escape ladder.
 * Linking the same pull request twice changes nothing, so a failed attempt is simply
 * submitted again.
 */
export function usePullRequestLink(boardId: string, cardId: string): PullRequestLinkController {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PullRequestLinkPhase>("idle");
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const submit = useCallback(
    async (repositoryId: number | null) => {
      const text = draftRef.current.trim();
      if (phaseRef.current !== "idle" || text === "") return;
      setError(null);
      setAnnouncement(null);
      setPhase("pending");
      try {
        const response = await api.boards[":id"].cards[":cardId"].development["pull-requests"].$post({
          param: { id: boardId, cardId },
          json: { pullRequest: text, ...(repositoryId === null ? {} : { repositoryId }) },
        });
        if (!response.ok) {
          setError(await refusalMessage(response, "Could not link the pull request."));
          return;
        }
        queryClient.setQueryData(cardDevelopmentQueryKey(boardId, cardId), (await response.json()) as CardDevelopment);
        void queryClient.invalidateQueries({ queryKey: boardDevelopmentQueryKey(boardId) });
        setDraft("");
        setOpen(false);
        setAnnouncement("Pull request linked.");
        restoreFocusSoon(triggerRef.current);
      } catch {
        setError("Could not reach foxban. Try again.");
      } finally {
        setPhase("idle");
      }
    },
    [boardId, cardId, queryClient],
  );

  const start = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    setOpen(true);
    setAnnouncement(null);
  }, []);

  const change = useCallback((value: string) => {
    setDraft(value);
    setError(null);
  }, []);

  const cancel = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    setOpen(false);
    setDraft("");
    setError(null);
    setAnnouncement(null);
  }, []);

  const handleEscape = useCallback(() => {
    // A request in flight is not erased by Escape: the modal's guarded close takes the key.
    if (!open || phaseRef.current !== "idle") return false;
    if (draftRef.current.trim() !== "" || error !== null) {
      setDraft("");
      setError(null);
      return true;
    }
    setOpen(false);
    return true;
  }, [error, open]);

  return {
    open,
    draft,
    error,
    phase,
    announcement,
    hasWork: (open && draft.trim() !== "") || phase !== "idle",
    triggerRef,
    start,
    change,
    cancel,
    submit: (repositoryId) => void submit(repositoryId),
    handleEscape,
  };
}
