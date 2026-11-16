import { expect, test } from "@playwright/test";
import {
  cardBody,
addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  expectBoardAccessDenied,
  generateAccountInvite,
  getBoardUuid,
  openBoardList,
  openPersonalWorkspace,
  inviteMember,
  PASSWORD,
  settleAnimationFrames,
  signup,
  uniqueEmail,
} from "./helpers";
function randomBoardKey(prefix = "K"): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 8)
    .toUpperCase();
  return `${prefix}${rand}`.slice(0, 10);
}


test("a created board appears in the list and opens with its name", async ({ page }) => {
  await signup(page, uniqueEmail("boards"), "Boards User");

  const name = `Roadmap ${Date.now()}`;
  const boardKey = await createBoard(page, name);

  await expect(page.getByRole("status")).toHaveText("Board created.");
  await expect(page.getByRole("link", { name })).toBeVisible();
  await page.getByRole("link", { name }).click();

  await expect(page).toHaveURL(`/board/${boardKey}`);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
});

test("create dialog cancellation resets draft and restores focus", async ({ page }) => {
  await signup(page, uniqueEmail("boards-create-cancel"), "Create Cancel User");
  const trigger = page.getByRole("button", { name: "New board" });
  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "Create a board" });
  await dialog.getByLabel("Board name").fill("Discarded draft");
  await dialog.getByLabel("Board key").fill("DD");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await settleAnimationFrames(page);
  await expect(trigger).toBeFocused();

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "Create a board" });
  await expect(dialog.getByLabel("Board name")).toHaveValue("");
  await expect(dialog.getByLabel("Board key")).toHaveValue("");
  await expect(dialog.getByLabel("Board name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("board appearance persists through creation and editing", async ({ page }) => {
  await signup(page, uniqueEmail("board-appearance"), "Appearance User");
  const boardKey = randomBoardKey("S");
  const boardName = `Styled roadmap ${boardKey}`;
  await page.getByRole("button", { name: "New board" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create a board" });
  await createDialog.getByLabel("Board name").fill(boardName);
  await createDialog.getByLabel("Board key").fill(boardKey);
  await createDialog.getByRole("radio", { name: "Fish icon" }).click();
  await createDialog.getByRole("radio", { name: "Blue color" }).click();
  await expect(createDialog.getByText(boardName, { exact: true })).toBeVisible();
  await createDialog.getByRole("button", { name: "Create board" }).click();
  await expect(createDialog).toHaveCount(0);

  let row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: boardName }) });
  await expect(row.locator('[data-board-icon="fish"][data-board-color="blue"]')).toBeVisible();

  await row.getByRole("button", { name: `Board settings for ${boardName}` }).click();
  await row.getByRole("menuitem", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit board" });
  await editDialog.getByRole("radio", { name: "Star icon" }).click();
  await editDialog.getByRole("radio", { name: "Purple color" }).click();
  await editDialog.getByRole("button", { name: "Save" }).click();
  await expect(editDialog).toHaveCount(0);
  await expect(row.locator('[data-board-icon="star"][data-board-color="purple"]')).toBeVisible();

  await page.reload();
  row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: boardName }) });
  await expect(row.locator('[data-board-icon="star"][data-board-color="purple"]')).toBeVisible();
});

test("board row reflows at 375px without horizontal overflow, keeps controls reachable, and opens menu within bounds", async ({
  page,
}) => {
  await signup(page, uniqueEmail("boards-mobile"), "Mobile User");

  const name = `Sprint ${Date.now()}`;
  await createBoard(page, name);

  await page.setViewportSize({ width: 375, height: 667 });

  const createButton = page.getByRole("button", { name: "New board" });
  await expect(createButton).toBeVisible();
  await expect(createButton).toHaveAccessibleName("New board");

  const boardLink = page.getByRole("link", { name });
  await expect(boardLink).toBeVisible();

  const row = page.getByRole("listitem").filter({ has: boardLink });
  const settingsButton = row.getByRole("button", { name: `Board settings for ${name}` });

  await expect(settingsButton).toBeVisible();
  await expect(settingsButton).toHaveAccessibleName(`Board settings for ${name}`);

  const assertMenuAt375px = async () => {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBe(clientWidth);

    // Open menu
    await settingsButton.click();
    const menu = row.getByRole("menu");
    await expect(menu).toBeVisible();

    // Menu must stay within page bounds (0 <= x and x + width <= 375)
    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    if (menuBox) {
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(375);
    }

    // Document must not overflow with open menu
    const openScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const openClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(openScrollWidth).toBe(openClientWidth);

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(settingsButton).toBeFocused();
  };

  await assertMenuAt375px();

  // Dialog flow: opening Add member from menu works and restores focus
  await settingsButton.click();
  const addMemberItem = row.getByRole("menuitem", { name: "Add member" });
  await expect(addMemberItem).toBeVisible();
  await addMemberItem.click();
  const dialog = page.getByRole("dialog", { name: `Add member to ${name}` });
  await expect(dialog).toBeVisible();
  const searchInput = dialog.getByRole("combobox", { name: "Search registered users" });
  await expect(searchInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settingsButton).toBeFocused();
});

test("board list renders board key below the name without wrapping it into the link and prevents overflow at 375px", async ({
  page,
}) => {
  await signup(page, uniqueEmail("board-key-order"), "Key Order User");
  const boardKey = randomBoardKey("O");
  const boardName = `Order Validation Board ${Date.now()}`;
  await createBoard(page, boardName, boardKey);

  await page.setViewportSize({ width: 375, height: 667 });
  await openBoardList(page);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBe(clientWidth);

  const boardRow = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: boardName }) });
  await expect(boardRow).toBeVisible();

  // Board key remains adjacent text below the linked name.
  const keySpan = boardRow.getByText(boardKey);
  const link = boardRow.getByRole("link", { name: boardName });

  const keyBox = await keySpan.boundingBox();
  const linkBox = await link.boundingBox();
  expect(keyBox).not.toBeNull();
  expect(linkBox).not.toBeNull();
  expect(keyBox!.y).toBeGreaterThan(linkBox!.y);

  // Link accessible name is still solely the board name
  await expect(link).toHaveAccessibleName(boardName);
});

test("human board URLs /board/$boardKey cutover: list click lands on /board/<KEY>, no UUID in URL, editing key invalidates old URL", async ({
  page,
}) => {
  await signup(page, uniqueEmail("board-url-key"), "URL Key User");
  const initialKey = randomBoardKey("I");
  const changedKey = randomBoardKey("C");
  const boardName = `URL Key Board ${Date.now()}`;
  const boardKey = await createBoard(page, boardName, initialKey);
  expect(boardKey).toBe(initialKey);

  // 1. Click link from boards list
  const link = page.getByRole("link", { name: boardName });
  await link.click();

  // URL is /board/<initialKey>
  await expect(page).toHaveURL(`/board/${initialKey}`);
  await expect(page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();

  // 2. Return to board list and change key to changedKey
  await openBoardList(page);
  const listRow = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: boardName }) });
  await listRow.getByRole("button", { name: `Board settings for ${boardName}` }).click();
  await listRow.getByRole("menuitem", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit board" });
  await editDialog.getByLabel("Board key").fill(changedKey);
  await editDialog.getByRole("button", { name: "Save" }).click();
  await expect(editDialog).toHaveCount(0);

  // 3. New URL works
  await page.goto(`/board/${changedKey}`);
  await expect(page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();

  // 4. Old URL is invalid: the route refuses the retired key without
  //    disclosing whether the board or the key is the reason
  await page.goto(`/board/${initialKey}`);
  await expectBoardAccessDenied(page, boardName);
});

