/// <reference types="node" />
import { expect, test, type Page } from "@playwright/test";
import { DESCRIPTION_MAX_BYTES, descriptionByteLength } from "@foxban/shared";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  signup,
  uniqueEmail,
} from "./helpers";

/**
 * Markdown descriptions (ADR 0013): rendering, the toolbar's splice, and the
 * inertness of hostile input. Single-user — none of it involves the socket fan-out
 * that modal.spec already covers.
 */
async function boardWithCard(page: Page, suffix: string, cardTitle: string): Promise<void> {
  await signup(page, uniqueEmail(suffix), suffix);
  const boardName = `Desc ${suffix} ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", cardTitle);
}

test("a Markdown description renders as rich text", async ({ page }) => {
  await boardWithCard(page, "desc-fmt", "fmt card");

  const card = cardIn(columnByTitle(page, "Todo"), "fmt card");
  await card.click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  await dialog.getByLabel("Card description").fill("Intro **bold** _em_\n\n- alpha\n- beta");
  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(dialog).toHaveCount(0);

  await card.click();
  const view = dialog.getByTestId("description-view");
  await expect(view.locator("strong")).toHaveText("bold");
  await expect(view.locator("em")).toHaveText("em");
  await expect(view.locator("li")).toHaveCount(2);
});
test("rendered description supports text selection and requires triple-click confirmation to edit", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.removeItem("foxban-skip-description-edit-confirmation");
  });
  await boardWithCard(page, "desc-select", "select card");

  const card = cardIn(columnByTitle(page, "Todo"), "select card");
  await card.click();

  const cardDialog = page.getByRole("dialog", { name: "select card" });
  await cardDialog.getByRole("button", { name: "Add a description…" }).click();
  const descriptionTextarea = cardDialog.getByLabel("Card description");
  const sentence = "The quick brown fox jumps over the lazy dog.";
  await descriptionTextarea.fill(sentence);
  await cardDialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(cardDialog).toHaveCount(0);

  await card.click();
  const view = cardDialog.getByTestId("description-view");
  await expect(view).toHaveText(sentence);
  await expect(cardDialog.getByLabel("Card description")).not.toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).toBeDisabled();

  // Clear key just in case.
  await page.evaluate(() => {
    localStorage.removeItem("foxban-skip-description-edit-confirmation");
  });

  // Single click on rendered text leaves it rendered and does not enter edit mode or open confirmation.
  await view.click();
  await expect(cardDialog.getByLabel("Card description")).not.toBeVisible();
  await expect(page.getByRole("dialog", { name: "Edit description?" })).toHaveCount(0);

  // Double click on rendered text also does not enter edit mode or open confirmation.
  await view.dblclick();
  await expect(cardDialog.getByLabel("Card description")).not.toBeVisible();
  await expect(page.getByRole("dialog", { name: "Edit description?" })).toHaveCount(0);

  // Dragging across part of the sentence selects the text.
  const box = await view.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2);
    await page.mouse.up();
  }

  const selectedText = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selectedText.length).toBeGreaterThan(0);
  expect(sentence).toContain(selectedText);
  await expect(cardDialog.getByLabel("Card description")).not.toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).toBeDisabled();
  await expect(page.getByRole("dialog", { name: "Edit description?" })).toHaveCount(0);

  const confirmDialog = page.getByRole("dialog", { name: "Edit description?" });

  // Triple click opens Edit description? dialog while card stays open.
  await view.click({ clickCount: 3 });
  await expect(confirmDialog).toBeVisible();
  // The portalled confirmation dialog renders at body level and the card dialog is marked inert.
  await expect(cardDialog).toHaveAttribute("inert", "");
  await expect(cardDialog.getByRole("heading", { name: "select card", level: 2 })).toBeVisible();
  // Cancel receives initial focus.
  const cancelBtn = confirmDialog.getByRole("button", { name: "Cancel" });
  await expect(cancelBtn).toBeFocused();

  // Tab cycles within the confirmation dialog.
  await page.keyboard.press("Tab");
  await expect(confirmDialog.getByRole("button", { name: "Edit" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirmDialog.getByLabel("Don’t ask again")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancelBtn).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirmDialog.getByLabel("Don’t ask again")).toBeFocused();

  // Escape closes only the confirmation without editing and restores card dialog inertness.
  await page.keyboard.press("Escape");
  await expect(confirmDialog).toHaveCount(0);
  await expect(cardDialog).not.toHaveAttribute("inert");
  await expect(cardDialog.getByRole("heading", { name: "select card", level: 2 })).toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).not.toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).toBeDisabled();
  // Edit description button receives returned focus.
  await expect(cardDialog.getByRole("button", { name: "Edit description" })).toBeFocused();

  // Triple click again, then test backdrop click closes only confirmation without editing.
  await view.click({ clickCount: 3 });
  await expect(confirmDialog).toBeVisible();
  await expect(cardDialog).toHaveAttribute("inert", "");
  // Click outside dialog box (e.g. at overlay margin)
  await page.mouse.click(10, 10);
  await expect(confirmDialog).toHaveCount(0);
  await expect(cardDialog).not.toHaveAttribute("inert");
  await expect(cardDialog.getByRole("heading", { name: "select card", level: 2 })).toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).not.toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).toBeDisabled();

  // Triple click again, check Don't ask again, click Edit.
  await view.click({ clickCount: 3 });
  await expect(confirmDialog).toBeVisible();
  await expect(cardDialog).toHaveAttribute("inert", "");
  await confirmDialog.getByLabel("Don’t ask again").check();
  await confirmDialog.getByRole("button", { name: "Edit" }).click();
  await expect(confirmDialog).toHaveCount(0);
  await expect(cardDialog).not.toHaveAttribute("inert");
  await expect(cardDialog.getByLabel("Card description")).toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).toHaveValue(sentence);

  const pref = await page.evaluate(() => localStorage.getItem("foxban-skip-description-edit-confirmation"));
  expect(pref).toBe("true");

  // Return to preview.
  await cardDialog.getByRole("button", { name: "Preview description" }).click();
  await expect(cardDialog.getByLabel("Card description")).not.toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).toBeDisabled();

  // Triple click again: editing begins immediately without confirmation.
  await view.click({ clickCount: 3 });
  await expect(confirmDialog).toHaveCount(0);
  await expect(cardDialog.getByLabel("Card description")).toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).toHaveValue(sentence);

  // Preview returns to rendered draft mode.
  await cardDialog.getByRole("button", { name: "Preview description" }).click();
  await expect(cardDialog.getByLabel("Card description")).not.toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).toBeDisabled();

  // Clear key in test cleanup, return to preview, and verify explicit Edit description button still opens immediately.
  await page.evaluate(() => localStorage.removeItem("foxban-skip-description-edit-confirmation"));
  await cardDialog.getByRole("button", { name: "Edit description" }).click();
  await expect(confirmDialog).toHaveCount(0);
  await expect(cardDialog.getByLabel("Card description")).toBeVisible();
  await expect(cardDialog.getByLabel("Card description")).toHaveValue(sentence);
});
test("the Bold toolbar button wraps the selection and Preview renders the draft", async ({ page }) => {
  await boardWithCard(page, "desc-tb", "toolbar card");

  const card = cardIn(columnByTitle(page, "Todo"), "toolbar card");
  await card.click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");
  await textarea.fill("make this strong");
  await textarea.press("ControlOrMeta+a");
  await dialog.getByRole("button", { name: "Bold" }).click();
  await expect(textarea).toHaveValue("**make this strong**");

  // Preview leaves edit mode without saving: the view renders the draft.
  await dialog.getByRole("button", { name: "Preview description" }).click();
  await expect(dialog.getByTestId("description-view").locator("strong")).toHaveText(
    "make this strong",
  );

  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(dialog).toHaveCount(0);

  await card.click();
  await expect(dialog.getByTestId("description-view").locator("strong")).toHaveText(
    "make this strong",
  );
});

test("hostile description input stays inert", async ({ page }) => {
  await boardWithCard(page, "desc-xss", "xss card");

  const card = cardIn(columnByTitle(page, "Todo"), "xss card");
  await card.click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  await dialog
    .getByLabel("Card description")
    .fill('<img src=x onerror="window.x=1">\n\n[click](javascript:alert(1))');
  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(dialog).toHaveCount(0);

  await card.click();
  const view = dialog.getByTestId("description-view");
  // No rehype-raw: the tag is literal text, not an element.
  await expect(view.locator("img")).toHaveCount(0);
  await expect(view).toContainText("<img");
  // react-markdown's default urlTransform drops the unsafe scheme.
  const href = await view.getByText("click").getAttribute("href");
  expect(href ?? "").toBe("");
});

test("YouTube descriptions load automatically across reopen and reload", async ({
  page,
}) => {
  const providerRequests: string[] = [];
  page.on("request", (request) => {
    const hostname = new URL(request.url()).hostname;
    if (
      /(^|\.)youtube(?:-nocookie)?\.com$/.test(hostname) ||
      /(^|\.)ytimg\.com$/.test(hostname) ||
      /(^|\.)googlevideo\.com$/.test(hostname)
    ) {
      providerRequests.push(request.url());
    }
  });
  await page.route(/^https:\/\/www\.youtube-nocookie\.com\/embed\//, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>YouTube stub</title>" }),
  );
  await boardWithCard(page, "desc-youtube-life", "video card");

  const card = cardIn(columnByTitle(page, "Todo"), "video card");
  const videoBadge = card.getByTestId("video-badge");
  await expect(videoBadge).toHaveCount(0);
  await card.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  await dialog
    .getByLabel("Card description")
    .fill("Intro\n\nhttps://youtu.be/M7lc1UVf-VE?t=1m30s");
  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(videoBadge).toBeVisible();
  await expect(videoBadge).toHaveAttribute("role", "img");
  await expect(videoBadge).toHaveAttribute("aria-label", "Has a YouTube video");
  await expect(videoBadge).toHaveAttribute("title", "YouTube video");
  await card.click();
  const view = dialog.getByTestId("description-view");
  await expect(view).toContainText("Intro");

  const iframe = view.locator('iframe[title="YouTube video player"]');
  await expect(iframe).toHaveCount(1);
  await expect(iframe).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1&start=90",
  );
  expect(providerRequests).toHaveLength(1);
  await expect(dialog.getByLabel("Card description")).not.toBeVisible();
  await expect(dialog.getByLabel("Card description")).toBeDisabled();
  await expect(dialog.getByText(/^Unsaved (title|description)/)).toHaveCount(0);
  await expect(view.getByRole("link", { name: "Open on YouTube" })).toHaveAttribute(
    "href",
    "https://www.youtube.com/watch?v=M7lc1UVf-VE&t=90s",
  );

  await dialog.getByRole("button", { name: "Close card" }).click();
  await expect(videoBadge).toBeVisible();
  await card.click();
  const reopenedIframe = dialog.locator('iframe[title="YouTube video player"]');
  await expect(reopenedIframe).toHaveCount(1);
  await expect(reopenedIframe).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1&start=90",
  );

  await page.reload();
  const reloadedCard = cardIn(columnByTitle(page, "Todo"), "video card");
  await expect(reloadedCard.getByTestId("video-badge")).toBeVisible();
  const reloadedDialog = page.getByRole("dialog");
  const reloadedIframe = reloadedDialog.locator('iframe[title="YouTube video player"]');
  await expect(reloadedIframe).toHaveCount(1);
  await expect(reloadedIframe).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1&start=90",
  );
});

test("editing preserves YouTube Markdown and keeps multiple players independent", async ({ page }) => {
  await page.route(/^https:\/\/www\.youtube-nocookie\.com\/embed\//, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>YouTube stub</title>" }),
  );
  await boardWithCard(page, "desc-youtube-edit", "editable video card");

  const card = cardIn(columnByTitle(page, "Todo"), "editable video card");
  await card.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const original = "https://youtu.be/M7lc1UVf-VE?t=1m30s";
  await dialog.getByLabel("Card description").fill(original);
  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await card.click();

  await dialog.getByRole("button", { name: "Edit description" }).click();
  await expect(dialog.getByLabel("Card description")).toHaveValue(original);
  const replacement =
    "https://youtu.be/dQw4w9WgXcQ\n\nhttps://www.youtube.com/shorts/M7lc1UVf-VE?t=10s";
  await dialog.getByLabel("Card description").fill(replacement);
  await dialog.getByRole("button", { name: "Preview description" }).click();
  const previewIframes = dialog.locator('iframe[title="YouTube video player"]');
  await expect(previewIframes).toHaveCount(2);
  await expect(previewIframes.first()).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1",
  );
  await expect(previewIframes.nth(1)).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1&start=10",
  );
  await dialog.getByRole("button", { name: "Save title & description" }).click();

  await card.click();
  await dialog.getByRole("button", { name: "Edit description" }).click();
  await expect(dialog.getByLabel("Card description")).toHaveValue(replacement);
  await dialog.getByRole("button", { name: "Preview description" }).click();
  const reopenedIframes = dialog.locator('iframe[title="YouTube video player"]');
  await expect(reopenedIframes).toHaveCount(2);
  await expect(reopenedIframes.first()).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1",
  );
  await expect(reopenedIframes.nth(1)).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1&start=10",
  );
});

test("only standalone safe YouTube links become players", async ({ page }) => {
  await page.route(/^https:\/\/www\.youtube-nocookie\.com\/embed\//, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>YouTube stub</title>" }),
  );
  await boardWithCard(page, "desc-youtube-boundary", "boundary video card");
  const card = cardIn(columnByTitle(page, "Todo"), "boundary video card");
  await expect(card.getByTestId("video-badge")).toHaveCount(0);
  await card.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  await dialog.getByLabel("Card description").fill(
    [
      "https://WWW.YOUTUBE.COM/watch?v=M7lc1UVf-VE&start=invalid",
      "",
      "https://youtube.com/shorts/dQw4w9WgXcQ?t=1h2m3s",
      "",
      "Inline https://youtu.be/M7lc1UVf-VE inside a sentence.",
      "",
      "[reference](https://youtu.be/M7lc1UVf-VE)",
      "",
      "`https://youtu.be/M7lc1UVf-VE`",
      "",
      "    https://youtu.be/M7lc1UVf-VE",
      "",
      "https://youtube.com.evil.test/watch?v=M7lc1UVf-VE",
      "",
      "[https://user@youtube.com/watch?v=M7lc1UVf-VE](https://user@youtube.com/watch?v=M7lc1UVf-VE)",
      "",
      "https://youtu.be/too-short",
      "",
      '<iframe src="https://www.youtube.com/embed/M7lc1UVf-VE"></iframe>',
      "",
      "[unsafe](javascript:alert(1))",
    ].join("\n"),
  );
  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(card.getByTestId("video-badge")).toBeVisible();
  await card.click();
  const view = dialog.getByTestId("description-view");
  const iframes = view.locator('iframe[title="YouTube video player"]');
  await expect(iframes).toHaveCount(2);
  await expect(view.locator("p > code")).toContainText("https://youtu.be/M7lc1UVf-VE");
  await expect(view.locator("pre code")).toContainText("https://youtu.be/M7lc1UVf-VE");
  await expect(view.getByRole("link", { name: "reference" })).toHaveAttribute(
    "href",
    "https://youtu.be/M7lc1UVf-VE",
  );
  await expect(view).toContainText("<iframe");
  expect((await view.getByText("unsafe").getAttribute("href")) ?? "").toBe("");

  await expect(iframes.first()).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1",
  );
  await expect(iframes.nth(1)).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1&start=3723",
  );

  await dialog.getByRole("button", { name: "Edit description" }).click();
  const invalidOnly = [
    "```",
    "https://youtu.be/M7lc1UVf-VE",
    "```",
    "",
    "<!-- https://youtu.be/M7lc1UVf-VE -->",
    "",
    "<div>",
    "https://youtu.be/M7lc1UVf-VE",
    "</div>",
    "",
    "Inline https://youtu.be/M7lc1UVf-VE in sentence.",
    "",
    "[labeled link](https://youtu.be/M7lc1UVf-VE)",
  ].join("\n");
  await dialog.getByLabel("Card description").fill(invalidOnly);
  await dialog.getByRole("button", { name: "Save title & description" }).click();

  await expect(card.getByTestId("video-badge")).toHaveCount(0);
  await card.click();
  const invalidView = dialog.getByTestId("description-view");
  await expect(invalidView.locator('iframe[title="YouTube video player"]')).toHaveCount(0);
  await dialog.getByRole("button", { name: "Edit description" }).click();
  await expect(dialog.getByLabel("Card description")).toHaveValue(invalidOnly);
});

