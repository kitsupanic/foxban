import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardBody,
  cardIn,
  columnByTitle,
  columns,
  createBoard,
  generateAccountInvite,
  inviteMember,
  signup,
  settleAnimationFrames,
  uniqueEmail,
} from "./helpers";

/** Signs a fresh user up and opens a board with "Todo" and "Done" columns. */
async function openBoard(page: Page, suffix: string): Promise<void> {
  await signup(page, uniqueEmail(suffix), "Shortcut User");
  const boardName = `Shortcuts ${suffix} ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addColumn(page, "Done");
}

/**
 * A signed-up user in its own browser context (own cookie jar). The default
 * admin domain needs no invite; a plain `user.test` member needs the invite
 * token an admin generated for it.
 */
async function newUser(
  browser: Browser,
  suffix: string,
  name: string,
  joined: { domain?: string; invite?: string } = {},
): Promise<{ page: Page; email: string; name: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail(suffix, joined.domain ?? "admin.test");
  await signup(page, email, name, joined.invite);
  return { page, email, name };
}

/** The board heading is a safe place to park focus: not a field, so the shortcut guard lets the keystroke through. */
async function parkFocus(page: Page): Promise<void> {
  await page.getByRole("heading", { level: 1 }).click();
}

test("n opens the first column's creation dialog without creating anything", async ({ page }) => {
  await openBoard(page, "shortcut-n");
  await parkFocus(page);

  await page.keyboard.press("n");

  const dialog = page.getByRole("dialog", { name: "Create a card" });
  await expect(dialog).toBeVisible();
  // The typed title goes to the dialog's field, not to the shortcut.
  await expect(dialog.getByLabel("Title")).toBeFocused();
  await expect(dialog.getByLabel("Title")).toHaveValue("");
  // The first sorted column is preselected, and opening created nothing.
  await expect(dialog.getByRole("button", { name: "Status" })).toHaveText("Todo");
  await expect(columnByTitle(page, "Todo").locator("[data-card-title]")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(columnByTitle(page, "Todo").locator("[data-card-title]")).toHaveCount(0);
});

test("c opens the Add a column dialog and creates nothing until submitted", async ({ page }) => {
  await openBoard(page, "shortcut-c");
  await parkFocus(page);

  await page.keyboard.press("c");

  const dialog = page.getByRole("dialog", { name: "Add a column" });
  await expect(dialog).toBeVisible();
  const nameInput = dialog.getByLabel("Column name");
  await expect(nameInput).toBeFocused();
  await nameInput.fill("Draft only");
  await expect(columns(page)).toHaveCount(2);

  // Cancel discards the draft, and reopening starts clean.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(columns(page)).toHaveCount(2);

  await page.keyboard.press("c");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Column name")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(columns(page)).toHaveCount(2);
});

test("m toggles Assigned to me only from an unmodified board target", async ({ page }) => {
  await openBoard(page, "shortcut-m");
  const assignedToMe = page.getByRole("button", {
    name: "Assigned to me",
    exact: true,
  });
  const search = page.getByLabel("Search cards");

  await search.focus();
  await page.keyboard.press("m");
  await expect(search).toHaveValue("m");
  expect(new URL(page.url()).searchParams.get("assignees")).toBeNull();
  await expect(assignedToMe).toHaveAttribute("aria-pressed", "false");
  await search.fill("");
  await search.blur();

  await page.evaluate(() => {
    const heading = document.querySelector("h1");
    if (!(heading instanceof HTMLElement)) throw new Error("Board heading not found");
    for (const init of [
      { repeat: true },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      heading.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true, ...init }));
    }
  });
  expect(new URL(page.url()).searchParams.get("assignees")).toBeNull();
  await expect(assignedToMe).toHaveAttribute("aria-pressed", "false");

  await page.evaluate(() => {
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    const nested = document.createElement("span");
    editable.append(nested);
    document.body.append(textarea, select, editable);
    for (const target of [textarea, select, nested]) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true }));
    }
    textarea.remove();
    select.remove();
    editable.remove();
  });
  expect(new URL(page.url()).searchParams.get("assignees")).toBeNull();
  await expect(assignedToMe).toHaveAttribute("aria-pressed", "false");

  await parkFocus(page);
  await page.keyboard.press("m");
  await expect(assignedToMe).toHaveAttribute("aria-pressed", "true");
  expect(new URL(page.url()).searchParams.get("assignees")).toBeTruthy();

  await page.keyboard.press("m");
  await expect(assignedToMe).toHaveAttribute("aria-pressed", "false");
  expect(new URL(page.url()).searchParams.get("assignees")).toBeNull();
});

test("committing a column rename does not steal focus from the search field", async ({ page }) => {
  await openBoard(page, "shortcut-rename-focus");
  const search = page.getByLabel("Search cards");
  const todo = columnByTitle(page, "Todo");

  await todo.getByRole("button", { name: "Rename column Todo", exact: true }).click();
  const titleInput = todo.locator("header input");
  await expect(titleInput).toBeFocused();
  await titleInput.fill("Later");

  // Committing the rename hands focus back to the rename button on a later
  // animation frame. Move to the search field in the same task so that frame
  // lands while the field owns the keyboard: the restore must yield, or the
  // "m" below would reach the board shortcut instead of the field.
  await page.evaluate(() => {
    const editors = document.querySelectorAll<HTMLInputElement>(
      "[data-column-id] header input",
    );
    editors[editors.length - 1]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    document.querySelector<HTMLElement>('input[aria-label="Search cards"]')?.focus();
  });
  await settleAnimationFrames(page);

  await expect(search).toBeFocused();
  await page.keyboard.press("m");
  await expect(search).toHaveValue("m");
  expect(new URL(page.url()).searchParams.get("assignees")).toBeNull();
});

test("Space and arrow keys reorder a card within its column", async ({ page }) => {
  await openBoard(page, "shortcut-kbd");
  await addCard(page, "Todo", "first card");
  await addCard(page, "Todo", "second card");

  const todo = columnByTitle(page, "Todo");
  await expect(todo.locator("li").nth(0)).toContainText("first card");

  // dnd-kit's sortable attributes make the card a focusable `role=button`, so
  // the KeyboardSensor picks it up: Space lifts, ArrowDown moves, Space drops.
  const card = cardIn(todo, "first card");
  const body = cardBody(card);
  const assignedToMe = page.getByRole("button", {
    name: "Assigned to me",
    exact: true,
  });
  await body.focus();
  await page.keyboard.press("Space");
  // `aria-pressed` is dnd-kit's own signal that the drag is live.
  await expect(body).toHaveAttribute("aria-pressed", "true");
  const preview = page.getByTestId("card-drag-preview");
  await expect(preview).toBeVisible();
  // m is suppressed while a drag is live, then works again after the drop.
  await page.keyboard.press("m");
  expect(new URL(page.url()).searchParams.get("assignees")).toBeNull();
  await expect(assignedToMe).toHaveAttribute("aria-pressed", "false");
  await expect(body).toHaveAttribute("aria-pressed", "true");
  const initialPreviewBox = await preview.boundingBox();
  expect(initialPreviewBox).not.toBeNull();
  // n is suppressed while a drag is live: the keyboard belongs to the sensor.
  await page.keyboard.press("n");
  await expect(page.getByRole("dialog", { name: "Create a card" })).toHaveCount(0);
  await expect(body).toHaveAttribute("aria-pressed", "true");
  // The sensor's keydown listener is attached in a `setTimeout` after the lift
  // (KeyboardSensor.attach), so an arrow pressed too early is silently dropped.
  // Repeat it until the visible preview y exceeds its lift-time y: with two cards
  // the bottom slot clamps, so a surplus press moves nothing.
  await expect(async () => {
    await page.keyboard.press("ArrowDown");
    const currentBox = await preview.boundingBox();
    expect(currentBox).not.toBeNull();
    expect(currentBox!.y).toBeGreaterThan(initialPreviewBox!.y);
  }).toPass({ timeout: 5000 });
  await page.keyboard.press("Space");
  await expect(body).not.toHaveAttribute("aria-pressed", "true");

  await expect(todo.locator("li").nth(0)).toContainText("second card");
  await expect(todo.locator("li").nth(1)).toContainText("first card");
  await page.keyboard.press("m");
  await expect(assignedToMe).toHaveAttribute("aria-pressed", "true");
  expect(new URL(page.url()).searchParams.get("assignees")).toBeTruthy();
});

test("the help button opens the keyboard shortcuts dialog", async ({ page }) => {
  await openBoard(page, "shortcut-help");

  const shortcutsButton = page.getByRole("button", { name: "Keyboard shortcuts" });
  const shortcutsDialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcutsButton).toHaveAttribute("aria-haspopup", "dialog");
  await expect(shortcutsButton).toHaveAttribute("aria-expanded", "false");
  await expect(shortcutsDialog).toHaveCount(0);

  await shortcutsButton.click();
  await expect(shortcutsButton).toHaveAttribute("aria-expanded", "true");
  await expect(shortcutsDialog).toBeVisible();
  // The close control starts the dialog, and every row states its own key.
  const closeButton = shortcutsDialog.getByRole("button", { name: "Close dialog" });
  await expect(closeButton).toBeFocused();
  await expect(shortcutsDialog.getByText("Search cards")).toBeVisible();
  await expect(shortcutsDialog.getByText("Add card to first column")).toBeVisible();
  await expect(shortcutsDialog.getByText("Add column")).toBeVisible();
  await expect(shortcutsDialog.getByText("Assigned to me")).toBeVisible();
  await expect(shortcutsDialog.getByText("Pick up focused card")).toBeVisible();
  await expect(shortcutsDialog.getByText("Move picked-up card")).toBeVisible();
  await expect(shortcutsDialog.getByText("Close or cancel")).toBeVisible();
  // Tab is trapped inside the panel.
  await page.keyboard.press("Shift+Tab");
  await expect(closeButton).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(shortcutsDialog).toHaveCount(0);
  await expect(shortcutsButton).toHaveAttribute("aria-expanded", "false");
  await expect(shortcutsButton).toBeFocused();

  // Backdrop dismissal closes it too, and the trigger stays reachable.
  await shortcutsButton.click();
  await expect(shortcutsDialog).toBeVisible();
  await page.locator(".boards-dialog-overlay").click({ position: { x: 5, y: 5 } });
  await expect(shortcutsDialog).toHaveCount(0);
  await expect(shortcutsButton).toHaveAttribute("aria-expanded", "false");
});

test("board creation dialogs preserve selections and cancellation", async ({ browser }) => {
  const ada = await newUser(browser, "creation-ada", "Ada Creator");
  const { token } = await generateAccountInvite(ada.page);
  const bo = await newUser(browser, "creation-bo", "Bo Creator", {
    domain: "user.test",
    invite: token,
  });
  const boardName = `Creation Board ${Date.now()}`;
  const boardKey = await createBoard(ada.page, boardName);
  await inviteMember(ada.page, boardName, bo.email);
  await ada.page.goto(`/board/${boardKey}`);
  await expect(ada.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await addColumn(ada.page, "Todo");
  await addColumn(ada.page, "Done");
  await parkFocus(ada.page);

  // N opens the first column's dialog and creates nothing.
  await ada.page.keyboard.press("n");
  const dialog = ada.page.getByRole("dialog", { name: "Create a card" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Status" })).toHaveText("Todo");
  await expect(columns(ada.page).locator("[data-card-title]")).toHaveCount(0);

  // Every selection the dialog offers survives to the created card.
  await dialog.getByLabel("Title").fill("Configured card");
  await dialog.getByRole("button", { name: "Status" }).click();
  await dialog.getByRole("option", { name: "Done" }).click();
  await dialog.getByRole("button", { name: "Type" }).click();
  await dialog.getByRole("option", { name: "Epic" }).click();
  await dialog.getByRole("button", { name: "Priority" }).click();
  await dialog.getByRole("option", { name: "Highest" }).click();
  await dialog.getByRole("button", { name: "Assignee" }).click();
  await dialog.getByRole("option", { name: "Bo Creator" }).click();
  // A picker's Escape closes its list, not the dialog.
  await dialog.getByRole("button", { name: "Type" }).click();
  await ada.page.keyboard.press("Escape");
  await expect(dialog.getByRole("option", { name: "Epic" })).toHaveCount(0);
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Create card" }).click();
  await expect(dialog).toHaveCount(0);

  const doneColumn = columnByTitle(ada.page, "Done");
  const created = cardIn(doneColumn, "Configured card");
  await expect(created).toBeVisible();
  await expect(created.locator("[data-task-type]")).toHaveAttribute("data-task-type", "epic");
  await expect(created.getByTestId("priority-badge")).toHaveAttribute(
    "aria-label",
    "Highest priority",
  );
  await expect(created.getByRole("img", { name: "Assigned to Bo Creator" })).toBeVisible();
  await expect(columnByTitle(ada.page, "Todo").locator("[data-card-title]")).toHaveCount(0);

  // The peer receives the fully configured card.
  await bo.page.goto(`/board/${boardKey}`);
  const peerCard = cardIn(columnByTitle(bo.page, "Done"), "Configured card");
  await expect(peerCard).toBeVisible();
  await expect(peerCard.locator("[data-task-type]")).toHaveAttribute("data-task-type", "epic");

  // And it survives a reload as one card, never a duplicate.
  await ada.page.reload();
  await expect(ada.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await expect(cardIn(columnByTitle(ada.page, "Done"), "Configured card")).toHaveCount(1);

  // A per-column trigger preselects its own column, and cancelling creates nothing.
  const doneFooter = columnByTitle(ada.page, "Done").getByRole("button", {
    name: "Add card",
    exact: true,
  });
  await doneFooter.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Status" })).toHaveText("Done");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(doneFooter).toBeFocused();
  await expect(columns(ada.page).locator("[data-card-title]")).toHaveCount(1);

  // The header Plus is the same entry point for its column.
  const donePlus = columnByTitle(ada.page, "Done").getByRole("button", {
    name: "Add card to Done",
  });
  await donePlus.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Status" })).toHaveText("Done");
  await ada.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(donePlus).toBeFocused();

  // New card opens for the first column and restores focus to itself on cancel.
  const newCard = ada.page.getByRole("button", { name: "New card" });
  await newCard.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Status" })).toHaveText("Todo");
  await ada.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(newCard).toBeFocused();

  await bo.page.context().close();
  await ada.page.context().close();
});

test("an uncertain creation recovers through the connection Retry", async ({ page }) => {
  // The board takes the creation; only its echo is held back. The transport is
  // then taken away, so the retry budget runs out while the form is still locked.
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "card.create") return;
      ws.send(message);
    });
    ws.onMessage((message) => server.send(message));
  });

  await openBoard(page, "creation-terminal");
  const todo = columnByTitle(page, "Todo");
  await todo.getByRole("button", { name: "Add card", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a card" });
  await dialog.getByLabel("Title").fill("Recovered card");
  await dialog.getByRole("button", { name: "Create card" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Checking whether creation completed");

  await page.context().setOffline(true);
  await expect(dialog.getByText("Could not connect.")).toBeVisible({ timeout: 40_000 });

  // Terminal failure must not strand the reader: the transport retry stays usable
  // while the submitted values stay locked.
  const retry = dialog.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  await expect(dialog.getByLabel("Title")).toBeDisabled();

  await page.context().setOffline(false);
  await retry.click();
  await expect(dialog).toHaveCount(0, { timeout: 40_000 });
  await expect(cardIn(todo, "Recovered card")).toHaveCount(1);
  await page.reload();
  await expect(cardIn(columnByTitle(page, "Todo"), "Recovered card")).toHaveCount(1);
});

test("an empty board's column dialog hands focus to a usable control", async ({ page }) => {
  await signup(page, uniqueEmail("creation-empty"), "Empty Board User");
  const boardName = `Empty ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  // The loaded empty board: no snapshot yet means no canvas controls to focus.
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  const newCard = page.getByRole("button", { name: "New card" });
  await expect(newCard).toBeDisabled();
  await expect(newCard).toHaveAttribute("title", "Add a column before creating a card.");

  await parkFocus(page);
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "Add a column" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // The disabled New card button is not a target: focus lands on Add column, which
  // is the control this board can actually use.
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeFocused();
});

