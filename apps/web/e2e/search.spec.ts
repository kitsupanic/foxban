import { authTest as test, expect, type Locator } from "./fixtures";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
} from "./helpers";

/**
 * Scopes to the column header's sr-only accessible text, then returns the
 * visible child numeric span to assert rendered values.
 */
function columnCounter(column: Locator, accessibleText: string): Locator {
  return column
    .locator("header")
    .getByText(accessibleText)
    .locator("..")
    .locator('[aria-hidden="true"]');
}

test("the board header filters cards by title search, intersects with labels, and persists across reload and card navigation", async ({
  page,
}) => {
  // 1. Set up a unique signed-up user and board with at least two columns.
  // Add cards exactly Alpha Bug, Alpha Chore, and Beta, distributed so both columns participate.
  const boardName = `Search Board ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Boards" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Profile", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addColumn(page, "Doing");

  let todoCol = columnByTitle(page, "Todo");
  let doingCol = columnByTitle(page, "Doing");
  await expect(columnCounter(todoCol, "0 cards")).toHaveText("0");
  await expect(columnCounter(doingCol, "0 cards")).toHaveText("0");

  await addCard(page, "Todo", "Alpha Bug");
  await addCard(page, "Doing", "Alpha Chore");
  await addCard(page, "Doing", "Beta");

  await expect(cardIn(todoCol, "Alpha Bug")).toBeVisible();
  await expect(cardIn(doingCol, "Alpha Chore")).toBeVisible();
  await expect(cardIn(doingCol, "Beta")).toBeVisible();
  await expect(columnCounter(todoCol, "1 card")).toHaveText("1");
  await expect(columnCounter(doingCol, "2 cards")).toHaveText("2");
  // Add ALpHa solely to Beta's description to prove search matches card.title only.
  await cardIn(doingCol, "Beta").click();
  const betaDialog = page.getByRole("dialog");
  await expect(betaDialog).toBeVisible();
  await betaDialog.getByRole("button", { name: "Add a description…" }).click();
  await betaDialog.getByLabel("Card description").fill("ALpHa description details");
  await betaDialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(betaDialog).toHaveCount(0);

  // 2. Through the existing card modal UI, create and assign a Bug label to Alpha Bug
  // using the established labels.spec.ts flow, then close the picker/modal correctly.
  await cardIn(todoCol, "Alpha Bug").click();
  const cardDialog = page.getByRole("dialog");
  await expect(cardDialog).toBeVisible();
  await cardDialog.getByRole("button", { name: "+ Add label…" }).click();
  await cardDialog.getByRole("button", { name: "Create label", exact: true }).click();
  await cardDialog.getByLabel("New label name").fill("Bug");
  await cardDialog.getByLabel("New label name").press("Enter");
  await expect(cardDialog.getByLabel("Remove label Bug")).toBeVisible();
  // First escape closes the label picker popover; second escape closes the card modal.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(cardDialog).toHaveCount(0);

  // 3. Assert / focuses getByLabel("Search cards").
  // Park focus on a non-input element so the board shortcut handler fires.
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("/");
  const searchInput = page.getByLabel("Search cards");
  await expect(searchInput).toBeFocused();
  await expect(searchInput).toHaveValue("");

  // Capture browser history length before search edits to defend replace-only route updates.
  const historyLengthBeforeSearch = await page.evaluate(() => window.history.length);

  // Enter whitespace-only raw query: cards remain visible, spaces preserved, history doesn't grow.
  await searchInput.fill("   ");
  await expect(searchInput).toHaveValue("   ");
  await expect(page).toHaveURL(/q=/);
  expect(new URL(page.url()).searchParams.get("q")).toBe("   ");
  expect(await page.evaluate(() => window.history.length)).toBe(historyLengthBeforeSearch);
  await expect(cardIn(todoCol, "Alpha Bug")).toBeVisible();
  await expect(cardIn(doingCol, "Alpha Chore")).toBeVisible();
  await expect(cardIn(doingCol, "Beta")).toBeVisible();
  await expect(columnCounter(todoCol, "1 card")).toHaveText("1");
  await expect(columnCounter(doingCol, "2 cards")).toHaveText("2");

  // 4. Enter mixed-case ALpHa; assert both Alpha cards remain across their columns and Beta is absent
  // (even though Beta contains ALpHa in its description, proving search is title-only).
  await searchInput.fill("ALpHa");
  await expect(searchInput).toHaveValue("ALpHa");
  await expect(page).toHaveURL(/q=ALpHa/);
  expect(new URL(page.url()).searchParams.get("q")).toBe("ALpHa");
  expect(await page.evaluate(() => window.history.length)).toBe(historyLengthBeforeSearch);
  await expect(cardIn(todoCol, "Alpha Bug")).toBeVisible();
  await expect(cardIn(doingCol, "Alpha Chore")).toBeVisible();
  await expect(cardIn(doingCol, "Beta")).toHaveCount(0);
  await expect(page.getByText("2 of 3 cards")).toBeVisible();
  await expect(columnCounter(todoCol, "1 of 1 cards shown")).toHaveText("1 / 1");
  await expect(columnCounter(doingCol, "1 of 2 cards shown")).toHaveText("1 / 2");
  // 5. Open the label filter and select Bug; assert only Alpha Bug remains.
  // Assert URL query state has exact q ALpHa and non-empty labels.
  const filterButton = page.getByRole("button", { name: "Filter cards", exact: true });
  await expect(filterButton).toHaveAttribute("aria-expanded", "false");
  await filterButton.click();
  await expect(filterButton).toHaveAttribute("aria-expanded", "true");

  // Backdrop dismissal: a pointer outside the panel closes it.
  await page.locator(".board-filter-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(filterButton).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Filter by label Bug" })).toHaveCount(0);

  await filterButton.click();
  await expect(filterButton).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Filter by label Bug" }).click();

  await expect(cardIn(todoCol, "Alpha Bug")).toBeVisible();
  await expect(cardIn(doingCol, "Alpha Chore")).toHaveCount(0);
  await expect(cardIn(doingCol, "Beta")).toHaveCount(0);
  await expect(page.getByText("1 of 3 cards")).toBeVisible();
  await expect(columnCounter(todoCol, "1 of 1 cards shown")).toHaveText("1 / 1");
  await expect(columnCounter(doingCol, "0 of 2 cards shown")).toHaveText("0 / 2");
  await expect(page).toHaveURL(/q=ALpHa/);
  await expect(page).toHaveURL(/labels=/);
  const urlAfterFilter = new URL(page.url());
  expect(urlAfterFilter.searchParams.get("q")).toBe("ALpHa");
  expect(urlAfterFilter.searchParams.get("labels")).toBeTruthy();

  // 6. Reload; re-resolve locators; assert search value, both URL states, and only Alpha Bug visible.
  await page.reload();
  todoCol = columnByTitle(page, "Todo");
  doingCol = columnByTitle(page, "Doing");
  await expect(todoCol.getByRole("button", { name: "Rename column Todo", exact: true })).toBeVisible();

  const searchAfterReload = page.getByLabel("Search cards");
  await expect(searchAfterReload).toHaveValue("ALpHa");

  await expect(page).toHaveURL(/q=ALpHa/);
  await expect(page).toHaveURL(/labels=/);
  const urlAfterReload = new URL(page.url());
  expect(urlAfterReload.searchParams.get("q")).toBe("ALpHa");
  expect(urlAfterReload.searchParams.get("labels")).toBeTruthy();

  await expect(cardIn(todoCol, "Alpha Bug")).toBeVisible();
  await expect(cardIn(doingCol, "Alpha Chore")).toHaveCount(0);
  await expect(cardIn(doingCol, "Beta")).toHaveCount(0);
  await expect(page.getByText("1 of 3 cards")).toBeVisible();
  await expect(columnCounter(todoCol, "1 of 1 cards shown")).toHaveText("1 / 1");
  await expect(columnCounter(doingCol, "0 of 2 cards shown")).toHaveText("0 / 2");
  // 7. While both filters are active, open Alpha Bug and close it through the existing dialog interaction;
  // assert q and labels remain in the URL and the filtered board remains unchanged.
  await cardIn(todoCol, "Alpha Bug").click();
  const openedCardDialog = page.getByRole("dialog");
  await expect(openedCardDialog).toBeVisible();
  await openedCardDialog.getByRole("button", { name: "Close card" }).click();
  await expect(openedCardDialog).toHaveCount(0);

  await expect(page).toHaveURL(/q=ALpHa/);
  await expect(page).toHaveURL(/labels=/);
  const urlAfterCardModal = new URL(page.url());
  expect(urlAfterCardModal.searchParams.get("q")).toBe("ALpHa");
  expect(urlAfterCardModal.searchParams.get("labels")).toBeTruthy();

  await expect(cardIn(todoCol, "Alpha Bug")).toBeVisible();
  await expect(cardIn(doingCol, "Alpha Chore")).toHaveCount(0);
  await expect(cardIn(doingCol, "Beta")).toHaveCount(0);

  // 8. Focus search and press Escape; assert q is removed, labels remains, focus stays on search,
  // and only Alpha Bug remains. Press Escape again; assert search is no longer focused.
  await searchAfterReload.focus();
  await expect(searchAfterReload).toBeFocused();

  await searchAfterReload.press("Escape");
  await expect(searchAfterReload).toHaveValue("");
  await expect(page).not.toHaveURL(/q=/);
  await expect(page).toHaveURL(/labels=/);
  const urlAfterClearSearch = new URL(page.url());
  expect(urlAfterClearSearch.searchParams.get("q")).toBeNull();
  expect(urlAfterClearSearch.searchParams.get("labels")).toBeTruthy();

  await expect(searchAfterReload).toBeFocused();
  await expect(cardIn(todoCol, "Alpha Bug")).toBeVisible();
  await expect(cardIn(doingCol, "Alpha Chore")).toHaveCount(0);
  await expect(cardIn(doingCol, "Beta")).toHaveCount(0);
  await expect(page.getByText("1 of 3 cards")).toBeVisible();
  await expect(columnCounter(todoCol, "1 of 1 cards shown")).toHaveText("1 / 1");
  await expect(columnCounter(doingCol, "0 of 2 cards shown")).toHaveText("0 / 2");
  await searchAfterReload.press("Escape");
  await expect(searchAfterReload).not.toBeFocused();

  // 9. Clear the label filter through the header UI and assert all three cards are visible again
  // and labels is absent.
  const filterAfterClear = page.getByRole("button", { name: "Filter cards", exact: true });
  await expect(filterAfterClear).toHaveAttribute("aria-expanded", "false");
  await filterAfterClear.click();
  await expect(filterAfterClear).toHaveAttribute("aria-expanded", "true");
  const filterDialogAfterClear = page.getByRole("dialog", { name: "Filter cards" });
  await filterDialogAfterClear.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(filterAfterClear).toHaveAttribute("aria-expanded", "false");

  await expect(page).not.toHaveURL(/labels=/);
  const urlAfterClearLabels = new URL(page.url());
  expect(urlAfterClearLabels.searchParams.get("labels")).toBeNull();

  await expect(cardIn(todoCol, "Alpha Bug")).toBeVisible();
  await expect(cardIn(doingCol, "Alpha Chore")).toBeVisible();
  await expect(cardIn(doingCol, "Beta")).toBeVisible();
  // Nothing is filtered now, so no clear action is offered.
  await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
  await expect(columnCounter(todoCol, "1 card")).toHaveText("1");
  await expect(columnCounter(doingCol, "2 cards")).toHaveText("2");
  // 10. Activate both title search and label filter with a zero-match query; assert "0 of 3 cards",
  // role="status" zero state, and header "Clear filters" clearing both parameters.
  await searchInput.fill("Nonexistent");
  await expect(page).toHaveURL(/q=Nonexistent/);

  const filterForBoth = page.getByRole("button", { name: "Filter cards", exact: true });
  await filterForBoth.click();
  await page.getByRole("button", { name: "Filter by label Bug" }).click();
  await page.keyboard.press("Escape");

  await expect(page).toHaveURL(/q=Nonexistent/);
  await expect(page).toHaveURL(/labels=/);
  await expect(page.getByText("0 of 3 cards")).toBeVisible();

  const zeroState = page.locator('[role="status"]').filter({ hasText: "No cards match the active filters." });
  await expect(zeroState).toBeVisible();
  await expect(zeroState).toHaveText("No cards match the active filters.");
  await expect(cardIn(todoCol, "Alpha Bug")).toHaveCount(0);
  await expect(cardIn(doingCol, "Alpha Chore")).toHaveCount(0);
  await expect(cardIn(doingCol, "Beta")).toHaveCount(0);
  await expect(columnCounter(todoCol, "0 of 1 cards shown")).toHaveText("0 / 1");
  await expect(columnCounter(doingCol, "0 of 2 cards shown")).toHaveText("0 / 2");
  // Header "Clear filters" clears both q and labels in one action while preserving the route.
  const clearAllFiltersButton = page.getByRole("button", { name: "Clear filters", exact: true });
  await clearAllFiltersButton.click();

  await expect(page).not.toHaveURL(/q=/);
  await expect(page).not.toHaveURL(/labels=/);
  const urlAfterClearAll = new URL(page.url());
  expect(urlAfterClearAll.searchParams.get("q")).toBeNull();
  expect(urlAfterClearAll.searchParams.get("labels")).toBeNull();

  await expect(searchInput).toHaveValue("");
  await expect(zeroState).toHaveCount(0);
  await expect(clearAllFiltersButton).toHaveCount(0);
  // With every dimension cleared the count is the plain, unfiltered readout.
  await expect(page.getByText("3 of 3 cards", { exact: true })).toBeVisible();

  await expect(cardIn(todoCol, "Alpha Bug")).toBeVisible();
  await expect(cardIn(doingCol, "Alpha Chore")).toBeVisible();
  await expect(cardIn(doingCol, "Beta")).toBeVisible();
  await expect(columnCounter(todoCol, "1 card")).toHaveText("1");
  await expect(columnCounter(doingCol, "2 cards")).toHaveText("2");
});
