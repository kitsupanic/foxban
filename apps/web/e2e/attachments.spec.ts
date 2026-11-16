/// <reference types="node" />
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  generateAccountInvite,
  inviteMember,
  openCardSection,
  signup,
  uniqueEmail,
} from "./helpers";

declare global {
  interface Window {
    __svgScriptRan?: boolean;
    __originalGetContext?: typeof HTMLCanvasElement.prototype.getContext;
    __originalToBlob?: typeof HTMLCanvasElement.prototype.toBlob;
    __origWrongMimeToBlob?: typeof HTMLCanvasElement.prototype.toBlob;
    __origDecodeErrSrcDesc?: PropertyDescriptor;
    __origTimeoutSrcDesc?: PropertyDescriptor;
  }
}

/**
 * File attachments end to end: arbitrary-byte upload/download isolation, live
 * sync, image-only Markdown entry points, client-side WebP compression, image
 * preview, and the membership gate on the serve route.
 */

/** A real 1x1 PNG. `setInputFiles` needs actual bytes, and the browser decodes them. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const BLENDER_FILE = Buffer.from("BLENDER-fixture\n");
const BLENDER_NAME = "scene final.blend";
const BLENDER_MIME = "application/x-blender";

/** A signed-up user in its own browser context (own cookie jar). */
async function newUser(browser: Browser, suffix: string): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail(suffix);
  await signup(page, email, suffix);
  return { page, email };
}

async function boardWithCard(page: Page, suffix: string, cardTitle: string): Promise<void> {
  await signup(page, uniqueEmail(suffix), suffix);
  const boardName = `Attach ${suffix} ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", cardTitle);
}
/**
 * Opens the description editor via triple-click and confirms the prompt.
 */
async function openDescriptionEditor(target: Page | Locator): Promise<void> {
  const page = "page" in target && typeof (target as Locator).page === "function" ? (target as Locator).page() : (target as Page);
  await target.getByTestId("description-view").click({ clickCount: 3 });
  const confirmDialog = page.getByRole("dialog", { name: "Edit description?" });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole("button", { name: "Edit" }).click();
}



test("the toolbar Image button embeds the upload, lists it and badges the card", async ({
  page,
}) => {
  await boardWithCard(page, "att-toolbar", "attach card");

  const card = cardIn(columnByTitle(page, "Todo"), "attach card");
  await expect(card.getByTestId("attachment-badge")).toHaveCount(0);
  await card.click();
  await openCardSection(page.getByRole("dialog"), "attachments");

  const dialog = page.getByRole("dialog");
  let attachmentPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/attachments$/.test(request.url())) attachmentPosts++;
  });
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const imageInput = dialog.getByTestId("image-input");
  await imageInput.setInputFiles({
    name: BLENDER_NAME,
    mimeType: BLENDER_MIME,
    buffer: BLENDER_FILE,
  });
  await expect(dialog.getByText("Choose a PNG, JPEG, GIF, or WebP image.")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Attachments", exact: true })).toBeVisible();
  await expect(dialog.getByText(BLENDER_NAME, { exact: true })).toHaveCount(0);
  expect(attachmentPosts).toBe(0);

  await imageInput.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG_1X1 });

  // The upload resolved and the editor spliced the Markdown at the caret.
  await expect(dialog.getByLabel("Card description")).toHaveValue(
    /!\[photo\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/,
  );

  // The same upload is a first-class attachment, not just a description string.
  await expect(dialog.getByRole("heading", { name: "Attachments 1" })).toBeVisible();
  await expect(
    dialog
      .getByTestId("card-sidebar")
      .getByRole("listitem")
      .getByText("photo.png", { exact: true }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Preview description" }).click();
  const embedded = dialog.getByTestId("description-view").locator("img");
  await expect(embedded).toHaveAttribute("src", /\/attachments\//);

  // Embedded card attachment image renders inside a preview button and opens the fullscreen viewer.
  const previewButton = dialog
    .getByTestId("description-view")
    .getByRole("button", { name: /Preview attachment photo\./ });
  await expect(previewButton).toBeVisible();
  await previewButton.click();

  // Fullscreen image viewer opens and reflects in URL search param.
  const viewerDialog = page.getByRole("dialog", { name: "photo.png" });
  await expect(viewerDialog).toBeVisible();
  await expect(page).toHaveURL(/attachment=[0-9a-f-]+/);

  // Escape closes the viewer while keeping the card modal open and non-editing.
  await page.keyboard.press("Escape");
  await expect(viewerDialog).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Card description")).not.toBeVisible();
  await expect(dialog.getByTestId("description-view")).toBeVisible();

  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByTestId("attachment-badge")).toHaveText("1");
  await expect(card.getByTestId("attachment-badge")).toHaveAttribute("aria-label", "1 attachment");

  // Reopen: the embed survives, preview works again, and the bytes really come back over HTTP.
  await card.click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const reopenedEmbedded = dialog.getByTestId("description-view").locator("img");
  const src = await reopenedEmbedded.getAttribute("src");
  expect(src).not.toBeNull();
  const served = await page.request.get(src!);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toContain("image/");

  await dialog
    .getByTestId("description-view")
    .getByRole("button", { name: /Preview attachment photo\./ })
    .click();
  await expect(page.getByRole("dialog", { name: "photo.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "photo.png" })).toHaveCount(0);

  // Edit description to include an external image and a linked attachment image.
  await dialog.getByRole("button", { name: "Edit description" }).click();
  const descTextarea = dialog.getByLabel("Card description");
  const currentDesc = await descTextarea.inputValue();
  await descTextarea.fill(
    `${currentDesc}\n\n![external image](https://example.com/external.png)\n\n[![linked photo](${src})](https://example.com/dest)`,
  );
  await dialog.getByRole("button", { name: "Preview description" }).click();

  // The external image remains plain without an interactive preview button.
  const descView = dialog.getByTestId("description-view");
  await expect(
    descView.getByRole("button", { name: "Preview attachment external.png" }),
  ).toHaveCount(0);
  const externalImg = descView.locator('img[src="https://example.com/external.png"]');
  await expect(externalImg).toBeVisible();
  await externalImg.click();
  await expect(page.getByRole("dialog", { name: "photo.png" })).toHaveCount(0);
  await expect(dialog.getByLabel("Card description")).not.toBeVisible();
  // Linked attachment image renders as an anchor without nested interactive controls.
  const linkedAnchor = descView.locator('a[href="https://example.com/dest"]');
  await expect(linkedAnchor).toBeVisible();
  await expect(linkedAnchor.locator("button")).toHaveCount(0);
  const linkedImg = linkedAnchor.locator(`img[src="${src}"]`);
  await expect(linkedImg).toBeVisible();
  await expect(linkedImg).toHaveAttribute("alt", "linked photo");
  await linkedImg.click();
  await expect(page.getByRole("dialog", { name: "photo.png" })).toHaveCount(0);
  await expect(dialog.getByLabel("Card description")).not.toBeVisible();
  expect(await linkedAnchor.getAttribute("rel")).toBe("noreferrer");
});

