import { authTest as test, expect, type Page } from "./fixtures";
import type { Locator } from "@playwright/test";
import {
  addCard,
  addColumn,
  inviteMember,
  cardBody,
  cardIn,
  columnByTitle,
  createBoard,
  dragCardTo,
  openBoardList,
  signup,
  settleAnimationFrames,
  uniqueEmail,
  ensureChecklistComposer,
} from "./helpers";

/**
 * A board with a Todo column and a card in it. A board with two columns or more
 * has its workflow roles (the first column starts work, the last finishes it),
 * so pass more columns when a child has to be completed.
 */
async function boardWithCard(
  page: Page,
  suffix: string,
  cardTitle: string,
  columns: string[] = ["Todo"],
): Promise<string> {
  const boardName = `Subtasks ${suffix} ${Date.now()}`;
  const boardKey = await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  for (const column of columns) await addColumn(page, column);
  await addCard(page, "Todo", cardTitle);
  return boardKey;
}

/** A card by its own title marker. A child in its parent's column is nested inside the parent's `li`. */
function cardTitled(scope: Locator | Page, title: string): Locator {
  return scope.locator(`[data-card-title="${title}"]`);
}

/** The control that opens one card, found by title wherever the card sits. */
function bodyOfTitled(scope: Locator | Page, title: string): Locator {
  return cardTitled(scope, title).locator("xpath=ancestor::li[1]").locator("[data-card-body]").first();
}

/** The card dialog of one card, opened from the board. */
async function openCard(page: Page, columnTitle: string, cardTitle: string): Promise<void> {
  await cardBody(cardIn(columnByTitle(page, columnTitle), cardTitle)).click();
  await expect(page.getByRole("dialog", { name: cardTitle })).toBeVisible();
}

/** The inline Add-subtask form inside an open card. */
function subtaskComposer(dialog: Locator): Locator {
  return dialog.getByLabel("Subtask title").locator("xpath=ancestor::form");
}

/** Adds one subtask through the details composer's given control. */
async function addSubtask(
  page: Page,
  parentTitle: string,
  childTitle: string,
  submitWith: "enter" | "button" = "enter",
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: parentTitle });
  await dialog.getByRole("button", { name: "Add subtask" }).click();
  const composer = subtaskComposer(dialog);
  await composer.getByLabel("Subtask title").fill(childTitle);
  if (submitWith === "enter") {
    await composer.getByLabel("Subtask title").press("Enter");
  } else {
    await composer.getByRole("button", { name: "Add", exact: true }).click();
  }
  await expect(dialog.getByRole("button", { name: `Open subtask ${childTitle}` })).toBeVisible();
  // Settled: a write still in flight keeps the card dirty, so a close would park behind the discard strip.
  await expect(dialog.getByRole("button", { name: "Adding…" })).toHaveCount(0);
}