test("column delete confirmation dialog supports cancellation, archives cards, and restores to surviving column", async ({
  page,
}) => {
  await signup(page, uniqueEmail("boards-column-delete"), "Column Delete User");

  const boardName = `Delete Column ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();

  await addColumn(page, "Backlog");
  await addColumn(page, "Doomed");
  await addCard(page, "Doomed", "Doomed card");

  const backlogColumn = columnByTitle(page, "Backlog");
  const doomedColumn = columnByTitle(page, "Doomed");
  const doomedCard = cardIn(doomedColumn, "Doomed card");
  await expect(backlogColumn).toBeVisible();
  await expect(doomedColumn).toBeVisible();
  await expect(doomedCard).toBeVisible();
  const cardId = await cardBody(doomedCard).getAttribute("data-card-id");
  expect(cardId).toBeTruthy();

  const deleteTrigger = doomedColumn.getByRole("button", {
    name: "Column actions for Doomed",
    exact: true,
  });
  const dialog = page.getByRole("alertdialog", { name: "Delete “Doomed”?", exact: true });
  /** Delete lives in the column's actions menu, so opening its confirmation is two clicks. */
  const openDeleteDialog = async () => {
    await deleteTrigger.click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  await openDeleteDialog();

  await expect(dialog).toHaveAttribute("aria-modal", "true");
  const cancelButton = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancelButton).toBeFocused();
  const populatedDescription =
    "The column will be deleted. Its card will be kept in Archived cards for 90 days.";
  await expect(dialog).toHaveAccessibleDescription(populatedDescription);
  await expect(dialog.getByText(populatedDescription, { exact: true })).toBeVisible();

  // Board and header are inert while dialog is open.
  await expect(page.locator(".boards-shell[inert]")).toBeVisible();
  
  // Backdrop non-dismissal: clicking outside the dialog does not dismiss it.
  await page.locator(".bg-overlay").click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeVisible();

  // 1. Cancel via button: dialog dismisses, column and card remain, focus restored to trigger.
  await cancelButton.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".boards-shell[inert]")).toHaveCount(0);
    await expect(doomedColumn).toBeVisible();
  await expect(doomedCard).toBeVisible();
  await expect(deleteTrigger).toBeFocused();

  // 2. Cancel via Escape: dialog dismisses, column and card remain, focus restored to trigger.
  await openDeleteDialog();
  await expect(cancelButton).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".boards-shell[inert]")).toHaveCount(0);
    await expect(doomedColumn).toBeVisible();
  await expect(doomedCard).toBeVisible();
  await expect(deleteTrigger).toBeFocused();

  // Unfiltered card count: filtering cards out does not change the dialog warning.
  const searchInput = page.getByLabel("Search cards");
  await searchInput.fill("nomatch");
  await expect(doomedCard).toHaveCount(0);
  await openDeleteDialog();
  await expect(dialog).toHaveAccessibleDescription(populatedDescription);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await searchInput.fill("");
  await expect(doomedCard).toBeVisible();

  // 3. Card-route history precedence: returning to ?card= clears the alert dialog and gives modal precedence to the card.
  const cardDialog = page.getByRole("dialog", { name: "Doomed card", exact: true });
  await doomedCard.click();
  await expect(cardDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cardDialog).toHaveCount(0);

  await openDeleteDialog();
  await expect(cancelButton).toBeFocused();
  await page.goBack();

  await expect(dialog).toHaveCount(0);
  await expect(cardDialog).toBeVisible();
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
  await expect(deleteTrigger).not.toBeFocused();
  await expect(cardDialog.locator(":focus")).toBeVisible();
  await expect(cardDialog.getByRole("button", { name: "Close card" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(cardDialog).toHaveCount(0);
  await expect(dialog).toHaveCount(0);

  // 4. Confirm deletion: dialog closes, column and its cards are removed over WebSocket.
  await openDeleteDialog();
  await expect(cancelButton).toBeFocused();

  const confirmButton = dialog.getByRole("button", {
    name: "Delete column",
    exact: true,
  });
  await confirmButton.click();
  await expect(dialog).toHaveCount(0);

  // Confirm deletion removes only Doomed + its card from active board.
  await expect(doomedColumn).toHaveCount(0);
  await expect(doomedCard).toHaveCount(0);
  await expect(backlogColumn).toBeVisible();

  // 5. Open header Archived cards; assert visible archive count/title, former column text,
  // 90-day countdown, Close initial focus, archive dialog + board/header inertness,
  // overlay non-dismissal and Escape restoring the archive trigger.
  const archiveTrigger = page.getByRole("button", { name: "Archived cards", exact: true });
  await expect(archiveTrigger).toBeVisible();
  await expect(archiveTrigger).toHaveText("Archive 1");
  await archiveTrigger.click();

  const archiveDialog = page.getByRole("dialog", { name: "Archived cards", exact: true });
  await expect(archiveDialog).toBeVisible();
  await expect(archiveDialog).toHaveAttribute("aria-modal", "true");

  const closeArchiveButton = archiveDialog.getByRole("button", {
    name: "Close archived cards",
    exact: true,
  });
  await expect(closeArchiveButton).toBeFocused();

  // Archive dialog keeps board and header inert.
  await expect(page.locator(".boards-shell[inert]")).toBeVisible();
  
  // Archive row details.
  await expect(
    archiveDialog.getByRole("heading", { name: "Doomed card", exact: true }),
  ).toBeVisible();
  await expect(archiveDialog.getByText("From Doomed", { exact: true })).toBeVisible();
  await expect(
    archiveDialog.getByText("Permanently deleted in 90 days.", { exact: true }),
  ).toBeVisible();

  // Overlay non-dismissal.
  await page.locator(".bg-overlay").click({ position: { x: 5, y: 5 } });
  await expect(archiveDialog).toBeVisible();

  // Escape restores the archive trigger.
  await page.keyboard.press("Escape");
  await expect(archiveDialog).toHaveCount(0);
  await expect(page.locator(".boards-shell[inert]")).toHaveCount(0);
    await expect(archiveTrigger).toBeFocused();

  // 6. Reopen archive, choose Backlog via native destination select, restore, keep dialog open, then close.
  await archiveTrigger.click();
  await expect(archiveDialog).toBeVisible();
  await expect(closeArchiveButton).toBeFocused();

  const destinationSelect = archiveDialog.getByLabel("Restore Doomed card to column", {
    exact: true,
  });
  await destinationSelect.selectOption({ label: "Backlog" });

  const restoreButton = archiveDialog.getByRole("button", {
    name: "Restore Doomed card",
    exact: true,
  });
  await restoreButton.click();

  // Dialog remains open showing empty state and Close focus.
  await expect(archiveDialog.getByText("No archived cards.", { exact: true })).toBeVisible();
  await expect(archiveDialog).toBeVisible();
  await expect(closeArchiveButton).toBeFocused();

  await closeArchiveButton.click();
  await expect(archiveDialog).toHaveCount(0);

  // 7. Assert restored card identity/title in Backlog and prove it survives reload.
  const restoredCard = cardIn(backlogColumn, "Doomed card");
  await expect(restoredCard).toBeVisible();
  await expect(cardBody(restoredCard)).toHaveAttribute("data-card-id", cardId!);

  await page.reload();
  const reloadedBacklogColumn = columnByTitle(page, "Backlog");
  await expect(reloadedBacklogColumn).toBeVisible();
  const reloadedRestoredCard = cardIn(reloadedBacklogColumn, "Doomed card");
  await expect(reloadedRestoredCard).toBeVisible();
  await expect(cardBody(reloadedRestoredCard)).toHaveAttribute("data-card-id", cardId!);
});

test("closing the column delete dialog does not steal focus from the search field mid-clear", async ({
  page,
}) => {
  await signup(page, uniqueEmail("boards-search-focus"), "Search Focus User");

  const boardName = `Search Focus ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();

  await addColumn(page, "Doomed");
  await addCard(page, "Doomed", "Doomed card");

  const doomedColumn = columnByTitle(page, "Doomed");
  const doomedCard = cardIn(doomedColumn, "Doomed card");
  const deleteTrigger = doomedColumn.getByRole("button", {
    name: "Column actions for Doomed",
    exact: true,
  });
  const deleteDialog = page.getByRole("alertdialog", { name: "Delete “Doomed”?", exact: true });
  const searchInput = page.getByLabel("Search cards");

  await searchInput.fill("nomatch");
  await expect(doomedCard).toHaveCount(0);

  await deleteTrigger.click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(deleteDialog).toBeVisible();

  // Escape hands focus back to the delete trigger on a later animation frame.
  // Claim the search field before that frame runs, assert the deferred restore
  // yields instead of stealing it, and only then clear the field: a restore
  // that did steal focus would drop the clear's Delete keystroke and leave the
  // board filtered. The microtask yields let React commit the dialog's unmount
  // (and drop the header's `inert`) without giving up a frame to the restore.
  await page.evaluate(async () => {
    document
      .querySelector('[role="alertdialog"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    for (let i = 0; i < 10 && document.querySelector('[role="alertdialog"]'); i += 1) {
      await Promise.resolve();
    }
    document.querySelector<HTMLElement>('input[aria-label="Search cards"]')?.focus();
  });
  await settleAnimationFrames(page);

  await expect(searchInput).toBeFocused();
  await searchInput.fill("");
  await expect(doomedCard).toBeVisible();
});

