import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardBody,
  cardIn,
  columnByTitle,
  createBoard,
  dragCardTo,
  inviteMember,
  settleAnimationFrames,
  signup,
  uniqueEmail,
  ensureChecklistComposer,
} from "./helpers";
import { mobileViewport } from "./fixtures";

/** A signed-up user in its own browser context (own cookie jar). */
async function newUser(browser: Browser, suffix: string): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail(suffix);
  await signup(page, email, suffix);
  return { page, email };
}

test("a saved description persists across reopen and reaches another member", async ({
  browser,
}) => {
  const alice = await newUser(browser, "modal-a");
  const bob = await newUser(browser, "modal-b");

  const boardName = `Modal ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);

  await alice.page.getByRole("link", { name: boardName }).click();
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "modal card");

  const card = cardIn(columnByTitle(alice.page, "Todo"), "modal card");
  await card.click();

  const dialog = alice.page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "modal card", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Description" })).toBeVisible();
  // A card with no description opens on the placeholder, not a textarea.
  await expect(dialog.getByRole("button", { name: "Add a description…" })).toBeVisible();
  await expect(dialog.getByLabel("Card description")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Add a description…" }).click();
  await expect(dialog.getByLabel("Card description")).toBeVisible();
  await expect(dialog.getByLabel("Card description")).toHaveValue("");

  await dialog.getByLabel("Card description").fill("hello from A");
  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(dialog).toHaveCount(0);

  // Reopening shows the saved Markdown rendered, not an editor.
  await card.click();
  await expect(dialog.getByTestId("description-view")).toContainText("hello from A");
  await expect(dialog.getByLabel("Card description")).not.toBeVisible();
  await expect(dialog.getByLabel("Card description")).toBeDisabled();
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The update travelled over the socket, so the other member reads it too.
  await bob.page.goto(`/board/${boardId}`);
  await cardIn(columnByTitle(bob.page, "Todo"), "modal card").click();
  await expect(bob.page.getByRole("dialog").getByTestId("description-view")).toContainText(
    "hello from A",
  );

  await alice.page.context().close();
  await bob.page.context().close();
});

test("Escape previews a dirty description, then warns, then discards", async ({ browser }) => {
  const user = await newUser(browser, "modal-esc");

  const boardName = `Discard ${Date.now()}`;
  await createBoard(user.page, boardName);
  await user.page.getByRole("link", { name: boardName }).click();
  await addColumn(user.page, "Todo");
  await addCard(user.page, "Todo", "discard card");

  const card = cardIn(columnByTitle(user.page, "Todo"), "discard card");
  await card.click();

  const dialog = user.page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  await dialog.getByLabel("Card description").fill("never saved");

  // First Escape leaves the editor only: the draft survives as a preview.
  await dialog.getByLabel("Card description").press("Escape");
  await expect(dialog.getByLabel("Card description")).not.toBeVisible();
  await expect(dialog.getByLabel("Card description")).toBeDisabled();
  await expect(dialog.getByTestId("description-view")).toContainText("never saved");
  await expect(dialog).toBeVisible();

  // Second reaches the modal, which refuses to drop the draft in silence.
  await user.page.keyboard.press("Escape");
  await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
  await expect(dialog).toBeVisible();

  // Third answers the prompt.
  await user.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await card.click();
  await expect(dialog.getByRole("button", { name: "Add a description…" })).toBeVisible();
  await expect(dialog.getByTestId("description-view")).toHaveCount(0);

  await user.page.context().close();
});

test("the close button restores focus, and the dirty guard blocks close until discard", async ({
  browser,
}) => {
  const user = await newUser(browser, "modal-close");

  const boardName = `Close ${Date.now()}`;
  await createBoard(user.page, boardName);
  await user.page.getByRole("link", { name: boardName }).click();
  await addColumn(user.page, "Todo");
  await addCard(user.page, "Todo", "close card");

  const card = cardIn(columnByTitle(user.page, "Todo"), "close card");
  const body = cardBody(card);
  await body.click();

  const dialog = user.page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Nothing edited: the panel closes on the first ask and hands focus back to
  // the card it came from, which was inert while the dialog was up.
  await dialog.getByRole("button", { name: "Close card" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(body).toBeFocused();
  await body.click();
  await dialog.getByRole("button", { name: "Edit title", exact: true }).click();
  await dialog.getByLabel("Card title").fill("close card edited");
  await dialog.getByRole("button", { name: "Close card" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();

  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByText("Discard unsaved changes?")).toHaveCount(0);
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Close card" }).click();
  await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Discard" }).click();
  await expect(dialog).toHaveCount(0);

  // Discard means discard: the card kept its title.
  await body.click();
  await expect(dialog.getByRole("heading", { name: "close card", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);

  await user.page.context().close();
});

test("a card re-parented before the restoration frame still regains focus", async ({ browser }) => {
  const user = await newUser(browser, "modal-remount");

  const boardName = `Remount ${Date.now()}`;
  await createBoard(user.page, boardName);
  await user.page.getByRole("link", { name: boardName }).click();
  await addColumn(user.page, "Todo");
  await addCard(user.page, "Todo", "remount card");

  const card = cardIn(columnByTitle(user.page, "Todo"), "remount card");
  const cardId = await cardBody(card).getAttribute("data-card-id");
  expect(cardId).toBeTruthy();

  await card.click();
  const dialog = user.page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Close the panel and, before its restoration frame runs, replace the card's
  // node — what a peer move does when the card re-parents into another column's
  // keyed list: the old <li> disconnects and a replacement carries the same
  // data-card-id. The restore has to resolve the card inside the frame.
  await user.page.evaluate(async (id) => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Close card"]')?.click();
    for (let i = 0; i < 200 && document.querySelector('[role="dialog"]'); i += 1) {
      await Promise.resolve();
    }
    const current = document.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
    if (current) {
      const replacement = current.cloneNode(true) as HTMLElement;
      replacement.setAttribute("data-test-remount", "1");
      current.replaceWith(replacement);
    }
  }, cardId!);
  await settleAnimationFrames(user.page);

  await expect(user.page.locator("[data-test-remount]")).toBeFocused();
  await user.page.context().close();
});

test("a card re-parented before the restoration frame does not steal a focused search field", async ({
  browser,
}) => {
  const user = await newUser(browser, "modal-remount-search");

  const boardName = `Remount search ${Date.now()}`;
  await createBoard(user.page, boardName);
  await user.page.getByRole("link", { name: boardName }).click();
  await addColumn(user.page, "Todo");
  await addCard(user.page, "Todo", "remount card");

  const card = cardIn(columnByTitle(user.page, "Todo"), "remount card");
  const cardId = await cardBody(card).getAttribute("data-card-id");
  expect(cardId).toBeTruthy();

  await card.click();
  const dialog = user.page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Same replacement, but this time the user has already claimed the search
  // field: the deferred restore must yield to it even though the card it was
  // meant to focus still exists.
  await user.page.evaluate(async (id) => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Close card"]')?.click();
    // Wait for the modal commit and for the board shell to leave `inert`
    // before claiming the field; both happen in microtasks, so the restore
    // frame is still pending when focus moves.
    for (let i = 0; i < 200 && document.querySelector('[role="dialog"]'); i += 1) {
      await Promise.resolve();
    }
    for (let i = 0; i < 200 && document.querySelector('.boards-shell[inert]'); i += 1) {
      await Promise.resolve();
    }
    const current = document.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
    if (current) current.replaceWith(current.cloneNode(true));
    document.querySelector<HTMLElement>('input[aria-label="Search cards"]')?.focus();
  }, cardId!);
  await settleAnimationFrames(user.page);

  await expect(user.page.getByLabel("Search cards")).toBeFocused();
  await expect(card).not.toBeFocused();
  await user.page.context().close();
});

test("double-clicking a card opens the modal and keeps it open", async ({ browser }) => {
  const user = await newUser(browser, "modal-dbl");

  const boardName = `Double ${Date.now()}`;
  await createBoard(user.page, boardName);
  await user.page.getByRole("link", { name: boardName }).click();
  await addColumn(user.page, "Todo");
  await addCard(user.page, "Todo", "double card");

  // The second click lands on the overlay that the first one raised; it must not
  // be read as a backdrop discard.
  await cardIn(columnByTitle(user.page, "Todo"), "double card").dblclick();

  const dialog = user.page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "double card", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);
  // Still open a moment later: no delayed close from the trailing click.
  await user.page.waitForTimeout(200);
  await expect(dialog).toBeVisible();

  await user.page.context().close();
});

test("dragging a card moves it without opening the modal", async ({ browser }) => {
  const user = await newUser(browser, "modal-drag");

  const boardName = `Drag ${Date.now()}`;
  await createBoard(user.page, boardName);
  await user.page.getByRole("link", { name: boardName }).click();
  await addColumn(user.page, "Todo");
  await addColumn(user.page, "Done");
  await addCard(user.page, "Todo", "dragged card");

  const card = cardIn(columnByTitle(user.page, "Todo"), "dragged card");
  await dragCardTo(user.page, card, columnByTitle(user.page, "Done").locator("ul"));

  await expect(cardIn(columnByTitle(user.page, "Done"), "dragged card")).toBeVisible();
  // dnd-kit stops the trailing click once its activation distance is met, so the
  // drop must not leave a dialog behind.
  await expect(user.page.getByRole("dialog")).toHaveCount(0);

  await user.page.context().close();
});

test("deleting a card archives it for live restoration with its saved content", async ({
  browser,
}) => {
  const alice = await newUser(browser, "modal-del-a");
  const bob = await newUser(browser, "modal-del-b");

  const boardName = `Delete ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);
  await alice.page.getByRole("link", { name: boardName }).click();
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "doomed card");

  const todo = columnByTitle(alice.page, "Todo");
  const card = cardIn(todo, "doomed card");
  const cardId = await cardBody(card).getAttribute("data-card-id");
  expect(cardId).toBeTruthy();
  // Nothing destructive on the card front: deletion lives in the dialog.
  await expect(alice.page.getByRole("button", { name: /^Delete card/ })).toHaveCount(0);

  const dialog = alice.page.getByRole("dialog", { name: "doomed card", exact: true });
  await card.click();
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  await dialog.getByLabel("Card description").fill("saved before archival");
  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(dialog).toHaveCount(0);

  await bob.page.goto(`/board/${boardId}`);
  const bobTodo = columnByTitle(bob.page, "Todo");
  const bobCard = cardIn(bobTodo, "doomed card");
  await expect(cardBody(bobCard)).toHaveAttribute("data-card-id", cardId!);

  await card.click();
  await expect(dialog).toBeVisible();

  // Cancel leaves both the confirmation and the card behind.
  await dialog.getByRole("button", { name: "Delete card" }).click();
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(card).toBeVisible();

  // Escape cancels only the inline confirmation rung.
  await dialog.getByRole("button", { name: "Delete card" }).click();
  await alice.page.keyboard.press("Escape");
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(card).toBeVisible();

  await dialog.getByRole("button", { name: "Delete card" }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(alice.page).not.toHaveURL(/card=/);
  await expect(todo).toBeVisible();
  await expect(cardIn(todo, "doomed card")).toHaveCount(0);
  await expect(bobTodo).toBeVisible();
  await expect(bobCard).toHaveCount(0);

  const archiveTrigger = alice.page.getByRole("button", {
    name: "Archived cards",
    exact: true,
  });
  const bobArchiveTrigger = bob.page.getByRole("button", {
    name: "Archived cards",
    exact: true,
  });
  await expect(archiveTrigger).toHaveText("Archive 1");
  await expect(bobArchiveTrigger).toHaveText("Archive 1");
  await archiveTrigger.click();

  let archiveDialog = alice.page.getByRole("dialog", {
    name: "Archived cards",
    exact: true,
  });
  await expect(
    archiveDialog.getByRole("heading", { name: "doomed card", exact: true }),
  ).toBeVisible();
  await expect(archiveDialog.getByText("From Todo", { exact: true })).toBeVisible();
  await expect(
    archiveDialog.getByText("Permanently deleted in 90 days.", { exact: true }),
  ).toBeVisible();

  await alice.page.reload();
  await expect(archiveTrigger).toHaveText("Archive 1");
  await archiveTrigger.click();
  archiveDialog = alice.page.getByRole("dialog", {
    name: "Archived cards",
    exact: true,
  });
  await expect(
    archiveDialog.getByRole("heading", { name: "doomed card", exact: true }),
  ).toBeVisible();
  await archiveDialog
    .getByLabel("Restore doomed card to column", { exact: true })
    .selectOption({ label: "Todo" });
  await archiveDialog
    .getByRole("button", { name: "Restore doomed card", exact: true })
    .click();
  await expect(archiveDialog.getByText("No archived cards.", { exact: true })).toBeVisible();
  await archiveDialog
    .getByRole("button", { name: "Close archived cards", exact: true })
    .click();

  const restoredCard = cardIn(columnByTitle(alice.page, "Todo"), "doomed card");
  await expect(cardBody(restoredCard)).toHaveAttribute("data-card-id", cardId!);
  await expect(cardBody(cardIn(bobTodo, "doomed card"))).toHaveAttribute("data-card-id", cardId!);
  await restoredCard.click();
  await expect(
    alice.page
      .getByRole("dialog", { name: "doomed card", exact: true })
      .getByTestId("description-view"),
  ).toContainText("saved before archival");

  await alice.page.context().close();
  await bob.page.context().close();
});

