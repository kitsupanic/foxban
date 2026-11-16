import { authTest as test, expect } from "./fixtures";
import { addCard, addColumn, createBoard, columnByTitle, dragCardTo, settleAnimationFrames } from "./helpers";

for (const mobile of [false, true]) {
  test(`independent workflow ${mobile ? "mobile" : "desktop"}: roles, grouping, status, persistence and peer updates`, async ({ page, context }) => {
    await page.clock.install();
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const name = `Independent ${Date.now()}`;
    await createBoard(page, name); await page.getByRole("link", { name }).click();
    await addColumn(page, "Todo"); await addColumn(page, "Work"); await addColumn(page, "Done");
    await addCard(page, "Todo", "Parent task"); await addCard(page, "Work", "Work anchor");
    const card = (title: string) => page.locator(`[data-card-title="${title}"]`).locator("xpath=ancestor::li[1]");
    const body = (title: string) => card(title).locator("[data-card-body]").first();
    await body("Parent task").click();
    let modal = page.getByRole("dialog", { name: "Parent task", exact: true });
    await modal.getByRole("button", { name: "Add subtask", exact: true }).click();
    await modal.getByLabel("Subtask title").fill("Child task"); await modal.getByLabel("Subtask title").press("Enter");
    await expect(modal.getByRole("button", { name: "Open subtask Child task" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Workflow settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Workflow settings", exact: true });
    await settings.getByLabel("Starting status", { exact: true }).selectOption({ label: "Todo" });
    await settings.getByLabel("Completed status", { exact: true }).selectOption({ label: "Done" });
    await settings.getByRole("button", { name: "Save workflow columns", exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(body("Child task")).toBeVisible();
    await expect(card("Parent task").getByRole("button", { name: /Subtasks/ })).toContainText("0 / 1");
    const peer = await context.newPage(); await peer.goto(page.url()); await expect(peer.getByRole("heading", { name, exact: true })).toBeVisible();
    if (!mobile) {
      await dragCardTo(page, body("Child task"), body("Work anchor"));
      await expect(columnByTitle(page, "Work").locator('[data-card-title="Child task"]')).toBeVisible();
      await expect(card("Child task").getByRole("button", { name: "Parent: Parent task", exact: true })).toBeVisible();
      await dragCardTo(page, body("Child task"), body("Parent task"));
      await expect(card("Parent task").locator('[data-card-title="Child task"]')).toBeVisible();
      // dnd-kit intentionally suppresses click events for 50ms after pointer drop.
      // Advance its real timer contract before testing a separate click-to-open.
      await page.clock.fastForward(51);
      await settleAnimationFrames(page);
    }
    await body("Child task").click();
    let childModal = page.getByRole("dialog", { name: "Child task", exact: true });
    await childModal.getByRole("button", { name: "Status", exact: true }).click(); await childModal.getByRole("option", { name: "Done", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(columnByTitle(page, "Done").locator('[data-card-title="Child task"]')).toBeVisible();
    await expect(card("Parent task").getByRole("button", { name: /Subtasks/ })).toContainText("1 / 1");
    await expect(peer.locator('[data-card-title="Child task"]').locator('xpath=ancestor::section[1]')).toContainText("Done");
    await body("Parent task").click(); modal = page.getByRole("dialog", { name: "Parent task", exact: true });
    await modal.getByRole("button", { name: "Status", exact: true }).click(); await modal.getByRole("option", { name: "Work", exact: true }).click(); await page.keyboard.press("Escape");
    await expect(columnByTitle(page, "Done").locator('[data-card-title="Child task"]')).toBeVisible();
    await page.reload(); await expect(columnByTitle(page, "Work").locator('[data-card-title="Parent task"]')).toBeVisible(); await expect(columnByTitle(page, "Done").locator('[data-card-title="Child task"]')).toBeVisible();
    await body("Child task").click(); childModal = page.getByRole("dialog", { name: "Child task", exact: true });
    await childModal.getByRole("button", { name: "Status", exact: true }).click(); await childModal.getByRole("option", { name: "Work", exact: true }).click(); await page.keyboard.press("Escape");
    await expect(card("Parent task").locator('[data-card-title="Child task"]')).toBeVisible();
    await page.getByLabel("Search cards").fill("Child task");
    await expect(card("Parent task").locator('[data-card-title="Child task"]')).toBeVisible();
    await expect(page.locator('[data-card-title="Work anchor"]')).toHaveCount(0);
    await expect(columnByTitle(page, "Work")).toContainText("1 / 3");
    await page.getByLabel("Search cards").fill("");
    await page.screenshot({ path: `test-results/independent-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await peer.close();
  });
}