test("an archived card can be permanently deleted only after inline confirmation", async ({
  page,
}) => {
  await signup(page, uniqueEmail("boards-permanent-delete"), "Permanent Delete User");

  const boardName = `Permanent Delete ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();

  await addColumn(page, "Temporary");
  await addCard(page, "Temporary", "Erase forever");
  const temporaryColumn = columnByTitle(page, "Temporary");
  await temporaryColumn
    .getByRole("button", { name: "Column actions for Temporary", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const columnDialog = page.getByRole("alertdialog", {
    name: "Delete “Temporary”?",
    exact: true,
  });
  await columnDialog.getByRole("button", { name: "Delete column", exact: true }).click();
  await expect(temporaryColumn).toHaveCount(0);

  const archiveTrigger = page.getByRole("button", { name: "Archived cards", exact: true });
  await expect(archiveTrigger).toHaveText("Archive 1");
  await archiveTrigger.click();

  const archiveDialog = page.getByRole("dialog", { name: "Archived cards", exact: true });
  const archivedRow = archiveDialog
    .locator('[data-archived-card-id]')
    .filter({ hasText: "Erase forever" });
  const purgeTrigger = archivedRow.getByRole("button", {
    name: "Delete Erase forever permanently",
    exact: true,
  });
  await expect(purgeTrigger).toBeVisible();

  // Cancel restores the row action and focus.
  await purgeTrigger.click();
  const confirmation = archivedRow.getByRole("group", {
    name: "Confirm permanent deletion of Erase forever",
    exact: true,
  });
  await expect(confirmation).toContainText(
    "Permanently delete this card and everything on it? This cannot be undone.",
  );
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(purgeTrigger).toBeFocused();
  await expect(archivedRow).toBeVisible();

  // Escape consumes only the confirmation rung.
  await purgeTrigger.click();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(purgeTrigger).toBeFocused();
  await expect(archiveDialog).toBeVisible();

  await purgeTrigger.click();
  await confirmation
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(archivedRow).toHaveCount(0);
  await expect(archiveDialog.getByText("No archived cards.", { exact: true })).toBeVisible();
  await expect(
    archiveDialog.getByRole("button", { name: "Close archived cards", exact: true }),
  ).toBeFocused();
  await expect(archiveTrigger).toHaveText("Archive");

  await page.reload();
  await expect(page.getByRole("button", { name: "Archived cards", exact: true })).toHaveText(
    "Archive",
  );
  await expect(cardIn(columnByTitle(page, "Temporary"), "Erase forever")).toHaveCount(0);
});
test("permanently deletes a board", async ({ page }) => {
  await signup(page, uniqueEmail("board-delete"), "Delete Board User");

  const boardName = `Doomed Board ${Date.now()}`;
  const boardKey = await createBoard(page, boardName);

  const boardLink = page.getByRole("link", { name: boardName });
  await expect(boardLink).toBeVisible();

  const row = page.getByRole("listitem").filter({ has: boardLink });
  const settingsTrigger = row.getByRole("button", {
    name: `Board settings for ${boardName}`,
    exact: true,
  });
  await expect(settingsTrigger).toBeVisible();

  // 1. Open the named alert dialog; assert Cancel has initial focus
  await settingsTrigger.click();
  await row.getByRole("menuitem", { name: "Delete" }).click();

  const dialog = page.getByRole("alertdialog", { name: `Delete “${boardName}”?`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  const cancelButton = dialog.getByRole("button", { name: "Cancel", exact: true });
  const confirmationInput = dialog.getByRole("textbox", {
    name: `Type ${boardName} to confirm`,
    exact: true,
  });
  const confirmDeleteButton = dialog.getByRole("button", {
    name: "Delete board",
    exact: true,
  });
  await expect(cancelButton).toBeFocused();
  await expect(confirmationInput).toHaveValue("");
  await expect(confirmDeleteButton).toBeDisabled();

  // Confirmation is exact, case-sensitive, and does not trim whitespace.
  for (const value of [boardName.toLowerCase(), boardName.slice(0, -1), `${boardName} `]) {
    await confirmationInput.fill(value);
    await expect(confirmDeleteButton).toBeDisabled();
  }
  await confirmationInput.fill(boardName);
  await expect(confirmDeleteButton).toBeEnabled();

  // Assert exact irreversible warning is visible
  const warningText =
    "This permanently deletes every column, card, comment, attachment, and member connection on this board. This cannot be undone.";
  await expect(dialog).toHaveAccessibleDescription(warningText);
  await expect(dialog.getByText(warningText, { exact: true })).toBeVisible();

  // Assert page content is inert while dialog is open
  expect(await page.getByRole("main").evaluate((node) => Boolean(node.closest("[inert]")))).toBe(true);

  // Assert overlay click does not dismiss
  await page.locator(".bg-overlay").click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeVisible();

  // 2. Escape restores trigger focus
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settingsTrigger).toBeFocused();

  // Cancel restores trigger focus
  await settingsTrigger.click();
  await row.getByRole("menuitem", { name: "Delete" }).click();
  await expect(dialog).toBeVisible();
  await expect(cancelButton).toBeFocused();
  await cancelButton.click();
  await expect(dialog).toHaveCount(0);
  await expect(settingsTrigger).toBeFocused();

  // 3. Test pending disables both actions and failure retains dialog with alert then re-enables
  // 3. Test pending disables the input and both actions; failure retains exact input and re-enables
  await settingsTrigger.click();
  await row.getByRole("menuitem", { name: "Delete" }).click();
  await expect(dialog).toBeVisible();
  await confirmationInput.fill(boardName);
  // Intercept DELETE to hold request in pending state, verify single request and disabled controls, then fail with 500
  let fulfillFirstDelete!: () => void;
  const firstDeleteHold = new Promise<void>((resolve) => {
    fulfillFirstDelete = resolve;
  });
  let deleteCalls = 0;
  await page.route(
    new RegExp(`/boards/([0-9a-f-]+)(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "DELETE") {
        deleteCalls++;
        if (deleteCalls === 1) {
          await firstDeleteHold;
          return route.fulfill({ status: 500, json: { error: "could not delete board" } });
        }
        return route.continue();
      }
      return route.continue();
    },
  );

  // Click delete board: while pending, both actions disabled and label is "Deleting…"
  await confirmDeleteButton.click();

  const deletingButton = dialog.getByRole("button", { name: "Deleting…" });
  const cancelButtonWhilePending = dialog.getByRole("button", { name: "Cancel" });
  await expect(deletingButton).toBeVisible();
  await expect(deletingButton).toBeDisabled();
  await expect(cancelButtonWhilePending).toBeDisabled();
  await expect(confirmationInput).toBeDisabled();

  // Double-submit attempt while pending must be prevented / ignored
  await deletingButton.click({ force: true }).catch(() => {});
  expect(deleteCalls).toBe(1);
  // Fulfill the first delete with a simulated 500 failure.
  fulfillFirstDelete();

  // On failure, dialog stays open, displays role="alert" with exact message, re-enables actions
  const errorAlert = dialog.getByRole("alert");
  await expect(errorAlert).toBeVisible();
  await expect(errorAlert).toHaveText("Could not delete the board. Try again.");
  await expect(confirmationInput).toHaveValue(boardName);
  await expect(confirmationInput).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Delete board" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();

  // Retry successfully
  await dialog.getByRole("button", { name: "Delete board" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(boardLink).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Board deleted.");
  await expect(page.getByRole("button", { name: "New board" })).toBeFocused();

  // Reload keeps the row absent
  await page.reload();
  await expect(page.getByRole("link", { name: boardName })).toHaveCount(0);

  // Navigating to the deleted board's saved URL shows the nondisclosing
  // access-lost state the board route answers 403 and 404 with
  await page.goto(`/board/${boardKey}`);
  await expectBoardAccessDenied(page, boardName);

  // 4. At 375x667, repeat the row reachability/scrollWidth === clientWidth assertion with delete button present
  await openBoardList(page);
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();

  const mobileBoardName = `Mobile Board ${Date.now()}`;
  await createBoard(page, mobileBoardName);

  await page.setViewportSize({ width: 375, height: 667 });

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBe(clientWidth);

  const mobileBoardLink = page.getByRole("link", { name: mobileBoardName });
  await expect(mobileBoardLink).toBeVisible();

  const mobileRow = page.getByRole("listitem").filter({ has: mobileBoardLink });
  const mobileSettingsButton = mobileRow.getByRole("button", { name: `Board settings for ${mobileBoardName}` });
  await expect(mobileSettingsButton).toBeVisible();

  await mobileSettingsButton.click();
  const mobileAddMemberItem = mobileRow.getByRole("menuitem", { name: "Add member" });
  const mobileDeleteItem = mobileRow.getByRole("menuitem", { name: "Delete" });
  await expect(mobileAddMemberItem).toBeVisible();
  await expect(mobileDeleteItem).toBeVisible();

  await mobileDeleteItem.click();
  const mobileDialog = page.getByRole("alertdialog", {
    name: `Delete “${mobileBoardName}”?`,
    exact: true,
  });
  await expect(mobileDialog).toBeVisible();
  await mobileDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(mobileDialog).toHaveCount(0);
});