test("task title requires explicit editing", async ({ browser }) => {
  const user = await newUser(browser, "modal-title-view");

  const boardName = `TitleMode ${Date.now()}`;
  await createBoard(user.page, boardName);
  await user.page.getByRole("link", { name: boardName }).click();
  await addColumn(user.page, "Todo");
  await addCard(user.page, "Todo", "Safe title");

  const card = cardIn(columnByTitle(user.page, "Todo"), "Safe title");
  await card.click();

  const dialog = user.page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // 1. Initial state: level-two heading visible, no title textbox, Close card button focused.
  const titleHeading = dialog.getByRole("heading", { name: "Safe title", exact: true, level: 2 });
  await expect(titleHeading).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close card" })).toBeFocused();

  // 2. Ordinary typing and Backspace without activating Edit title do not modify the title or create Unsaved changes.
  await user.page.keyboard.type("accidental");
  await user.page.keyboard.press("Backspace");
  await user.page.keyboard.press("Backspace");
  await expect(titleHeading).toBeVisible();
  await expect(dialog.getByText("Unsaved title", { exact: true })).toHaveCount(0);

  // Backspace when document.body or a non-editable dialog surface has focus does not close dialog or modify title.
  await user.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await user.page.keyboard.press("Backspace");
  await expect(dialog).toBeVisible();
  await expect(titleHeading).toBeVisible();

  // Focusing a checklist checkbox and pressing Backspace leaves dialog and title intact.
  const addItem = await ensureChecklistComposer(dialog);
  await addItem.fill("Check item");
  await addItem.press("Enter");
  const checkbox = dialog.getByRole("checkbox", { name: "Check item" });
  await expect(checkbox).toBeVisible();
  await checkbox.focus();
  await expect(checkbox).toBeFocused();
  await user.page.keyboard.press("Backspace");
  await expect(dialog).toBeVisible();
  await expect(titleHeading).toBeVisible();
  await expect(checkbox).toBeVisible();
  // 3. Close and reopen: remains unchanged.
  await dialog.getByRole("button", { name: "Close card" }).click();
  await expect(dialog).toHaveCount(0);
  await card.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Safe title", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);

  // 4. Keyboard-focus Edit title and Enter activation focuses input.
  const editTitleBtn = dialog.getByRole("button", { name: "Edit title", exact: true });
  await editTitleBtn.focus();
  await expect(editTitleBtn).toBeFocused();
  await user.page.keyboard.press("Enter");
  const titleInput = dialog.getByLabel("Card title");
  await expect(titleInput).toBeVisible();
  await expect(titleInput).toBeFocused();

  // 5. While editing, Backspace deletes a typed character normally.
  await titleInput.fill("Deliberate title!");
  await user.page.keyboard.press("Backspace");
  await expect(titleInput).toHaveValue("Deliberate title");

  // Escape returns to draft heading, textbox disappears, Edit title regains focus, Unsaved changes remains.
  await user.page.keyboard.press("Escape");
  await expect(titleInput).toHaveCount(0);
  const draftHeading = dialog.getByRole("heading", { name: "Deliberate title", exact: true, level: 2 });
  await expect(draftHeading).toBeVisible();
  await expect(editTitleBtn).toBeFocused();
  await expect(dialog.getByText("Unsaved title", { exact: true })).toBeVisible();

  // 6. Close triggers discard guard; Keep editing preserves draft.
  await dialog.getByRole("button", { name: "Close card" }).click();
  await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByText("Discard unsaved changes?")).toHaveCount(0);
  await expect(draftHeading).toBeVisible();

  // 7. Activate Edit title and Enter saves/closes; card front and reload/reopen show persisted view mode.
  await editTitleBtn.click();
  await expect(titleInput).toBeVisible();
  await expect(titleInput).toBeFocused();
  await user.page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);

  const updatedCard = cardIn(columnByTitle(user.page, "Todo"), "Deliberate title");
  await expect(updatedCard).toBeVisible();

  await user.page.reload();
  const reloadedCard = cardIn(columnByTitle(user.page, "Todo"), "Deliberate title");
  await expect(reloadedCard).toBeVisible();
  await reloadedCard.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Deliberate title", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);

  // 8. A blank title is not a saveable change; Close preserves the original title.
  await dialog.getByRole("button", { name: "Edit title", exact: true }).click();
  await expect(dialog.getByLabel("Card title")).toBeVisible();
  await dialog.getByLabel("Card title").fill("   ");
  await expect(dialog.getByRole("button", { name: "Save title & description", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await reloadedCard.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Deliberate title", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);

  await user.page.context().close();
});

test("mobile touch: card details renders full-viewport shell, ordered task content, 16px inputs, visible header/footer, coarse 44px actions, and dirty close protection", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: mobileViewport,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  await signup(page, uniqueEmail("mobile-modal"), "Mobile Modal User");
  const boardKey = await createBoard(page, `Mobile Modal Board ${Date.now()}`);
  await page.goto(`/board/${boardKey}`);

  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Phone Task");

  const card = cardIn(columnByTitle(page, "Todo"), "Phone Task");
  await card.click();

  const dialog = page.getByRole("dialog", { name: "Phone Task" });
  await expect(dialog).toBeVisible();

  // 1. Verify dialog renders as full-viewport surface on mobile (<md): width and height match viewport
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.width).toBeGreaterThanOrEqual(mobileViewport.width - 2);
  expect(dialogBox!.height).toBeGreaterThanOrEqual(mobileViewport.height - 2);
  expect(dialogBox!.x).toBeLessThanOrEqual(2);
  expect(dialogBox!.y).toBeLessThanOrEqual(2);

  // Fullscreen toggle is hidden below md (accessible name "Open full screen")
  await expect(dialog.getByRole("button", { name: "Open full screen" })).toHaveCount(0);
  // 2. Header and footer controls are within visual viewport
  const closeButton = dialog.getByRole("button", { name: "Close card" });
  await expect(closeButton).toBeVisible();
  const closeBox = await closeButton.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(mobileViewport.height);
  // Coarse-pointer target is at least 44px
  expect(closeBox!.width).toBeGreaterThanOrEqual(44);
  expect(closeBox!.height).toBeGreaterThanOrEqual(44);

  // 3. Main task content precedes sidebar/metadata in DOM order and geometry
  const descHeading = dialog.getByRole("heading", { name: "Description" });
  await expect(descHeading).toBeVisible();
  const descBox = await descHeading.boundingBox();
  expect(descBox).not.toBeNull();

  const sidebar = dialog.getByTestId("card-sidebar");
  await expect(sidebar).toBeVisible();
  const sidebarBox = await sidebar.boundingBox();
  expect(sidebarBox).not.toBeNull();

  // Description appears before sidebar vertically in geometry
  expect(descBox!.y).toBeLessThan(sidebarBox!.y);

  // DOM order check: description precedes sidebar
  const domOrder = await dialog.evaluate((el) => {
    const desc = el.querySelector("h3, h2");
    const sb = el.querySelector("[data-testid='card-sidebar']");
    if (!desc || !sb) return false;
    return Boolean(desc.compareDocumentPosition(sb) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(domOrder).toBe(true);

  // Background scroll locking: record initial scroll positions, attempt scrolling the backdrop, assert positions remain unchanged
  const initialDocScroll = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    bodyX: document.body.scrollLeft,
    bodyY: document.body.scrollTop,
  }));
  await page.evaluate(() => window.scrollTo(100, 200));
  const postScroll = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    bodyX: document.body.scrollLeft,
    bodyY: document.body.scrollTop,
  }));
  expect(postScroll).toEqual(initialDocScroll);
  // 4. Form inputs render at >= 16px to prevent iOS Safari auto-zoom
  // Open description editor
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  const descTextarea = dialog.getByLabel("Card description");
  await expect(descTextarea).toBeVisible();

  const descFontSize = await descTextarea.evaluate((el) => {
    return window.getComputedStyle(el).fontSize;
  });
  expect(parseFloat(descFontSize)).toBeGreaterThanOrEqual(16);

  // Type some text to make it dirty
  await descTextarea.fill("Dirty mobile description text");

  // 5. Coarse actions in markdown toolbar have accessible hit boxes (>= 44px hit target)
  const boldButton = dialog.getByRole("button", { name: "Bold", exact: true });
  await expect(boldButton).toBeVisible();
  const boldBox = await boldButton.boundingBox();
  expect(boldBox).not.toBeNull();
  expect(boldBox!.height).toBeGreaterThanOrEqual(44);
  expect(boldBox!.width).toBeGreaterThanOrEqual(44);
  // 6. Dirty close trigger via close button or Escape shows prompt and wrapping/full-width actions
  await closeButton.click();
  // Modal stays open because of dirty guard
  await expect(dialog).toBeVisible();

  const discardBtn = dialog.getByRole("button", { name: "Discard" });
  const keepEditingBtn = dialog.getByRole("button", { name: "Keep editing" });
  await expect(discardBtn).toBeVisible();
  await expect(keepEditingBtn).toBeVisible();

  // Both actions are reachable and at least 44px high for coarse touch
  const discardBox = await discardBtn.boundingBox();
  const keepBox = await keepEditingBtn.boundingBox();
  expect(discardBox).not.toBeNull();
  expect(keepBox).not.toBeNull();
  expect(discardBox!.height).toBeGreaterThanOrEqual(44);
  expect(keepBox!.height).toBeGreaterThanOrEqual(44);

  // Keep editing keeps dialog open and restores editor focus
  await keepEditingBtn.click();
  await expect(dialog).toBeVisible();
  await expect(descTextarea).toBeVisible();

  // Save button is visible and at least 44px high
  const saveBtn = dialog.getByRole("button", { name: "Save title & description" });
  await expect(saveBtn).toBeVisible();
  const saveBox = await saveBtn.boundingBox();
  expect(saveBox).not.toBeNull();
  expect(saveBox!.height).toBeGreaterThanOrEqual(44);

  // Now discard changes
  await closeButton.click();
  await discardBtn.click();
  await expect(dialog).toHaveCount(0);

  // 7. Verify no page-level / background horizontal overflow
  const pageOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  expect(pageOverflow).toBe(false);

  await context.close();
});

