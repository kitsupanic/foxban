import { test, expect, type Page } from "@playwright/test";
import { addCard, addColumn, cardIn, columnByTitle, createBoard, signup, uniqueEmail } from "./helpers";

async function openCard(page: Page) {
  await signup(page, uniqueEmail("editor-recovery"));
  const name = `Editor recovery ${crypto.randomUUID()}`;
  await createBoard(page, name);
  await page.getByRole("link", { name }).click();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Recovery card");
  await cardIn(columnByTitle(page, "Todo"), "Recovery card").click();
}

async function addComment(page: Page, text: string) {
  const dialog = page.getByRole("dialog");
  const composer = dialog.locator(".card-comment-composer");
  await composer.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  const editor = composer.getByRole("textbox", { name: "Comment", exact: true });
  await editor.fill(text);
  await editor.press("ControlOrMeta+Enter");
  await expect(dialog.locator("[data-comment-id]").filter({ hasText: text })).toHaveCount(1);
}

test("peer archive releases the dirty editor navigation guard", async ({ page, context }) => {
  await openCard(page);
  const peer = await context.newPage();
  await peer.goto(page.url());
  await page.getByRole("button", { name: "Edit title", exact: true }).click();
  await page.getByLabel("Card title", { exact: true }).fill("Unsaved title");
  await expect(page.getByText("Unsaved title", { exact: true })).toBeVisible();
  const peerDialog = peer.getByRole("dialog");
  await peerDialog.getByRole("button", { name: "Delete card", exact: true }).click();
  await peerDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/card=/);
  await page.getByRole("link", { name: "Profile", exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/profile$/);
});