test("an image whose file name exceeds 200 characters is refused before upload and inserts nothing", async ({
  page,
}) => {
  await boardWithCard(page, "att-long-name", "long name card");
  await cardIn(columnByTitle(page, "Todo"), "long name card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");
  let attachmentPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/attachments$/.test(request.url())) attachmentPosts++;
  });

  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");
  const imageInput = dialog.getByTestId("image-input");
  const longName = `${"n".repeat(206)}.png`;
  expect(longName).toHaveLength(210);
  await imageInput.setInputFiles({ name: longName, mimeType: "image/png", buffer: PNG_1X1 });

  // The sidebar's upload lane reports the same error; assert the editor's own alert.
  const editorAlert = textarea.locator("xpath=ancestor::*[.//p[@role='alert']][1]").getByRole("alert");
  await expect(editorAlert).toHaveText("File name must be 200 characters or fewer.");
  await expect(textarea).toHaveValue("");
  expect(attachmentPosts).toBe(0);
  await expect(dialog.getByRole("heading", { name: "Attachments", exact: true })).toBeVisible();

  await imageInput.setInputFiles({ name: "short.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(textarea).toHaveValue(/!\[short\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/);
  await expect(dialog.getByRole("heading", { name: "Attachments 1" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await cardIn(columnByTitle(page, "Todo"), "long name card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  await expect(page.getByRole("dialog").getByTestId("description-view").locator("img")).toHaveAttribute(
    "src",
    /\/attachments\//,
  );
});

test("pasting an image into the description uploads and embeds it", async ({ page }) => {
  await boardWithCard(page, "att-paste", "paste card");

  await cardIn(columnByTitle(page, "Todo"), "paste card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");
  let attachmentPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/attachments$/.test(request.url())) attachmentPosts++;
  });
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");
  await textarea.fill("draft");

  // Unsupported clipboard files (e.g. PDF/TIFF) are left untouched: no upload,
  // preventDefault, attachment metadata, or Markdown insertion.
  await textarea.evaluate((element) => {
    const file = new File(["%PDF-1.4"], "document.pdf", {
      type: "application/pdf",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(textarea).toHaveValue("draft");
  await expect(dialog.getByRole("heading", { name: "Attachments", exact: true })).toBeVisible();
  expect(attachmentPosts).toBe(0);

  // Playwright cannot seed the OS clipboard with an image, so the supported
  // paste uses a synthetic DataTransfer — the same event React receives.
  await textarea.evaluate((element, base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const file = new File([bytes], "pasted.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, PNG_1X1.toString("base64"));

  await expect(textarea).toHaveValue(/draft!\[pasted\.\w+\]\(\/boards\//);
  await expect(
    dialog
      .getByTestId("card-sidebar")
      .getByRole("listitem")
      .getByText("pasted.png", { exact: true }),
  ).toBeVisible();
});

test("a large image is downscaled and re-encoded as webp before upload", async ({ page }) => {
  await boardWithCard(page, "att-compress", "compress card");

  await cardIn(columnByTitle(page, "Todo"), "compress card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");

  // A wide gradient: 2500px on the long side (over the 2048 cap) and noisy
  // enough that webp cannot compress it to nothing.
  const wide = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2500;
    canvas.height = 400;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 2500, 400);
    gradient.addColorStop(0, "#ff0055");
    gradient.addColorStop(0.5, "#00d0ff");
    gradient.addColorStop(1, "#ffee00");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 2500, 400);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });

  await dialog.getByTestId("attach-input").setInputFiles({
    name: "wide.png",
    mimeType: "image/png",
    buffer: Buffer.from(wide, "base64"),
  });

  // The stored name carries the re-encode, and so does what R2 serves back.
  const row = dialog.getByTestId("card-sidebar").getByText("wide.webp", { exact: false });
  await expect(row).toBeVisible();
  const src = await dialog.locator("img[alt='wide.webp']").getAttribute("src");
  expect(src).not.toBeNull();
  const served = await page.request.get(src!);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/webp");
});

test("a file attachment downloads for a member, confirms deletion and deletes live", async ({
  browser,
}) => {
  const alice = await newUser(browser, "att-sync-a");
  const { token: strangerInvite } = await generateAccountInvite(alice.page);
  const bob = await newUser(browser, "att-sync-b");

  const strangerContext = await browser.newContext();
  const strangerPage = await strangerContext.newPage();
  const strangerEmail = uniqueEmail("att-sync-c", "user.test");
  await signup(strangerPage, strangerEmail, "att-sync-c", strangerInvite);
  const stranger = { page: strangerPage, email: strangerEmail };
  const boardName = `Attach sync ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);

  await alice.page.getByRole("link", { name: boardName }).click();
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "shared card");

  await cardIn(columnByTitle(alice.page, "Todo"), "shared card").click();
  await openCardSection(alice.page.getByRole("dialog"), "attachments");
  const aliceDialog = alice.page.getByRole("dialog");

  // Bob watches the same card while Alice uploads.
  await bob.page.goto(`/board/${boardId}`);
  await cardIn(columnByTitle(bob.page, "Todo"), "shared card").click();
  await openCardSection(bob.page.getByRole("dialog"), "attachments");
  const bobDialog = bob.page.getByRole("dialog", { name: "shared card" });
  await expect(bobDialog).toBeVisible();

  await aliceDialog.getByTestId("attach-input").setInputFiles({
    name: BLENDER_NAME,
    mimeType: BLENDER_MIME,
    buffer: BLENDER_FILE,
  });

  // The download row arrives over the socket, with no reload or image element.
  const bobDownload = bobDialog.getByRole("link", {
    name: `Download attachment ${BLENDER_NAME}`,
  });
  await expect(bobDownload).toBeVisible();
  const bobRow = bobDialog
    .getByTestId("card-sidebar")
    .getByRole("listitem")
    .filter({ has: bob.page.getByRole("link", { name: `Download attachment ${BLENDER_NAME}` }) });
  await expect(bobRow.getByRole("link", { name: `Download attachment ${BLENDER_NAME}` })).toBeVisible();
  await expect(bobRow.locator("img")).toHaveCount(0);

  const href = await bobDownload.getAttribute("href");
  expect(href).not.toBeNull();
  const asMember = await bob.page.request.get(href!);
  expect(asMember.status()).toBe(200);
  expect(asMember.headers()["content-type"]).toBe("application/octet-stream");
  expect(asMember.headers()["content-disposition"]).toBe("attachment");
  expect(asMember.headers()["x-content-type-options"]).toBe("nosniff");
  expect(await asMember.body()).toEqual(BLENDER_FILE);

  // A signed-up user who is not on the board cannot read the object at all.
  const asStranger = await stranger.page.request.get(href!);
  expect(asStranger.status()).toBe(403);

  const cardUrl = bob.page.url();
  const downloadPromise = bob.page.waitForEvent("download");
  await bobDownload.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(BLENDER_NAME);
  expect(bob.page.url()).toBe(cardUrl);

  const fileId = href!.split("/").at(-1);
  expect(fileId).toBeTruthy();
  await bob.page.goto(`${cardUrl}&attachment=${fileId}`);
  await expect(bob.page).not.toHaveURL(/attachment=/);
  await expect(bob.page.getByRole("dialog", { name: BLENDER_NAME })).toHaveCount(0);
  await expect(bobDialog).toBeVisible();
  await openCardSection(bobDialog, "attachments");

  const aliceRow = aliceDialog
    .getByTestId("card-sidebar")
    .getByRole("listitem")
    .filter({ hasText: BLENDER_NAME });
  const deleteAttachment = aliceRow.getByRole("button", {
    name: `Delete attachment ${BLENDER_NAME}`,
  });

  await deleteAttachment.click();
  const confirmation = aliceRow.getByRole("group", {
    name: `Confirm delete attachment ${BLENDER_NAME}`,
  });
  await expect(confirmation).toBeVisible();
  await expect(bobRow).toBeVisible();

  await alice.page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(aliceDialog).toBeVisible();
  await expect(bobRow).toBeVisible();

  await deleteAttachment.click();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(bobRow).toBeVisible();

  await deleteAttachment.click();
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(bobRow).toHaveCount(0);
  await expect.poll(async () => (await bob.page.request.get(href!)).status()).toBe(404);

  await alice.page.context().close();
  await bob.page.context().close();
  await stranger.page.context().close();
});

test("an attachment previews fullscreen, deep-links via the URL and closes back to the card", async ({
  page,
}) => {
  await boardWithCard(page, "att-preview", "preview card");

  await cardIn(columnByTitle(page, "Todo"), "preview card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  // Two dialogs coexist once the viewer is up, so every locator here is by name.
  const dialog = page.getByRole("dialog", { name: "preview card" });
  await dialog
    .getByTestId("attach-input")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(
    dialog
      .getByTestId("card-sidebar")
      .getByRole("listitem")
      .getByText("photo.png", { exact: true }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Preview attachment photo.png" }).click();
  const viewer = page.getByRole("dialog", { name: "photo.png" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("img")).toBeVisible();
  await expect(page).toHaveURL(/attachment=/);

  // The viewer is in the URL, so a reload lands straight back in it.
  const previewUrl = page.url();
  await page.reload();
  await expect(viewer).toBeVisible();

  // Esc peels the viewer off first, leaving the card open.
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/card=/);
  await expect(page).not.toHaveURL(/attachment=/);

  // The same link pasted fresh opens the preview: it is shareable.
  await page.goto(previewUrl);
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/board\/[A-Z0-9]+$/);
});

async function uploadDescriptionImage(page: Page, name: string): Promise<string> {
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("image-input").setInputFiles({
    name,
    mimeType: "image/png",
    buffer: PNG_1X1,
  });
  const preview = attachmentRow(page, name).getByRole("button", {
    name: `Preview attachment ${name}`, exact: true,
  });
  await expect(preview).toBeVisible();
  const thumbnailUrl = await preview.locator("img").getAttribute("src");
  expect(thumbnailUrl).not.toBeNull();
  const textarea = dialog.getByLabel("Card description");
  await expect(textarea).toHaveValue(
    new RegExp(thumbnailUrl!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  const urls = (await textarea.inputValue()).match(/\/boards\/[^)\s]+\/attachments\/[0-9a-f-]+/g);
  const url = urls?.find((candidate) => candidate === thumbnailUrl);
  expect(url).toBe(thumbnailUrl);
  return url!;
}

function attachmentRow(page: Page, name: string) {
  return page.getByRole("dialog").getByTestId("card-sidebar").getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: `Preview attachment ${name}`, exact: true }) });
}

async function deleteImage(page: Page, name: string): Promise<void> {
  const row = attachmentRow(page, name);
  await row.getByRole("button", { name: `Delete attachment ${name}` }).click();
  await row.getByRole("group", { name: `Confirm delete attachment ${name}` })
    .getByRole("button", { name: "Delete", exact: true }).click();
}

async function sharedDescriptionCard(browser: Browser, suffix: string) {
  const alice = await newUser(browser, `${suffix}-a`);
  const bob = await newUser(browser, `${suffix}-b`);
  const boardName = `Description deletion ${suffix} ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);
  await alice.page.getByRole("link", { name: boardName }).click();
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "shared description");
  await cardIn(columnByTitle(alice.page, "Todo"), "shared description").click();
  await openCardSection(alice.page.getByRole("dialog"), "attachments");
  await alice.page.getByRole("dialog").getByRole("button", { name: "Add a description…" }).click();
  return { alice: alice.page, bob: bob.page, boardId };
}

test("deleting an attachment cleans both members' saved previews and exact durable source", async ({
  browser,
}) => {
  const { alice, bob, boardId } = await sharedDescriptionCard(browser, "att-clean-saved");
  try {
    const u1 = await uploadDescriptionImage(alice, "remove.png");
    const u2 = await uploadDescriptionImage(alice, "keep.png");
    const source = `Before **keep**\n\n![remove](${u1})\n\n[download](${u1})\n\n![keep](${u2})\n\nAfter`;
    const cleaned = `Before **keep**\n\n\n\ndownload\n\n![keep](${u2})\n\nAfter`;
    const aliceDialog = alice.getByRole("dialog");
    await aliceDialog.getByLabel("Card description").fill(source);
    await aliceDialog.getByRole("button", { name: "Save title & description" }).click();
    await expect(aliceDialog).toHaveCount(0);
    await cardIn(columnByTitle(alice, "Todo"), "shared description").click();
    await openCardSection(alice.getByRole("dialog"), "attachments");
    await bob.goto(`/board/${boardId}`);
    await cardIn(columnByTitle(bob, "Todo"), "shared description").click();
    await openCardSection(bob.getByRole("dialog"), "attachments");
    for (const member of [alice, bob]) {
      const view = member.getByTestId("description-view");
      await expect(view.locator(`img[src="${u1}"]`)).toBeVisible();
      await expect(view.locator(`a[href="${u1}"]`)).toHaveText("download");
    }

    await deleteImage(alice, "remove.png");
    for (const member of [alice, bob]) {
      const view = member.getByTestId("description-view");
      await expect(view.locator(`img[src="${u1}"]`)).toHaveCount(0);
      await expect(view.locator(`a[href="${u1}"]`)).toHaveCount(0);
      await expect(view).toContainText("download");
      await expect(view.locator("strong")).toHaveText("keep");
      await expect(view.locator(`img[src="${u2}"]`)).toBeVisible();
      await expect(attachmentRow(member, "remove.png")).toHaveCount(0);
      // No Save: this must have been committed with attachment.delete.
      await member.reload();
      await openDescriptionEditor(member);
      await expect(member.getByLabel("Card description")).toHaveValue(cleaned);
    }
    await expect.poll(async () => (await bob.request.get(u1)).status()).toBe(404);
    expect((await bob.request.get(u2)).status()).toBe(200);
  } finally {
    await alice.context().close();
    await bob.context().close();
  }
});

test("deleting an attachment preserves both dirty drafts while discard and Save remain independent", async ({
  browser,
}) => {
  const { alice, bob, boardId } = await sharedDescriptionCard(browser, "att-clean-dirty");
  try {
    const url = await uploadDescriptionImage(alice, "dirty.png");
    const source = `Saved before\n\n![remove](${url})\n\nSaved after`;
    const cleaned = "Saved before\n\n\n\nSaved after";
    await alice.getByLabel("Card description").fill(source);
    await alice.getByRole("button", { name: "Save title & description", exact: true }).click();
    await expect(alice.getByRole("dialog")).toHaveCount(0);
    await cardIn(columnByTitle(alice, "Todo"), "shared description").click();
    await openCardSection(alice.getByRole("dialog"), "attachments");
    await bob.goto(`/board/${boardId}`);
    await cardIn(columnByTitle(bob, "Todo"), "shared description").click();
    await openCardSection(bob.getByRole("dialog"), "attachments");
    for (const member of [alice, bob]) await openDescriptionEditor(member);
    await alice.getByLabel("Card description").fill(`Alice before\n${source}\nAlice after`);
    await alice.getByRole("button", { name: "Edit title", exact: true }).click();
    await alice.getByLabel("Card title").fill("Alice unsaved title");
    await bob.getByLabel("Card description").fill(`Bob before\n${source}\nBob after`);

    await deleteImage(alice, "dirty.png");
    await expect(alice.getByLabel("Card description")).toHaveValue(`Alice before\n${cleaned}\nAlice after`);
    await expect(bob.getByLabel("Card description")).toHaveValue(`Bob before\n${cleaned}\nBob after`);
    await expect(alice.getByLabel("Card title")).toHaveValue("Alice unsaved title");
    await alice.getByLabel("Card description").press("Escape");
    await alice.keyboard.press("Escape");
    await expect(alice.getByText("Discard unsaved changes?")).toBeVisible();
    await alice.keyboard.press("Escape");
    await expect(alice.getByRole("dialog")).toHaveCount(0);
    await alice.reload();
    await cardIn(columnByTitle(alice, "Todo"), "shared description").click();
    await openCardSection(alice.getByRole("dialog"), "attachments");
    await expect(alice.getByRole("heading", { name: "shared description", exact: true, level: 2 })).toBeVisible();
    await expect(alice.getByLabel("Card title")).toHaveCount(0);
    await openDescriptionEditor(alice);
    await expect(alice.getByLabel("Card description")).toHaveValue(cleaned);
    await bob.getByRole("button", { name: "Save title & description", exact: true }).click();
    await expect(bob.getByRole("dialog")).toHaveCount(0);
    await bob.reload();
    await cardIn(columnByTitle(bob, "Todo"), "shared description").click();
    await openCardSection(bob.getByRole("dialog"), "attachments");
    await openDescriptionEditor(bob);
    await expect(bob.getByLabel("Card description")).toHaveValue(`Bob before\n${cleaned}\nBob after`);
    await expect(bob.getByLabel("Card title")).toHaveCount(0);
  } finally {
    await alice.context().close();
    await bob.context().close();
  }
});

test("deleting an attachment cleans a never-saved upload but Cancel and Escape preserve its draft", async ({
  page,
}) => {
  await boardWithCard(page, "att-clean-unsaved", "unsaved image");
  await cardIn(columnByTitle(page, "Todo"), "unsaved image").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const url = await uploadDescriptionImage(page, "unsaved.png");
  const source = `Unsaved before\n\n![remove](${url})\n\nUnsaved after`;
  await dialog.getByLabel("Card description").fill(source);
  const row = attachmentRow(page, "unsaved.png");
  const startDelete = row.getByRole("button", { name: "Delete attachment unsaved.png" });
  const confirmation = row.getByRole("group", { name: "Confirm delete attachment unsaved.png" });
  await startDelete.click();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(dialog.getByLabel("Card description")).toHaveValue(source);
  await startDelete.click();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(dialog.getByLabel("Card description")).toHaveValue(source);
  expect((await page.request.get(url)).status()).toBe(200);

  await deleteImage(page, "unsaved.png");
  await expect(dialog.getByLabel("Card description")).toHaveValue("Unsaved before\n\n\n\nUnsaved after");
  await expect(row).toHaveCount(0);
  await dialog.getByLabel("Card description").press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await cardIn(columnByTitle(page, "Todo"), "unsaved image").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  await expect(dialog.getByRole("button", { name: "Add a description…" })).toBeVisible();
  await expect(attachmentRow(page, "unsaved.png")).toHaveCount(0);
});

for (const outcome of ["rejection", "timeout", "lost echo"] as const) {
  test(`deleting an attachment gates keyboard Save during ${outcome} and reconciles the draft`, async ({
    page,
  }) => {
    let targetId: string | undefined;
    let mutationId: string | undefined;
    let echoHeld = false;
    let cardUpdates = 0;
    let snapshots = 0;
    let rejectDelete: (() => void) | undefined;
    let disconnect: (() => Promise<void>) | undefined;
    // Install before navigation; connect to the real board and forward every
    // ordinary frame explicitly in both directions.
    await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.type === "card.update") cardUpdates++;
        if (frame.type === "attachment.delete" && frame.id === targetId && !mutationId) {
          mutationId = frame.mutationId;
          rejectDelete = () => ws.send(JSON.stringify({
            type: "error", mutationId: frame.mutationId, message: "test rejection",
          }));
          disconnect = async () => {
            await ws.close({ code: 1012, reason: "test lost echo reconnect" });
            await server.close({ code: 1012, reason: "test lost echo reconnect" });
          };
          if (outcome === "lost echo") server.send(message);
          return;
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.type === "snapshot") snapshots++;
        if (outcome === "lost echo" && frame.type === "attachment.delete" &&
          frame.mutationId === mutationId) {
          echoHeld = true;
          return;
        }
        ws.send(message);
      });
    });
    await boardWithCard(page, `att-clean-${outcome.replace(" ", "-")}`, "pending image");
    await cardIn(columnByTitle(page, "Todo"), "pending image").click();
    await openCardSection(page.getByRole("dialog"), "attachments");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add a description…" }).click();
    const url = await uploadDescriptionImage(page, "pending.png");
    const source = `Before\n\n![remove](${url})\n\nAfter`;
    await dialog.getByLabel("Card description").fill(source);
    await dialog.getByRole("button", { name: "Save title & description", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await cardIn(columnByTitle(page, "Todo"), "pending image").click();
    await openCardSection(page.getByRole("dialog"), "attachments");
    await openDescriptionEditor(dialog);
    targetId = url.split("/").at(-1);
    const deleteStartedAt = Date.now();
    await deleteImage(page, "pending.png");
    await expect.poll(() => mutationId).toBeTruthy();
    await expect(dialog.getByText("Deleting attachment…", { exact: true })).toBeVisible();
    const save = dialog.getByRole("button", { name: "Save title & description", exact: true });
    const textarea = dialog.getByLabel("Card description");
    await textarea.fill(`${source}\n`);
    await textarea.pressSequentially("More prose while pending");
    const draft = `${source}\nMore prose while pending`;
    await expect(textarea).toHaveValue(draft);
    await expect(save).toBeDisabled();
    const updatesBeforeKeyboardSave = cardUpdates;
    await textarea.press("ControlOrMeta+Enter");
    await expect(dialog).toBeVisible();
    await expect(save).toBeDisabled();
    expect(cardUpdates).toBe(updatesBeforeKeyboardSave);

    if (outcome === "rejection") {
      rejectDelete!();
    } else if (outcome === "lost echo") {
      await expect.poll(() => echoHeld).toBe(true);
      const previousSnapshots = snapshots;
      await disconnect!();
      await expect.poll(() => snapshots).toBeGreaterThan(previousSnapshots);
    }
    // Timeout deliberately exercises the real five-second rollback, not a clock
    // mock or sleep. Other outcomes settle through the error/snapshot frame.
    await expect(save).toBeEnabled({ timeout: 10_000 });
    await expect(dialog.getByText("Deleting attachment…", { exact: true })).toHaveCount(0);
    if (outcome === "timeout") expect(Date.now() - deleteStartedAt).toBeGreaterThanOrEqual(5_000);
    const expected = outcome === "lost echo"
      ? "Before\n\n\n\nAfter\nMore prose while pending"
      : draft;
    await expect(textarea).toHaveValue(expected);
    if (outcome === "lost echo") {
      await expect(attachmentRow(page, "pending.png")).toHaveCount(0);
      await expect.poll(async () => (await page.request.get(url)).status()).toBe(404);
    } else {
      await expect(attachmentRow(page, "pending.png")).toBeVisible();
      expect((await page.request.get(url)).status()).toBe(200);
    }
    await textarea.press("ControlOrMeta+Enter");
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await cardIn(columnByTitle(page, "Todo"), "pending image").click();
    await openCardSection(page.getByRole("dialog"), "attachments");
    await openDescriptionEditor(dialog);
    await expect(dialog.getByLabel("Card description")).toHaveValue(expected);
  });
}

/** Hold only the selected own delete; all other traffic stays real. */
async function holdOwnAttachmentDelete(page: Page) {
  const control = {
    targetId: "",
    mutationId: "",
    startedAt: 0,
    peerAccepted: false,
    reject: async (): Promise<void> => { throw new Error("No attachment deletion is held"); },
  };
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "attachment.delete" && frame.id === control.targetId &&
        !control.mutationId) {
        control.mutationId = frame.mutationId;
        control.startedAt = Date.now();
        control.reject = async () => {
          const received = page.waitForEvent("console", (message) =>
            message.text().includes("test held deletion rejected"));
          ws.send(JSON.stringify({
            type: "error", mutationId: frame.mutationId, message: "test held deletion rejected",
          }));
          await received;
        };
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "attachment.delete" && frame.id === control.targetId &&
        frame.mutationId !== control.mutationId) control.peerAccepted = true;
      ws.send(message);
    });
  });
  return control;
}

