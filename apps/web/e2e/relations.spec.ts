import { authTest as test, expect, type Page } from "./fixtures";
import { addCard, addColumn, cardIn, columnByTitle, createBoard, openCardSection } from "./helpers";

async function boardWithCard(page: Page, suffix: string, cardTitle: string): Promise<void> {
  const boardName = `Relations ${suffix} ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", cardTitle);
}

/**
 * A fresh board key for the relation-search case. Focused runs share the local
 * D1 persistence, so a literal key collides on the next run. Letters only: the
 * case's third card title embeds the key, and a digit-bearing key could contain
 * the `02` the leading-zero oracle relies on. The fixed `REL` prefix keeps it
 * distinct from the `OTHERBOARD-2` wrong-prefix probe.
 */
function uniqueBoardKey(): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const suffix = Array.from(
    crypto.getRandomValues(new Uint8Array(6)),
    (byte) => letters[byte % letters.length],
  ).join("");
  return `REL${suffix}`;
}

test("a blocks relation shows on both cards, navigates, survives a reload, and clears", async ({
  page,
}) => {
  await boardWithCard(page, "blocks", "Alpha");
  await addCard(page, "Todo", "Beta");

  let column = columnByTitle(page, "Todo");
  let alpha = cardIn(column, "Alpha");
  let beta = cardIn(column, "Beta");
  await expect(alpha.getByTestId("relation-badge")).toHaveCount(0);
  await expect(beta.getByTestId("relation-badge")).toHaveCount(0);

  await alpha.click();
  let dialog = page.getByRole("dialog");
  await openCardSection(dialog, "relations");
  // The composer is collapsed until asked for, like the comment one.
  await dialog.getByRole("button", { name: "+ Link a card…" }).click();
  await dialog.getByLabel("Relation kind").selectOption({ label: "Blocks" });
  const picker = dialog.getByRole("textbox", { name: "Link a card", exact: true });
  await picker.fill("bet");
  const results = dialog.getByTestId("relation-results");
  await expect(results.getByRole("button").filter({ hasText: "Beta" })).toBeVisible();
  await results.getByRole("button").filter({ hasText: "Beta" }).click();
  await expect(dialog.getByText("Blocks Beta", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Relations 1" })).toBeVisible();
  await expect(picker).toHaveValue("");

  await picker.fill("x");
  await expect(dialog.getByText("No matching cards", { exact: true })).toBeVisible();
  // Three stages, innermost first: the query, then the composer, then the modal.
  await picker.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(picker).toHaveValue("");
  await picker.press("Escape");
  await expect(dialog.getByRole("textbox", { name: "Link a card", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "+ Link a card…" })).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await expect(alpha.getByTestId("relation-badge")).toHaveText("1");
  await expect(alpha.getByTestId("relation-badge")).toHaveAttribute("data-blocked", "false");
  await expect(alpha.getByTestId("relation-badge")).toHaveAttribute("aria-label", "1 linked card");
  await expect(beta.getByTestId("relation-badge")).toHaveText("1");
  await expect(beta.getByTestId("relation-badge")).toHaveAttribute("data-blocked", "true");
  await expect(beta.getByTestId("relation-badge")).toHaveAttribute("aria-label", "Blocked by another card; 1 linked card");

  await beta.click();
  dialog = page.getByRole("dialog");
  await openCardSection(dialog, "relations");
  await expect(dialog.getByText("Blocked by Alpha", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Open Alpha" }).click();
  await expect(dialog.getByRole("heading", { name: "Alpha", exact: true, level: 2 })).toBeVisible();
  await expect(dialog.getByLabel("Card title")).toHaveCount(0);

  // Close first: the URL would otherwise restore the dialog across the reload.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.reload();
  column = columnByTitle(page, "Todo");
  alpha = cardIn(column, "Alpha");
  beta = cardIn(column, "Beta");
  await expect(alpha.getByTestId("relation-badge")).toHaveText("1");
  await expect(alpha.getByTestId("relation-badge")).toHaveAttribute("data-blocked", "false");
  await expect(alpha.getByTestId("relation-badge")).toHaveAttribute("aria-label", "1 linked card");
  await expect(beta.getByTestId("relation-badge")).toHaveText("1");
  await expect(beta.getByTestId("relation-badge")).toHaveAttribute("data-blocked", "true");
  await expect(beta.getByTestId("relation-badge")).toHaveAttribute("aria-label", "Blocked by another card; 1 linked card");

  await alpha.click();
  dialog = page.getByRole("dialog");
  await openCardSection(dialog, "relations");
  await dialog.getByRole("button", { name: "Delete relation Blocks Beta" }).click();
  await expect(dialog.getByRole("heading", { name: "Relations", exact: true })).toBeVisible();
  await expect(dialog.getByText("Blocks Beta", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alpha.getByTestId("relation-badge")).toHaveCount(0);
  await expect(beta.getByTestId("relation-badge")).toHaveCount(0);

  await page.reload();
  column = columnByTitle(page, "Todo");
  await expect(cardIn(column, "Alpha").getByTestId("relation-badge")).toHaveCount(0);
  await expect(cardIn(column, "Beta").getByTestId("relation-badge")).toHaveCount(0);
});

test("relation search matches by exact board task ID, task number, and title with exact key priority", async ({
  page,
}) => {
  const boardName = `RelSearch ${Date.now()}`;
  const boardKey = uniqueBoardKey();
  const secondKey = `${boardKey}-2`;
  const lowercaseSecondKey = `${boardKey.toLowerCase()}-2`;
  await createBoard(page, boardName, boardKey);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Backlog");

  // Card 1: "Task One" (<KEY>-1)
  await addCard(page, "Backlog", "Task One");
  // Card 2: "Second 123 item" (<KEY>-2)
  await addCard(page, "Backlog", "Second 123 item");
  // Card 3: "<KEY>-2 in title" (<KEY>-3)
  await addCard(page, "Backlog", `${secondKey} in title`);

  const col = columnByTitle(page, "Backlog");
  const card1 = cardIn(col, "Task One");
  await card1.click();

  const dialog = page.getByRole("dialog");
  await openCardSection(dialog, "relations");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "+ Link a card…" }).click();

  const picker = dialog.getByPlaceholder("Search by title or task ID…");
  await expect(picker).toBeVisible();

  // 1. Search by task number "2": exact match for <KEY>-2 comes first
  await picker.fill("2");
  const results = dialog.getByTestId("relation-results");
  await expect(results).toBeVisible();
  const firstResult = results.getByRole("button").first();
  await expect(firstResult).toContainText(secondKey);
  await expect(firstResult).toContainText("Second 123 item");

  // 2. Search by lowercase task key "<key>-2": exact match for <KEY>-2 comes first
  await picker.fill(lowercaseSecondKey);
  const lowerResults = dialog.getByTestId("relation-results");
  const topResult = lowerResults.getByRole("button").first();
  await expect(topResult).toContainText(secondKey);

  // 3. Search by exact uppercase key "<KEY>-2": exact match comes first
  await picker.fill(secondKey);
  const exactResults = dialog.getByTestId("relation-results");
  await expect(exactResults.getByRole("button").first()).toContainText(secondKey);

  // 4. Zero and leading zeros ("0", "02") do not match by identifier; only match title substring if present
  await picker.fill("02");
  await expect(dialog.getByText("No matching cards", { exact: true })).toBeVisible();

  // 5. The valid ten-letter wrong key cannot occur in the nine-letter fixture key or its title.
  await picker.fill("OTHERBOARD-2");
  await expect(dialog.getByText("No matching cards", { exact: true })).toBeVisible();

  // Pressing Enter links the first matching card
  await picker.fill("2");
  await expect(results.getByRole("button").first()).toBeVisible();
  await picker.press("Enter");
  const relationButton = dialog.getByRole("button", { name: "Open Second 123 item" });
  await expect(relationButton).toBeVisible();
  await expect(relationButton).toContainText("Related to");
  await expect(relationButton).toContainText("Second 123 item");
});