test("owner can edit board name and key with initial focus, cancel/escape focus restoration, retained drafts on error, and responsive layout", async ({
  page,
}) => {
  await signup(page, uniqueEmail("board-edit"), "Edit Board User");

  const originalName = `Project Alpha ${Date.now()}`;
  const originalKey = randomBoardKey("A");
  const boardId = await createBoard(page, originalName, originalKey);

  const boardLink = page.getByRole("link", { name: originalName });
  await expect(boardLink).toBeVisible();

  const row = page.getByRole("listitem").filter({ has: boardLink });
  const settingsTrigger = row.getByRole("button", {
    name: `Board settings for ${originalName}`,
    exact: true,
  });
  await expect(settingsTrigger).toBeVisible();

  // 1. Open edit dialog; assert role="dialog", aria-modal="true", initial name focus + selection, seeded uppercase key
  await settingsTrigger.click();
  await row.getByRole("menuitem", { name: "Edit" }).click();

  const dialog = page.getByRole("dialog", { name: "Edit board", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  const nameInput = dialog.getByLabel("Board name", { exact: true });
  const keyInput = dialog.getByLabel("Board key", { exact: true });
  const saveButton = dialog.getByRole("button", { name: "Save", exact: true });
  const cancelButton = dialog.getByRole("button", { name: "Cancel", exact: true });

  await expect(nameInput).toBeFocused();
  await expect(nameInput).toHaveValue(originalName);
  await expect(keyInput).toHaveValue(originalKey);

  // Verify name input is selected by checking selection range
  const selection = await nameInput.evaluate((el: HTMLInputElement) => ({
    start: el.selectionStart,
    end: el.selectionEnd,
  }));
  expect(selection.start).toBe(0);
  expect(selection.end).toBe(originalName.length);

  // Save is disabled while values are unchanged
  await expect(saveButton).toBeDisabled();

  // Typing lowercase into key input automatically uppercases and caps at 10 chars
  await keyInput.fill("toolongkey123");
  await expect(keyInput).toHaveValue("TOOLONGKEY");
  await keyInput.fill(originalKey);

  // Page content is inert while edit dialog is open
  expect(await page.getByRole("main").evaluate((node) => Boolean(node.closest("[inert]")))).toBe(true);

  // Overlay click does not dismiss dialog
  await page.locator(".bg-overlay").click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeVisible();

  // 2. Escape restores focus to edit trigger
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settingsTrigger).toBeFocused();

  // Cancel button restores focus to edit trigger
  await settingsTrigger.click();
  await row.getByRole("menuitem", { name: "Edit" }).click();
  await expect(dialog).toBeVisible();
  await expect(nameInput).toBeFocused();
  await cancelButton.click();
  await expect(dialog).toHaveCount(0);
  await expect(settingsTrigger).toBeFocused();

  // 3. Duplicate key error retains drafts and enables successful retry
  const collidingName = `Second Board ${Date.now()}`;
  const collidingKey = randomBoardKey("B");
  await createBoard(page, collidingName, collidingKey);

  const firstRow = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: originalName }) });
  const firstSettingsTrigger = firstRow.getByRole("button", {
    name: `Board settings for ${originalName}`,
    exact: true,
  });
  await firstSettingsTrigger.click();
  await firstRow.getByRole("menuitem", { name: "Edit" }).click();
  await expect(dialog).toBeVisible();

  // Change to colliding key and draft name
  const draftName = `${originalName} Draft`;
  await nameInput.fill(draftName);
  await keyInput.fill(collidingKey.toLowerCase());
  await expect(keyInput).toHaveValue(collidingKey);
  await expect(saveButton).toBeEnabled();

  await saveButton.click();

  // Dialog stays open, renders alert with duplicate key error, keeps drafts for correction
  const alert = dialog.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText("That board key is already in use.");
  await expect(nameInput).toHaveValue(draftName);
  await expect(keyInput).toHaveValue(collidingKey);
  await expect(nameInput).toBeEnabled();
  await expect(keyInput).toBeEnabled();

  // Fix key and retry successfully
  const updatedName = `Updated Project Alpha ${Date.now()}`;
  const updatedKey = randomBoardKey("U");
  await nameInput.fill(updatedName);
  await keyInput.fill(updatedKey);
  await saveButton.click();

  await expect(dialog).toHaveCount(0);
  const status = page.getByRole("status");
  await expect(status).toHaveText("Board updated.");

  // Row updates immediately and focus returns to updated edit trigger
  const updatedLink = page.getByRole("link", { name: updatedName });
  await expect(updatedLink).toBeVisible();
  const updatedRow = page.getByRole("listitem").filter({ has: updatedLink });
  await expect(updatedRow.getByText(updatedKey)).toBeVisible();
  const updatedSettingsTrigger = updatedRow.getByRole("button", {
    name: `Board settings for ${updatedName}`,
    exact: true,
  });
  await expect(updatedSettingsTrigger).toBeFocused();

  // Open board to observe updated heading and key
  await updatedLink.click();
  await expect(page).toHaveURL(`/board/${updatedKey}`);
  await expect(page.getByRole("heading", { name: updatedName, exact: true })).toBeVisible();
  await expect(page.getByText(updatedKey)).toBeVisible();
  // 4. Responsive at 375px: Edit, Delete, member controls reachable, no document overflow
  await openBoardList(page);
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 667 });

  const assertResponsiveControls = async () => {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBe(clientWidth);

    const targetRow = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: updatedName }) });
    const settingsBtn = targetRow.getByRole("button", { name: `Board settings for ${updatedName}` });
    await expect(settingsBtn).toBeVisible();

    await settingsBtn.click();
    const menu = targetRow.getByRole("menu");
    await expect(menu).toBeVisible();
    const addBtn = targetRow.getByRole("menuitem", { name: "Add member" });
    const editBtn = targetRow.getByRole("menuitem", { name: "Edit" });
    const deleteBtn = targetRow.getByRole("menuitem", { name: "Delete" });

    await expect(addBtn).toBeVisible();
    await expect(editBtn).toBeVisible();
    await expect(deleteBtn).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(settingsBtn).toBeFocused();
  };
  await assertResponsiveControls();
});