for (const outcome of ["rejection", "timeout"] as const) {
  test(`deleting an attachment by a peer permanently settles a held own deletion before ${outcome}`, async ({
    browser,
  }) => {
    const { alice, bob, boardId } = await sharedDescriptionCard(browser, `att-peer-${outcome}`);
    try {
      const url = await uploadDescriptionImage(alice, "contested.png");
      const source = `Before\n\n![remove](${url})\n\nAfter`;
      const cleaned = "Before\n\n\n\nAfter";
      await alice.getByLabel("Card description").fill(source);
      await alice.getByRole("button", { name: "Save title & description", exact: true }).click();
      await expect(alice.getByRole("dialog")).toHaveCount(0);
      const control = await holdOwnAttachmentDelete(alice);
      control.targetId = url.split("/").at(-1)!;
      // Routing applies to the next connection, not the already-open socket.
      await alice.reload();
    await cardIn(columnByTitle(alice, "Todo"), "shared description").click();
    await openCardSection(alice.getByRole("dialog"), "attachments");
    await openDescriptionEditor(alice);
    await bob.goto(`/board/${boardId}`);
      await cardIn(columnByTitle(bob, "Todo"), "shared description").click();
      await openCardSection(bob.getByRole("dialog"), "attachments");
      await expect(attachmentRow(bob, "contested.png")).toBeVisible();
      await deleteImage(alice, "contested.png");
      await expect.poll(() => control.mutationId).not.toBe("");
      await alice.getByLabel("Card description").fill(`${source}\nDraft while delete is pending`);
      const save = alice.getByRole("dialog").getByRole("button", { name: "Save title & description", exact: true });
      await expect(save).toBeDisabled();
      await expect(alice.getByText("Deleting attachment…", { exact: true })).toBeVisible();

      await deleteImage(bob, "contested.png");
      await expect.poll(() => control.peerAccepted).toBe(true);
      // This must release on acceptance, before the held operation can time out.
      await expect(alice.getByText("Deleting attachment…", { exact: true })).toHaveCount(0, {
        timeout: 2_000,
      });
      await alice.getByLabel("Card description").fill(`${cleaned}\nUnsaved after acceptance`);
      await expect(save).toBeEnabled();
      expect(Date.now() - control.startedAt).toBeLessThan(5_000);
      if (outcome === "rejection") {
        await control.reject();
      } else {
        // Cross the real rollback deadline without mocking the application clock.
        await expect.poll(() => Date.now() - control.startedAt, {
          timeout: 10_000,
        }).toBeGreaterThanOrEqual(5_500);
      }
      await expect(attachmentRow(alice, "contested.png")).toHaveCount(0);
      await expect(alice.getByLabel("Card description")).toHaveValue(
        `${cleaned}\nUnsaved after acceptance`,
      );
      await expect(save).toBeEnabled();
      await alice.getByRole("button", { name: "Close card", exact: true }).click();
      await expect(alice.getByText("Discard unsaved changes?")).toBeVisible();
      await alice.keyboard.press("Escape");
      await expect(alice.getByRole("dialog")).toHaveCount(0);
      // Do not reload: a fresh mount must agree with this session's query cache.
      await cardIn(columnByTitle(alice, "Todo"), "shared description").click();
      await openCardSection(alice.getByRole("dialog"), "attachments");
      await expect(attachmentRow(alice, "contested.png")).toHaveCount(0);
      await openDescriptionEditor(alice);
      await expect(alice.getByLabel("Card description")).toHaveValue(cleaned);
    } finally {
      await alice.context().close();
      await bob.context().close();
    }
  });
}