test("large Markdown description persists across reload and bounds rejection with retained draft", async ({
  page,
}) => {
  await boardWithCard(page, "desc-large", "large card");

  const card = cardIn(columnByTitle(page, "Todo"), "large card");
  await card.click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");
  const byteCounter = dialog.getByTestId("description-byte-count");

  // Entering edit mode initially displays 0 / 100,000 bytes.
  await expect(byteCounter).toBeVisible();
  await expect(byteCounter).toHaveText("0 / 100,000 bytes");

  const heading = "# Kampai Roulette";
  const finalParagraph =
    "Distinctive final design paragraph: balance pass, scoring multipliers, and payout settlement rules.";
  const bodyParagraph =
    "Roulette wheel mechanics require precision physics calculation, deterministic seed selection, and client interpolation.";
  const validLargeMarkdown = [
    heading,
    "",
    ...Array.from({ length: 150 }, (_, index) => `Paragraph ${index + 1}: ${bodyParagraph}`),
    "",
    finalParagraph,
  ].join("\n\n");
  // Independent oracle: verify descriptionByteLength against the browser's native TextEncoder UTF-8 implementation.
  const standardEncoder = new TextEncoder();
  for (const sample of ["ascii characters only", validLargeMarkdown, "😀", "\uD800"]) {
    expect(descriptionByteLength(sample)).toBe(standardEncoder.encode(sample).byteLength);
  }

  const expectedUtf8Bytes = descriptionByteLength(validLargeMarkdown);
  expect(expectedUtf8Bytes).toBe(20_414);
  expect(expectedUtf8Bytes).toBeGreaterThanOrEqual(16_905);
  expect(expectedUtf8Bytes).toBeLessThan(DESCRIPTION_MAX_BYTES);

  await textarea.fill(validLargeMarkdown);
  await expect(byteCounter).toHaveText("20,414 / 100,000 bytes");

  // Multibyte text increments byte counter by UTF-8 byte count, not JavaScript string length.
  // "😀" is 2 UTF-16 code units (length 2) but 4 UTF-8 bytes.
  const multibyteSnippet = "😀";
  expect(multibyteSnippet.length).toBe(2);
  await textarea.fill(`${validLargeMarkdown}${multibyteSnippet}`);
  const multibyteExpectedBytes = descriptionByteLength(`${validLargeMarkdown}${multibyteSnippet}`);
  expect(multibyteExpectedBytes).toBe(expectedUtf8Bytes + 4);
  await expect(byteCounter).toHaveText("20,418 / 100,000 bytes");

  // Revert to valid large markdown before saving.
  await textarea.fill(validLargeMarkdown);
  await expect(byteCounter).toHaveText("20,414 / 100,000 bytes");

  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  const reloadedCard = cardIn(columnByTitle(page, "Todo"), "large card");
  await reloadedCard.click();

  const view = dialog.getByTestId("description-view");
  await expect(view.locator("h1")).toHaveText("Kampai Roulette");
  await expect(view).toContainText(finalParagraph);
  // Counter is visible only while description editing.
  await expect(dialog.getByTestId("description-byte-count")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Edit description" }).click();
  await expect(textarea).toHaveValue(validLargeMarkdown);
  await expect(byteCounter).toBeVisible();
  await expect(byteCounter).toHaveText("20,414 / 100,000 bytes");

  // Construct rejected draft from 25,000 emoji (100,000 bytes) plus one ASCII byte (100,001 bytes).
  const overflowDraft = `${"😀".repeat(25_000)}a`;
  expect(descriptionByteLength(overflowDraft)).toBe(DESCRIPTION_MAX_BYTES + 1);
  await textarea.fill(overflowDraft);

  await expect(byteCounter).toHaveText("100,001 / 100,000 bytes");

  await dialog.getByRole("button", { name: "Save title & description" }).click();

  await expect(dialog).toBeVisible();
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText("Description must be 100,000 bytes or fewer.");
  await expect(textarea).toHaveValue(overflowDraft);

  // Restoring the persisted text clears the error and leaves no change to save.
  await textarea.fill(validLargeMarkdown);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(byteCounter).toHaveText("20,414 / 100,000 bytes");

  await expect(dialog.getByRole("button", { name: "Save title & description", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await cardIn(columnByTitle(page, "Todo"), "large card").click();
  const finalView = dialog.getByTestId("description-view");
  await expect(finalView.locator("h1")).toHaveText("Kampai Roulette");
  await expect(finalView).toContainText(finalParagraph);
  await expect(dialog.getByTestId("description-byte-count")).toHaveCount(0);
});

test("typing while an image upload is in flight preserves intervening edits and updates caret position", async ({
  page,
}) => {
  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );

  await boardWithCard(page, "desc-f9", "upload-race-card");

  const card = cardIn(columnByTitle(page, "Todo"), "upload-race-card");
  await card.click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");

  // Type initial draft before initiating upload
  await textarea.fill("Initial paragraph before image.");

  // Intercept the upload request to simulate a slow network upload
  let resumeUpload!: () => void;
  const uploadHold = new Promise<void>((resolve) => {
    resumeUpload = resolve;
  });

  await page.route("**/boards/*/attachments", async (route) => {
    await uploadHold;
    await route.continue();
  });

  // Start the image upload via the hidden image input
  const imageInput = dialog.getByTestId("image-input");
  await imageInput.setInputFiles({ name: "delayed-photo.png", mimeType: "image/png", buffer: PNG_1X1 });

  // While the upload is in flight, continue typing into the description textarea
  await textarea.focus();
  await textarea.pressSequentially("\nIntervening paragraph typed while upload is pending.");

  // Now release the network hold, allowing the upload and insert to complete
  resumeUpload();

  // The upload completes and inserts the image Markdown
  // Assert both initial text and the intervening typed text are retained
  await expect(textarea).toHaveValue(
    /Initial paragraph before image\.\nIntervening paragraph typed while upload is pending\.\n*!\[delayed-photo\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/,
  );

  // Assert caret is at the end of the text after insertion
  const selectionStart = await textarea.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
  const currentVal = await textarea.inputValue();
  expect(selectionStart).toBe(currentVal.length);
});

test("replacing selection while image upload is pending preserves edits and inserts image conservatively", async ({
  page,
}) => {
  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );

  await boardWithCard(page, "desc-f9-sel", "upload-sel-race-card");

  const card = cardIn(columnByTitle(page, "Todo"), "upload-sel-race-card");
  await card.click();

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");

  // Initial text with a clearly delimited target range
  const initialText = "Prefix [target text] Suffix";
  await textarea.fill(initialText);

  // Focus and select "[target text]" (offsets 7 to 20)
  const selStart = initialText.indexOf("[target text]");
  const selEnd = selStart + "[target text]".length;
  await textarea.evaluate(
    (el: HTMLTextAreaElement, [start, end]) => {
      el.focus();
      el.setSelectionRange(start, end);
    },
    [selStart, selEnd],
  );

  // Verify selection is set before initiating upload
  const initialSelection = await textarea.evaluate((el: HTMLTextAreaElement) => [
    el.selectionStart,
    el.selectionEnd,
  ]);
  expect(initialSelection).toEqual([selStart, selEnd]);

  // Intercept the upload request to keep upload in flight
  let resumeUpload!: () => void;
  const uploadHold = new Promise<void>((resolve) => {
    resumeUpload = resolve;
  });

  await page.route("**/boards/*/attachments", async (route) => {
    await uploadHold;
    await route.continue();
  });

  // Start image upload with active selection
  const imageInput = dialog.getByTestId("image-input");
  await imageInput.setInputFiles({ name: "overlap-photo.png", mimeType: "image/png", buffer: PNG_1X1 });

  // While upload is pending, replace the selected range by typing over it
  const replacement = "intervening replacement";
  await page.keyboard.insertText(replacement);

  // Assert intervening edit took effect in the textarea before upload completes
  await expect(textarea).toHaveValue(`Prefix ${replacement} Suffix`);

  await expect(textarea).toBeFocused();
  expect(await textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([selStart + replacement.length, selStart + replacement.length]);

  // Release the network hold to let upload finish and insert image markdown
  resumeUpload();

  // Assert every intervening edit remains and image markdown is inserted
  // at the implementation's conservative insertion point (boundedEnd)
  await expect(textarea).toHaveValue(
    new RegExp(
      `^Prefix ${replacement}!\\[overlap-photo\\.\\w+\\]\\(/boards/[^)]+/attachments/[0-9a-f-]+\\) Suffix$`,
    ),
  );

  // Assert caret placement is deterministic: immediately after the inserted image markdown
  const currentValue = await textarea.inputValue();
  const imageMatch = currentValue.match(
    /!\[overlap-photo\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/,
  );
  expect(imageMatch).not.toBeNull();
  const expectedCaret = selStart + replacement.length + imageMatch![0].length;

  // Observe the committed text and its selection together.
  await expect.poll(() => textarea.evaluate((el: HTMLTextAreaElement) => [
    el.selectionStart,
    el.selectionEnd,
  ])).toEqual([expectedCaret, expectedCaret]);
});
