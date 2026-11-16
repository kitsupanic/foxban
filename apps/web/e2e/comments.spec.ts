import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  inviteMember,
  signup,
  uniqueEmail,
} from "./helpers";

/**
 * Card comments end to end: the Markdown round-trip through the shared editor,
 * the author-only edit and the (edited) marker, the comment badge, and the live
 * cross-member sync with an admin deleting someone else's comment.
 *
 * Every e2e user signs up on `@admin.test`, so all of them are admins. That is
 * used deliberately below: Edit is author-only even for an admin, while Delete
 * is the admin power being proved.
 */

/** A signed-up user in its own browser context (own cookie jar), with an explicit display name. */
async function newUser(
  browser: Browser,
  suffix: string,
  name: string,
): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail(suffix);
  await signup(page, email, name);
  return { page, email };
}

/**
 * Locates a single comment row container uniquely by its own rendered Markdown body,
 * resolving to its nearest `[data-comment-id]` row root to avoid nesting ambiguity
 * and styling class coupling.
 */
function commentRow(scope: Locator | Page, bodyText: string | RegExp): Locator {
  return scope.locator(".prose", { hasText: bodyText }).locator("xpath=ancestor::*[@data-comment-id][1]");
}

async function boardWithCard(page: Page, suffix: string, cardTitle: string): Promise<void> {
  await signup(page, uniqueEmail(suffix), "Comment Author");
  const boardName = `Comments ${suffix} ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", cardTitle);
}

test("audit 3: a server-rejected comment edit keeps the exact draft for correction", async ({ page }) => {
  await boardWithCard(page, "edit-rejected", "Rejected edit");
  await cardIn(columnByTitle(page, "Todo"), "Rejected edit").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("Original comment");
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();
  await commentRow(dialog, "Original comment").getByRole("button", { name: "Edit comment" }).click();
  const editor = dialog.getByRole("textbox", { name: "Comment", exact: true });
  const draft = `  ${"x".repeat(10_001)}\n `;
  await editor.fill(draft);
  await dialog.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(editor).toHaveValue(draft);
  await expect(editor).not.toHaveAttribute("readonly", "");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(editor).toHaveValue(draft);
  await editor.fill("Corrected comment");
  await dialog.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await cardIn(columnByTitle(page, "Todo"), "Rejected edit").click();
  await expect(commentRow(page.getByRole("dialog"), "Corrected comment")).toBeVisible();
});

for (const stored of [false, true]) {
  test(`audit 3: disconnected comment edit verifies ${stored ? "acceptance" : "absence and explicit retry"} without losing raw text`, async ({ page }) => {
    let disconnectNextEdit = true;
    let holdSnapshot = false;
    let releaseSnapshot: (() => void) | undefined;
    let editFrames = 0;
    await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.type === "comment.update") {
          editFrames++;
          if (disconnectNextEdit) {
            disconnectNextEdit = false;
            if (!stored) {
              holdSnapshot = true;
              ws.close({ code: 1012, reason: "edit interrupted before delivery" });
              return;
            }
          }
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (stored && frame.type === "comment.update" && !holdSnapshot) {
          holdSnapshot = true;
          ws.close({ code: 1012, reason: "edit accepted, echo lost" });
          return;
        }
        if (frame.type === "snapshot" && holdSnapshot) {
          releaseSnapshot = () => ws.send(message);
          return;
        }
        ws.send(message);
      });
    });
    await boardWithCard(page, `edit-reconnect-${stored}`, "Reconnect edit");
    await cardIn(columnByTitle(page, "Todo"), "Reconnect edit").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("Original comment");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();
    await commentRow(dialog, "Original comment").getByRole("button", { name: "Edit comment" }).click();
    const editor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    const draft = "  edited **comment**\n ";
    await editor.fill(draft);
    await dialog.getByRole("button", { name: "Save comment", exact: true }).click();
    await expect(dialog.getByText("Checking whether comment edit completed…")).toBeVisible();
    await expect(editor).toHaveValue(draft);
    await expect(editor).toHaveAttribute("readonly", "");
    await expect(dialog.getByRole("button", { name: "Save comment", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await editor.press("Escape");
    await expect(editor).toHaveValue(draft);
    await expect.poll(() => Boolean(releaseSnapshot)).toBe(true);
    releaseSnapshot!();
    if (!stored) {
      await expect(dialog.getByRole("alert")).toHaveText("Sync could not verify comment edit. You can retry saving.");
      await expect(editor).toHaveValue(draft);
      await expect(editor).not.toHaveAttribute("readonly", "");
      expect(editFrames).toBe(1);
      await dialog.getByRole("button", { name: "Save comment", exact: true }).click();
    }
    await expect(editor).toHaveCount(0);
    expect(editFrames).toBe(stored ? 1 : 2);
    holdSnapshot = false;
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await cardIn(columnByTitle(page, "Todo"), "Reconnect edit").click();
    await expect(commentRow(page.getByRole("dialog"), "edited comment")).toHaveCount(1);
  });
}

test("a comment renders its Markdown, edits in place, badges the card and survives a reopen", async ({
  page,
}) => {
  await boardWithCard(page, "cmt-basic", "comment card");

  const card = cardIn(columnByTitle(page, "Todo"), "comment card");
  await expect(card.getByTestId("comment-badge")).toHaveCount(0);
  await card.click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  const composer = dialog.getByRole("textbox", { name: "Comment", exact: true });
  await composer.fill("**important** note");

  // Escape cancels the composer without reaching the modal's window listener.
  await composer.press("Escape");
  await expect(composer).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Add a comment", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Comment", exact: true })).toBeDisabled();
  await expect(dialog).toBeVisible();

  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("**important** note");
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();

  await expect(dialog.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Comments · 1", exact: true })).toBeVisible();
  const row = dialog.getByRole("listitem").filter({ hasText: "important" });
  await expect(row.locator("strong")).toHaveText("important");
  await expect(row.getByText("Comment Author")).toBeVisible();
  await expect(row.getByText("(edited)")).toHaveCount(0);

  await row.getByRole("button", { name: "Edit comment" }).click();
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("revised note");
  await dialog.getByRole("button", { name: "Save comment" }).click();

  const edited = dialog.getByRole("listitem").filter({ hasText: "revised note" });
  await expect(edited.getByText("revised note")).toBeVisible();
  await expect(edited.getByText("(edited)")).toBeVisible();

  // With the composer idle, Escape closes the modal as always.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card.getByTestId("comment-badge")).toHaveText("1");
  await expect(card.getByTestId("comment-badge")).toHaveAttribute("aria-label", "1 comment");

  // Reopening reads the comment back off the snapshot, not the local cache.
  await page.reload();
  await cardIn(columnByTitle(page, "Todo"), "comment card").click();
  await expect(
    page.getByRole("dialog").getByRole("listitem").filter({ hasText: "revised note" }),
  ).toBeVisible();
});

test("a comment reaches another member live, and an admin deletes it", async ({ browser }) => {
  const alice = await newUser(browser, "cmt-sync-a", "Alice Sync");
  const bob = await newUser(browser, "cmt-sync-b", "Bob Sync");

  const boardName = `Comments sync ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);

  await alice.page.getByRole("link", { name: boardName }).click();
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "shared card");

  await cardIn(columnByTitle(alice.page, "Todo"), "shared card").click();
  const aliceDialog = alice.page.getByRole("dialog");

  await bob.page.goto(`/board/${boardId}`);
  await cardIn(columnByTitle(bob.page, "Todo"), "shared card").click();
  const bobDialog = bob.page.getByRole("dialog");
  await expect(bobDialog).toBeVisible();

  await aliceDialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await aliceDialog.getByRole("textbox", { name: "Comment", exact: true }).fill("from alice");
  await aliceDialog.getByRole("button", { name: "Comment", exact: true }).click();

  // Bob sees it over the socket, with no reload.
  const bobsViewOfAlice = bobDialog.getByRole("listitem").filter({ hasText: "from alice" });
  await expect(bobsViewOfAlice).toBeVisible();
  await expect(bobsViewOfAlice.getByText("Alice Sync")).toBeVisible();

  // Edit is author-only — Bob is an admin and still does not get it. Delete he does.
  await expect(bobsViewOfAlice.getByRole("button", { name: "Edit comment" })).toHaveCount(0);
  await expect(bobsViewOfAlice.getByRole("button", { name: "Delete comment" })).toHaveCount(1);

  await bobDialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await bobDialog.getByRole("textbox", { name: "Comment", exact: true }).fill("from bob");
  await bobDialog.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(aliceDialog.getByRole("listitem").filter({ hasText: "from bob" })).toBeVisible();

  await bobsViewOfAlice.getByRole("button", { name: "Delete comment" }).click();
  await expect(aliceDialog.getByRole("listitem").filter({ hasText: "from alice" })).toHaveCount(0);
  await expect(aliceDialog.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(
    aliceDialog.getByRole("tab", { name: "Comments · 1", exact: true }),
  ).toBeVisible();

  await alice.page.context().close();
  await bob.page.context().close();
});