test("deleting an attachment then reopening before rejection preserves the saved reference and new prose", async ({
  page,
}) => {
  const control = await holdOwnAttachmentDelete(page);
  await boardWithCard(page, "att-reopen-reject", "reopened image");
  await cardIn(columnByTitle(page, "Todo"), "reopened image").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const url = await uploadDescriptionImage(page, "reopened.png");
  const source = `Before\n\n![retain](${url})\n\nAfter`;
  await dialog.getByLabel("Card description").fill(source);
  await dialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await cardIn(columnByTitle(page, "Todo"), "reopened image").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  control.targetId = url.split("/").at(-1)!;
  await deleteImage(page, "reopened.png");
  await expect.poll(() => control.mutationId).not.toBe("");
  await expect(dialog.getByText("Deleting attachment…", { exact: true })).toBeVisible();
  // The untouched description follows the optimistically cleaned card, so
  // there is no draft to discard and Close closes directly.
  await dialog.getByRole("button", { name: "Close card", exact: true }).click();
  await expect(dialog.getByText("Discard unsaved changes?")).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await cardIn(columnByTitle(page, "Todo"), "reopened image").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  await openDescriptionEditor(dialog);
  const textarea = dialog.getByLabel("Card description");
  // Append to the actual mount seed; never fill the reference back in ourselves.
  await textarea.press("ControlOrMeta+A");
  await textarea.press("ArrowRight");
  await textarea.press("Enter");
  await textarea.pressSequentially("New prose after reopening");
  await expect(dialog.getByRole("button", { name: "Save title & description", exact: true })).toBeDisabled();
  await control.reject();
  const expected = `${source}\nNew prose after reopening`;
  await expect(textarea).toHaveValue(expected);
  await expect(attachmentRow(page, "reopened.png")).toBeVisible();
  await expect(dialog.getByText("Deleting attachment…", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await cardIn(columnByTitle(page, "Todo"), "reopened image").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  await openDescriptionEditor(dialog);
  await expect(dialog.getByLabel("Card description")).toHaveValue(expected);
  await expect(attachmentRow(page, "reopened.png")).toBeVisible();
  expect((await page.request.get(url)).status()).toBe(200);
});
async function inspectDecodedImage(
  page: Page,
  url: string,
  samplePoints?: { x: number; y: number }[],
): Promise<{
  naturalWidth: number;
  naturalHeight: number;
  pixels: Record<string, [number, number, number, number]>;
}> {
  return page.evaluate(
    async ({ src, points }) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image failed to load: " + src));
        img.src = src;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not get 2d context");
      ctx.drawImage(img, 0, 0);

      const pixels: Record<string, [number, number, number, number]> = {};
      if (points) {
        for (const pt of points) {
          const d = ctx.getImageData(pt.x, pt.y, 1, 1).data;
          pixels[`${pt.x},${pt.y}`] = [d[0], d[1], d[2], d[3]];
        }
      }
      return {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        pixels,
      };
    },
    { src: url, points: samplePoints },
  );
}

test("SVG file paste creates a WebP description image with decoded geometry, dimensions and transparency", async ({
  page,
  browser,
}) => {
  await boardWithCard(page, "att-svg-paste", "svg paste card");
  await cardIn(columnByTitle(page, "Todo"), "svg paste card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");

  let attachmentPosts = 0;
  let lastContentType: string | null = null;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/attachments$/.test(request.url())) {
      attachmentPosts++;
      lastContentType = request.headers()["content-type"] ?? null;
    }
  });

  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");
  await textarea.fill("Prefix ");

  // Paste an SVG file with colored geometry and transparency (100x100 green rect, red circle, transparent corners)
  const svgContent =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="#22c55e"/><circle cx="50" cy="50" r="30" fill="#ef4444"/></svg>';

  await textarea.evaluate((element, svg) => {
    const file = new File([svg], "graphic.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, svgContent);

  await expect(textarea).toHaveValue(/Prefix !\[graphic\.webp\]\((\/boards\/[^)]+\/attachments\/[^)]+)\)/);
  expect(attachmentPosts).toBe(1);
  expect(lastContentType).toBe("image/webp");

  // Extract attachment URL and verify actual WebP bytes (RIFF .... WEBP) from the uploaded resource
  const match = (await textarea.inputValue()).match(/\/boards\/[^)]+\/attachments\/[^)]+/);
  expect(match).not.toBeNull();
  const uploadedUrl = match![0];
  const initialServed = await page.request.get(uploadedUrl);
  expect(initialServed.status()).toBe(200);
  expect(initialServed.headers()["content-type"]).toBe("image/webp");
  const initialBytes = await initialServed.body();
  expect(initialBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(initialBytes.subarray(8, 12).toString("ascii")).toBe("WEBP");

  // Verify decoded pixel dimensions, rendered colored geometry, and transparency via canvas in page context
  const pixelAnalysis = await page.evaluate(async (url) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Image failed to load"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context");
    ctx.drawImage(img, 0, 0);

    // Corner (0, 0) should be transparent (alpha == 0)
    const corner = ctx.getImageData(0, 0, 1, 1).data;
    // Center (50, 50) should be red circle (R > 200, G < 100, B < 100, alpha == 255)
    const center = ctx.getImageData(50, 50, 1, 1).data;
    // Inside rect but outside circle (15, 15) should be green (R < 100, G > 150, B < 100, alpha == 255)
    const rectPoint = ctx.getImageData(15, 15, 1, 1).data;

    return {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      cornerAlpha: corner[3],
      centerR: center[0],
      centerG: center[1],
      centerB: center[2],
      centerAlpha: center[3],
      rectR: rectPoint[0],
      rectG: rectPoint[1],
      rectB: rectPoint[2],
      rectAlpha: rectPoint[3],
    };
  }, uploadedUrl);

  expect(pixelAnalysis.naturalWidth).toBe(100);
  expect(pixelAnalysis.naturalHeight).toBe(100);
  expect(pixelAnalysis.cornerAlpha).toBe(0); // transparent
  expect(pixelAnalysis.centerR).toBeGreaterThan(200); // red circle
  expect(pixelAnalysis.centerG).toBeLessThan(100);
  expect(pixelAnalysis.centerAlpha).toBe(255);
  expect(pixelAnalysis.rectG).toBeGreaterThan(150); // green rect
  expect(pixelAnalysis.rectR).toBeLessThan(100);
  expect(pixelAnalysis.rectAlpha).toBe(255);

  await expect(
    dialog.getByTestId("card-sidebar").getByRole("listitem").getByText("graphic.webp", { exact: true }),
  ).toBeVisible();

  // Preview and check the rendered draft description
  await dialog.getByRole("button", { name: "Preview description" }).click();
  const descView = dialog.getByTestId("description-view");
  const embeddedImg = descView.locator("img");
  await expect(embeddedImg).toBeVisible();
  const src = await embeddedImg.getAttribute("src");
  expect(src).not.toBeNull();

  // Save card, then verify second user sees and decodes the persisted WebP attachment
  await dialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Second-member verification: load board with second user / fresh session and verify rendered WebP geometry
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  try {
    await signup(secondPage, uniqueEmail("att-svg-bob"), "Bob Reviewer");
    const currentUrl = page.url();
    await secondPage.goto(currentUrl);
    await cardIn(columnByTitle(secondPage, "Todo"), "svg paste card").click();
    await openCardSection(secondPage.getByRole("dialog"), "attachments");
    const secondDialog = secondPage.getByRole("dialog");
    const secondImg = secondDialog.getByTestId("description-view").locator("img");
    await expect(secondImg).toBeVisible();
    const secondSrc = await secondImg.getAttribute("src");
    expect(secondSrc).toBe(uploadedUrl);

    const secondAnalysis = await secondPage.evaluate(async (url) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image failed to load"));
        img.src = url;
      });
      return { width: img.naturalWidth, height: img.naturalHeight };
    }, secondSrc!);
    expect(secondAnalysis.width).toBe(100);
    expect(secondAnalysis.height).toBe(100);
  } finally {
    await secondContext.close();
  }
});

