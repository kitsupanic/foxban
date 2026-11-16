import { authTest as test, expect } from "./fixtures";
import { addCard, addColumn, cardBody, cardIn, columnByTitle, createBoard, settleAnimationFrames } from "./helpers";

test("checklist composer and long items fit desktop and narrow dialogs", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const boardName = `Checklist layout ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName, exact: true }).click();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Checklist layout");
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Checklist layout")).click();
  const dialog = page.getByRole("dialog", { name: "Checklist layout", exact: true });
  const checklist = dialog.getByTestId("card-checklist-section");
  const composer = checklist.getByRole("textbox", { name: "Add checklist item", exact: true });
  const add = checklist.getByRole("button", { name: "Add checklist item", exact: true });
  await expect(composer).toHaveCount(0);
  await checklist.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(composer).toBeFocused();
  await expect(add).toBeDisabled();

  const text = "x".repeat(200);
  await composer.fill(text);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  const item = checklist.getByRole("checkbox", { name: text, exact: true });
  const progress = checklist.getByRole("progressbar", { name: "Checklist progress" });
  await expect(item).toBeVisible();

  for (const size of [{ width: 1280, height: 900 }, { width: 320, height: 800 }]) {
    await page.setViewportSize(size);
    await composer.scrollIntoViewIfNeeded();
    await settleAnimationFrames(page);
    const inputBox = await composer.boundingBox();
    const addBox = await add.boundingBox();
    const dialogBox = await dialog.boundingBox();
    const sectionBox = await checklist.boundingBox();
    const rowBox = await checklist.getByRole("listitem").boundingBox();
    expect(inputBox).not.toBeNull();
    expect(addBox).not.toBeNull();
    expect(dialogBox).not.toBeNull();
    expect(sectionBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(addBox!.x - (inputBox!.x + inputBox!.width)).toBeGreaterThanOrEqual(6);
    expect(Math.abs(inputBox!.y - addBox!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(inputBox!.height - addBox!.height)).toBeLessThanOrEqual(1);
    expect(inputBox!.height).toBeGreaterThanOrEqual(size.width === 320 ? 44 : 36);
    expect(inputBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
    expect(addBox!.x + addBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
    expect(rowBox!.x).toBeGreaterThanOrEqual(sectionBox!.x);
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(sectionBox!.x + sectionBox!.width);
    for (const element of [dialog, checklist, checklist.getByRole("button", { name: `Edit checklist item ${text}`, exact: true })]) {
      expect(await element.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    }
    await item.click();
    await expect(item).toBeChecked();
    await expect(progress).toHaveAttribute("aria-valuenow", "100");
    await item.click();
    await expect(item).not.toBeChecked();
    await expect(progress).toHaveAttribute("aria-valuenow", "0");
    const screenshot = testInfo.outputPath(`checklist-${size.width}px.png`);
    await checklist.screenshot({ path: screenshot });
    await testInfo.attach(`checklist-${size.width}px`, { path: screenshot, contentType: "image/png" });
  }
});