test("a rejected card creation keeps the typed title and creates nothing", async ({ page }) => {
  // Send the destination as a column that no longer exists: the real board
  // refuses it, so the client sees the server's own correlated error.
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => ws.send(message));
    ws.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      server.send(
        frame.type === "card.create"
          ? JSON.stringify({ ...frame, columnId: "no-such-column" })
          : message,
      );
    });
  });

  await openBoard(page, "creation-reject");
  const todo = columnByTitle(page, "Todo");
  await todo.getByRole("button", { name: "Add card", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a card" });
  await dialog.getByLabel("Title").fill("Refused card");
  await dialog.getByRole("button", { name: "Create card" }).click();

  await expect(dialog.getByRole("alert")).toContainText("destination column does not exist");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue("Refused card");
  await expect(todo.locator("[data-card-title]")).toHaveCount(0);

  // The draft is still editable, so the same title can be corrected and resubmitted.
  await dialog.getByRole("button", { name: "Create card" }).click();
  await expect(dialog.getByRole("alert")).toContainText("destination column does not exist");
  await expect(dialog.getByLabel("Title")).toHaveValue("Refused card");
});

test("a dropped echo settles the same creation on reconnect without duplicating it", async ({
  page,
}) => {
  // The server receives the creation and answers; only its echo is held back.
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "card.create") return;
      ws.send(message);
    });
    ws.onMessage((message) => server.send(message));
  });

  await openBoard(page, "creation-echo");
  const todo = columnByTitle(page, "Todo");
  await todo.getByRole("button", { name: "Add card", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a card" });
  await dialog.getByLabel("Title").fill("Echoed card");
  await dialog.getByRole("button", { name: "Create card" }).click();

  // Nothing has confirmed the creation yet, so the form stays locked and says so.
  await expect(dialog.getByRole("alert")).toContainText("Checking whether creation completed");
  await expect(dialog.getByRole("button", { name: "Creating…" })).toBeDisabled();

  // The resync snapshot carries the card, so the attempt settles as accepted
  // exactly once and the dialog closes on its own.
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(cardIn(todo, "Echoed card")).toHaveCount(1);
  await page.reload();
  await expect(cardIn(columnByTitle(page, "Todo"), "Echoed card")).toHaveCount(1);
});

test("an absent snapshot unlocks an explicit retry that creates one card", async ({ page }) => {
  // The first creation never reaches the server, so the resync snapshot cannot
  // carry it; the retry afterwards travels normally.
  let dropped = false;
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "card.create" && !dropped) {
        dropped = true;
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  await openBoard(page, "creation-retry");
  const todo = columnByTitle(page, "Todo");
  await todo.getByRole("button", { name: "Add card", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a card" });
  await dialog.getByLabel("Title").fill("Retried card");
  await dialog.getByRole("button", { name: "Create card" }).click();

  await expect(dialog.getByRole("alert")).toContainText("Checking whether creation completed");
  // The board reconnects, reads a snapshot without the card, and hands the draft back.
  await expect(dialog.getByRole("alert")).toContainText(
    "Creation was not confirmed. You can try again.",
    { timeout: 20_000 },
  );
  await expect(dialog.getByRole("button", { name: "Create card" })).toBeEnabled();
  await expect(todo.locator("[data-card-title]")).toHaveCount(0);

  // Retrying is an explicit action, and it creates the card exactly once.
  await dialog.getByRole("button", { name: "Create card" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(cardIn(todo, "Retried card")).toHaveCount(1);
});