test("SVG clipboard variants: whole plain text, MIME string, empty-MIME file, mixed clipboard, prose preservation, and download isolation", async ({
  page,
  context,
}) => {
  await boardWithCard(page, "att-svg-variants", "svg variants card");
  await cardIn(columnByTitle(page, "Todo"), "svg variants card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");

  let attachmentPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/attachments$/.test(request.url())) attachmentPosts++;
  });

  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");
  const saveBtn = dialog.getByRole("button", { name: "Save title & description", exact: true });
  // 1. Whole SVG plain text with XML declaration and comments and viewBox-only
  const svgWithXmlDecl =
    '<?xml version="1.0" encoding="UTF-8"?>\n<!-- leading comment -->\n<svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20" fill="blue"/></svg>\n<!-- trailing comment -->';
  await textarea.evaluate((element, text) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, svgWithXmlDecl);
  await expect(textarea).toHaveValue(/!\[pasted\.webp\]\(\/boards\//);
  await expect.poll(() => attachmentPosts).toBe(1);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  await expect(dialog.getByTestId("card-sidebar").getByRole("listitem").getByText("pasted.webp", { exact: true })).toBeVisible();
  // 2. Mixed clipboard payload: SVG file + PNG file -> SVG wins, exactly one attachment POST
  await textarea.fill("Dual test: ");
  await textarea.evaluate((element) => {
    const svgFile = new File(['<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'], "dual.svg", {
      type: "image/svg+xml",
    });
    const pngFile = new File([new Uint8Array([1, 2, 3])], "dual.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [svgFile, pngFile],
        items: [],
        types: ["Files"],
        getData: () => "",
      },
      enumerable: true,
    });
    element.dispatchEvent(event);
  });
  await expect(textarea).toHaveValue(/^Dual test: !\[dual\.webp\]/);
  await expect.poll(() => attachmentPosts).toBe(2);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  await expect(dialog.getByTestId("card-sidebar").getByRole("listitem").getByText("dual.webp", { exact: true })).toBeVisible();
  // Explicitly clear textarea or prefix so value assertion waits for THIS paste's new Markdown embed
  await textarea.fill("Mime test: ");
  await textarea.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData("image/svg+xml", '<svg viewBox="0 0 10 10"><circle r="5"/></svg>');
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(textarea).toHaveValue(/^Mime test: !\[pasted\.webp\]/);
  await expect.poll(() => attachmentPosts).toBe(3);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  await textarea.evaluate((element) => {
    const emptyMimeSvg = new File(['<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'], "untyped.svg", {
      type: "",
    });
    const transfer = new DataTransfer();
    transfer.items.add(emptyMimeSvg);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(textarea).toHaveValue(/untyped\.webp/);
  await expect.poll(() => attachmentPosts).toBe(4);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  await expect(dialog.getByTestId("card-sidebar").getByRole("listitem").getByText("untyped.webp", { exact: true })).toBeVisible();
  // Explicit application/octet-stream .svg file is NOT treated as SVG (only empty MIME is normalized)
  await textarea.evaluate((element) => {
    const octetSvg = new File(['<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'], "binary.svg", {
      type: "application/octet-stream",
    });
    const transfer = new DataTransfer();
    transfer.items.add(octetSvg);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  // Should not trigger attachment POST
  expect(attachmentPosts).toBe(4);

  // 5. Valid whole SVG variants: quoted attributes containing '>' and legal closing whitespace </svg >
  await textarea.evaluate((element) => {
    const validWithClosingSpace =
      '<svg xmlns="http://www.w3.org/2000/svg" aria-label="hello > world" width="20" height="20"><rect width="20" height="20"/></svg  >';
    const transfer = new DataTransfer();
    transfer.setData("text/plain", validWithClosingSpace);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect.poll(() => attachmentPosts).toBe(5);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);

  // 5b. Whole SVG with processing instruction inside root -> converts to WebP
  await textarea.fill("PI test: ");
  await textarea.evaluate((element) => {
    const piSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><?note x?><rect width="10" height="10"/></svg>';
    const transfer = new DataTransfer();
    transfer.setData("text/plain", piSvg);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(textarea).toHaveValue(/^PI test: !\[pasted\.webp\]/);
  await expect.poll(() => attachmentPosts).toBe(6);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  // 6. Real native clipboard paste with grantPermissions for native prose, fenced code, and completed SVG + prose
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const trailingProseWithPi = '<svg width="10" height="10"><?note x?><rect/></svg> trailing notes';
  await page.evaluate((text) => navigator.clipboard.writeText(text), trailingProseWithPi);
  await textarea.focus();
  // Native paste via keyboard shortcut
  const isMac = process.platform === "darwin";
  const modifier = isMac ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+v`);
  await expect(textarea).toContainText(trailingProseWithPi);
  // Post count unchanged (no upload)
  expect(attachmentPosts).toBe(6);
  // Fenced code block containing SVG
  const fencedSvg = "```xml\n<svg viewBox='0 0 10 10'><circle r='5'/></svg>\n```";
  await page.evaluate((text) => navigator.clipboard.writeText(text), fencedSvg);
  await page.keyboard.press(`${modifier}+v`);
  await expect(textarea).toContainText(fencedSvg);
  expect(attachmentPosts).toBe(6);

  // 7. General SVG download isolation: general attachment upload of raw SVG remains download-only
  const generalFileInput = dialog.getByTestId("attach-input");
  const rawSvgBuffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>');
  await generalFileInput.setInputFiles({
    name: "raw-vector.svg",
    mimeType: "image/svg+xml",
    buffer: rawSvgBuffer,
  });
  // Triggers general attachment upload
  await expect.poll(() => attachmentPosts).toBe(7);
  const generalItem = dialog.getByTestId("card-sidebar").getByRole("listitem").filter({ hasText: "raw-vector.svg" });
  await expect(generalItem).toBeVisible();
  // Raw SVG attachments do not have preview button / modal preview in policy
  await expect(generalItem.getByRole("button", { name: "Preview" })).toHaveCount(0);
  const downloadLink = generalItem.getByRole("link", { name: "Download attachment raw-vector.svg" });
  await expect(downloadLink).toBeVisible();
  const downloadHref = await downloadLink.getAttribute("href");
  expect(downloadHref).not.toBeNull();
  const downloadResponse = await page.request.get(downloadHref!);
  expect(downloadResponse.status()).toBe(200);
  expect(downloadResponse.headers()["content-disposition"]).toBe("attachment");
  expect(downloadResponse.headers()["content-type"]).toBe("application/octet-stream");
  expect(await downloadResponse.body()).toEqual(rawSvgBuffer);
});

test("SVG security, sizing geometry, namespace normalization, and boundary rejections", async ({
  page,
}) => {
  await boardWithCard(page, "att-svg-sec", "svg sec card");
  await cardIn(columnByTitle(page, "Todo"), "svg sec card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");

  let attachmentPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/attachments$/.test(request.url())) attachmentPosts++;
  });

  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");
  const saveBtn = dialog.getByRole("button", { name: "Save title & description", exact: true });
  await textarea.fill("Safe initial draft");

  // 1. External font, stylesheet, and image references + script execution prevention
  let externalRequests = 0;
  page.on("request", (req) => {
    if (req.url().includes("malicious-external-domain.test")) {
      externalRequests++;
    }
  });

  await textarea.evaluate((element) => {
    window.__svgScriptRan = false;
    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <defs>
        <style>
          @import url("https://malicious-external-domain.test/font.css");
          @font-face { font-family: "RemoteFont"; src: url("https://malicious-external-domain.test/font.woff2"); }
        </style>
      </defs>
      <script>window.__svgScriptRan = true;</script>
      <image href="https://malicious-external-domain.test/leak.png"/>
      <text x="10" y="50" font-family="RemoteFont">Safe &amp; &lt;escaped&gt; &quot;text&quot;</text>
      <rect width="100" height="100" fill="purple" onload="window.__svgScriptRan = true;"/>
    </svg>`;
    const file = new File([maliciousSvg], "security.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });

  // Upload succeeds as image-context conversion, but script did not execute and external request was not made
  await expect(textarea).toHaveValue(/security\.webp/);
  expect(externalRequests).toBe(0);
  const scriptRan = await page.evaluate(() => window.__svgScriptRan);
  expect(scriptRan).toBe(false);
  await expect.poll(() => attachmentPosts).toBe(1);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  await expect(dialog.getByTestId("card-sidebar").getByRole("listitem").getByText("security.webp", { exact: true })).toBeVisible();

  // 2. DOCTYPE and ENTITY declarations -> reject before decode
  await textarea.evaluate((element) => {
    const xxe = '<!DOCTYPE svg [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><svg>&xxe;</svg>';
    const file = new File([xxe], "xxe.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(dialog.getByRole("alert")).toHaveText(
    "Could not convert SVG to WebP. Try copying a self-contained SVG again.",
  );
  expect(attachmentPosts).toBe(1);

  // Commented DOCTYPE / CDATA should NOT be rejected as a declaration
  await textarea.evaluate((element) => {
    const commentedDoctype =
      '<!-- <!DOCTYPE svg> --><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';
    const file = new File([commentedDoctype], "commented.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(textarea).toHaveValue(/commented\.webp/);
  await expect.poll(() => attachmentPosts).toBe(2);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  await expect(dialog.getByTestId("card-sidebar").getByRole("listitem").getByText("commented.webp", { exact: true })).toBeVisible();

  // 3. Oversized SVG > 10MB -> reject with max 10 MB error
  await textarea.evaluate((element) => {
    const hugeHeader = '<svg viewBox="0 0 10 10">';
    const hugeFooter = "</svg>";
    const padding = " ".repeat(10 * 1024 * 1024 + 100);
    const file = new File([hugeHeader + padding + hugeFooter], "huge.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(dialog.getByRole("alert")).toHaveText("SVG is too large (max 10 MB).");
  expect(attachmentPosts).toBe(2);

  // 4. Malformed XML and root non-svg -> reject
  await textarea.evaluate((element) => {
    const nonSvg = '<div xmlns="http://www.w3.org/1999/xhtml"><p>hello</p></div>';
    const file = new File([nonSvg], "notsvg.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(dialog.getByRole("alert")).toHaveText(
    "Could not convert SVG to WebP. Try copying a self-contained SVG again.",
  );
  expect(attachmentPosts).toBe(2);

  // 5. Strict dimension, viewBox grammar, and explicit invalid namespace rejections:
  // malformed viewBox grammar, malformed dimension syntax/units, and explicit foreign namespaces all reject
  const invalidSvgSnippets = [
    'viewBox="0 0 0x10 10"',
    'viewBox=",0 0 10 10,"',
    'viewBox="0,,0,10,10"',
    'width="100em"',
    'width="abc"',
    'width="-50"',
    'width="0"',
    'width="10.20.30"',
    'xmlns="http://www.w3.org/1999/xhtml" width="50" height="50"',
    'xmlns="urn:custom-namespace" width="50" height="50"',
  ];
  for (const snippet of invalidSvgSnippets) {
    await textarea.evaluate((element, attr) => {
      const invalidSvg = `<svg ${attr}><rect/></svg>`;
      const file = new File([invalidSvg], "invalid-grammar.svg", { type: "image/svg+xml" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    }, snippet);
    await expect(dialog.getByRole("alert")).toHaveText(
      "Could not convert SVG to WebP. Try copying a self-contained SVG again.",
    );
  }
  expect(attachmentPosts).toBe(2);

  // 5b. Valid viewBox separator variants (spaces, single commas, mixed) and nonzero origins
  await textarea.evaluate((element) => {
    const validSepSvg = '<svg viewBox="-10 -10, 50, 50"><rect x="-10" y="-10" width="50" height="50" fill="#06b6d4"/></svg>';
    const file = new File([validSepSvg], "valid-sep.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(textarea).toHaveValue(/valid-sep\.webp/);
  await expect.poll(() => attachmentPosts).toBe(3);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  const validSepMatch = (await textarea.inputValue()).match(/\/boards\/[^)]+\/attachments\/[0-9a-f-]+(?=\))/g);
  const validSepUrl = validSepMatch ? validSepMatch[validSepMatch.length - 1] : "";
  const validSepAnalysis = await inspectDecodedImage(page, validSepUrl, [{ x: 25, y: 25 }]);
  expect(validSepAnalysis.naturalWidth).toBe(50);
  expect(validSepAnalysis.naturalHeight).toBe(50);
  const validSepPx = validSepAnalysis.pixels["25,25"];
  expect(validSepPx[0]).toBeLessThan(50); // cyan R
  expect(validSepPx[1]).toBeGreaterThan(150); // cyan G
  expect(validSepPx[2]).toBeGreaterThan(150); // cyan B
  expect(validSepPx[3]).toBe(255); // fully opaque (proves nonzero-origin geometry was not clipped away)

  // 5c. Width-only with viewBox derives height proportionally via aspect ratio
  await textarea.evaluate((element) => {
    const widthOnlySvg = '<svg width="200" viewBox="0 0 100 50"><rect width="100" height="50" fill="#0d9488"/></svg>';
    const file = new File([widthOnlySvg], "width-only.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(textarea).toHaveValue(/width-only\.webp/);
  await expect.poll(() => attachmentPosts).toBe(4);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  const widthOnlyMatch = (await textarea.inputValue()).match(/\/boards\/[^)]+\/attachments\/[0-9a-f-]+(?=\))/g);
  const widthOnlyUrl = widthOnlyMatch ? widthOnlyMatch[widthOnlyMatch.length - 1] : "";
  const widthOnlyAnalysis = await inspectDecodedImage(page, widthOnlyUrl, [{ x: 100, y: 50 }]);
  expect(widthOnlyAnalysis.naturalWidth).toBe(200);
  expect(widthOnlyAnalysis.naturalHeight).toBe(100); // 2:1 aspect ratio derived from viewBox 100 50
  const widthOnlyPx = widthOnlyAnalysis.pixels["100,50"];
  expect(widthOnlyPx[0]).toBeLessThan(50); // teal R
  expect(widthOnlyPx[1]).toBeGreaterThan(100); // teal G
  expect(widthOnlyPx[2]).toBeGreaterThan(100); // teal B
  expect(widthOnlyPx[3]).toBe(255);

  // 6. Namespace normalization on namespace-less SVG with leading comment:
  // child element renders inside inserted SVG namespace
  await textarea.evaluate((element) => {
    const namespaceless =
      '<!-- <svg example> --><svg width="30" height="30"><rect width="30" height="30" fill="#3b82f6"/></svg>';
    const file = new File([namespaceless], "namespaceless.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(textarea).toHaveValue(/namespaceless\.webp/);
  await expect.poll(() => attachmentPosts).toBe(5);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  await expect(dialog.getByTestId("card-sidebar").getByRole("listitem").getByText("namespaceless.webp", { exact: true })).toBeVisible();
  const namespacelessMatch = (await textarea.inputValue()).match(/\/boards\/[^)]+\/attachments\/[0-9a-f-]+(?=\))/g);
  const namespacelessUrl = namespacelessMatch ? namespacelessMatch[namespacelessMatch.length - 1] : "";
  const namespacelessAnalysis = await inspectDecodedImage(page, namespacelessUrl, [{ x: 15, y: 15 }]);
  expect(namespacelessAnalysis.naturalWidth).toBe(30);
  expect(namespacelessAnalysis.naturalHeight).toBe(30);
  const namespacelessPx = namespacelessAnalysis.pixels["15,15"];
  expect(namespacelessPx[0]).toBeLessThan(100); // blue R
  expect(namespacelessPx[1]).toBeLessThan(160); // blue G
  expect(namespacelessPx[2]).toBeGreaterThan(200); // blue B
  expect(namespacelessPx[3]).toBe(255); // opaque blue proves child <rect> rendered in SVG namespace

  // 7. Oversized SVG without viewBox: distinguishable far-edge geometry proves scaling rather than clipping
  await textarea.evaluate((element) => {
    const oversizedWithFarEdge =
      '<svg width="4000" height="2000"><rect x="3800" y="1800" width="200" height="200" fill="#e11d48"/></svg>';
    const file = new File([oversizedWithFarEdge], "oversized.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(textarea).toHaveValue(/oversized\.webp/);
  await expect.poll(() => attachmentPosts).toBe(6);
  await expect(saveBtn).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  await expect(dialog.getByTestId("card-sidebar").getByRole("listitem").getByText("oversized.webp", { exact: true })).toBeVisible();
  const oversizedMatch = (await textarea.inputValue()).match(/\/boards\/[^)]+\/attachments\/[0-9a-f-]+(?=\))/g);
  const oversizedUrl = oversizedMatch ? oversizedMatch[oversizedMatch.length - 1] : "";
  const oversizedAnalysis = await inspectDecodedImage(page, oversizedUrl, [{ x: 10, y: 10 }, { x: 1990, y: 970 }]);
  expect(oversizedAnalysis.naturalWidth).toBe(2048);
  expect(oversizedAnalysis.naturalHeight).toBe(1024);
  // Top-left is empty (transparent, alpha == 0)
  expect(oversizedAnalysis.pixels["10,10"][3]).toBe(0);
  // Far bottom-right edge contains the red rect scaled into the 2048x1024 output (alpha == 255, red R > 200)
  const farEdgePx = oversizedAnalysis.pixels["1990,970"];
  expect(farEdgePx[0]).toBeGreaterThan(200); // red R
  expect(farEdgePx[1]).toBeLessThan(100);
  expect(farEdgePx[2]).toBeLessThan(100);
  expect(farEdgePx[3]).toBe(255); // proves geometry at (3800, 1800) was scaled into canvas, not clipped away

  // 7b. Root CSS dimension override cannot defeat 2048px maximum edge cap
  await textarea.evaluate((element) => {
    const rootCssOverride =
      '<svg width="4000" height="2000" style="width: 6000px !important; height: 3000px !important;"><rect width="4000" height="2000" fill="#84cc16"/></svg>';
    const file = new File([rootCssOverride], "root-css-override.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(textarea).toHaveValue(/root-css-override\.webp/);
  await expect.poll(() => attachmentPosts).toBe(7);
  await expect(saveBtn).toBeEnabled();
  const rootCssMatch = (await textarea.inputValue()).match(/\/boards\/[^)]+\/attachments\/[0-9a-f-]+(?=\))/g);
  const rootCssUrl = rootCssMatch ? rootCssMatch[rootCssMatch.length - 1] : "";
  const rootCssAnalysis = await inspectDecodedImage(page, rootCssUrl);
  expect(rootCssAnalysis.naturalWidth).toBe(2048);
  expect(rootCssAnalysis.naturalHeight).toBe(1024); // capped at maxEdge 2048 despite 6000px !important inline CSS

  // 8. Comment SVG behavior: pasting SVG in comment textarea remains non-upload / plain / native
  // Focus the compact entry to expand the existing comment editor.
  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
  await expect(commentEditor).toBeVisible();
  await commentEditor.fill("");
  await commentEditor.evaluate((element) => {
    const file = new File(['<svg viewBox="0 0 10 10"><rect/></svg>'], "comment.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(commentEditor).toHaveValue("");
  expect(attachmentPosts).toBe(7);
});

test("SVG conversion fault tolerance: upload error, canvas, wrong-MIME encoding, decode error, timeout, and successful retry", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await boardWithCard(page, "att-svg-faults", "svg faults card");
  await cardIn(columnByTitle(page, "Todo"), "svg faults card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");
  await textarea.fill("Preserved initial text");

  let attachmentPosts = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/attachments$/.test(req.url())) attachmentPosts++;
  });

  const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20"/></svg>';

  // 1. Upload rejection (server 500)
  await page.route("**/attachments", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 500, body: "Upload failed" });
    } else {
      await route.continue();
    }
  });

  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
  });

  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "upload-err.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, validSvg);

  await expect(dialog.getByRole("alert")).toHaveText("Could not upload the attachment.");
  await expect(textarea).toHaveValue("Preserved initial text");
  expect(await textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 10]);
  expect(attachmentPosts).toBe(1);

  await page.unroute("**/attachments");

  // 2. Canvas context null fault
  await page.evaluate(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    window.__originalGetContext = originalGetContext;
    HTMLCanvasElement.prototype.getContext = function (contextId: string, ...args: unknown[]) {
      if (contextId === "2d") return null;
      return (originalGetContext as Function).apply(this, [contextId, ...args]);
    };
  });

  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
  });

  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "canvas-err.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, validSvg);

  await expect(dialog.getByRole("alert")).toHaveText("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
  await expect(textarea).toHaveValue("Preserved initial text");
  expect(await textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 10]);
  expect(attachmentPosts).toBe(1); // No new POST on canvas error

  // Restore getContext
  await page.evaluate(() => {
    const original = window.__originalGetContext;
    if (original) HTMLCanvasElement.prototype.getContext = original;
  });

  // 3. Canvas toBlob returns null
  await page.evaluate(() => {
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    window.__originalToBlob = originalToBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type?: string, ...args: unknown[]) {
      if (type === "image/webp") {
        callback(null);
        return;
      }
      (originalToBlob as Function).apply(this, [callback, type, ...args]);
    };
  });

  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
  });

  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "blob-null.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, validSvg);

  await expect(dialog.getByRole("alert")).toHaveText("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
  await expect(textarea).toHaveValue("Preserved initial text");
  expect(await textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 10]);
  expect(attachmentPosts).toBe(1);

  // Restore toBlob
  await page.evaluate(() => {
    const original = window.__originalToBlob;
    if (original) HTMLCanvasElement.prototype.toBlob = original;
  });

  // 4. Canvas toBlob returns non-null wrong-MIME Blob (e.g. image/png)
  await page.evaluate(() => {
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    window.__origWrongMimeToBlob = originalToBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type?: string, ...args: unknown[]) {
      if (type === "image/webp") {
        callback(new Blob(["not-webp"], { type: "image/png" }));
        return;
      }
      (originalToBlob as Function).apply(this, [callback, type, ...args]);
    };
  });

  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
  });

  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "blob-wrong-mime.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, validSvg);

  await expect(dialog.getByRole("alert")).toHaveText("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
  await expect(textarea).toHaveValue("Preserved initial text");
  expect(await textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 10]);
  expect(attachmentPosts).toBe(1);

  // Restore toBlob
  await page.evaluate(() => {
    const orig = window.__origWrongMimeToBlob;
    if (orig) HTMLCanvasElement.prototype.toBlob = orig;
  });

  // 5. Actual decode error injection: image element fires error during decode
  await page.evaluate(() => {
    const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    window.__origDecodeErrSrcDesc = origSrcDesc;
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      set(_val: string) {
        setTimeout(() => {
          if (typeof this.onerror === "function") {
            this.onerror(new Event("error"));
          } else {
            this.dispatchEvent(new Event("error"));
          }
        }, 0);
      },
      configurable: true,
    });
  });

  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
  });

  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "decode-err.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, validSvg);

  await expect(dialog.getByRole("alert")).toHaveText("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
  await expect(textarea).toHaveValue("Preserved initial text");
  expect(await textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 10]);
  expect(attachmentPosts).toBe(1);

  // Restore src descriptor
  await page.evaluate(() => {
    const orig = window.__origDecodeErrSrcDesc;
    if (orig) Object.defineProperty(HTMLImageElement.prototype, "src", orig);
  });

  // 6. Actual decode-wait timeout injection: image loading hangs without firing load or error
  // compressImage enforces SVG_DECODE_TIMEOUT_MS = 10_000ms.
  await page.evaluate(() => {
    const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    window.__origTimeoutSrcDesc = origSrcDesc;
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      set(_val: string) {
        // Deliberately do not fire onload or onerror: image decode hangs until the 10s timer rejects
      },
      configurable: true,
    });
  });

  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
  });

  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "decode-timeout.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, validSvg);

  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveText("Converting and uploading image…");
  // Await the 10-second timeout rejection
  await expect(dialog.getByRole("alert")).toHaveText(
    "Could not convert SVG to WebP. Try copying a self-contained SVG again.",
    { timeout: 15_000 },
  );
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  await expect(textarea).toHaveValue("Preserved initial text");
  expect(await textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 10]);
  expect(attachmentPosts).toBe(1);

  // Restore src descriptor
  await page.evaluate(() => {
    const orig = window.__origTimeoutSrcDesc;
    if (orig) Object.defineProperty(HTMLImageElement.prototype, "src", orig);
  });

  // 7. Explicit subsequent successful re-paste clears failure
  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "recovered.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, validSvg);

  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(textarea).toHaveValue(/!\[recovered\.webp\]\(\/boards\/[^)]+\/attachments\/[^)]+\)/);
  await expect.poll(() => attachmentPosts).toBe(2);
  await expect(dialog.getByTestId("card-sidebar").getByRole("listitem").getByText("recovered.webp", { exact: true })).toBeVisible();
});

