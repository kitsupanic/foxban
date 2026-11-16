import { authTest as test, expect } from "./fixtures";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
} from "./helpers";

test("a card expands fullscreen, deep-links via the URL, survives a reload, and collapses back", async ({
  page,
}) => {
  const boardName = `Fullscreen ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Big task");

  await cardIn(columnByTitle(page, "Todo"), "Big task").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("card-sidebar")).toBeVisible();
  await expect(page).toHaveURL(/card=/);

  // Expanding swaps the shell around the same component instance: the mode
  // button flips, the URL gains the mode, and the title draft is untouched. The
  // sidebar is in both shells, so it cannot tell them apart.
  await dialog.getByRole("button", { name: "Open full screen" }).click();
  await expect(dialog.getByRole("button", { name: "Exit full screen" })).toBeVisible();
  await expect(page).toHaveURL(/view=full/);
  await expect(dialog.getByRole("heading", { name: "Big task", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);
  const fullUrl = page.url();

  // No card click after the reload: the URL alone restores the fullscreen card.
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Exit full screen" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Big task", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close card" })).toBeFocused();
  await dialog.getByRole("button", { name: "Exit full screen" }).click();
  await expect(dialog.getByRole("button", { name: "Open full screen" })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/card=/);
  await expect(page).not.toHaveURL(/view=full/);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/board\/[A-Z0-9]+$/);

  // The shareable link: the same URL pasted fresh lands in the fullscreen card.
  await page.goto(fullUrl);
  await expect(dialog.getByRole("button", { name: "Exit full screen" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Big task", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close card" })).toBeFocused();

  // While editing, switching between modal and fullscreen shells preserves the
  // draft and textbox edit state.
  await dialog.getByRole("button", { name: "Edit title", exact: true }).click();
  await expect(dialog.getByLabel("Card title")).toBeFocused();
  await dialog.getByLabel("Card title").fill("Big task in progress");

  await dialog.getByRole("button", { name: "Exit full screen" }).click();
  await expect(dialog.getByRole("button", { name: "Open full screen" })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveValue("Big task in progress");

  await dialog.getByRole("button", { name: "Open full screen" }).click();
  await expect(dialog.getByRole("button", { name: "Exit full screen" })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveValue("Big task in progress");

  await page.keyboard.press("Escape");
  // Escape exits title editing mode, returning to draft heading preview without closing the dialog.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Big task in progress", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/board\/[A-Z0-9]+$/);
});