test("ordinary member has no Edit control, and configured admin outside board_members can edit", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signup(adminPage, uniqueEmail("outside-admin"), "Outside Admin");
  const { token: ownerToken } = await generateAccountInvite(adminPage);
  const { token } = await generateAccountInvite(adminPage);
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(`/signup?invite=${ownerToken}`);
  await ownerPage.getByLabel("Email").fill(uniqueEmail("owner", "user.test"));
  await ownerPage.getByLabel("Name").fill("Board Owner");
  await ownerPage.getByLabel("Password").fill(PASSWORD);
  await ownerPage.getByRole("button", { name: "Create account" }).click();
  await openPersonalWorkspace(ownerPage);
  expect(await (await ownerPage.request.get("/me")).json()).toMatchObject({ isAdmin: false });

  // A board belongs to its owner's workspace, so a guest or a configured admin
  // reaches it inside that workspace's context — never in their own list.
  const boardWorkspaceId = new URL(ownerPage.url()).pathname.replace("/w/", "");
  let boardName = `Restricted Board ${Date.now()}`;
  const boardKey = randomBoardKey("R");
  const boardId = await createBoard(ownerPage, boardName, boardKey);

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  const memberEmail = uniqueEmail("member", "user.test");
  await memberPage.goto(`/signup?invite=${token}`);
  await memberPage.getByLabel("Email").fill(memberEmail);
  await memberPage.getByLabel("Name").fill("Ordinary Member");
  await memberPage.getByLabel("Password").fill(PASSWORD);
  await memberPage.getByRole("button", { name: "Create account" }).click();
  await openPersonalWorkspace(memberPage);
  await expect(memberPage.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
  expect(await (await memberPage.request.get("/me")).json()).toMatchObject({ isAdmin: false });

  // Owner invites ordinary user to board
  await inviteMember(ownerPage, boardName, memberEmail);
  const ownerRow = ownerPage.getByRole("listitem").filter({
    has: ownerPage.getByRole("link", { name: boardName, exact: true }),
  });
  await ownerRow.getByRole("button", { name: `Board settings for ${boardName}` }).click();
  await ownerRow.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const ownerDialog = ownerPage.getByRole("dialog", { name: "Edit board", exact: true });
  boardName = `Owner Edited Board ${Date.now()}`;
  await ownerDialog.getByLabel("Board name").fill(boardName);
  await ownerDialog.getByLabel("Board key").fill(randomBoardKey("O"));
  await ownerDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(ownerDialog).toHaveCount(0);
  await expect(ownerPage.getByRole("link", { name: boardName, exact: true })).toBeVisible();

  // Ordinary member opens the board's workspace, sees the board there and has
  // NO Edit button and NO Delete button
  await memberPage.goto(`/w/${boardWorkspaceId}`);
  const memberBoardLink = memberPage.getByRole("link", { name: boardName });
  await expect(memberBoardLink).toBeVisible();
  const memberRow = memberPage.getByRole("listitem").filter({ has: memberBoardLink });
  const memberSettingsBtn = memberRow.getByRole("button", { name: `Board settings for ${boardName}` });
  await expect(memberSettingsBtn).toBeVisible();
  await memberSettingsBtn.click();
  await expect(memberRow.getByRole("menuitem", { name: "Add member" })).toBeVisible();
  await expect(memberRow.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
  await expect(memberRow.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
  await memberPage.keyboard.press("Escape");
  await expect(memberSettingsBtn).toBeFocused();

  // The configured administrator remains outside actual board membership, and
  // reaches the board through the workspace that owns it.
  await adminPage.goto(`/w/${boardWorkspaceId}`);
  const adminUser = await (await adminPage.request.get("/me")).json();
  expect(adminUser.isAdmin).toBe(true);
  const uuid = await getBoardUuid(ownerPage, boardName);
  const { members: actualMembers } = await (await adminPage.request.get(`/boards/${uuid}/members`)).json();
  expect(actualMembers.some((member: { id: string }) => member.id === adminUser.id)).toBe(false);

  const adminBoardLink = adminPage.getByRole("link", { name: boardName });
  await expect(adminBoardLink).toBeVisible();
  const adminRow = adminPage.getByRole("listitem").filter({ has: adminBoardLink });
  const adminSettingsBtn = adminRow.getByRole("button", {
    name: `Board settings for ${boardName}`,
    exact: true,
  });
  await expect(adminSettingsBtn).toBeVisible();

  // Outside admin opens edit dialog and updates the board
  await adminSettingsBtn.click();
  await adminRow.getByRole("menuitem", { name: "Edit" }).click();
  const editDialog = adminPage.getByRole("dialog", { name: "Edit board", exact: true });
  await expect(editDialog).toBeVisible();

  const adminUpdatedName = `Admin Edited Board ${Date.now()}`;
  const adminUpdatedKey = randomBoardKey("M");
  await editDialog.getByLabel("Board name").fill(adminUpdatedName);
  await editDialog.getByLabel("Board key").fill(adminUpdatedKey);
  await editDialog.getByRole("button", { name: "Save" }).click();

  await expect(editDialog).toHaveCount(0);
  await expect(adminPage.getByRole("status")).toHaveText("Board updated.");
  await expect(adminPage.getByRole("link", { name: adminUpdatedName })).toBeVisible();

  await ownerContext.close();
  await memberContext.close();
  await adminContext.close();
});

test("Add member dialog allows searching registered users, displays candidate details, supports keyboard/escape/focus, and announces success upon member addition", async ({
  browser,
}) => {
  // Admin creates invites for the test users (admin sees global boards, but owner should only see their own)
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const adminEmail = uniqueEmail("add-mem-admin");
  await signup(adminPage, adminEmail, "Admin Inviter");

  const { token: ownerInviteToken } = await generateAccountInvite(adminPage);
  const { token: token1 } = await generateAccountInvite(adminPage);
  const { token: token2 } = await generateAccountInvite(adminPage);

  // Register ordinary board owner (not an admin on @admin.test)
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const ownerEmail = uniqueEmail("add-mem-owner", "user.test");
  await ownerPage.goto(`/signup?invite=${ownerInviteToken}`);
  await ownerPage.getByLabel("Email").fill(ownerEmail);
  await ownerPage.getByLabel("Name").fill("Board Owner");
  await ownerPage.getByLabel("Password").fill(PASSWORD);
  await ownerPage.getByRole("button", { name: "Create account" }).click();
  await openPersonalWorkspace(ownerPage);
  await expect(ownerPage.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();

  // The board lives in the owner's workspace; a board guest reaches it only
  // inside that workspace's context.
  const boardWorkspaceId = new URL(ownerPage.url()).pathname.replace("/w/", "");
  const boardName = `Member Flow Board ${Date.now()}`;
  const boardKey = await createBoard(ownerPage, boardName);
  // Register User 1: Zoe Candidate
  const user1UniqueName = `Zoe ${Date.now()}`;
  const user1Context = await browser.newContext();
  const user1Page = await user1Context.newPage();
  const user1Email = uniqueEmail("zoe-cand", "foxban.test");
  await user1Page.goto(`/signup?invite=${token1}`);
  await user1Page.getByLabel("Email").fill(user1Email);
  await user1Page.getByLabel("Name").fill(user1UniqueName);
  await user1Page.getByLabel("Password").fill(PASSWORD);
  await user1Page.getByRole("button", { name: "Create account" }).click();
  await openPersonalWorkspace(user1Page);

  // Register User 2: Alex Candidate
  const user2UniqueName = `Alex ${Date.now()}`;
  const user2Context = await browser.newContext();
  const user2Page = await user2Context.newPage();
  const user2Email = uniqueEmail("alex-cand", "foxban.test");
  await user2Page.goto(`/signup?invite=${token2}`);
  await user2Page.getByLabel("Email").fill(user2Email);
  await user2Page.getByLabel("Name").fill(user2UniqueName);
  await user2Page.getByLabel("Password").fill(PASSWORD);
  await user2Page.getByRole("button", { name: "Create account" }).click();
  await openPersonalWorkspace(user2Page);

  // User 1 currently cannot access the board
  await user1Page.goto(`/board/${boardKey}`);
  await expectBoardAccessDenied(user1Page, boardName);

  // Return to owner page to test dialog interactions
  await openBoardList(ownerPage);
  const boardRow = ownerPage.getByRole("listitem").filter({ has: ownerPage.getByRole("link", { name: boardName }) });
  const settingsBtn = boardRow.getByRole("button", { name: `Board settings for ${boardName}` });
  await expect(settingsBtn).toBeVisible();

  // Compact viewport containment assertion (e.g. at 375x667): dialog fits without overflow
  await ownerPage.setViewportSize({ width: 375, height: 667 });
  await settingsBtn.click();
  await boardRow.getByRole("menuitem", { name: "Add member" }).click();
  const dialog = ownerPage.getByRole("dialog", { name: `Add member to ${boardName}` });
  await expect(dialog).toBeVisible();

  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  if (dialogBox) {
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(375);
  }
  const docOverflow = await ownerPage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(docOverflow.scrollWidth).toBe(docOverflow.clientWidth);

  // Restore standard viewport
  await ownerPage.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settingsBtn).toBeFocused();
  await ownerPage.setViewportSize({ width: 1280, height: 720 });

  // 1. Open dialog and check initial focus and presence of candidates
  await settingsBtn.click();
  await boardRow.getByRole("menuitem", { name: "Add member" }).click();
  await expect(dialog).toBeVisible();
  const searchInput = dialog.getByRole("combobox", { name: "Search registered users" });
  await expect(searchInput).toBeFocused();
  // Already added section contains the current board member (Board Owner) with "Added" status
  // and is not selectable or a listbox option
  const alreadyAddedList = dialog.getByRole("list", { name: "Already added members" });
  await expect(alreadyAddedList).toBeVisible();
  const ownerMemberItem = alreadyAddedList.getByRole("listitem").filter({ hasText: ownerEmail });
  await expect(ownerMemberItem).toBeVisible();
  await expect(ownerMemberItem.getByText("Board Owner")).toBeVisible();
  await expect(ownerMemberItem.getByText("Owner", { exact: true })).toBeVisible();
  await expect(ownerMemberItem.getByRole("button")).toHaveCount(0);
  await expect(dialog.getByRole("option").filter({ hasText: ownerEmail })).toHaveCount(0);

  // Candidates list should contain Zoe and Alex under Users listbox, but NOT the board owner
  const listbox = dialog.getByRole("listbox", { name: "Users" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option").filter({ hasText: user1Email })).toBeVisible();
  await expect(listbox.getByRole("option").filter({ hasText: user2Email })).toBeVisible();
  await expect(listbox.getByRole("option").filter({ hasText: ownerEmail })).toHaveCount(0);
  // 2. Test Tab and Shift+Tab wrap containment
  const cancelBtn = dialog.getByRole("button", { name: "Cancel" });
  const addMemberDialogBtn = dialog.getByRole("button", { name: "Add member" });

  // Tab backwards from first focusable element (searchInput) wraps to last focusable element (Cancel)
  await searchInput.focus();
  await expect(searchInput).toBeFocused();
  await ownerPage.keyboard.press("Shift+Tab");
  await expect(cancelBtn).toBeFocused();

  // Tab forwards from last focusable element wraps back to first element (searchInput)
  await ownerPage.keyboard.press("Tab");
  await expect(searchInput).toBeFocused();

  // 3. Test Escape key closes the dialog and restores focus to trigger button
  await ownerPage.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settingsBtn).toBeFocused();

  // 4. Test ArrowDown/ArrowUp keyboard navigation in options list, Enter selection, and Escape
  await settingsBtn.click();
  await boardRow.getByRole("menuitem", { name: "Add member" }).click();
  await expect(dialog).toBeVisible();
  await expect(searchInput).toBeFocused();
  // Wait for candidate query to settle and options to be present
  await expect(dialog.getByText("Loading users…")).toHaveCount(0);
  const optionButtons = listbox.getByRole("option");
  await expect(optionButtons.first()).toBeVisible();
  await expect(searchInput).toBeFocused();

  // ArrowDown from searchInput moves focus to first option in listbox
  await ownerPage.keyboard.press("ArrowDown");
  await expect(optionButtons.first()).toBeFocused();
  // ArrowDown/ArrowUp moves between options
  await ownerPage.keyboard.press("ArrowDown");
  await expect(optionButtons.nth(1)).toBeFocused();
  await ownerPage.keyboard.press("ArrowUp");
  await expect(optionButtons.first()).toBeFocused();

  // Escape closes dialog and restores trigger focus
  await ownerPage.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settingsBtn).toBeFocused();

  // 5. Search filtering: matching already-added member vs candidate honest no-match feedback
  await settingsBtn.click();
  await boardRow.getByRole("menuitem", { name: "Add member" }).click();
  await expect(dialog).toBeVisible();

  // Searching for owner matches under Already added, while Candidates shows "No matching users."
  await searchInput.fill(ownerEmail);
  await expect(alreadyAddedList.getByRole("listitem").filter({ hasText: ownerEmail })).toBeVisible();
  await expect(dialog.getByText("No matching users.")).toBeVisible();
  await expect(listbox.getByRole("option")).toHaveCount(0);
  // Pressing Enter when searching for already-added member must not select or submit
  await searchInput.press("Enter");
  await expect(addMemberDialogBtn).toBeDisabled();
  await expect(dialog).toBeVisible();

  // Searching for non-existent user shows no match in either section
  await searchInput.fill("NonExistentNameQuery12345");
  await expect(dialog.getByText("No matching users.")).toBeVisible();
  await expect(dialog.getByText("No matching current members.")).toBeVisible();
  await expect(listbox.getByRole("option")).toHaveCount(0);
  // 6. Select candidate, change search to already-added member/no-match -> Add button disabled, Enter does not add hidden selection
  await searchInput.fill(user1Email);
  await expect(dialog.getByText("No matching users.")).toHaveCount(0);
  const zoeOption = dialog.getByRole("option").filter({ hasText: user1Email });
  await expect(zoeOption).toBeVisible();

  // Pressing Enter selects Zoe
  await searchInput.press("Enter");
  await expect(zoeOption).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText(`Selected: ${user1UniqueName}`)).toBeVisible();
  await expect(addMemberDialogBtn).toBeEnabled();

  // Change search to an already-added member (owner): candidate match disappears, selection clears, Add button disabled
  await searchInput.fill(ownerEmail);
  await expect(alreadyAddedList.getByRole("listitem").filter({ hasText: ownerEmail })).toBeVisible();
  await expect(dialog.getByText("No matching users.")).toBeVisible();
  await expect(dialog.getByText(`Selected: ${user1UniqueName}`)).toHaveCount(0);
  await expect(addMemberDialogBtn).toBeDisabled();
  // Pressing Enter must NOT submit or add the hidden selection
  await searchInput.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(addMemberDialogBtn).toBeDisabled();

  // Clear and search for Zoe again, select and complete addition
  await searchInput.fill(user1Email);
  await expect(zoeOption).toBeVisible();
  await searchInput.press("Enter");
  await expect(zoeOption).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText(`Selected: ${user1UniqueName}`)).toBeVisible();
  await expect(addMemberDialogBtn).toBeEnabled();
  await searchInput.press("Enter");
  // 6. Dialog closes, focus restored to trigger, and success status announced
  await expect(dialog).toHaveCount(0);
  await expect(settingsBtn).toBeFocused();
  await expect(ownerPage.getByRole("status").filter({ hasText: `Added ${user1UniqueName} as member.` })).toBeVisible();

  // 7. Zoe now has board access
  await user1Page.goto(`/board/${boardKey}`);
  await expect(user1Page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await expect(user1Page.getByRole("button", { name: "Archived cards", exact: true })).toBeVisible();
  // 9. Delayed candidates route assertion: reopening dialog shows loading state and cached rows are not selectable while refetching
  await ownerPage.route("**/boards/*/membership-candidates", async (route) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 300);
    await promise;
    await route.continue();
  });

  await settingsBtn.click();
  await boardRow.getByRole("menuitem", { name: "Add member" }).click();
  await expect(dialog).toBeVisible();
  // While fetching, Loading users... is displayed and no options are rendered/selectable
  await expect(dialog.getByText("Loading users…")).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(0);

  // Once refetch completes, Zoe is absent from candidate options and present in Already added
  await expect(listbox.getByRole("option").filter({ hasText: user2Email })).toBeVisible();
  await expect(listbox.getByRole("option").filter({ hasText: user1Email })).toHaveCount(0);
  const zoeMemberItem = alreadyAddedList.getByRole("listitem").filter({ hasText: user1Email });
  await expect(zoeMemberItem).toBeVisible();
  await expect(zoeMemberItem.getByText(user1UniqueName)).toBeVisible();
  await ownerPage.unroute("**/boards/*/membership-candidates");

  // 10. Removal lifecycle: owner protection, confirmation, cancel/escape focus, and removal
  // Assert owner has Owner status and no Remove button
  const ownerItem = alreadyAddedList.getByRole("listitem").filter({ hasText: ownerEmail });
  await expect(ownerItem.getByText("Owner", { exact: true })).toBeVisible();
  await expect(ownerItem.getByRole("button", { name: /Remove/ })).toHaveCount(0);

  // Zoe has a Remove button
  const zoeRemoveTrigger = zoeMemberItem.getByRole("button", {
    name: `Remove member ${user1UniqueName}`,
  });
  await expect(zoeRemoveTrigger).toBeVisible();

  // Clicking Remove opens row-local confirmation and focuses Cancel
  await zoeRemoveTrigger.click();
  const confirmGroup = zoeMemberItem.getByRole("group", {
    name: `Confirm removal of ${user1UniqueName}`,
  });
  await expect(confirmGroup).toBeVisible();
  const cancelRemoveBtn = confirmGroup.getByRole("button", { name: "Cancel", exact: true });
  const confirmRemoveBtn = confirmGroup.getByRole("button", { name: "Remove member", exact: true });
  await expect(cancelRemoveBtn).toBeFocused();

  // Test Cancel button cancels confirmation and restores focus to Remove trigger without removing member
  await cancelRemoveBtn.click();
  await expect(confirmGroup).toHaveCount(0);
  await expect(zoeRemoveTrigger).toBeFocused();
  await expect(zoeMemberItem).toBeVisible();

  // Open confirmation again and test Escape cancels confirmation and restores focus to Remove trigger
  await zoeRemoveTrigger.click();
  await expect(confirmGroup).toBeVisible();
  await expect(cancelRemoveBtn).toBeFocused();
  await ownerPage.keyboard.press("Escape");
  await expect(confirmGroup).toHaveCount(0);
  await expect(zoeRemoveTrigger).toBeFocused();
  await expect(dialog).toBeVisible(); // Dialog stays open!
  // Delay DELETE /boards/*/members/* to assert slow pending state keeps search input disabled
  await ownerPage.route("**/boards/*/members/*", async (route) => {
    if (route.request().method() === "DELETE") {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 300);
      await promise;
    }
    await route.continue();
  });

  // Open confirmation again and confirm removal
  await zoeRemoveTrigger.click();
  await expect(confirmGroup).toBeVisible();
  await confirmRemoveBtn.click();

  // While DELETE is pending, search input is disabled
  await expect(searchInput).toBeDisabled();

  // Once removal completes:
  // 1. Dialog remains open
  await expect(dialog).toBeVisible();
  // 2. Exact polite status announcement is visible: "Removed <name> from the board."
  await expect(dialog.locator('div[aria-live="polite"]')).toHaveText(
    `Removed ${user1UniqueName} from the board.`,
  );
  // 3. Search input is focused and re-enabled
  await expect(searchInput).toBeFocused();
  await expect(searchInput).toBeEnabled();
  // 4. Zoe moves from Already added to Add someone candidates
  await expect(alreadyAddedList.getByRole("listitem").filter({ hasText: user1Email })).toHaveCount(0);
  await expect(listbox.getByRole("option").filter({ hasText: user1Email })).toBeVisible();
  await expect(listbox.getByRole("option").filter({ hasText: user2Email })).toBeVisible();
  await ownerPage.unroute("**/boards/*/members/*");

  // Close dialog with Escape and verify focus returns to board Add member button
  await ownerPage.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settingsBtn).toBeFocused();

  // Zoe's access to the board is now revoked: the saved board URL answers with
  // the same nondisclosing state as any other refused key
  await user1Page.goto(`/board/${boardKey}`);
  await expectBoardAccessDenied(user1Page, boardName);

  // 11. Add Zoe back so we can test the non-owner viewer perspective on board list / dialog
  await settingsBtn.click();
  await boardRow.getByRole("menuitem", { name: "Add member" }).click();
  await expect(dialog).toBeVisible();
  await searchInput.fill(user1Email);
  const zoeOptionReadd = dialog.getByRole("option").filter({ hasText: user1Email });
  await expect(zoeOptionReadd).toBeVisible();
  await searchInput.press("Enter");
  await searchInput.press("Enter");
  await expect(dialog).toHaveCount(0);

  // Now Zoe visits the board's workspace and opens Add member dialog for the board
  await user1Page.goto(`/w/${boardWorkspaceId}`);
  const zoeBoardRow = user1Page
    .getByRole("listitem")
    .filter({ has: user1Page.getByRole("link", { name: boardName }) });
  const zoeSettingsBtn = zoeBoardRow.getByRole("button", { name: `Board settings for ${boardName}` });
  await expect(zoeSettingsBtn).toBeVisible();
  await zoeSettingsBtn.click();
  await zoeBoardRow.getByRole("menuitem", { name: "Add member" }).click();
  const zoeDialog = user1Page.getByRole("dialog", { name: `Add member to ${boardName}` });
  await expect(zoeDialog).toBeVisible();

  const zoeAlreadyAddedList = zoeDialog.getByRole("list", { name: "Already added members" });
  await expect(zoeAlreadyAddedList).toBeVisible();

  // For Zoe (current non-owner viewer):
  // - Owner item shows "Owner" badge and no Remove button
  const zoeViewOwnerItem = zoeAlreadyAddedList.getByRole("listitem").filter({ hasText: ownerEmail });
  await expect(zoeViewOwnerItem.getByText("Owner", { exact: true })).toBeVisible();
  await expect(zoeViewOwnerItem.getByRole("button", { name: /Remove/ })).toHaveCount(0);

  // - Self item (Zoe) shows "You" badge and no Remove button
  const zoeViewSelfItem = zoeAlreadyAddedList.getByRole("listitem").filter({ hasText: user1Email });
  await expect(zoeViewSelfItem.getByText("You", { exact: true })).toBeVisible();
  await expect(zoeViewSelfItem.getByRole("button", { name: /Remove/ })).toHaveCount(0);

  await user1Page.keyboard.press("Escape");
  await user1Context.close();
  await user2Context.close();
  await ownerContext.close();
  await adminContext.close();
});