test("SVG lifecycle: editing through selection, Save guards, preview completion without focus theft, and failure retry in preview", async ({
  page,
}) => {
  await boardWithCard(page, "att-svg-lifecycle", "svg lifecycle card");
  await cardIn(columnByTitle(page, "Todo"), "svg lifecycle card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");

  // Route /attachments with a deferred gate to hold the upload request in-flight
  let releaseUpload: (() => void) | null = null;
  const uploadDeferred = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let requestReadyResolve: (() => void) | null = null;
  const requestReadyPromise = new Promise<void>((resolve) => {
    requestReadyResolve = resolve;
  });

  await page.route("**/attachments", async (route) => {
    if (route.request().method() === "POST") {
      requestReadyResolve?.();
      await uploadDeferred;
      await route.continue();
    } else {
      await route.continue();
    }
  });

  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");
  await textarea.fill("Hello [REPLACE_ME] World");

  // Select [REPLACE_ME] (start: 6, end: 18)
  const replaceStart = "Hello ".length;
  const replaceEnd = replaceStart + "[REPLACE_ME]".length;
  await textarea.evaluate((el: HTMLTextAreaElement, { start, end }) => {
    el.focus();
    el.setSelectionRange(start, end);
  }, { start: replaceStart, end: replaceEnd });

  // Paste SVG while held
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>';
  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "held.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, svg);

  // Await request ready
  await requestReadyPromise;

  // Status message visible
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveText("Converting and uploading image…");

  // Edit inside/through the captured selection: place caret at index 13 (inside [REPLACE_ME]) and type INTERVENING
  await textarea.focus();
  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(13, 13);
  });
  await textarea.pressSequentially("INTERVENING");
  await expect(textarea).toHaveValue("Hello [REPLACINTERVENINGE_ME] World");

  // Save button is guarded (disabled while uploading)
  const saveBtn = dialog.getByRole("button", { name: "Save title & description", exact: true });
  await expect(saveBtn).toBeDisabled();

  // Keyboard shortcut Ctrl/Cmd+Enter is guarded (does not trigger save/close while uploading)
  const isMac = process.platform === "darwin";
  const modifier = isMac ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(dialog).toBeVisible(); // modal did not close

  // Second paste is suppressed while uploading
  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "second.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, svg);
  await expect(dialog.getByRole("alert")).toHaveText("An image is still uploading. Paste again when it finishes.");

  // Preview while upload is in progress: status remains visible beside preview
  await dialog.getByRole("button", { name: "Preview description" }).click();
  await expect(dialog.getByTestId("description-view")).toBeVisible();
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveText("Converting and uploading image…");

  // Reenter editing before settlement: busy status persists and textarea reflects current edited draft
  await dialog.getByRole("button", { name: "Edit description" }).click();
  await expect(textarea).toBeVisible();
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveText("Converting and uploading image…");

  // Switch back to preview mode before releasing upload
  await dialog.getByRole("button", { name: "Preview description" }).click();
  await expect(dialog.getByTestId("description-view")).toBeVisible();

  // Release the upload while viewing preview
  expect(releaseUpload).not.toBeNull();
  releaseUpload!();

  // Await upload completion in preview: status clears, rendered image appears in preview
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);
  await expect(dialog.getByTestId("description-view").locator("img")).toBeVisible();

  // Assert completion in preview does NOT steal focus to the hidden textarea
  await expect(textarea).not.toBeFocused();
  const activeElementTag = await page.evaluate(() => document.activeElement?.tagName);
  expect(activeElementTag).not.toBe("TEXTAREA");

  // Reenter editing: assert resulting draft has image markdown inserted after the edited selection
  await dialog.getByRole("button", { name: "Edit description" }).click();
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue(/^Hello \[REPLACINTERVENINGE_ME\]!\[held\.webp\]\(\/boards\/[^)]+\/attachments\/[^)]+\) World$/);
  const postSettleSel = await textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
  expect(postSettleSel[0]).toBeGreaterThan(0);
  expect(postSettleSel[1]).toBe(postSettleSel[0]);

  // Observe conversion/upload failure in preview and perform explicit successful retry
  await page.unroute("**/attachments");
  let failRequestReadyResolve: (() => void) | null = null;
  const failRequestReadyPromise = new Promise<void>((resolve) => {
    failRequestReadyResolve = resolve;
  });
  await page.route("**/attachments", async (route) => {
    if (route.request().method() === "POST") {
      failRequestReadyResolve?.();
      await route.fulfill({ status: 500, body: "Upload failed in preview" });
    } else {
      await route.continue();
    }
  });

  const currentDraft = await textarea.inputValue();
  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "preview-fail.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, svg);

  // Switch to preview while upload is in progress
  await dialog.getByRole("button", { name: "Preview description" }).click();
  await expect(dialog.getByTestId("description-view")).toBeVisible();
  await failRequestReadyPromise;

  // Observe failure alert displayed beside preview
  await expect(dialog.getByRole("alert")).toHaveText("Could not upload the attachment.");
  await expect(dialog.getByRole("status").filter({ hasText: "Converting and uploading image…" })).toHaveCount(0);

  // Reenter edit mode: draft is preserved and alert persists
  await dialog.getByRole("button", { name: "Edit description" }).click();
  await expect(textarea).toHaveValue(currentDraft);
  await expect(dialog.getByRole("alert")).toHaveText("Could not upload the attachment.");

  // Perform explicit successful retry: clear failing route, re-paste valid SVG
  await page.unroute("**/attachments");
  await textarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "retry.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, svg);

  // Alert clears, upload succeeds, and retry WebP is inserted
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(textarea).toHaveValue(/!\[retry\.webp\]\(\/boards\/[^)]+\/attachments\/[^)]+\)/);
});