test("a standalone YouTube URL in a comment remains an ordinary link", async ({ page }) => {
  await boardWithCard(page, "cmt-youtube", "comment video card");

  await cardIn(columnByTitle(page, "Todo"), "comment video card").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  const url = "https://youtu.be/M7lc1UVf-VE?t=1m30s";
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill(url);
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();

  const row = dialog.getByRole("listitem").filter({ hasText: "M7lc1UVf-VE" });
  await expect(row.getByRole("link", { name: url })).toHaveAttribute("href", url);
  await expect(row.locator("iframe")).toHaveCount(0);
});
test("one-level reply threads sync live, flatten reply-to-reply, tombstone on root delete, and prune on final reply delete", async ({
  browser,
}) => {
  const alice = await newUser(browser, "thread-a", "Alice Threads");
  const bob = await newUser(browser, "thread-b", "Bob Threads");

  const boardName = `Reply threads ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);

  await alice.page.getByRole("link", { name: boardName }).click();
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "thread card");

  await cardIn(columnByTitle(alice.page, "Todo"), "thread card").click();
  const aliceDialog = alice.page.getByRole("dialog");

  await bob.page.goto(`/board/${boardId}`);
  await cardIn(columnByTitle(bob.page, "Todo"), "thread card").click();
  const bobDialog = bob.page.getByRole("dialog");
  await expect(bobDialog).toBeVisible();

  // 1. Alice creates root comment
  await aliceDialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await aliceDialog.getByRole("textbox", { name: "Comment", exact: true }).fill("Alice root comment");
  await aliceDialog.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(commentRow(aliceDialog, "Alice root comment")).toBeVisible();
  await expect(commentRow(bobDialog, "Alice root comment")).toBeVisible();

  // 2. Bob tests reply composer Escape and cancellation
  const bobsViewOfRoot = commentRow(bobDialog, "Alice root comment");
  await bobsViewOfRoot.getByRole("button", { name: "Reply to comment" }).click();
  const replyComposer = bobDialog.getByRole("textbox", { name: "Comment", exact: true });
  await expect(replyComposer).toBeVisible();
  await replyComposer.fill("Draft reply");
  await replyComposer.press("Escape");
  await expect(replyComposer).toHaveCount(0);
  await expect(bobDialog).toBeVisible();

  // Re-open reply composer, Bob replies live to root
  await bobsViewOfRoot.getByRole("button", { name: "Reply to comment" }).click();
  await bobDialog.getByRole("textbox", { name: "Comment", exact: true }).fill("**Bob** reply 1");
  await bobDialog.getByRole("button", { name: "Reply", exact: true }).click();

  // Both see Bob's reply live, Markdown rendered.
  // Root <li> contains replies; anchor to the comment's own rendered prose to avoid ancestor ambiguity.
  const bobsReplyOnAlice = commentRow(aliceDialog, "Bob reply 1");
  await expect(bobsReplyOnAlice.locator("strong")).toHaveText("Bob");

  // 3. Alice replies to Bob's reply -> flattens to sibling under root
  await bobsReplyOnAlice.getByRole("button", { name: "Reply to comment" }).click();
  await aliceDialog.getByRole("textbox", { name: "Comment", exact: true }).fill("Alice sibling reply");
  await aliceDialog.getByRole("button", { name: "Reply", exact: true }).click();

  const alicesReply = commentRow(aliceDialog, "Alice sibling reply");
  await expect(alicesReply).toBeVisible();
  await expect(commentRow(bobDialog, "Alice sibling reply")).toBeVisible();

  // Check counts on tabs and card front
  await expect(aliceDialog.getByRole("tab", { name: "Comments · 3", exact: true })).toBeVisible();
  await alice.page.keyboard.press("Escape");
  await expect(aliceDialog).toHaveCount(0);
  const cardBadge = cardIn(columnByTitle(alice.page, "Todo"), "thread card").getByTestId("comment-badge");
  await expect(cardBadge).toHaveText("3");
  await expect(cardBadge).toHaveAttribute("aria-label", "3 comments");

  // Reopen and reload to verify snapshot persistence and order
  await alice.page.reload();
  await cardIn(columnByTitle(alice.page, "Todo"), "thread card").click();
  const reloadedAliceDialog = alice.page.getByRole("dialog");
  await expect(reloadedAliceDialog).toBeVisible();
  await expect(reloadedAliceDialog.getByRole("tab", { name: "Comments · 3", exact: true })).toBeVisible();

  // Assert exact DOM order of root and replies:
  // The root comment comes first, then Bob's reply, then Alice's reply.
  const commentTextContainers = reloadedAliceDialog
    .getByRole("list")
    .locator(".prose");
  await expect(commentTextContainers).toHaveCount(3);
  expect(await commentTextContainers.allInnerTexts()).toEqual([
    "Alice root comment",
    "Bob reply 1",
    "Alice sibling reply",
  ]);

  // 4. Permissions and editing on replies:
  // - On Alice's view: Alice cannot edit Bob's reply, but as board admin can delete it.
  //   Alice CAN edit her own reply.
  const reloadedBobsReplyOnAlice = commentRow(reloadedAliceDialog, "Bob reply 1");
  await expect(reloadedBobsReplyOnAlice.getByRole("button", { name: "Edit comment" })).toHaveCount(0);
  await expect(reloadedBobsReplyOnAlice.getByRole("button", { name: "Delete comment" })).toHaveCount(1);

  const alicesReplyOnAlice = commentRow(reloadedAliceDialog, "Alice sibling reply");
  await expect(alicesReplyOnAlice.getByRole("button", { name: "Edit comment" })).toHaveCount(1);
  await expect(alicesReplyOnAlice.getByRole("button", { name: "Delete comment" })).toHaveCount(1);

  // - On Bob's view: Bob can edit his own reply and, as an admin, can delete any comment.
  const bobsReplyOnBob = commentRow(bobDialog, "Bob reply 1");
  await expect(bobsReplyOnBob.getByRole("button", { name: "Edit comment" })).toHaveCount(1);
  await expect(bobsReplyOnBob.getByRole("button", { name: "Delete comment" })).toHaveCount(1);

  const alicesRootOnBob = commentRow(bobDialog, "Alice root comment");
  await expect(alicesRootOnBob.getByRole("button", { name: "Edit comment" })).toHaveCount(0);
  await expect(alicesRootOnBob.getByRole("button", { name: "Delete comment" })).toHaveCount(1);

  const alicesReplyOnBob = commentRow(bobDialog, "Alice sibling reply");
  await expect(alicesReplyOnBob.getByRole("button", { name: "Edit comment" })).toHaveCount(0);
  await expect(alicesReplyOnBob.getByRole("button", { name: "Delete comment" })).toHaveCount(1);

  // Exercise Bob's reply edit flow in place:
  await bobsReplyOnBob.getByRole("button", { name: "Edit comment" }).click();
  const bobsEditInput = bobDialog.getByRole("textbox", { name: "Comment", exact: true });
  await expect(bobsEditInput).toHaveValue("**Bob** reply 1");
  await bobsEditInput.fill("**Bob** reply 1 (revised)");
  await bobDialog.getByRole("button", { name: "Save comment", exact: true }).click();

  // Both see Bob's edited reply and the (edited) marker
  const updatedBobsReplyOnBob = commentRow(bobDialog, "Bob reply 1 (revised)");
  await expect(updatedBobsReplyOnBob).toBeVisible();
  await expect(updatedBobsReplyOnBob.getByText("(edited)")).toBeVisible();

  const updatedBobsReplyOnAlice = commentRow(reloadedAliceDialog, "Bob reply 1 (revised)");
  await expect(updatedBobsReplyOnAlice).toBeVisible();
  await expect(updatedBobsReplyOnAlice.getByText("(edited)")).toBeVisible();
  // 5. Delete root comment while replies exist -> "Comment deleted" placeholder appears
  const rootItem = commentRow(alice.page.getByRole("dialog"), "Alice root comment");
  await rootItem.getByRole("button", { name: "Delete comment" }).click();
  await expect(alice.page.getByRole("dialog").getByText("Comment deleted")).toBeVisible();
  // The two replies are still visible
  await expect(commentRow(alice.page.getByRole("dialog"), "Bob reply 1")).toBeVisible();
  await expect(commentRow(alice.page.getByRole("dialog"), "Alice sibling reply")).toBeVisible();
  // Badge and tab counts only count active (non-tombstoned) comments: 2 remaining
  await expect(alice.page.getByRole("dialog").getByRole("tab", { name: "Comments · 2", exact: true })).toBeVisible();

  // 6. Delete first reply
  await commentRow(alice.page.getByRole("dialog"), "Bob reply 1 (revised)").getByRole("button", { name: "Delete comment" }).click();
  await expect(commentRow(alice.page.getByRole("dialog"), "Bob reply 1 (revised)")).toHaveCount(0);
  // Root placeholder remains because second reply still exists
  await expect(alice.page.getByRole("dialog").getByText("Comment deleted")).toBeVisible();
  await expect(commentRow(alice.page.getByRole("dialog"), "Alice sibling reply")).toBeVisible();
  await expect(alice.page.getByRole("dialog").getByRole("tab", { name: "Comments · 1", exact: true })).toBeVisible();

  // 7. Delete final reply -> placeholder pruned
  await commentRow(alice.page.getByRole("dialog"), "Alice sibling reply").getByRole("button", { name: "Delete comment" }).click();
  await expect(commentRow(alice.page.getByRole("dialog"), "Alice sibling reply")).toHaveCount(0);
  await expect(alice.page.getByRole("dialog").getByText("Comment deleted")).toHaveCount(0);
  await expect(alice.page.getByRole("dialog").getByText("No comments yet.")).toBeVisible();
  await expect(alice.page.getByRole("dialog").getByRole("tab", { name: "Comments · 0", exact: true })).toBeVisible();

  await alice.page.context().close();
  await bob.page.context().close();
});

/** One text node to measure, resolved inside a row by its exact trimmed text. */
type ContrastTarget = {
  /** Human label used in assertion messages and attached measurements. */
  name: string;
  /** CSS selector resolved against the row root. */
  selector: string;
  /** Exact trimmed text of the target, so sibling rows can never be confused. */
  text: string;
  /** Measure the `::marker` pseudo-element instead of the element itself. */
  marker?: boolean;
};

type ContrastMeasurement = {
  label: string;
  target: string;
  selector: string;
  foreground: string;
  background: string;
  contrast: number;
};

/**
 * Measures text contrast for targets inside one row, in the browser.
 *
 * Colours are normalized to sRGB channels through a canvas, so any computed
 * colour syntax resolves to usable channels. The background is the nearest
 * opaque painted ancestor, and opacity is required to be 1 across the whole
 * ancestor chain above it; a partially transparent painted layer or an
 * effective opacity below 1 would make a ratio built on it wrong, so those fail
 * loudly instead of being assumed white. Ratios use the WCAG 2.x
 * relative-luminance formula and stay unrounded: rounding to a display
 * precision can lift a true 4.496… ratio onto the 4.5 boundary and let a
 * failing screenshot pass. Kept private to this spec: it exists for this one
 * regression, not as a reusable colour framework.
 */
async function measureContrast(
  root: Locator,
  label: string,
  targets: ContrastTarget[],
): Promise<ContrastMeasurement[]> {
  return root.evaluate((element, args) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) {
      throw new Error("Canvas 2D context unavailable for colour normalization");
    }

    const channels = (css: string): { r: number; g: number; b: number; a: number } => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(1, 2, 3, 0.5)"; // sentinel: survives an unparseable colour
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };

    const linear = (value: number): number => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (c: { r: number; g: number; b: number }): number =>
      0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);

    const nearestOpaqueBackground = (node: Element, target: string): string => {
      let painted: string | null = null;
      for (let current: Element | null = node; current !== null; current = current.parentElement) {
        // Opacity is checked along the whole ancestor chain, not only up to the
        // nearest opaque paint: an ancestor above it still composites the whole
        // subtree, so its backdrop is what the text is really shown against.
        const opacity = Number.parseFloat(getComputedStyle(current).opacity);
        if (Number.isFinite(opacity) && opacity < 1) {
          throw new Error(
            `effective opacity ${opacity} on <${current.tagName.toLowerCase()}> prevents contrast measurement of ${target}`,
          );
        }
        if (painted !== null) continue;
        const raw = getComputedStyle(current).backgroundColor;
        const parsed = channels(raw);
        if (parsed.a === 0) continue;
        if (parsed.a < 1) {
          throw new Error(
            `partially transparent painted layer (alpha ${parsed.a}) on <${current.tagName.toLowerCase()}> prevents contrast measurement of ${target}`,
          );
        }
        painted = raw;
      }
      if (painted === null) {
        throw new Error(`no opaque painted ancestor found for ${target}`);
      }
      return painted;
    };

    return args.targets.map(({ name, selector, text, marker }) => {
      const node = Array.from(element.querySelectorAll(selector)).find(
        (candidate) => candidate.textContent?.trim() === text,
      );
      if (node === undefined) {
        throw new Error(`target "${name}" (${selector} "${text}") not found in ${args.label}`);
      }
      const markerStyle = getComputedStyle(node, marker === true ? "::marker" : null);
      const foregroundRaw = markerStyle.color === "" ? getComputedStyle(node).color : markerStyle.color;
      const foreground = channels(foregroundRaw);
      if (foreground.a < 1) {
        throw new Error(`foreground alpha ${foreground.a} on "${name}" prevents contrast measurement`);
      }
      const backgroundRaw = nearestOpaqueBackground(node, name);
      const background = channels(backgroundRaw);
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return {
        label: args.label,
        target: name,
        selector,
        foreground: foregroundRaw,
        background: backgroundRaw,
        contrast: (lighter + 0.05) / (darker + 0.05),
      };
    });
  }, { label, targets });
}

/**
 * Screenshots and measurements are written outside Playwright's output
 * directory as well as attached, so a run clearing its own output directory
 * does not delete them and they can be inspected on disk afterwards. The folder
 * is keyed by the Playwright output-directory basename, which separates
 * concurrently running shards but is not unique per run: a focused run sets no
 * output-directory variable and lands in "default", and a later run resolving
 * to the same basename overwrites its same-named files. Files therefore
 * accumulate in one folder per basename rather than per run; copy the folder to
 * preserve a run's evidence.
 */
const EVIDENCE_DIR = path.join(
  os.tmpdir(),
  "foxban-contrast-evidence",
  process.env.E2E_OUTPUT_DIR ? path.basename(process.env.E2E_OUTPUT_DIR) : "default",
);

async function saveEvidence(name: string, body: string | Buffer, contentType: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, name);
  await writeFile(filePath, body);
  await test.info().attach(name, { path: filePath, contentType });
}

/**
 * Saved comments and replies must stay readable whatever the OS colour scheme
 * is. The regression this guards: the saved-Markdown wrapper used to carry
 * `dark:prose-invert`, which follows `prefers-color-scheme` rather than the
 * application style, so with a dark OS preference the body text inverted to a
 * pale grey on the still-light card. The application stays light independently
 * of the OS preference; a saved description preview using the non-inverted
 * typography pattern is inspected unchanged as the control.
 */
test("comments and replies stay readable regardless of system color scheme", async ({ page }) => {
  await boardWithCard(page, "contrast", "contrast card");

  const card = cardIn(columnByTitle(page, "Todo"), "contrast card");

  // The description preview is the non-inverted control: it already renders
  // `prose prose-sm` without any dark inversion. Save it, then reopen the card.
  await card.click();
  await page.getByRole("dialog").getByRole("button", { name: "Add a description…" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Card description")
    .fill("Description control paragraph\n\n1. First control item\n2. Second control item");
  await page.getByRole("dialog").getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await card.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("description-view")).toContainText(
    "Description control paragraph",
  );

  // Root comment: a paragraph, bold text and an ordered list.
  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Contrast root paragraph\n\n**Contrast bold**\n\n1. First root item\n2. Second root item");
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();

  const rootRow = commentRow(dialog, "Contrast root paragraph");
  await expect(rootRow).toHaveCount(1);

  // Reply through the shared row renderer: a paragraph and an ordered list.
  await rootRow.getByRole("button", { name: "Reply to comment" }).click();
  await dialog
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Contrast reply paragraph\n\n1. First reply item\n2. Second reply item");
  await dialog.getByRole("button", { name: "Reply", exact: true }).click();

  const replyRow = commentRow(dialog, "Contrast reply paragraph");
  await expect(replyRow).toHaveCount(1);

  // Exact target counts, each scoped to its own row rather than the thread list item.
  await expect(rootRow.locator("strong")).toHaveCount(1);
  await expect(rootRow.locator("ol > li")).toHaveCount(2);
  await expect(replyRow.locator("strong")).toHaveCount(0);
  await expect(replyRow.locator("ol > li")).toHaveCount(2);
  await expect(dialog.getByRole("tab", { name: "Comments · 2", exact: true })).toBeVisible();

  const descriptionView = dialog.getByTestId("description-view");

  // The thread list item wraps the root row and its indented replies, so a
  // screenshot of it shows the hierarchy and indentation in one image.
  const threadRow = rootRow.locator("xpath=ancestor::li[1]");

  const rootTargets: ContrastTarget[] = [
    { name: "root paragraph", selector: "p", text: "Contrast root paragraph" },
    { name: "root bold", selector: "strong", text: "Contrast bold" },
    { name: "root item 1", selector: "ol > li", text: "First root item" },
    { name: "root item 2", selector: "ol > li", text: "Second root item" },
    { name: "root item 1 marker", selector: "ol > li", text: "First root item", marker: true },
    { name: "root item 2 marker", selector: "ol > li", text: "Second root item", marker: true },
  ];
  const replyTargets: ContrastTarget[] = [
    { name: "reply paragraph", selector: "p", text: "Contrast reply paragraph" },
    { name: "reply item 1", selector: "ol > li", text: "First reply item" },
    { name: "reply item 2", selector: "ol > li", text: "Second reply item" },
    { name: "reply item 1 marker", selector: "ol > li", text: "First reply item", marker: true },
    { name: "reply item 2 marker", selector: "ol > li", text: "Second reply item", marker: true },
  ];
  const descriptionTargets: ContrastTarget[] = [
    { name: "description paragraph", selector: "p", text: "Description control paragraph" },
    { name: "description item 1", selector: "ol > li", text: "First control item" },
    { name: "description item 2", selector: "ol > li", text: "Second control item" },
  ];

  type Observation = {
    osScheme: "light" | "dark";
    width: number;
    measurements: ContrastMeasurement[];
  };
  const observations: Observation[] = [];

  /** Emulate one OS preference, prove the invariants, then measure, attach and assert. */
  const inspect = async (osScheme: "light" | "dark") => {
    await page.emulateMedia({ colorScheme: osScheme });
    expect(
      await page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches),
      `the emulated ${osScheme} preference must be observed by the media query`,
    ).toBe(osScheme === "dark");
    await expect(dialog).toBeVisible();

    await threadRow.scrollIntoViewIfNeeded();
    const width = page.viewportSize()?.width ?? 0;
    const key = `${osScheme}-${width}`;

    const measurements = [
      ...(await measureContrast(rootRow, `root ${key}`, rootTargets)),
      ...(await measureContrast(replyRow, `reply ${key}`, replyTargets)),
      ...(await measureContrast(descriptionView, `description ${key}`, descriptionTargets)),
    ];
    observations.push({ osScheme, width, measurements });

    await saveEvidence(
      `contrast-${key}.json`,
      JSON.stringify(measurements, null, 2),
      "application/json",
    );
    await saveEvidence(`comments-${key}.png`, await dialog.screenshot(), "image/png");
    await saveEvidence(`thread-${key}.png`, await threadRow.screenshot(), "image/png");
    await saveEvidence(`root-row-${key}.png`, await rootRow.screenshot(), "image/png");
    await saveEvidence(`reply-row-${key}.png`, await replyRow.screenshot(), "image/png");
    await saveEvidence(
      `description-${key}.png`,
      await descriptionView.screenshot(),
      "image/png",
    );

    // Required targets (everything but the diagnostic numeric markers) must
    // clear 4.5:1 on every transition.
    for (const measurement of measurements) {
      if (measurement.target.includes("marker")) continue;
      expect(
        measurement.contrast,
        `${measurement.label} ${measurement.target}: ${measurement.foreground} on ${measurement.background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  };

  const desktop = page.viewportSize() ?? { width: 1280, height: 720 };

  // Modal mounted throughout: desktop light → dark, a 390px dark capture, then
  // desktop light again.
  await inspect("light");
  await inspect("dark");
  await page.setViewportSize({ width: 390, height: desktop.height });
  await inspect("dark");
  await page.setViewportSize(desktop);
  await inspect("light");


  // The OS preference must not move any computed foreground — markers included.
  // That mobility was the reported bug.
  const desktopObservations = observations.filter((o) => o.width === desktop.width);
  expect(desktopObservations.map((o) => o.osScheme)).toEqual(["light", "dark", "light"]);
  const baseline: Record<string, string> = Object.fromEntries(
    desktopObservations[0].measurements.map((m) => [m.target, m.foreground]),
  );
  for (const observation of desktopObservations.slice(1)) {
    for (const measurement of observation.measurements) {
      expect(
        measurement.foreground,
        `${observation.osScheme}: "${measurement.target}" foreground must not follow the OS preference`,
      ).toBe(baseline[measurement.target]);
    }
  }
});

