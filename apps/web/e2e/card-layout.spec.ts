import { authTest as test, expect } from "./fixtures";
import { addCard, addColumn, cardBody, cardIn, columnByTitle, createBoard, ensureChecklistComposer, openCardSection, settleAnimationFrames } from "./helpers";

test("card essentials lead on mobile and the desktop columns retain the open editor", async ({ page }, testInfo) => {
  const boardName = `Card layout ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addColumn(page, "In progress");
  const title = "Plan the next release and coordinate the team";
  await addCard(page, "Todo", title);
  await cardBody(cardIn(columnByTitle(page, "Todo"), title)).click();

  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const longDescription = "## Release context\n\n" + "A long task description with useful context.\n\n".repeat(25);
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  await dialog.getByLabel("Card description").fill(longDescription);
  await dialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await cardBody(cardIn(columnByTitle(page, "Todo"), title)).click();
  const essentials = dialog.getByTestId("card-essentials");
  const description = dialog.getByRole("heading", { name: "Description", exact: true });
  await expect(essentials.getByRole("button", { name: "Status", exact: true })).toBeInViewport();
  await expect(essentials.getByLabel("Due date", { exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Close card", exact: true })).toBeInViewport();
  const essentialBox = await essentials.boundingBox();
  const descriptionBox = await description.boundingBox();
  expect(essentialBox).not.toBeNull();
  expect(descriptionBox).not.toBeNull();
  expect(essentialBox!.y + essentialBox!.height).toBeLessThanOrEqual(descriptionBox!.y);
  expect(await essentials.evaluate((element) => {
    const main = element.parentElement!.querySelector(".card-detail-main")!;
    return Boolean(element.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);

  // Keyboard focus follows the same mobile reading order into the description.
  await essentials.getByLabel("Due date", { exact: true }).fill("2026-10-30");
  // Native date inputs have multiple internal Tab stops; leave via Clear.
  await essentials.getByRole("button", { name: "Clear due date", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Edit description", exact: true })).toBeFocused();
  await essentials.getByRole("button", { name: "Status", exact: true }).click();
  await dialog.getByRole("option", { name: "In progress", exact: true }).click();
  await expect(essentials.getByRole("button", { name: "Status", exact: true })).toHaveText("In progress");

  await dialog.getByRole("button", { name: "Edit title", exact: true }).click();
  await dialog.getByLabel("Card title", { exact: true }).fill("Release plan in progress");
  await dialog.getByLabel("Card title", { exact: true }).press("Escape");
  await expect(dialog.getByRole("heading", { name: "Release plan in progress", exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Edit description", exact: true }).click();
  const editor = dialog.getByLabel("Card description", { exact: true });
  await editor.fill(longDescription + "Retained draft");
  const originalEditor = await editor.elementHandle();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(editor).toHaveValue(longDescription + "Retained draft");
  expect(await editor.evaluate((element, previous) => element === previous, originalEditor)).toBe(true);

  // Desktop has a genuine second column, with essentials above advanced details.
  const mainBox = await dialog.locator(".card-detail-main").boundingBox();
  const desktopEssentialBox = await essentials.boundingBox();
  const advancedBox = await dialog.getByTestId("card-sidebar").boundingBox();
  expect(mainBox).not.toBeNull();
  expect(desktopEssentialBox).not.toBeNull();
  expect(advancedBox).not.toBeNull();
  expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(desktopEssentialBox!.x + 1);
  expect(desktopEssentialBox!.y + desktopEssentialBox!.height).toBeLessThanOrEqual(advancedBox!.y + 1);

  // Long content scrolls within its desktop pane; essential controls stay reachable.
  await dialog.getByRole("button", { name: "Preview description", exact: true }).click();
  const main = dialog.locator(".card-detail-main");
  expect(await main.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop > 0;
  })).toBe(true);
  await expect(essentials.getByRole("button", { name: "Status", exact: true })).toBeInViewport();
  await expect(essentials.getByLabel("Due date", { exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Save title & description", exact: true })).toBeInViewport();

  // Expanded secondary details have one full-height scroll, including top properties.
  await openCardSection(dialog, "relations");
  await openCardSection(dialog, "attachments");
  for (const name of ["Contributors", "Development"]) {
    await dialog.locator("summary").filter({ hasText: new RegExp(`^${name}$`) }).click();
  }
  const details = dialog.locator(".card-detail-details-pane");
  await details.evaluate((element) => { element.scrollTop = 0; });
  const detailsBox = (await details.boundingBox())!;
  const bodyBox = (await dialog.locator(".card-detail-body").boundingBox())!;
  expect(Math.abs(detailsBox.y - bodyBox.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(detailsBox.height - bodyBox.height)).toBeLessThanOrEqual(1);
  const mainScroll = await main.evaluate((element) => element.scrollTop);
  const status = essentials.getByRole("button", { name: "Status", exact: true });
  await main.hover();
  await page.mouse.wheel(0, 600);
  await settleAnimationFrames(page);
  expect(await details.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(status).toBeInViewport();
  await status.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(status).not.toBeInViewport();
  expect(await main.evaluate((element) => element.scrollTop)).toBe(mainScroll);
  expect((await main.boundingBox())!.y).toBe(mainBox!.y);
  await expect(dialog.getByRole("button", { name: "+ Attach file", exact: true })).toBeInViewport();
  const screenshot = testInfo.outputPath("full-height-details-scroll.png");
  await dialog.screenshot({ path: screenshot });
  await testInfo.attach("full-height-details-scroll", { path: screenshot, contentType: "image/png" });
  await details.evaluate((element) => { element.scrollTop = 0; });
  await expect(status).toBeInViewport();
  await dialog.getByRole("button", { name: "Edit description", exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await editor.evaluate((element, previous) => element === previous, originalEditor)).toBe(true);
  await expect(editor).toHaveValue(longDescription + "Retained draft");
  await dialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await cardBody(cardIn(columnByTitle(page, "In progress"), "Release plan in progress")).click();
  await expect(page.getByRole("dialog").getByTestId("description-view")).toContainText("Retained draft");
});

test("short landscape windows can reach advanced details for tasks and linked subtasks", async ({ page }) => {
  const boardName = `Short card ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Landscape parent");
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Landscape parent")).click();
  let dialog = page.getByRole("dialog", { name: "Landscape parent", exact: true });
  await dialog.getByRole("button", { name: "Add subtask", exact: true }).click();
  await dialog.getByLabel("Subtask title", { exact: true }).fill("Landscape child");
  await dialog.getByLabel("Subtask title", { exact: true }).press("Enter");
  await expect(dialog.getByRole("button", { name: "Open subtask Landscape child", exact: true })).toBeVisible();

  for (const title of ["Landscape parent", "Landscape child"]) {
    dialog = page.getByRole("dialog", { name: title, exact: true });
    for (const size of [{ width: 1024, height: 480 }, { width: 844, height: 390 }, { width: 1024, height: 600 }]) {
      await page.setViewportSize(size);
      const dueDate = dialog.getByLabel("Due date", { exact: true });
      await dueDate.scrollIntoViewIfNeeded();
      await expect(dueDate).toBeInViewport();
      await openCardSection(dialog, "attachments");
      const attach = dialog.getByRole("button", { name: "+ Attach file", exact: true });
      await attach.scrollIntoViewIfNeeded();
      await expect(attach).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Close card", exact: true })).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Save title & description", exact: true })).toBeInViewport();
      expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    }
    if (title === "Landscape parent") {
      await dialog.getByRole("button", { name: "Open subtask Landscape child", exact: true }).click();
      // A subtask has its own status, like any other card.
      await expect(page.getByRole("dialog", { name: "Landscape child", exact: true }).getByRole("button", { name: "Status", exact: true })).toBeVisible();
    }
  }
});

