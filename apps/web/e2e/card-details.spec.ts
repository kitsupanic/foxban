import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  inviteMember,
  signup,
  uniqueEmail,
  ensureChecklistComposer,
} from "./helpers";

/**
 * A signed-up user in its own browser context (own cookie jar). The display name
 * is explicit here: the assignee chip renders its initials, so the two users
 * need names whose initials are distinguishable.
 */
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

/** A board with a run-unique name, created from the list page. */
async function freshBoard(page: Page, label: string): Promise<string> {
  return await createBoard(page, `Details ${label} ${Date.now()}`);
}

async function openBoard(page: Page, boardId: string): Promise<void> {
  await page.goto(`/board/${boardId}`);
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
}

async function addItem(page: Page, text: string): Promise<void> {
  const composer = await ensureChecklistComposer(page.getByRole("dialog"));
  await composer.fill(text);
  await composer.press("Enter");
  // The composer clears only once the mutation left the socket.
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: text })).toBeVisible();
}

/**
 * Ticks an item. A plain `click`, not `check`: the box is controlled by the board
 * cache, which the optimistic apply refreshes one render after the native click,
 * so `check`'s own immediate re-read of `input.checked` is too early.
 */
async function tickItem(dialog: Locator, text: string): Promise<void> {
  const box = dialog.getByRole("checkbox", { name: text });
  await box.click();
  await expect(box).toBeChecked();
}

test("checklist and assignee show in the modal and as badges on the card front", async ({
  browser,
}) => {
  const alice = await newUser(browser, "details-solo", "Ada Alpha");
  const boardId = await freshBoard(alice.page, "solo");
  await openBoard(alice.page, boardId);
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "details card");

  const card = cardIn(columnByTitle(alice.page, "Todo"), "details card");
  await card.click();
  const dialog = alice.page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await addItem(alice.page, "one");
  await addItem(alice.page, "two");
  await tickItem(dialog, "one");

  await expect(dialog.getByRole("heading", { name: "Checklist 1/2" })).toBeVisible();
  const progressBar = dialog.getByRole("progressbar", { name: "Checklist progress" });
  await expect(progressBar).toHaveAttribute("aria-valuenow", "50");
  await expect(dialog.getByText("50%")).toBeVisible();
  await expect(card.getByTestId("checklist-badge")).toContainText("1/2");
  await expect(card.getByTestId("checklist-badge")).toHaveAttribute("aria-label", "Checklist: 1 of 2 done");

  // Dense card state: populate due date, comment, and description alongside priority and checklist
  const input = dialog.getByLabel("Due date", { exact: true });
  const dueUpcoming = isoDaysFromNow(7);
  await input.fill(dueUpcoming);

  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("dense comment");
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(card.getByTestId("comment-badge")).toContainText("1");

  await dialog.getByRole("button", { name: "Add a description…" }).click();
  await dialog.getByLabel("Card description").fill("dense description");
  await dialog.getByRole("button", { name: "Save title & description" }).click();
  await expect(dialog).toHaveCount(0);

  // Verify rendered badge data-testid DOM order excludes due and description,
  // following the expected subsequence: priority -> checklist -> comment
  await expect(card.getByTestId("description-badge")).toHaveCount(0);
  const badgeContainer = card.getByTestId("badge-row").locator("> *");
  const badgeTestIds = await badgeContainer.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-testid")),
  );
  expect(badgeTestIds).toEqual([
    "priority-badge",
    "checklist-badge",
    "comment-badge",
  ]);
  expect(badgeTestIds).not.toContain("description-badge");
  await card.click();
  const reopenedDialog = alice.page.getByRole("dialog");
  await reopenedDialog.getByRole("button", { name: "Assignee" }).click();
  await reopenedDialog.getByRole("option", { name: "Ada Alpha" }).click();
  // The chip carries the full name as its tooltip and the initials as its text.
  await expect(card.getByTitle("Ada Alpha")).toHaveText("AA");

  await alice.page.context().close();
});