test("SVG disposal: hold request, close and reopen with active draft and focus, await network and publication settlement", async ({
  page,
}) => {
  await boardWithCard(page, "att-svg-disposal", "svg disposal card");
  await cardIn(columnByTitle(page, "Todo"), "svg disposal card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const dialog = page.getByRole("dialog");

  // 1. Establish saved baseline
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const textarea = dialog.getByLabel("Card description");
  await textarea.fill("Baseline saved description text");
  await dialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Reopen card: verify saved baseline is present
  await cardIn(columnByTitle(page, "Todo"), "svg disposal card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const openDialog = page.getByRole("dialog");
  await expect(openDialog.getByTestId("description-view")).toContainText("Baseline saved description text");

  // Enter edit mode on saved baseline
  await openDialog.getByRole("button", { name: "Edit description" }).click();
  const editTextarea = openDialog.getByLabel("Card description");
  await expect(editTextarea).toHaveValue("Baseline saved description text");

  // 2. Explicit request-ready gate for /attachments POST
  let holdUploadResolve: (() => void) | null = null;
  const holdUploadPromise = new Promise<void>((resolve) => {
    holdUploadResolve = resolve;
  });
  let requestReadyResolve: (() => void) | null = null;
  const requestReadyPromise = new Promise<void>((resolve) => {
    requestReadyResolve = resolve;
  });

  const uploadResponsePromise = page.waitForResponse(
    (res) => res.url().includes("/attachments") && res.request().method() === "POST",
  );

  await page.route("**/attachments", async (route) => {
    if (route.request().method() === "POST") {
      requestReadyResolve?.();
      await holdUploadPromise;
      await route.continue();
    } else {
      await route.continue();
    }
  });

  // Paste SVG to initiate upload
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="purple"/></svg>';
  await editTextarea.evaluate((element, svgSource) => {
    const file = new File([svgSource], "disposed.svg", { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, svg);

  // Await explicit request-ready milestone before closing card
  await requestReadyPromise;

  // 3. Close/discard card while upload is still held
  await openDialog.getByRole("button", { name: "Close card", exact: true }).click();
  const discardPrompt = page.getByText("Discard unsaved changes?");
  if (await discardPrompt.isVisible()) {
    await page.keyboard.press("Escape");
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 4. Reopen card while upload remains held
  await cardIn(columnByTitle(page, "Todo"), "svg disposal card").click();
  await openCardSection(page.getByRole("dialog"), "attachments");
  const reopenedDialog = page.getByRole("dialog");
  await expect(reopenedDialog).toBeVisible();

  // Enter edit mode in reopened card
  await reopenedDialog.getByRole("button", { name: "Edit description" }).click();
  const reopenedTextarea = reopenedDialog.getByLabel("Card description");
  await expect(reopenedTextarea).toBeVisible();

  // 5. Establish exact draft and focused element before release
  const newActiveDraft = "Reopened active user draft establishing focus";
  await reopenedTextarea.fill(newActiveDraft);
  await reopenedTextarea.focus();
  await reopenedTextarea.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(9, 15));
  await expect(reopenedTextarea).toBeFocused();
  const establishedSel = await reopenedTextarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
  expect(establishedSel).toEqual([9, 15]);

  // 6. Release the held upload
  expect(holdUploadResolve).not.toBeNull();
  holdUploadResolve!();

  // 7. Await actual response body / requestfinished plus observable attachment publication / application settlement
  const uploadResponse = await uploadResponsePromise;
  const responseBody = await uploadResponse.body();
  expect(responseBody.length).toBeGreaterThan(0);

  // Observable attachment publication: the card sidebar lists the finished upload
  await expect(
    reopenedDialog.getByTestId("card-sidebar").getByRole("listitem").getByText("disposed.webp", { exact: true }),
  ).toBeVisible();

  // 8. Assert no late draft or focus change: active draft and focus remain intact
  await expect(reopenedTextarea).toHaveValue(newActiveDraft);
  await expect(reopenedTextarea).toBeFocused();
  const finalSel = await reopenedTextarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
  expect(finalSel).toEqual(establishedSel);
  await expect(reopenedDialog.getByRole("alert")).toHaveCount(0);

  // Also verify that the discarded image was not written into description
  await reopenedDialog.getByRole("button", { name: "Preview description" }).click();
  await expect(reopenedDialog.getByTestId("description-view")).not.toContainText("disposed.webp");
});