/** Two members on one board with one card, both on the board page. */
async function sharedCard(browser: Browser, suffix: string, cardTitle: string) {
  const alice = await newUser(browser, `${suffix}-a`);
  const bob = await newUser(browser, `${suffix}-b`);
  const boardName = `Concurrent ${suffix} ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);
  await alice.page.getByRole("link", { name: boardName }).click();
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", cardTitle);
  await bob.page.goto(`/board/${boardId}`);
  await expect(cardIn(columnByTitle(bob.page, "Todo"), cardTitle)).toBeVisible();
  return { alice, bob };
}

test("saving only a description keeps a peer's concurrent rename", async ({ browser }) => {
  const { alice, bob } = await sharedCard(browser, "desc-only", "Shared card");

  await cardIn(columnByTitle(alice.page, "Todo"), "Shared card").click();
  const aliceDialog = alice.page.getByRole("dialog");
  await aliceDialog.getByRole("button", { name: "Add a description…" }).click();
  await aliceDialog.getByLabel("Card description").fill("alice notes");

  await cardIn(columnByTitle(bob.page, "Todo"), "Shared card").click();
  const bobDialog = bob.page.getByRole("dialog");
  await bobDialog.getByRole("button", { name: "Edit title", exact: true }).click();
  await bobDialog.getByLabel("Card title").fill("Bob title");
  await bobDialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(bobDialog).toHaveCount(0);

  await expect(cardIn(columnByTitle(alice.page, "Todo"), "Bob title")).toHaveCount(1);
  await aliceDialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(aliceDialog).toHaveCount(0);

  await bob.page.reload();
  await cardIn(columnByTitle(bob.page, "Todo"), "Bob title").click();
  await expect(bobDialog.getByRole("heading", { name: "Bob title", exact: true, level: 2 })).toBeVisible();
  await expect(bobDialog.getByTestId("description-view")).toContainText("alice notes");

  await alice.page.context().close();
  await bob.page.context().close();
});

test("saving only a title keeps a peer's concurrent description", async ({ browser }) => {
  const { alice, bob } = await sharedCard(browser, "title-only", "Shared card");

  await cardIn(columnByTitle(alice.page, "Todo"), "Shared card").click();
  const aliceDialog = alice.page.getByRole("dialog");
  await aliceDialog.getByRole("button", { name: "Edit title", exact: true }).click();
  await aliceDialog.getByLabel("Card title").fill("Alice title");

  await cardIn(columnByTitle(bob.page, "Todo"), "Shared card").click();
  const bobDialog = bob.page.getByRole("dialog");
  await bobDialog.getByRole("button", { name: "Add a description…" }).click();
  await bobDialog.getByLabel("Card description").fill("bob notes");
  await bobDialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(bobDialog).toHaveCount(0);

  // Alice never touched the description, so her open card follows Bob's.
  await expect(aliceDialog.getByTestId("description-view")).toContainText("bob notes");
  await aliceDialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(aliceDialog).toHaveCount(0);

  await bob.page.reload();
  await cardIn(columnByTitle(bob.page, "Todo"), "Alice title").click();
  await expect(bobDialog.getByRole("heading", { name: "Alice title", exact: true, level: 2 })).toBeVisible();
  await expect(bobDialog.getByTestId("description-view")).toContainText("bob notes");

  await alice.page.context().close();
  await bob.page.context().close();
});

test("renaming a label keeps a peer's concurrent recolour", async ({ browser }) => {
  const { alice, bob } = await sharedCard(browser, "label", "Labelled card");

  const aliceCard = cardIn(columnByTitle(alice.page, "Todo"), "Labelled card");
  await aliceCard.click();
  const aliceDialog = alice.page.getByRole("dialog");
  await aliceDialog.getByRole("button", { name: "+ Add label…" }).click();
  await aliceDialog.getByRole("button", { name: "Create label", exact: true }).click();
  await aliceDialog.getByLabel("New label name").fill("Bug");
  await aliceDialog.getByLabel("New label name").press("Enter");
  await expect(aliceDialog.getByRole("heading", { name: "Labels 1" })).toBeVisible();
  await expect(aliceCard.getByTestId("label-pill")).not.toHaveClass(/bg-teal-50/);
  await aliceDialog.getByLabel("Edit label Bug").click();
  await aliceDialog.getByLabel("Label name Bug").fill("Fix");

  const bobCard = cardIn(columnByTitle(bob.page, "Todo"), "Labelled card");
  await expect(bobCard.getByTestId("label-pill")).toHaveText("Bug");
  await bobCard.click();
  const bobDialog = bob.page.getByRole("dialog");
  await bobDialog.getByRole("button", { name: "+ Add label…" }).click();
  await bobDialog.getByLabel("Edit label Bug").click();
  await bobDialog.getByLabel("Teal").click();
  await bobDialog.getByLabel("Save label Bug").click();
  await expect(bobCard.getByTestId("label-pill")).toHaveClass(/bg-teal-50/);

  await expect(aliceCard.getByTestId("label-pill")).toHaveClass(/bg-teal-50/);
  await aliceDialog.getByLabel("Save label Bug").click();

  await expect(bobCard.getByTestId("label-pill")).toHaveText("Fix");
  await expect(bobCard.getByTestId("label-pill")).toHaveClass(/bg-teal-50/);
  await bob.page.reload();
  const reloaded = cardIn(columnByTitle(bob.page, "Todo"), "Labelled card").getByTestId("label-pill");
  await expect(reloaded).toHaveText("Fix");
  await expect(reloaded).toHaveClass(/bg-teal-50/);

  await alice.page.context().close();
  await bob.page.context().close();
});