test("creates and completes nested subtasks", async ({ page }) => {
  await boardWithCard(page, "direct", "Parent task", ["Todo", "Done"]);

  // An empty parent still offers the add affordance; there is nothing to disclose.
  await openCard(page, "Todo", "Parent task");
  let dialog = page.getByRole("dialog", { name: "Parent task" });
  await expect(dialog.getByRole("heading", { name: "Subtasks", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add subtask" })).toBeVisible();
  await expect(dialog.getByRole("progressbar", { name: "Subtask progress" })).toHaveCount(0);

  await addSubtask(page, "Parent task", "Write docs");
  await addSubtask(page, "Parent task", "Draft copy", "button");
  await addSubtask(page, "Parent task", "Review copy");

  // Cancel clears the draft and leaves the family as it was.
  const composer = subtaskComposer(dialog);
  await dialog.getByRole("button", { name: "Add subtask" }).click();
  await composer.getByLabel("Subtask title").fill("Abandoned");
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Open subtask Abandoned" })).toHaveCount(0);

  // Three rows, nothing done: the count is the done count, not the total.
  await expect(dialog.getByText("0 of 3 done", { exact: true })).toBeVisible();
  const progress = dialog.getByRole("progressbar", { name: "Subtask progress" });
  await expect(progress).toHaveAttribute("aria-valuemin", "0");
  await expect(progress).toHaveAttribute("aria-valuemax", "3");
  await expect(progress).toHaveAttribute("aria-valuenow", "0");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The board shows the same family inside the parent card, each child a card of
  // its own, and the footer counts the done ones.
  const todo = columnByTitle(page, "Todo");
  const done = columnByTitle(page, "Done");
  const parent = cardIn(todo, "Parent task");
  const disclosure = parent.getByRole("button", { name: /Subtasks/ });
  await expect(disclosure).toContainText("0 / 3");
  await expect(cardTitled(parent, "Write docs")).toBeVisible();

  // Completing a child moves that card to the completed column and nothing else.
  await cardBody(parent).click();
  dialog = page.getByRole("dialog", { name: "Parent task" });
  await dialog.getByRole("button", { name: "Complete Write docs" }).click();
  await expect(dialog.getByText("1 of 3 done", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Reopen Write docs" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(cardTitled(done, "Write docs")).toBeVisible();
  await expect(disclosure).toContainText("1 / 3");
  await expect(cardIn(todo, "Parent task")).toHaveCount(1);
  await expect(cardTitled(todo, "Draft copy")).toBeVisible();
  await expect(cardTitled(todo, "Review copy")).toBeVisible();

  await page.reload();
  await expect(
    cardIn(columnByTitle(page, "Todo"), "Parent task").getByRole("button", { name: /Subtasks/ }),
  ).toContainText("1 / 3");
  await expect(cardTitled(columnByTitle(page, "Done"), "Write docs")).toBeVisible();

  // Reopening moves the card back to the starting column, so the footer returns to 0 / 3.
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Parent task")).click();
  dialog = page.getByRole("dialog", { name: "Parent task" });
  await dialog.getByRole("button", { name: "Reopen Write docs" }).click();
  await expect(dialog.getByText("0 of 3 done", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(cardTitled(columnByTitle(page, "Todo"), "Write docs")).toBeVisible();
  await expect(
    cardIn(columnByTitle(page, "Todo"), "Parent task").getByRole("button", { name: /Subtasks/ }),
  ).toContainText("0 / 3");

  // Details agree with the board, and every child keeps a row.
  await openCard(page, "Todo", "Parent task");
  dialog = page.getByRole("dialog", { name: "Parent task" });
  await dialog.getByRole("button", { name: "Complete Draft copy" }).click();
  await expect(dialog.getByText("1 of 3 done", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Open subtask / })).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a second member sees the same family and completion", async ({ browser }) => {
  const owner = await (async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const email = uniqueEmail("subtask-owner");
    await signup(page, email, "Owner One");
    return { page, email };
  })();
  const member = await (async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const email = uniqueEmail("subtask-member");
    await signup(page, email, "Member Two");
    return { page, email };
  })();

  const boardName = `Subtasks shared ${Date.now()}`;
  const boardKey = await createBoard(owner.page, boardName);
  await owner.page.goto(`/board/${boardKey}`);
  await addColumn(owner.page, "Todo");
  await addColumn(owner.page, "Done");
  await addCard(owner.page, "Todo", "Parent task");
  await openCard(owner.page, "Todo", "Parent task");
  await addSubtask(owner.page, "Parent task", "Write docs");
  await addSubtask(owner.page, "Parent task", "Draft copy");
  await owner.page.keyboard.press("Escape");

  // The member joins through the established member-add flow, which runs on the
  // board list rather than over the board itself.
  await openBoardList(owner.page);
  await inviteMember(owner.page, boardName, member.email);
  await owner.page.goto(`/board/${boardKey}`);
  await expect(
    cardIn(columnByTitle(owner.page, "Todo"), "Parent task").getByRole("button", {
      name: /Subtasks/,
    }),
  ).toContainText("0 / 2");

  await member.page.goto(`/board/${boardKey}`);
  const memberParent = cardIn(columnByTitle(member.page, "Todo"), "Parent task");
  await expect(memberParent.getByRole("button", { name: /Subtasks/ })).toContainText("0 / 2");

  // The owner completes one; the member's footer and columns follow live.
  await openCard(owner.page, "Todo", "Parent task");
  await owner.page
    .getByRole("dialog", { name: "Parent task" })
    .getByRole("button", { name: "Complete Write docs" })
    .click();
  await expect(
    memberParent.getByRole("button", { name: /Subtasks/ }),
  ).toContainText("1 / 2");
  await expect(cardTitled(columnByTitle(member.page, "Done"), "Write docs")).toBeVisible();
});

test("converting a checklist item makes a nested child, navigates both ways, survives a reload, and unlinks", async ({
  page,
}) => {
  await boardWithCard(page, "convert", "Parent task");

  let column = columnByTitle(page, "Todo");
  let parent = cardIn(column, "Parent task");

  await parent.click();
  let dialog = page.getByRole("dialog", { name: "Parent task" });
  await ensureChecklistComposer(dialog);
  await dialog.getByPlaceholder("Add an item").fill("Write docs");
  await dialog.getByPlaceholder("Add an item").press("Enter");
  await expect(dialog.getByRole("checkbox", { name: "Write docs" })).toBeVisible();

  // One click: the child, its link and the item's removal commit together.
  await dialog.getByRole("button", { name: "Convert to card Write docs" }).click();
  await expect(dialog.getByRole("heading", { name: "Checklist", exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Write docs" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Subtasks", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open subtask Write docs" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The child is a card nested inside its parent, not a second root card. The
  // board has one column and so no workflow roles: it joins its parent's column.
  column = columnByTitle(page, "Todo");
  parent = cardIn(column, "Parent task");
  await expect(parent.getByRole("button", { name: /Subtasks/ })).toContainText("0 / 1");
  await expect(cardTitled(parent, "Write docs")).toBeVisible();

  // Child details navigate to the parent and back, with a status of their own.
  await bodyOfTitled(page, "Write docs").click();
  dialog = page.getByRole("dialog", { name: "Write docs" });
  await expect(dialog.getByRole("heading", { name: "Write docs", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Status" })).toBeVisible();
  await expect(dialog.getByText("Subtask of", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Open parent Parent task" }).click();
  dialog = page.getByRole("dialog", { name: "Parent task" });
  await expect(dialog.getByRole("heading", { name: "Parent task", exact: true, level: 2 })).toBeVisible();

  // Close first: the URL would otherwise restore the dialog across the reload.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.reload();
  column = columnByTitle(page, "Todo");
  parent = cardIn(column, "Parent task");
  await expect(parent.getByRole("button", { name: /Subtasks/ })).toContainText("0 / 1");
  await expect(cardTitled(parent, "Write docs")).toBeVisible();

  // Unlinking drops the relation only: the child becomes its own root card in
  // the same column, with its number intact.
  await cardBody(parent).press("Enter");
  dialog = page.getByRole("dialog", { name: "Parent task" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove subtask Write docs" }).click();
  await expect(dialog.getByRole("button", { name: "Open subtask Write docs" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Subtasks", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  column = columnByTitle(page, "Todo");
  await expect(
    cardIn(column, "Parent task").getByRole("button", { name: /Subtasks/ }),
  ).toHaveCount(0);
  await expect(cardIn(column, "Write docs")).toHaveCount(1);

  await page.reload();
  column = columnByTitle(page, "Todo");
  await expect(
    cardIn(column, "Parent task").getByRole("button", { name: /Subtasks/ }),
  ).toHaveCount(0);
  await expect(cardIn(column, "Write docs")).toHaveCount(1);
});

test("an unresolved conversion owns its retained ids until it is retried or discarded", async ({
  page,
}) => {
  const boardName = `Subtasks convert recovery ${Date.now()}`;
  const boardKey = await createBoard(page, boardName);

  type ConversionFrame = {
    type: string;
    mutationId: string;
    id: string;
    relationId: string;
    checklistItemId?: string;
    title: string;
    position: string;
  };
  const conversions: ConversionFrame[] = [];
  let rejectHeldConversion: () => void = () => {
    throw new Error("No conversion is held");
  };
  let holdFirstConversion = true;
  // The first conversion is held at the socket — the server never sees it — so
  // the test can observe the lane's own pending state; every other frame flows
  // both ways and the board behaves exactly as usual.
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as ConversionFrame;
      if (frame.type === "subtask.create" && frame.checklistItemId !== undefined) {
        conversions.push(frame);
        if (holdFirstConversion) {
          holdFirstConversion = false;
          rejectHeldConversion = () => {
            ws.send(
              JSON.stringify({
                type: "error",
                mutationId: frame.mutationId,
                message: "test conversion rejected",
              }),
            );
          };
          return;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  await page.goto(`/board/${boardKey}`);
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Parent task");

  await openCard(page, "Todo", "Parent task");
  const dialog = page.getByRole("dialog", { name: "Parent task" });
  for (const text of ["Write docs", "Write tests"]) {
    await ensureChecklistComposer(dialog);
    await dialog.getByPlaceholder("Add an item").fill(text);
    await dialog.getByPlaceholder("Add an item").press("Enter");
    await expect(dialog.getByRole("checkbox", { name: text })).toBeVisible();
  }

  // The conversion is in flight: the optimistic apply already removed the
  // converted row, and the single-slot lane leaves the remaining item no Convert
  // action — there is no second write to race its settlement, and no second
  // recovery to overwrite its identity.
  await dialog.getByRole("button", { name: "Convert to card Write docs" }).click();
  await expect.poll(() => conversions.length).toBe(1);
  await expect(dialog.getByRole("checkbox", { name: "Write docs" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Convert to card Write tests" })).toBeDisabled();

  // The refusal restores the item and keeps that attempt's identity for a retry.
  rejectHeldConversion();
  await expect(dialog.getByRole("button", { name: "Retry conversion" })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Write docs" })).toBeVisible();

  // While the recovery is unresolved it owns the lane just the same: neither the
  // recovered item nor a sibling may start an ordinary conversion, so no fresh
  // child/relation identity can be minted for it and the retained one cannot be
  // replaced.
  await expect(dialog.getByRole("button", { name: "Convert to card Write docs" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Convert to card Write tests" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Convert to card Write tests" }).dispatchEvent("click");
  await expect(dialog.getByRole("button", { name: "Retry conversion" })).toBeVisible();

  // The retry is the first attempt's identity — the same child, relation, source
  // item and position, with only its own mutation id new. A conversion started
  // behind the recovery would have replaced these values.
  await dialog.getByRole("button", { name: "Retry conversion" }).click();
  await expect.poll(() => conversions.length).toBe(2);
  const first = conversions[0]!;
  const retry = conversions[1]!;
  expect(retry.id).toBe(first.id);
  expect(retry.relationId).toBe(first.relationId);
  expect(retry.checklistItemId).toBe(first.checklistItemId);
  expect(retry.position).toBe(first.position);
  expect(retry.mutationId).not.toBe(first.mutationId);

  // The accepted retry leaves exactly one child and releases the lane.
  await expect(dialog.getByRole("button", { name: "Retry conversion" })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: "Write docs" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Open subtask Write docs" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Convert to card Write tests" })).toBeEnabled();
});

test("a timed-out direct add survives overlap, navigation attempts, and stable-id retry", async ({
  page,
}) => {
  const boardName = `Subtasks direct recovery ${Date.now()}`;
  const boardKey = await createBoard(page, boardName);
  type DirectFrame = {
    type: string;
    mutationId: string;
    id: string;
    relationId: string;
    checklistItemId?: string;
    title: string;
    position: string;
  };
  const directFrames: DirectFrame[] = [];
  let dropFirstDirect = true;
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as DirectFrame;
      if (frame.type === "subtask.create" && frame.checklistItemId === undefined) {
        directFrames.push(frame);
        if (dropFirstDirect) {
          dropFirstDirect = false;
          return;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  await page.goto(`/board/${boardKey}`);
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Parent task");
  await openCard(page, "Todo", "Parent task");
  const dialog = page.getByRole("dialog", { name: "Parent task" });
  await ensureChecklistComposer(dialog);
  await dialog.getByPlaceholder("Add an item").fill("Convert while waiting");
  await dialog.getByPlaceholder("Add an item").press("Enter");
  await dialog.getByRole("button", { name: "Add subtask" }).click();
  const input = dialog.getByRole("textbox", { name: "Subtask title", exact: true });
  await input.fill("Delayed child");
  await input.press("Enter");
  await expect.poll(() => directFrames.length).toBe(1);
  await expect(input).toHaveAttribute("readonly", "");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  // Conversion is a separate authored lane: it can settle while the direct add
  // waits, without changing the direct add's generation or uncertainty ownership.
  await dialog
    .getByRole("button", { name: "Convert to card Convert while waiting" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Open subtask Convert while waiting" }),
  ).toBeVisible();
  // Five-second authored timeout closes the transport; the reconnect snapshot
  // proves the dropped child absent and exposes an explicit retry with the same
  // entity identities. The modal and submitted bytes stay mounted throughout.
  await expect(dialog.getByRole("button", { name: "Retry unsent subtask" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Unsent subtask: Delayed child", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Retry unsent subtask" }).click();
  await expect.poll(() => directFrames.length).toBe(2);
  expect(directFrames[1]!.id).toBe(directFrames[0]!.id);
  expect(directFrames[1]!.relationId).toBe(directFrames[0]!.relationId);
  expect(directFrames[1]!.position).toBe(directFrames[0]!.position);
  expect(directFrames[1]!.mutationId).not.toBe(directFrames[0]!.mutationId);
  await expect(dialog.getByRole("button", { name: "Open subtask Delayed child" })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Retry unsent subtask" })).toHaveCount(0);
});

test("the family disclosure never drags or opens the parent", async ({ page }) => {
  await boardWithCard(page, "guards", "Parent task");
  await openCard(page, "Todo", "Parent task");
  await addSubtask(page, "Parent task", "Write docs");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const todo = columnByTitle(page, "Todo");
  const parent = cardIn(todo, "Parent task");
  const disclosure = parent.getByRole("button", { name: /Subtasks/ });
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(cardTitled(parent, "Write docs")).toBeVisible();

  // A press-and-hold on the disclosure that is pulled out of the card must not
  // lift the parent card or open anything. The disclosure spans the card, so the
  // pointer leaves it entirely before release.
  const box = await disclosure.boundingBox();
  if (!box) throw new Error("disclosure is not laid out");
  const controlX = box.x + box.width / 2;
  const controlY = box.y + box.height / 2;
  await page.mouse.move(controlX, controlY);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.move(controlX + box.width, controlY + 12);
  await page.waitForTimeout(120);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Releasing away from the control commits nothing.
  await page.mouse.up();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(cardIn(todo, "Parent task")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The disclosure opens and closes the family without opening the card.
  await disclosure.click();
  await expect(cardTitled(page, "Write docs")).toHaveCount(0);
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(disclosure).toContainText("0 / 1");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await disclosure.click();
  await expect(cardTitled(page, "Write docs")).toBeVisible();

  // A whole-card click on the body still opens the card.
  await cardBody(parent).click();
  await expect(page.getByRole("dialog", { name: "Parent task" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("dragging the parent body moves only the parent; its child keeps its own column", async ({ page }) => {
  // The last column finishes work, so the drop target is the one between.
  await boardWithCard(page, "drag", "Parent task", ["Todo", "Elsewhere", "Done"]);

  await openCard(page, "Todo", "Parent task");
  await addSubtask(page, "Parent task", "Write docs");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const todo = columnByTitle(page, "Todo");
  const parent = cardIn(todo, "Parent task");
  await dragCardTo(page, cardBody(parent), columnByTitle(page, "Elsewhere").locator("ul"));

  // One card.move: the parent is in the destination with the whole family's count,
  // and the child is its own card where it was, with a link back to the parent.
  const moved = cardIn(columnByTitle(page, "Elsewhere"), "Parent task");
  await expect(moved).toHaveCount(1);
  await expect(moved.getByRole("button", { name: /Subtasks/ })).toContainText("0 / 1");
  await expect(cardIn(todo, "Parent task")).toHaveCount(0);
  const child = cardIn(todo, "Write docs");
  await expect(child).toHaveCount(1);
  await expect(child.getByRole("button", { name: "Parent: Parent task", exact: true })).toBeVisible();

  await page.reload();
  await expect(
    cardIn(columnByTitle(page, "Elsewhere"), "Parent task").getByRole("button", { name: /Subtasks/ }),
  ).toContainText("0 / 1");
  await expect(cardIn(columnByTitle(page, "Todo"), "Write docs")).toHaveCount(1);
});

test("a subtask has an immutable type, cannot nest, and remains reachable through filtering", async ({
  page,
}) => {
  await boardWithCard(page, "filter", "Parent task");

  await openCard(page, "Todo", "Parent task");
  await addSubtask(page, "Parent task", "Child task");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await bodyOfTitled(page, "Child task").click();
  const childDialog = page.getByRole("dialog", { name: "Child task" });
  await expect(childDialog.getByLabel("Type")).toContainText("Subtask");
  await expect(childDialog.getByRole("button", { name: "Type" })).toHaveCount(0);
  await expect(childDialog.getByRole("button", { name: "Add subtask" })).toHaveCount(0);
  await ensureChecklistComposer(childDialog);
  await childDialog.getByPlaceholder("Add an item").fill("Child checklist item");
  await childDialog.getByPlaceholder("Add an item").press("Enter");
  const childChecklist = childDialog.getByRole("checkbox", { name: "Child checklist item" });
  await expect(childChecklist).toBeVisible();
  await expect(
    childDialog.getByRole("button", { name: "Convert to card Child checklist item" }),
  ).toHaveCount(0);
  await childChecklist.click();
  await expect(childChecklist).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(childDialog).toHaveCount(0);

  const parent = cardIn(columnByTitle(page, "Todo"), "Parent task");
  await expect(cardTitled(parent, "Child task")).toBeVisible();

  // Filtering reveals a matching child through its otherwise collapsed parent.
  await parent.getByRole("button", { name: /Subtasks/ }).click();
  await expect(cardTitled(page, "Child task")).toHaveCount(0);
  await page.getByLabel("Search cards").fill("Child");
  await expect(parent).toBeVisible();
  await expect(cardTitled(page, "Child task")).toBeVisible();
  await expect(page.getByText("1 of 2 cards", { exact: true })).toBeVisible();

  // Clearing restores the user's collapsed state.
  await page.getByLabel("Search cards").fill("");
  await expect(cardTitled(page, "Child task")).toHaveCount(0);
  await parent.getByRole("button", { name: /Subtasks/ }).click();
  await expect(cardTitled(page, "Child task")).toBeVisible();
});

test("archiving a parent archives that card alone; its child stays on the board", async ({ page }) => {
  await boardWithCard(page, "archive", "Parent task");

  await openCard(page, "Todo", "Parent task");
  await addSubtask(page, "Parent task", "Write docs");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await cardBody(cardIn(columnByTitle(page, "Todo"), "Parent task")).click();
  const dialog = page.getByRole("dialog", { name: "Parent task" });
  await dialog.getByRole("button", { name: "Delete card" }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const column = columnByTitle(page, "Todo");
  await expect(cardIn(column, "Parent task")).toHaveCount(0);
  await expect(cardIn(column, "Write docs")).toHaveCount(1);

  await page.getByRole("button", { name: "Archived cards" }).click();
  const archiveDialog = page.getByRole("dialog", { name: "Archived cards" });
  await expect(archiveDialog.getByRole("button", { name: "Restore Parent task" })).toBeVisible();
  await expect(archiveDialog.getByRole("button", { name: "Restore Write docs" })).toHaveCount(0);
});

test("an archived child restores into the column it is sent to", async ({ page }) => {
  const boardName = `Subtasks child archive ${Date.now()}`;
  const boardKey = await createBoard(page, boardName);
  await page.goto(`/board/${boardKey}`);
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addColumn(page, "Doing");
  await addCard(page, "Todo", "Parent task");

  await openCard(page, "Todo", "Parent task");
  await addSubtask(page, "Parent task", "Write docs");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Archive the child while its parent is still active.
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Parent task")).press("Enter");
  const parentDialog = page.getByRole("dialog", { name: "Parent task" });
  await expect(parentDialog).toBeVisible();
  await parentDialog.getByRole("button", { name: "Open subtask Write docs" }).click();
  const childDialog = page.getByRole("dialog", { name: "Write docs" });
  await expect(childDialog).toBeVisible();
  await childDialog.getByRole("button", { name: "Delete card" }).click();
  await childDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(childDialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]card=/);
  await settleAnimationFrames(page);
  await expect(
    cardIn(columnByTitle(page, "Todo"), "Parent task").getByRole("button", { name: /Subtasks/ }),
  ).toHaveCount(0);

  // The archive dialog offers a destination for the linked child like any other
  // card; the last column is the completed one.
  await page.getByRole("button", { name: "Archived cards" }).click();
  const archiveDialog = page.getByRole("dialog", { name: "Archived cards" });
  await archiveDialog.getByLabel("Restore Write docs to column").selectOption({ label: "Doing" });
  await archiveDialog.getByRole("button", { name: "Restore Write docs" }).click();
  await archiveDialog.getByRole("button", { name: "Close archived cards" }).click();

  // It comes back in Doing as a card of its own, still the parent's subtask, and
  // being in the completed column it counts as done.
  const child = cardIn(columnByTitle(page, "Doing"), "Write docs");
  await expect(child).toHaveCount(1);
  await expect(child.getByRole("button", { name: "Parent: Parent task", exact: true })).toBeVisible();
  await expect(
    cardIn(columnByTitle(page, "Todo"), "Parent task").getByRole("button", { name: /Subtasks/ }),
  ).toContainText("1 / 1");
  await expect(cardIn(columnByTitle(page, "Todo"), "Write docs")).toHaveCount(0);
});

test("a restored child keeps its place after its active siblings", async ({ page }) => {
  const boardName = `Subtasks restore tail ${Date.now()}`;
  const boardKey = await createBoard(page, boardName);

  // Creation positions and the restore's own submitted position, as they cross
  // the board socket: the app orders these rows by exactly these keys.
  const childPositions: Record<string, string> = {};
  let restorePosition: string | null = null;
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as {
        type: string;
        title?: string;
        position?: string;
      };
      if (frame.type === "subtask.create" && frame.title !== undefined) {
        childPositions[frame.title] = frame.position ?? "";
      }
      if (frame.type === "card.restore") restorePosition = frame.position ?? null;
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  await page.goto(`/board/${boardKey}`);
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Parent task");

  await openCard(page, "Todo", "Parent task");
  await addSubtask(page, "Parent task", "First child");
  await addSubtask(page, "Parent task", "Second child");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Archive the LAST child while its parent stays active, then restore it.
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Parent task")).press("Enter");
  const parentDialog = page.getByRole("dialog", { name: "Parent task" });
  await expect(parentDialog).toBeVisible();
  await parentDialog.getByRole("button", { name: "Open subtask Second child" }).click();
  const childDialog = page.getByRole("dialog", { name: "Second child" });
  await childDialog.getByRole("button", { name: "Delete card" }).click();
  await childDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(childDialog).toHaveCount(0);
  await settleAnimationFrames(page);

  await page.getByRole("button", { name: "Archived cards" }).click();
  const archiveDialog = page.getByRole("dialog", { name: "Archived cards" });
  await archiveDialog.getByRole("button", { name: "Restore Second child" }).click();
  await archiveDialog.getByRole("button", { name: "Close archived cards" }).click();

  // The archived card is not a live row any more, so it cannot be picked as its
  // own tail: the restored position keys after the sibling that is still active,
  // instead of collapsing to the head of the family.
  const firstPosition = childPositions["First child"];
  expect(firstPosition).toBeTruthy();
  await expect.poll(() => restorePosition).not.toBeNull();
  expect(restorePosition! > firstPosition!).toBe(true);

  // Parent, then its children in key order: the restored child comes last.
  const titles = await cardIn(columnByTitle(page, "Todo"), "Parent task")
    .locator("[data-card-title]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-card-title")));
  expect(titles).toEqual(["Parent task", "First child", "Second child"]);
});