test("a second member sees the checklist and assignment, and their tick arrives live", async ({
  browser,
}) => {
  const alice = await newUser(browser, "details-a", "Ada Alpha");
  const bob = await newUser(browser, "details-b", "Bo Beta");

  const boardName = `Details shared ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);

  await openBoard(alice.page, boardId);
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "shared card");

  const aliceCard = cardIn(columnByTitle(alice.page, "Todo"), "shared card");
  await aliceCard.click();
  const aliceDialog = alice.page.getByRole("dialog");
  await addItem(alice.page, "one");
  await addItem(alice.page, "two");
  await tickItem(aliceDialog, "one");
  await aliceDialog.getByRole("button", { name: "Assignee" }).click();
  // The search narrows the panel live: this board has exactly the two members.
  const search = aliceDialog.getByLabel("Search members");
  await search.fill("bo");
  await expect(aliceDialog.getByRole("option", { name: "Bo Beta" })).toBeVisible();
  await expect(aliceDialog.getByRole("option", { name: "Ada Alpha" })).toBeHidden();
  await search.fill("ada");
  await expect(aliceDialog.getByRole("option", { name: "Ada Alpha" })).toBeVisible();
  await aliceDialog.getByRole("option", { name: "Ada Alpha" }).click();
  await expect(aliceDialog.getByRole("heading", { name: "Checklist 1/2" })).toBeVisible();
  const aliceProgressBar = aliceDialog.getByRole("progressbar", { name: "Checklist progress" });
  await expect(aliceProgressBar).toHaveAttribute("aria-valuenow", "50");
  await expect(aliceDialog.getByText("50%")).toBeVisible();
  await expect(aliceCard.getByTestId("checklist-badge")).toContainText("1/2");
  await expect(aliceCard.getByTestId("checklist-badge")).toHaveAttribute("aria-label", "Checklist: 1 of 2 done");
  await bob.page.goto(`/board/${boardId}`);
  await cardIn(columnByTitle(bob.page, "Todo"), "shared card").click();
  const bobDialog = bob.page.getByRole("dialog");
  await expect(bobDialog.getByRole("checkbox", { name: "one" })).toBeChecked();
  await expect(bobDialog.getByRole("checkbox", { name: "two" })).not.toBeChecked();
  await expect(bobDialog.getByRole("button", { name: "Assignee" })).toContainText("Ada Alpha");

  // No reload on Alice's side: her open modal and the card behind it both follow
  // the broadcast.
  await tickItem(bobDialog, "two");
  await expect(aliceDialog.getByRole("heading", { name: "Checklist 2/2" })).toBeVisible();
  await expect(aliceProgressBar).toHaveAttribute("aria-valuenow", "100");
  await expect(aliceDialog.getByText("100%")).toBeVisible();
  await expect(aliceCard.getByTestId("checklist-badge")).toContainText("2/2");
  await expect(aliceCard.getByTestId("checklist-badge")).toHaveAttribute("aria-label", "Checklist: 2 of 2 done");

  await alice.page.context().close();
  await bob.page.context().close();
});

test("Escape cancels an item edit and only then closes the modal", async ({ browser }) => {
  const alice = await newUser(browser, "details-esc", "Ada Alpha");
  const boardId = await freshBoard(alice.page, "esc");
  await openBoard(alice.page, boardId);
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "escape card");

  await cardIn(columnByTitle(alice.page, "Todo"), "escape card").click();
  const dialog = alice.page.getByRole("dialog");
  await addItem(alice.page, "one");

  await dialog.getByText("one", { exact: true }).click();
  const editor = dialog.locator("[data-checklist-edit]");
  await expect(editor).toBeFocused();
  await editor.fill("edited");
  await editor.press("Escape");

  // The edit is dropped, the modal is not: the item editor stops the key event
  // before the modal's window listener sees it.
  await expect(editor).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "one" })).toBeVisible();

  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await alice.page.context().close();
});

test("a checklist item's text is editable from the keyboard and focus returns to it", async ({ browser }) => {
  const alice = await newUser(browser, "details-kbd", "Ada Alpha");
  const boardId = await freshBoard(alice.page, "kbd");
  await openBoard(alice.page, boardId);
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "keyboard card");

  await cardIn(columnByTitle(alice.page, "Todo"), "keyboard card").click();
  const dialog = alice.page.getByRole("dialog");
  await addItem(alice.page, "first text");

  await dialog.getByRole("checkbox", { name: "first text" }).focus();
  await alice.page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Edit checklist item first text" })).toBeFocused();
  await alice.page.keyboard.press("Enter");
  const editor = dialog.locator("[data-checklist-edit]");
  await expect(editor).toBeFocused();
  await editor.fill("second text");
  await editor.press("Enter");

  await expect(editor).toHaveCount(0);
  const trigger = dialog.getByRole("button", { name: "Edit checklist item second text" });
  await expect(trigger).toHaveText("second text");
  await expect(trigger).toBeFocused();

  await alice.page.context().close();
});

test("a card front shows its priority icon, defaults to Medium, and the picker persists", async ({
  browser,
}) => {
  const alice = await newUser(browser, "details-prio", "Ada Alpha");
  const boardId = await freshBoard(alice.page, "prio");
  await openBoard(alice.page, boardId);
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "priority card");

  const card = cardIn(columnByTitle(alice.page, "Todo"), "priority card");
  const badge = card.getByTestId("priority-badge");
  // Every card has a priority, so a fresh card front already shows the default.
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("title", "Medium");
  await expect(badge).toHaveAttribute("aria-label", "Medium priority");

  await card.click();
  const dialog = alice.page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Priority" })).toContainText("Medium");

  await dialog.getByRole("button", { name: "Priority" }).click();
  // `exact` is load-bearing against "Highest": it works because the option's
  // icon and check spans are aria-hidden, so its name is only the level label.
  await dialog.getByRole("option", { name: "High", exact: true }).click();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("title", "High");
  await expect(badge).toHaveAttribute("aria-label", "High priority");

  // Close first: the URL would otherwise restore the dialog across the reload.
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Reload rather than reopen: only the snapshot proves the DO stored it.
  await alice.page.reload();
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  const reloaded = cardIn(columnByTitle(alice.page, "Todo"), "priority card");
  const reloadedBadge = reloaded.getByTestId("priority-badge");
  await expect(reloadedBadge).toBeVisible();
  await expect(reloadedBadge).toHaveAttribute("title", "High");
  await expect(reloadedBadge).toHaveAttribute("aria-label", "High priority");

  await reloaded.click();
  await expect(
    alice.page.getByRole("dialog").getByRole("button", { name: "Priority" }),
  ).toContainText("High");

  await alice.page.context().close();
});

/** `YYYY-MM-DD` `days` from today in the runner's local timezone, which is the browser's. */
const isoDaysFromNow = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Expected human-readable full date string matching parseDueDate(iso).toLocaleDateString(undefined, { year, month: 'long', day }). */
const fullDueDate = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
};

/** Expected badge short text matching formatDueDate(iso). */
const badgeDueDate = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString(undefined, opts);
};

test("a due date sets a badge with local urgency, survives a reload, and clears", async ({
  browser,
}) => {
  const alice = await newUser(browser, "details-due", "Ada Alpha");
  const boardId = await freshBoard(alice.page, "due");
  await openBoard(alice.page, boardId);
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "due card");

  const card = cardIn(columnByTitle(alice.page, "Todo"), "due card");
  // The field is optional: a fresh card has no deadline and so no badge.
  await expect(card.getByTestId("due-badge")).toHaveCount(0);

  await card.click();
  const dialog = alice.page.getByRole("dialog");
  // `exact`: the clear button's "Clear due date" substring-matches otherwise.
  const input = dialog.getByLabel("Due date", { exact: true });
  await expect(input).toHaveValue("");
  const dueUpcoming = isoDaysFromNow(7);
  await input.fill(dueUpcoming);

  // The due date keeps a row of its own: it follows the title and precedes the
  // badge row, and never shares the top row with the task key.
  const dueBadge = card.getByTestId("due-badge");
  await expect(dueBadge).toBeVisible();
  const duePlacement = await card.evaluate((cardEl) => {
    const due = cardEl.querySelector('[data-testid="due-badge"]');
    const title = cardEl.querySelector("[data-card-title]");
    const taskId = cardEl.querySelector('[data-testid="task-key"]');
    const badgeRow = cardEl.querySelector('[data-testid="badge-row"]');
    return {
      ownRow: Boolean(due && taskId && due.parentElement !== taskId.parentElement),
      afterTitle: Boolean(
        due && title && title.compareDocumentPosition(due) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      beforeBadges: Boolean(
        due && badgeRow && due.compareDocumentPosition(badgeRow) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    };
  });
  expect(duePlacement).toEqual({ ownRow: true, afterTitle: true, beforeBadges: true });

  // Lower badge-row direct children exclude due and begin with priority-badge
  const badgeContainer = card.getByTestId("badge-row").locator("> *");
  await expect(badgeContainer.nth(0)).toHaveAttribute("data-testid", "priority-badge");
  const lowerTestIds = await badgeContainer.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-testid")),
  );
  expect(lowerTestIds).not.toContain("due-badge");

  const badge = card.getByTestId("due-badge");
  await expect(badge).toHaveAttribute("data-due-state", "upcoming");
  await expect(badge).toHaveText(badgeDueDate(dueUpcoming));
  await expect(badge).toHaveAttribute("aria-label", `Due ${fullDueDate(dueUpcoming)}`);
  await expect(badge).toHaveAttribute("title", `Due ${fullDueDate(dueUpcoming)}`);
  // Close first: the URL would otherwise restore the dialog across the reload.
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Reload rather than reopen: only the snapshot proves the DO stored it.
  await alice.page.reload();
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  const reloaded = cardIn(columnByTitle(alice.page, "Todo"), "due card");
  const reloadedBadge = reloaded.getByTestId("due-badge");
  await expect(reloadedBadge).toHaveAttribute("data-due-state", "upcoming");
  await expect(reloadedBadge).toHaveText(badgeDueDate(dueUpcoming));
  await expect(reloadedBadge).toHaveAttribute("aria-label", `Due ${fullDueDate(dueUpcoming)}`);
  await expect(reloadedBadge).toHaveAttribute("title", `Due ${fullDueDate(dueUpcoming)}`);
  await reloaded.click();
  const reopened = alice.page.getByRole("dialog");
  const reloadedInput = reopened.getByLabel("Due date", { exact: true });
  await expect(reloadedInput).toHaveValue(isoDaysFromNow(7));

  // Yesterday in the viewer's own timezone: overdue.
  const dueOverdue = isoDaysFromNow(-1);
  await reloadedInput.fill(dueOverdue);
  await expect(reloaded.getByTestId("due-badge")).toHaveAttribute("data-due-state", "overdue");
  await expect(reloaded.getByTestId("due-badge")).toHaveText(`Overdue · ${badgeDueDate(dueOverdue)}`);
  await expect(reloaded.getByTestId("due-badge")).toHaveAttribute(
    "aria-label",
    `Overdue — was due ${fullDueDate(dueOverdue)}`,
  );
  await expect(reloaded.getByTestId("due-badge")).toHaveAttribute(
    "title",
    `Overdue — was due ${fullDueDate(dueOverdue)}`,
  );
  await reopened.getByRole("button", { name: "Clear due date" }).click();
  await expect(reloadedInput).toHaveValue("");
  await expect(reloaded.getByTestId("due-badge")).toHaveCount(0);

  await alice.page.reload();
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  const cleared = cardIn(columnByTitle(alice.page, "Todo"), "due card");
  await expect(cleared.getByTestId("due-badge")).toHaveCount(0);

  await alice.page.context().close();
});

test("status field displays current column, moves card across columns, and persists reload", async ({
  browser,
}) => {
  const alice = await newUser(browser, "details-status-a", "Ada Alpha");
  const bob = await newUser(browser, "details-status-b", "Bo Beta");

  const boardName = `Details status ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);

  await openBoard(alice.page, boardId);
  await addColumn(alice.page, "Todo");
  await addColumn(alice.page, "Done");
  await addCard(alice.page, "Todo", "status card");
  // Seed an existing card in destination column to assert moved-card tail order
  await addCard(alice.page, "Done", "existing destination card");

  await openBoard(bob.page, boardId);

  const sourceCol = columnByTitle(alice.page, "Todo");
  const destCol = columnByTitle(alice.page, "Done");
  const card = cardIn(sourceCol, "status card");

  await card.click();
  const dialog = alice.page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Accessible trigger name is "Status", exact column title is "Todo"
  const statusTrigger = dialog.getByRole("button", { name: "Status", exact: true });
  await expect(statusTrigger).toContainText("Todo");

  // Open picker and verify current column is marked aria-selected
  await statusTrigger.click();
  const pickerListbox = dialog.getByRole("listbox");
  await expect(pickerListbox).toBeVisible();
  const todoOption = dialog.getByRole("option", { name: "Todo", exact: true });
  const doneOption = dialog.getByRole("option", { name: "Done", exact: true });
  await expect(todoOption).toHaveAttribute("aria-selected", "true");
  await expect(doneOption).toHaveAttribute("aria-selected", "false");

  // Escape-ladder behavior: first Escape closes only the picker listbox while dialog remains
  await alice.page.keyboard.press("Escape");
  await expect(pickerListbox).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // Re-open picker to execute move
  await statusTrigger.click();
  await expect(pickerListbox).toBeVisible();
  await doneOption.click();
  await expect(dialog).toBeVisible();
  await expect(statusTrigger).toContainText("Done");

  // Observable card movement across columns and destination-tail card ordering
  await expect(cardIn(sourceCol, "status card")).toHaveCount(0);
  const destCards = destCol.locator("li");
  await expect(destCards).toHaveCount(2);
  await expect(destCards.nth(0)).toContainText("existing destination card");
  await expect(destCards.nth(1)).toContainText("status card");

  // Alice opens her Status picker again (currently Done)
  await statusTrigger.click();
  await expect(pickerListbox).toBeVisible();
  await expect(dialog.getByRole("option", { name: "Done", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Bob opens the same card and uses his Status picker to move it back to Todo
  const bobCard = cardIn(columnByTitle(bob.page, "Done"), "status card");
  await bobCard.click();
  const bobDialog = bob.page.getByRole("dialog");
  await expect(bobDialog).toBeVisible();
  const bobStatusTrigger = bobDialog.getByRole("button", { name: "Status", exact: true });
  await expect(bobStatusTrigger).toContainText("Done");
  await bobStatusTrigger.click();
  await bobDialog.getByRole("option", { name: "Todo", exact: true }).click();
  await expect(bobStatusTrigger).toContainText("Todo");

  // Alice's open picker and trigger follow peer card.move broadcast live without reload
  await expect(statusTrigger).toContainText("Todo");
  await expect(dialog.getByRole("option", { name: "Todo", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.getByRole("option", { name: "Done", exact: true })).toHaveAttribute(
    "aria-selected",
    "false",
  );

  // Close Alice's picker then dialog before reload to prevent URL-based auto-restore
  await alice.page.keyboard.press("Escape");
  await expect(pickerListbox).toHaveCount(0);
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Reload to verify BoardDO persistence
  await alice.page.reload();
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  const reloadedCard = cardIn(columnByTitle(alice.page, "Todo"), "status card");
  await expect(reloadedCard).toHaveCount(1);
  await expect(cardIn(columnByTitle(alice.page, "Done"), "status card")).toHaveCount(0);

  // Reopening card reflects persistent destination status
  await reloadedCard.click();
  const reopenedDialog = alice.page.getByRole("dialog");
  await expect(reopenedDialog).toBeVisible();
  await expect(
    reopenedDialog.getByRole("button", { name: "Status", exact: true }),
  ).toContainText("Todo");

  await alice.page.context().close();
  await bob.page.context().close();
});
test("task type picker defaults to Task, switches to Bug live, persists reload, and supports keyboard navigation", async ({
  browser,
}) => {
  const alice = await newUser(browser, "details-type-a", "Ada Alpha");
  const bob = await newUser(browser, "details-type-b", "Bo Beta");

  const boardName = `Details type ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);

  await openBoard(alice.page, boardId);
  await addColumn(alice.page, "Todo");
  await addCard(alice.page, "Todo", "Typed Card");

  await openBoard(bob.page, boardId);

  // Alice and Bob see the card with data-task-type="task"
  const todoColAlice = columnByTitle(alice.page, "Todo");
  const aliceCard = cardIn(todoColAlice, "Typed Card");
  const aliceCardFace = aliceCard.locator("[data-task-type]");
  await expect(aliceCardFace).toHaveAttribute("data-task-type", "task");

  const todoColBob = columnByTitle(bob.page, "Todo");
  const bobCard = cardIn(todoColBob, "Typed Card");
  const bobCardFace = bobCard.locator("[data-task-type]");
  await expect(bobCardFace).toHaveAttribute("data-task-type", "task");

  // Alice opens the card details modal
  await aliceCard.click();
  const dialog = alice.page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const typeTrigger = dialog.getByRole("button", { name: "Type", exact: true });
  await expect(typeTrigger).toBeVisible();
  await expect(typeTrigger).toContainText("Task");

  // Exercise keyboard behavior: open via ArrowDown, test Escape closes picker and restores focus to trigger
  await typeTrigger.focus();
  await alice.page.keyboard.press("ArrowDown");
  const pickerListbox = dialog.getByRole("listbox");
  await expect(pickerListbox).toBeVisible();

  await alice.page.keyboard.press("Escape");
  await expect(pickerListbox).toHaveCount(0);
  await expect(typeTrigger).toBeFocused();

  // Re-open and choose Bug
  await typeTrigger.click();
  await expect(pickerListbox).toBeVisible();
  const bugOption = dialog.getByRole("option", { name: "Bug", exact: true });
  await bugOption.click();

  // Trigger and compact card switch immediately to Bug
  await expect(typeTrigger).toContainText("Bug");
  await expect(aliceCardFace).toHaveAttribute("data-task-type", "bug");

  // Bob's compact card changes to Bug live without reload
  await expect(bobCardFace).toHaveAttribute("data-task-type", "bug");

  // Close Alice's dialog before reload to avoid URL auto-open
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Bob reloads and Bug persists
  await bob.page.reload();
  await expect(bob.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  const bobReloadedCardFace = cardIn(columnByTitle(bob.page, "Todo"), "Typed Card").locator("[data-task-type]");
  await expect(bobReloadedCardFace).toHaveAttribute("data-task-type", "bug");

  await alice.page.context().close();
  await bob.page.context().close();
});
