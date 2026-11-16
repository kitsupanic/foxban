import { expect, test, type Browser, type Page } from "@playwright/test";
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

async function assignCard(page: Page, title: string, assignee: string): Promise<void> {
  await cardIn(columnByTitle(page, "Todo"), title).click();
  const dialog = page.getByRole("dialog", { name: title });
  await dialog.getByRole("button", { name: "Assignee" }).click();
  await dialog.getByRole("option", { name: assignee, exact: true }).click();
  await dialog.getByRole("button", { name: "Close card" }).click();
  await expect(dialog).toHaveCount(0);
}

test("assignee filters use viewer identity, compose with board filters, and survive navigation", async ({
  browser,
}) => {
  const ada = await newUser(browser, "assignee-ada", "Ada Alpha");
  const bo = await newUser(browser, "assignee-bo", "Bo Beta");

  const boardName = `Assignee filters ${Date.now()}`;
  const boardKey = await createBoard(ada.page, boardName);
  await inviteMember(ada.page, boardName, bo.email);

  await ada.page.goto(`/board/${boardKey}`);
  await expect(ada.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(ada.page, "Todo");
  await addCard(ada.page, "Todo", "Alpha mine");
  await addCard(ada.page, "Todo", "Alpha theirs");
  await addCard(ada.page, "Todo", "Beta unassigned");

  await assignCard(ada.page, "Alpha mine", "Ada Alpha");
  await assignCard(ada.page, "Alpha theirs", "Bo Beta");

  // Create and assign Bug through the card modal; no test-only board state seeding.
  await cardIn(columnByTitle(ada.page, "Todo"), "Alpha mine").click();
  const mineDialog = ada.page.getByRole("dialog", { name: "Alpha mine" });
  await mineDialog.getByRole("button", { name: "+ Add label…" }).click();
  await mineDialog.getByRole("button", { name: "Create label", exact: true }).click();
  await mineDialog.getByLabel("New label name").fill("Bug");
  await mineDialog.getByLabel("New label name").press("Enter");
  await expect(mineDialog.getByLabel("Remove label Bug")).toBeVisible();
  await ada.page.keyboard.press("Escape");
  await mineDialog.getByRole("button", { name: "Close card" }).click();
  await expect(mineDialog).toHaveCount(0);

  let adaColumn = columnByTitle(ada.page, "Todo");
  const adaQuick = ada.page.getByRole("button", { name: "Assigned to me", exact: true });
  await expect(adaQuick).toHaveAttribute("aria-pressed", "false");
  await adaQuick.click();
  await expect(adaQuick).toHaveAttribute("aria-pressed", "true");
  await expect(cardIn(adaColumn, "Alpha mine")).toBeVisible();
  await expect(cardIn(adaColumn, "Alpha theirs")).toHaveCount(0);
  await expect(cardIn(adaColumn, "Beta unassigned")).toHaveCount(0);
  await expect(ada.page.getByText("1 of 3 cards", { exact: true })).toBeVisible();
  const adaToken = new URL(ada.page.url()).searchParams.get("assignees");
  expect(adaToken).toBeTruthy();
  expect(adaToken?.split(",")).toHaveLength(1);
  await adaQuick.click();
  await expect(adaQuick).toHaveAttribute("aria-pressed", "false");
  expect(new URL(ada.page.url()).searchParams.get("assignees")).toBeNull();

  // The shortcut is scoped to the signed-in viewer, not the board owner.
  await bo.page.goto(`/board/${boardKey}`);
  await expect(bo.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  const boQuick = bo.page.getByRole("button", { name: "Assigned to me", exact: true });
  await bo.page.getByRole("heading", { level: 1 }).click();
  await bo.page.keyboard.press("m");
  const boColumn = columnByTitle(bo.page, "Todo");
  await expect(cardIn(boColumn, "Alpha mine")).toHaveCount(0);
  await expect(cardIn(boColumn, "Alpha theirs")).toBeVisible();
  await expect(cardIn(boColumn, "Beta unassigned")).toHaveCount(0);
  await expect(boQuick).toHaveAttribute("aria-pressed", "true");
  const viewerBoToken = new URL(bo.page.url()).searchParams.get("assignees");
  expect(viewerBoToken).toBeTruthy();
  expect(viewerBoToken).not.toBe(adaToken);
  await bo.page.keyboard.press("m");
  expect(new URL(bo.page.url()).searchParams.get("assignees")).toBeNull();

  const filtersButton = ada.page.getByRole("button", {
    name: "Filter cards",
    exact: true,
  });
  const filterDialog = ada.page.getByRole("dialog", { name: "Filter cards" });
  await expect(filtersButton).toHaveAttribute("aria-haspopup", "dialog");
  await expect(filtersButton).toHaveAttribute("aria-expanded", "false");
  await filtersButton.click();
  await expect(filtersButton).toHaveAttribute("aria-expanded", "true");
  await expect(filterDialog.getByRole("button", { name: "Close filter cards" })).toBeFocused();
  await ada.page.keyboard.press("Escape");
  await expect(filterDialog).toHaveCount(0);
  await expect(filtersButton).toBeFocused();

  await filtersButton.click();
  await filterDialog.getByRole("button", { name: "Ada Alpha" }).click();
  await filterDialog.getByRole("button", { name: "Bo Beta" }).click();
  await expect(filterDialog).toBeVisible();
  await expect(filtersButton).toHaveText("Filters · 2");
  await expect(cardIn(adaColumn, "Alpha mine")).toBeVisible();
  await expect(cardIn(adaColumn, "Alpha theirs")).toBeVisible();
  await expect(cardIn(adaColumn, "Beta unassigned")).toHaveCount(0);

  await filterDialog.getByRole("button", { name: "Filter by unassigned" }).click();
  await expect(filtersButton).toHaveText("Filters · 3");
  await expect(cardIn(adaColumn, "Alpha mine")).toBeVisible();
  await expect(cardIn(adaColumn, "Alpha theirs")).toBeVisible();
  await expect(cardIn(adaColumn, "Beta unassigned")).toBeVisible();

  await filterDialog.getByRole("button", { name: "Ada Alpha" }).click();
  await filterDialog.getByRole("button", { name: "Unassigned" }).click();
  await expect(filtersButton).toHaveText("Filters · 1");
  await expect(cardIn(adaColumn, "Alpha mine")).toHaveCount(0);
  await expect(cardIn(adaColumn, "Alpha theirs")).toBeVisible();
  await expect(cardIn(adaColumn, "Beta unassigned")).toHaveCount(0);
  const boOnlyToken = new URL(ada.page.url()).searchParams.get("assignees");
  expect(boOnlyToken).toBeTruthy();

  await ada.page.reload();
  adaColumn = columnByTitle(ada.page, "Todo");
  await expect(adaColumn.getByRole("button", { name: "Rename column Todo", exact: true })).toBeVisible();
  expect(new URL(ada.page.url()).searchParams.get("assignees")).toBe(boOnlyToken);
  await expect(cardIn(adaColumn, "Alpha mine")).toHaveCount(0);
  await expect(cardIn(adaColumn, "Alpha theirs")).toBeVisible();
  await expect(cardIn(adaColumn, "Beta unassigned")).toHaveCount(0);

  await cardIn(adaColumn, "Alpha theirs").click();
  const theirsDialog = ada.page.getByRole("dialog", { name: "Alpha theirs" });
  await expect(theirsDialog).toBeVisible();
  await theirsDialog.getByRole("button", { name: "Close card" }).click();
  await expect(theirsDialog).toHaveCount(0);
  expect(new URL(ada.page.url()).searchParams.get("assignees")).toBe(boOnlyToken);
  await expect(cardIn(adaColumn, "Alpha theirs")).toBeVisible();

  // Label, assignee, and title dimensions intersect rather than widening one another.
  // The reload above closed the dialog, so the one Filters control opens it again.
  await filtersButton.click();
  await expect(filterDialog).toBeVisible();
  await filterDialog.getByRole("button", { name: "Filter by label Bug" }).click();
  await expect(ada.page.getByText("0 of 3 cards", { exact: true })).toBeVisible();
  await expect(cardIn(adaColumn, "Alpha mine")).toHaveCount(0);
  await expect(cardIn(adaColumn, "Alpha theirs")).toHaveCount(0);
  const bugToken = new URL(ada.page.url()).searchParams.get("labels");
  expect(bugToken).toBeTruthy();

  await ada.page.keyboard.press("Escape");
  await expect(filterDialog).toHaveCount(0);
  const search = ada.page.getByLabel("Search cards");
  await search.fill("Alpha");
  let combinedParams = new URL(ada.page.url()).searchParams;
  expect(combinedParams.get("q")).toBe("Alpha");
  expect(combinedParams.get("labels")).toBe(bugToken);
  expect(combinedParams.get("assignees")).toBe(boOnlyToken);
  await expect(ada.page.getByText("0 of 3 cards", { exact: true })).toBeVisible();

  // The hotkey replaces Bo with Ada, survives reload, then clears only assignees.
  const restoredQuick = ada.page.getByRole("button", { name: "Assigned to me", exact: true });
  await ada.page.getByRole("heading", { level: 1 }).click();
  await ada.page.keyboard.press("m");
  await expect(restoredQuick).toHaveAttribute("aria-pressed", "true");
  combinedParams = new URL(ada.page.url()).searchParams;
  expect(combinedParams.get("q")).toBe("Alpha");
  expect(combinedParams.get("labels")).toBe(bugToken);
  expect(combinedParams.get("assignees")).toBe(adaToken);
  await expect(cardIn(adaColumn, "Alpha mine")).toBeVisible();
  await expect(cardIn(adaColumn, "Alpha theirs")).toHaveCount(0);

  await ada.page.reload();
  adaColumn = columnByTitle(ada.page, "Todo");
  await expect(adaColumn.getByRole("button", { name: "Rename column Todo", exact: true })).toBeVisible();
  await expect(restoredQuick).toHaveAttribute("aria-pressed", "true");
  combinedParams = new URL(ada.page.url()).searchParams;
  expect(combinedParams.get("q")).toBe("Alpha");
  expect(combinedParams.get("labels")).toBe(bugToken);
  expect(combinedParams.get("assignees")).toBe(adaToken);
  await expect(cardIn(adaColumn, "Alpha mine")).toBeVisible();

  await ada.page.getByRole("heading", { level: 1 }).click();
  await ada.page.keyboard.press("m");
  await expect(restoredQuick).toHaveAttribute("aria-pressed", "false");
  combinedParams = new URL(ada.page.url()).searchParams;
  expect(combinedParams.get("q")).toBe("Alpha");
  expect(combinedParams.get("labels")).toBe(bugToken);
  expect(combinedParams.get("assignees")).toBeNull();
  await expect(cardIn(adaColumn, "Alpha mine")).toBeVisible();
  const restoredFiltersButton = ada.page.getByRole("button", { name: "Filter cards", exact: true });
  await restoredFiltersButton.click();
  await filterDialog.getByRole("button", { name: "Bo Beta" }).click();
  await expect(ada.page.getByText("0 of 3 cards", { exact: true })).toBeVisible();
  // One dialog owns the combined clear: it drops every dimension at once.
  await filterDialog.getByRole("button", { name: "Clear filters", exact: true }).click();
  combinedParams = new URL(ada.page.url()).searchParams;
  expect(combinedParams.get("q")).toBeNull();
  expect(combinedParams.get("labels")).toBeNull();
  expect(combinedParams.get("assignees")).toBeNull();
  await expect(cardIn(adaColumn, "Alpha mine")).toBeVisible();

  // Rebuild every dimension, then exercise the narrow header and the global clear.
  await filterDialog.getByRole("button", { name: "Bo Beta" }).click();
  await filterDialog.getByRole("button", { name: "Filter by label Bug" }).click();
  await ada.page.keyboard.press("Escape");
  await expect(filterDialog).toHaveCount(0);
  await search.fill("Alpha");
  await expect(ada.page.getByText("0 of 3 cards", { exact: true })).toBeVisible();

  await ada.page.setViewportSize({ width: 375, height: 667 });
  const mobileFiltersButton = ada.page.getByRole("button", { name: "Filter cards", exact: true });
  await expect(restoredQuick).toBeVisible();
  await expect(mobileFiltersButton).toBeVisible();
  await expect(mobileFiltersButton).toHaveText("Filters · 2");
  await expect(ada.page.getByText(/^(Live|reconnecting…)$/)).toBeVisible();
  await expect(ada.page.getByText("0 of 3 cards", { exact: true })).toBeVisible();
  const clearAll = ada.page.getByRole("button", { name: "Clear filters", exact: true });
  await expect(clearAll).toBeVisible();
  const documentWidth = await ada.page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(documentWidth.scrollWidth).toBe(documentWidth.clientWidth);

  await clearAll.click();
  combinedParams = new URL(ada.page.url()).searchParams;
  expect(combinedParams.get("q")).toBeNull();
  expect(combinedParams.get("labels")).toBeNull();
  expect(combinedParams.get("assignees")).toBeNull();
  await expect(search).toHaveValue("");
  await expect(cardIn(adaColumn, "Alpha mine")).toBeVisible();
  await expect(cardIn(adaColumn, "Alpha theirs")).toBeVisible();
  await expect(cardIn(adaColumn, "Beta unassigned")).toBeVisible();
  await ada.page.context().close();
  await bo.page.context().close();
});
test("assignee avatar is right-aligned in card footer across wrapped badges and fallbacks", async ({
  browser,
}) => {
  const ada = await newUser(browser, "align-ada", "Ada Alpha");
  const boardName = `Align Board ${Date.now()}`;
  const boardKey = await createBoard(ada.page, boardName);
  await ada.page.goto(`/board/${boardKey}`);
  await addColumn(ada.page, "Todo");
  await addCard(ada.page, "Todo", "Right Align Card");

  const col = columnByTitle(ada.page, "Todo");
  const card = cardIn(col, "Right Align Card");
  await assignCard(ada.page, "Right Align Card", "Ada Alpha");

  // Assignee avatar is positioned on the right side of the card bottom row
  const avatar = card.getByRole("img", { name: "Assigned to Ada Alpha" });
  await expect(avatar).toBeVisible();

  const cardBox = await card.boundingBox();
  const avatarBox = await avatar.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(avatarBox).not.toBeNull();
  // Avatar right edge should align closely to card right edge (within padding)
  const cardRight = cardBox!.x + cardBox!.width;
  const avatarRight = avatarBox!.x + avatarBox!.width;
  expect(cardRight - avatarRight).toBeLessThanOrEqual(24);
  await ada.page.context().close();
});
test("contributors sidebar section displays Created by and Assigned during this task in modal and fullscreen", async ({
  browser,
}) => {
  const ada = await newUser(browser, "contrib-ada", "Ada Alpha");
  const bo = await newUser(browser, "contrib-bo", "Bo Beta");
  const boardName = `Contrib Board ${Date.now()}`;
  const boardKey = await createBoard(ada.page, boardName);
  await inviteMember(ada.page, boardName, bo.email);

  await ada.page.goto(`/board/${boardKey}`);
  await addColumn(ada.page, "Todo");
  await addCard(ada.page, "Todo", "History Card");

  // Ada creates card, assigns Ada -> Bo -> unassigned
  await assignCard(ada.page, "History Card", "Ada Alpha");
  await assignCard(ada.page, "History Card", "Bo Beta");

  const col = columnByTitle(ada.page, "Todo");
  const card = cardIn(col, "History Card");
  await card.click();

  const dialog = ada.page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Unassign card
  await dialog.getByRole("button", { name: "Assignee" }).click();
  await dialog.getByRole("option", { name: "Unassigned" }).click();

  // Secondary contributor details open from their summary.
  const contributorsHeading = dialog.getByRole("heading", { name: "Contributors" });
  await expect(contributorsHeading).toBeVisible();
  const contributors = contributorsHeading.locator("../..");
  await contributors.locator("summary").click();
  await expect(contributors).toHaveAttribute("open", "");

  // Created by row displays Ada Alpha
  await expect(dialog.getByText("Created by:")).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Created by Ada Alpha" })).toBeVisible();

  // Assigned during this task row displays Ada Alpha and Bo Beta in first-assigned order
  await expect(dialog.getByText("Assigned during this task:")).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Assigned: Ada Alpha" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Assigned: Bo Beta" })).toBeVisible();

  // Switch to fullscreen: shared body displays the same Contributors section
  await dialog.getByRole("button", { name: "Open full screen" }).click();
  await expect(dialog.getByRole("heading", { name: "Contributors" })).toBeVisible();
  if (!(await contributors.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await contributors.locator("summary").click();
  }
  await expect(contributors).toHaveAttribute("open", "");
  await expect(dialog.getByRole("img", { name: "Created by Ada Alpha" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Assigned: Ada Alpha" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Assigned: Bo Beta" })).toBeVisible();
  await ada.page.context().close();
  await bo.page.context().close();
});