test("Clear split keeps realistic card content readable on desktop and a 320px phone", async ({ page }, testInfo) => {
  const boardName = `Clear split ${Date.now()}`;
  const title = "Polish the first-play experience";
  await page.setViewportSize({ width: 1280, height: 900 });
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName, exact: true }).click();
  await addColumn(page, "In progress");
  await addCard(page, "In progress", title);
  await cardBody(cardIn(columnByTitle(page, "In progress"), title)).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.getByRole("button", { name: "Add a description…" }).click();
  await dialog.getByLabel("Card description", { exact: true }).fill(
    "## Make the first minute feel effortless\n\nPlayers should understand their next move without leaving the game. Keep the tutorial short, clear, and easy to revisit.\n\n### Ready when\n\n- The opening screen explains the goal.\n- Every action gives useful feedback.\n- New players can finish their first round without help.",
  );
  await dialog.getByRole("button", { name: "Save title & description", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await cardBody(cardIn(columnByTitle(page, "In progress"), title)).click();
  const checklist = await ensureChecklistComposer(dialog);
  await checklist.fill("Review the opening screen copy");
  await checklist.press("Enter");
  await checklist.fill("Test the first round with a new player");
  await checklist.press("Enter");
  await checklist.press("Escape");
  const reviewedCopy = dialog.getByRole("checkbox", { name: "Review the opening screen copy", exact: true });
  await reviewedCopy.click();
  await expect(reviewedCopy).toBeChecked();
  await dialog.getByRole("button", { name: "Add subtask", exact: true }).click();
  await dialog.getByLabel("Subtask title", { exact: true }).fill("Tune the tutorial feedback");
  await dialog.getByLabel("Subtask title", { exact: true }).press("Enter");
  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("The opening screen reads clearly. Let’s check the first round together before release.");
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(dialog.getByRole("tabpanel")).toContainText("The opening screen reads clearly.");
  await expect(dialog.getByRole("button", { name: "Save title & description", exact: true })).toBeDisabled();

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await dialog.locator(".card-detail-main").evaluate((element) => { element.scrollTop = 0; });
    await dialog.getByTestId("card-essentials").getByRole("button", { name: "Status", exact: true }).scrollIntoViewIfNeeded();
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    const screenshot = testInfo.outputPath(`clear-split-${width}.png`);
    await dialog.screenshot({ path: screenshot });
    await testInfo.attach(`clear-split-${width}`, { path: screenshot, contentType: "image/png" });
    if (width === 320) {
      await dialog.getByRole("heading", { name: "Subtasks", exact: true }).scrollIntoViewIfNeeded();
      const contentScreenshot = testInfo.outputPath("clear-split-320-content.png");
      await dialog.screenshot({ path: contentScreenshot });
      await testInfo.attach("clear-split-320-content", { path: contentScreenshot, contentType: "image/png" });
    }
  }
});
