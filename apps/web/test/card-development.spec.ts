import { expect, test } from "@playwright/test";
import type { DevelopmentPullRequest } from "@foxban/shared";
import { cardPullRequestBadge } from "../src/lib/card-development";

const pr = (number: number, state: DevelopmentPullRequest["state"], updatedAt = 1_000): DevelopmentPullRequest => ({
  repositoryId: 1,
  repository: "Fork-Org/api",
  number,
  title: `PR ${number}`,
  state,
  url: `https://github.example/Fork-Org/api/pull/${number}`,
  updatedAt,
});

test("a card front says nothing when the card has no pull request", () => {
  expect(cardPullRequestBadge([])).toBeNull();
});

test("a card front shows the state of its one pull request, with a label that names it", () => {
  expect(cardPullRequestBadge([pr(5, "merged")])).toEqual({ state: "merged", count: 1, label: "Pull request #5: Merged" });
});

test("with several pull requests the front shows the one still in play: open, then draft, then merged, then closed", () => {
  expect(cardPullRequestBadge([pr(1, "closed"), pr(2, "merged"), pr(3, "draft"), pr(4, "open")])?.state).toBe("open");
  expect(cardPullRequestBadge([pr(1, "closed"), pr(2, "merged"), pr(3, "draft")])?.state).toBe("draft");
  expect(cardPullRequestBadge([pr(1, "closed"), pr(2, "merged")])?.state).toBe("merged");
  expect(cardPullRequestBadge([pr(1, "closed")])?.state).toBe("closed");
});

test("among pull requests in the same state the most recently updated one is named, and the rest are counted", () => {
  const badge = cardPullRequestBadge([pr(1, "open", 1_000), pr(2, "open", 3_000), pr(3, "open", 2_000)]);
  expect(badge).toEqual({ state: "open", count: 3, label: "Pull request #2: Open, and 2 more" });
});