for (const withReply of [false, true]) {
  test(`${withReply ? "tombstoned parent" : "removed comment"} preserves exact edit text`, async ({ page, context }) => {
    await openCard(page);
    const dialog = page.getByRole("dialog");
    await addComment(page, "Original comment");
    const row = dialog.locator("[data-comment-id]").filter({ hasText: "Original comment" });
    if (withReply) {
      await row.getByRole("button", { name: "Reply to comment" }).click();
      await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("Keep this reply");
      await dialog.getByRole("textbox", { name: "Comment", exact: true }).press("ControlOrMeta+Enter");
      await expect(dialog.getByText("Keep this reply", { exact: true })).toBeVisible();
    }
    const peer = await context.newPage();
    await peer.goto(page.url());
    await row.getByRole("button", { name: "Edit comment" }).click();
    const draft = "  preserved **raw** draft\n \n";
    await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill(draft);
    await peer.locator("[data-comment-id]").filter({ hasText: "Original comment" }).getByRole("button", { name: "Delete comment" }).click();
    const recovery = dialog.getByRole("alert").filter({ hasText: "Edited comment was deleted" });
    await expect(recovery.getByRole("textbox", { name: "Preserved comment edit", exact: true })).toHaveValue(draft);
    await expect(dialog.getByRole("button", { name: "Save comment", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
    await recovery.getByRole("button", { name: "Move to comment", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(draft);
    await expect(recovery).toHaveCount(0);
    await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(peer.getByRole("dialog").getByText("preserved raw draft", { exact: true })).toHaveCount(0);
  });
}

test("deletion keeps an in-flight draft through accepted no-op settlement", async ({ page, context }) => {
  let releaseEdit: (() => void) | undefined;
  let acceptedEdit = false;
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (JSON.parse(message.toString()).type === "comment.update") acceptedEdit = true;
      ws.send(message);
    });
    ws.onMessage((message) => {
      if (JSON.parse(message.toString()).type === "comment.update") releaseEdit = () => server.send(message);
      else server.send(message);
    });
  });
  await openCard(page);
  const dialog = page.getByRole("dialog");
  await addComment(page, "Delete during save");
  const peer = await context.newPage();
  await peer.goto(page.url());
  await dialog.locator("[data-comment-id]").getByRole("button", { name: "Edit comment" }).click();
  const draft = "  draft awaiting no-op settlement\n ";
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill(draft);
  await dialog.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect.poll(() => Boolean(releaseEdit)).toBe(true);
  await peer.locator("[data-comment-id]").getByRole("button", { name: "Delete comment" }).click();
  const recovery = dialog.getByRole("alert").filter({ hasText: "Edited comment was deleted" });
  await expect(recovery.getByRole("textbox", { name: "Preserved comment edit" })).toHaveValue(draft);
  await expect(recovery.getByRole("button", { name: "Discard edit" })).toBeDisabled();
  await expect(recovery.getByRole("button", { name: "Move to comment" })).toBeDisabled();
  releaseEdit!();
  await expect.poll(() => acceptedEdit).toBe(true);
  await expect(recovery.getByRole("button", { name: "Discard edit" })).toBeEnabled();
  await expect(recovery.getByRole("textbox", { name: "Preserved comment edit" })).toHaveValue(draft);
  await recovery.getByRole("button", { name: "Discard edit" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("image upload finishing after comment deletion joins the preserved draft", async ({ page, context }) => {
  await openCard(page);
  const dialog = page.getByRole("dialog");
  await addComment(page, "Delete during upload");
  const peer = await context.newPage();
  await peer.goto(page.url());
  let releaseUpload: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { releaseUpload = resolve; });
  let uploadStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
  await page.route("**/boards/*/attachments", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    uploadStarted();
    await held;
    await route.fallback();
  });
  await dialog.locator("[data-comment-id]").getByRole("button", { name: "Edit comment" }).click();
  const draft = "  draft with image\n ";
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill(draft);
  await dialog.locator("[data-comment-id]").getByTestId("comment-image-input").setInputFiles({
    name: "preserved.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"),
  });
  await started;
  await peer.locator("[data-comment-id]").getByRole("button", { name: "Delete comment" }).click();
  const recovery = dialog.getByRole("alert").filter({ hasText: "Edited comment was deleted" });
  await expect(recovery.getByRole("button", { name: "Discard edit" })).toBeDisabled();
  await expect(recovery.getByRole("button", { name: "Move to comment" })).toBeDisabled();
  releaseUpload();
  const preserved = recovery.getByRole("textbox", { name: "Preserved comment edit" });
  await expect(preserved).toHaveValue(/!\[preserved\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/);
  expect(await preserved.inputValue()).toMatch(new RegExp(`^${draft}`));
  const raw = await preserved.inputValue();
  await recovery.getByRole("button", { name: "Move to comment" }).click();
  await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(raw);
});

test("a composer upload stays with its composer when a separate edited comment is deleted", async ({ page, context }) => {
  await openCard(page);
  const dialog = page.getByRole("dialog");
  await addComment(page, "Separate edited comment");
  const peer = await context.newPage();
  await peer.goto(page.url());
  const row = dialog.locator("[data-comment-id]");
  await row.getByRole("button", { name: "Edit comment" }).click();
  const editDraft = "  untouched edit draft\n ";
  await row.getByRole("textbox", { name: "Comment", exact: true }).fill(editDraft);
  const composer = dialog.locator(".card-comment-composer");
  await composer.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  const composerDraft = "  separate composer draft\n ";
  await composer.getByRole("textbox", { name: "Comment", exact: true }).fill(composerDraft);
  let releaseUpload: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { releaseUpload = resolve; });
  let uploadStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
  await page.route("**/boards/*/attachments", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    uploadStarted();
    await held;
    await route.fallback();
  });
  await composer.getByTestId("comment-image-input").setInputFiles({
    name: "composer.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"),
  });
  await started;
  await peer.locator("[data-comment-id]").getByRole("button", { name: "Delete comment" }).click();
  const preserved = dialog.getByRole("textbox", { name: "Preserved comment edit", exact: true });
  await expect(preserved).toHaveValue(editDraft);
  releaseUpload();
  const composerText = composer.getByRole("textbox", { name: "Comment", exact: true });
  await expect(composerText).toHaveValue(/!\[composer\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/);
  expect(await composerText.inputValue()).toContain(composerDraft);
  await expect(preserved).toHaveValue(editDraft);
});
