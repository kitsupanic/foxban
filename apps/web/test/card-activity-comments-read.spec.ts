import { expect, test } from "@playwright/test";
import { commentsReadNotice } from "../src/components/CardActivity";

// ADR 0078: a card's comments arrive by their own read, so until it lands the thread is not
// "empty", and a failed read says so with a Retry instead of claiming there are no comments.

test("while a card's comments load, the panel says loading instead of the empty copy", () => {
  expect(commentsReadNotice("pending", "comments")).toEqual({ error: false, empty: "loading" });
  expect(commentsReadNotice("pending", "all")).toEqual({ error: false, empty: "loading" });
});

test("a failed read shows an error, and never the empty copy beside it", () => {
  expect(commentsReadNotice("error", "comments")).toEqual({ error: true, empty: "nothing" });
});

test("a loaded card with no comments is empty, and the history tab ignores the comments read", () => {
  expect(commentsReadNotice("success", "comments")).toEqual({ error: false, empty: "copy" });
  expect(commentsReadNotice("error", "history")).toEqual({ error: false, empty: "copy" });
  expect(commentsReadNotice("pending", "history")).toEqual({ error: false, empty: "copy" });
});