test("cross-task key change consequence: opens OLDKEY-1, edits key to NEWKEY, cached board uses NEWKEY-1 while OLDKEY-1 cleans with UUID/task unchanged", async ({
  page,
}) => {
  await signup(page, uniqueEmail("key-change"), "Key Change User");

  const oldKey = randomBoardKey("O");
  const boardName = `Task Board ${Date.now()}`;
  const boardId = await createBoard(page, boardName, oldKey);

  const boardLink = page.getByRole("link", { name: boardName });
  await expect(boardLink).toBeVisible();
  await boardLink.click();
  await expect(page).toHaveURL(`/board/${oldKey}`);
  await expect(page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();

  // Create column and card 1
  await addColumn(page, "Backlog");
  const cardTitle = "Persistent Task Item";
  await addCard(page, "Backlog", cardTitle);

  const backlogCol = columnByTitle(page, "Backlog");
  const card = cardIn(backlogCol, cardTitle);
  await expect(card.getByText(`${oldKey}-1`)).toBeVisible();

  // Capture card UUID from DOM data-card-id
  const cardUuid = await cardBody(card).getAttribute("data-card-id");
  expect(cardUuid).toBeTruthy();

  // 1. Open ?card=OLDKEY-1
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/board/${oldKey}\\?card=${oldKey}-1$`));
  const cardModal = page.getByRole("dialog", { name: cardTitle });
  await expect(cardModal).toBeVisible();
  await expect(cardModal.getByText(`${oldKey}-1`)).toBeVisible();

  // Close card modal
  await cardModal.getByRole("button", { name: "Close card", exact: true }).click();
  await expect(cardModal).toHaveCount(0);
  await expect(page).toHaveURL(`/board/${oldKey}`);

  // 2. Return to board list and change key to NEWKEY
  await openBoardList(page);
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();

  const listRow = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: boardName }) });
  const settingsBtn = listRow.getByRole("button", {
    name: `Board settings for ${boardName}`,
    exact: true,
  });
  await settingsBtn.click();
  await listRow.getByRole("menuitem", { name: "Edit" }).click();

  const editDialog = page.getByRole("dialog", { name: "Edit board", exact: true });
  await expect(editDialog).toBeVisible();

  const newKey = randomBoardKey("N");
  const keyInput = editDialog.getByLabel("Board key");
  await keyInput.fill(newKey);
  await editDialog.getByRole("button", { name: "Save" }).click();

  await expect(editDialog).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Board updated.");

  // 3. Revisit the cached board via list navigation
  const updatedBoardLink = page.getByRole("link", { name: boardName });
  await updatedBoardLink.click();
  await expect(page).toHaveURL(`/board/${newKey}`);
  await expect(page.getByText(newKey, { exact: true })).toBeVisible();

  // Card front now renders NEWKEY-1, while preserving card UUID and task number 1
  const updatedCard = cardIn(columnByTitle(page, "Backlog"), cardTitle);
  await expect(updatedCard.getByText(`${newKey}-1`)).toBeVisible();
  const updatedCardUuid = await cardBody(updatedCard).getAttribute("data-card-id");
  expect(updatedCardUuid).toBe(cardUuid);

  // Opening card produces URL ?card=NEWKEY-1
  await updatedCard.click();
  await expect(page).toHaveURL(new RegExp(`/board/${newKey}\\?card=${newKey}-1$`));
  const updatedModal = page.getByRole("dialog", { name: cardTitle });
  await expect(updatedModal).toBeVisible();
  await expect(updatedModal.getByText(`${newKey}-1`)).toBeVisible();
  await updatedModal.getByRole("button", { name: "Close card", exact: true }).click();
  await expect(updatedModal).toHaveCount(0);

  // 4. Saved OLDKEY-1 deep link cleans to board without modal, while preserving filters
  await page.goto(`/board/${newKey}?card=${oldKey}-1&view=full&attachment=old-att&q=Persistent`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(`/board/${newKey}?q=Persistent`);
  await expect(page.getByPlaceholder("Search cards")).toHaveValue("Persistent");

  // The card itself is still intact on the board with the same UUID and title
  const survivingCard = cardIn(columnByTitle(page, "Backlog"), cardTitle);
  await expect(survivingCard).toBeVisible();
  expect(await cardBody(survivingCard).getAttribute("data-card-id")).toBe(cardUuid);
  await expect(survivingCard.getByText(`${newKey}-1`)).toBeVisible();
});

test("board actions menu supports full 4-item authorized order, keyboard navigation, wrapping, Home/End, Escape, and outside pointer dismissal", async ({
  page,
}) => {
  await signup(page, uniqueEmail("menu-a11y"), "Menu A11y User");

  const boardName = `A11y Board ${Date.now()}`;
  await createBoard(page, boardName);

  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: boardName }) });
  const cog = row.getByRole("button", { name: `Board settings for ${boardName}` });
  await expect(cog).toBeVisible();
  await expect(cog).toHaveAttribute("aria-haspopup", "menu");
  await expect(cog).toHaveAttribute("aria-expanded", "false");

  // 1. Open menu and assert initial focus on first item and full 4-item authorized order
  await cog.click();
  await expect(cog).toHaveAttribute("aria-expanded", "true");
  const menu = row.getByRole("menu");
  await expect(menu).toBeVisible();

  const addMemberItem = row.getByRole("menuitem", { name: "Add member" });
  const editItem = row.getByRole("menuitem", { name: "Edit" });
  const moveItem = row.getByRole("menuitem", { name: "Move workspace" });
  const deleteItem = row.getByRole("menuitem", { name: "Delete" });

  // Verify full 4-item list order: Add member -> Edit -> Move workspace -> Delete. Boards own no GitHub repository (ADR 0064).
  const menuItems = menu.getByRole("menuitem");
  await expect(menuItems).toHaveCount(4);
  await expect(row.getByRole("menuitem", { name: "GitHub" })).toHaveCount(0);
  await expect(menuItems.nth(0)).toHaveText("Add member");
  await expect(menuItems.nth(1)).toHaveText("Edit");
  await expect(menuItems.nth(2)).toHaveText("Move workspace");
  await expect(menuItems.nth(3)).toHaveText("Delete");

  await expect(addMemberItem).toBeFocused();

  // 2. ArrowDown walks items in order
  await page.keyboard.press("ArrowDown");
  await expect(editItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(moveItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(deleteItem).toBeFocused();

  // 3. ArrowDown wrapping from last (Delete) to first (Add member)
  await page.keyboard.press("ArrowDown");
  await expect(addMemberItem).toBeFocused();

  // 4. ArrowUp wrapping from first (Add member) to last (Delete)
  await page.keyboard.press("ArrowUp");
  await expect(deleteItem).toBeFocused();

  // 5. Home and End keys
  await page.keyboard.press("Home");
  await expect(addMemberItem).toBeFocused();
  await page.keyboard.press("End");
  await expect(deleteItem).toBeFocused();

  // 6. Escape dismissal restores focus to cog trigger
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(cog).toHaveAttribute("aria-expanded", "false");
  await expect(cog).toBeFocused();

  // 7. Outside pointer dismissal restores focus to cog trigger
  await cog.click();
  await expect(menu).toBeVisible();
  await page.locator("body").click({ position: { x: 10, y: 10 } });
  await expect(menu).toHaveCount(0);
});