test("editing a comment cannot save before its image upload lands", async ({ page }) => {
  await boardWithCard(page, "cmt-edit-upload", "comment upload card");
  await cardIn(columnByTitle(page, "Todo"), "comment upload card").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("original note");
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();
  const row = commentRow(dialog, "original note");
  await expect(row).toBeVisible();

  let releaseUpload: () => void = () => undefined;
  const uploadHeld = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let uploadStarted: () => void = () => undefined;
  const uploadRequested = new Promise<void>((resolve) => {
    uploadStarted = resolve;
  });
  await page.route("**/boards/*/attachments", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    uploadStarted();
    await uploadHeld;
    await route.fallback();
  });

  await row.getByRole("button", { name: "Edit comment" }).click();
  const editor = dialog.getByRole("textbox", { name: "Comment", exact: true });
  await dialog.locator(".markdown-editor").filter({ has: page.getByRole("textbox", { name: "Comment", exact: true }) }).getByTestId("comment-image-input").setInputFiles({
    name: "edit.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await uploadRequested;

  const save = dialog.getByRole("button", { name: "Save comment" });
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole("status").filter({ hasText: "Uploading image…" })).toBeVisible();
  await editor.press("ControlOrMeta+Enter");
  await expect(editor).toBeVisible();
  await expect(row.getByText("(edited)")).toHaveCount(0);

  releaseUpload();
  await expect(editor).toHaveValue(/!\[edit\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/);
  await expect(save).toBeEnabled();
  await save.click();

  const edited = dialog.getByRole("listitem").filter({ hasText: "original note" });
  await expect(edited.getByText("(edited)")).toBeVisible();
  await expect(edited.locator("img")).toHaveAttribute("src", /\/attachments\//);
  await page.reload();
  // The card modal is URL-backed, so the reload reopens it on its own.
  await expect(page.getByRole("dialog", { name: "comment upload card" })).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("listitem").filter({ hasText: "original note" }).locator("img"),
  ).toHaveAttribute("src", /\/attachments\//);
});


test("cancelling a failed inline comment upload clears feedback without replacing the textarea", async ({ page }) => {
  await boardWithCard(page, "cmt-inline-upload-reset", "inline upload reset");
  await cardIn(columnByTitle(page, "Todo"), "inline upload reset").click();
  const dialog = page.getByRole("dialog");
  const root = dialog.locator(".card-comment-composer-row");
  const entry = root.getByPlaceholder("Add a comment…", { exact: true });
  const textarea = await entry.elementHandle();
  expect(textarea).not.toBeNull();
  await entry.click();
  await entry.fill("Draft with a failed image");

  let releaseUpload!: () => void;
  const uploadHeld = new Promise<void>((resolve) => { releaseUpload = resolve; });
  let uploadStarted!: () => void;
  const uploadRequested = new Promise<void>((resolve) => { uploadStarted = resolve; });
  await page.route("**/boards/*/attachments", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    uploadStarted();
    await uploadHeld;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "upload unavailable" }) });
  });
  await root.getByTestId("comment-image-input").setInputFiles({
    name: "failed.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"),
  });
  await uploadRequested;
  const cancel = root.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeDisabled();
  await entry.press("Escape");
  await expect(entry).toHaveValue("Draft with a failed image");
  await expect(entry).toHaveAccessibleName("Comment");
  await expect(dialog).toBeVisible();

  releaseUpload();
  await expect(root.getByRole("alert")).toHaveText("Could not upload the attachment.");
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(root.getByRole("alert")).toHaveCount(0);
  await expect(root.getByRole("status")).toHaveCount(0);
  await expect(entry).toHaveValue("");
  await expect(entry).toHaveAccessibleName("Add a comment");
  expect(await entry.evaluate((element, previous) => element === previous, textarea)).toBe(true);

  await entry.click();
  await expect(root.getByRole("alert")).toHaveCount(0);
  await entry.fill("Plain comment after cancelled upload");
  await root.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(commentRow(dialog, "Plain comment after cancelled upload")).toBeVisible();
  await expect(entry).toHaveValue("");
  await expect(entry).toHaveAccessibleName("Add a comment");
  await expect(root.getByRole("alert")).toHaveCount(0);
  expect(await entry.evaluate((element, previous) => element === previous, textarea)).toBe(true);
  await expect(dialog.getByRole("button", { name: "Save title & description", exact: true })).toBeDisabled();
});
