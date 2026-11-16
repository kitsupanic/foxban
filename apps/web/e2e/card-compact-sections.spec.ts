import { authTest as test, expect } from "./fixtures";
import { addCard, addColumn, cardBody, cardIn, columnByTitle, createBoard, openCardSection, settleAnimationFrames } from "./helpers";

test("compact card sections expand into saved work and secondary details stay keyboard accessible", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // Connected repos are instance-wide and open the Development section; another spec may have connected one.
  await page.route("**/boards/*/connected-repos", (route) => route.fulfill({ json: { repos: [] } }));
  const boardName = `Compact card ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName, exact: true }).click();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Compact example");
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Compact example")).click();
  const dialog = page.getByRole("dialog", { name: "Compact example", exact: true });
  const checklist = dialog.getByTestId("card-checklist-section");
  const subtasks = dialog.getByTestId("card-subtasks-section");
  const composer = checklist.getByRole("textbox", { name: "Add checklist item", exact: true });
  const addItem = checklist.getByRole("button", { name: "Add item", exact: true });
  const addSubtask = subtasks.getByRole("button", { name: "Add subtask", exact: true });

  // Empty sections expose compact actions rather than empty editor panels.
  for (const [section, heading, action] of [
    [checklist, checklist.getByRole("heading", { name: "Checklist", exact: true }), addItem],
    [subtasks, subtasks.getByRole("heading", { name: "Subtasks", exact: true }), addSubtask],
  ] as const) {
    await expect(heading).toHaveCount(1);
    await expect(action).toBeVisible();
    const headingBox = await heading.boundingBox();
    const actionBox = await action.boundingBox();
    expect(headingBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    expect(Math.min(headingBox!.y + headingBox!.height, actionBox!.y + actionBox!.height))
      .toBeGreaterThan(Math.max(headingBox!.y, actionBox!.y));
    expect(actionBox!.x).toBeGreaterThanOrEqual(headingBox!.x + headingBox!.width);
    await expect(section.getByRole("listitem")).toHaveCount(0);
  }

  const sidebar = dialog.getByTestId("card-sidebar");
  const labels = sidebar.getByRole("heading", { name: "Labels", exact: true });
  for (const name of ["Relations", "Attachments", "Contributors", "Development"]) {
    const summary = sidebar.locator("summary").filter({ hasText: new RegExp(`^${name}$`) });
    const disclosure = summary.locator("..");
    await expect(summary).toHaveCount(1);
    await expect(disclosure).not.toHaveAttribute("open", "");
    expect(await labels.evaluate((element, secondary) => Boolean(
      element.compareDocumentPosition(secondary!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ), await summary.elementHandle())).toBe(true);
    await summary.focus();
    await page.keyboard.press(name === "Contributors" ? "Space" : "Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
    await page.keyboard.press(name === "Contributors" ? "Space" : "Enter");
    await expect(disclosure).not.toHaveAttribute("open", "");
  }

  await openCardSection(dialog, "relations");
  await dialog.getByRole("button", { name: "+ Link a card…" }).click();
  const relationDraft = dialog.getByRole("textbox", { name: "Link a card", exact: true });
  await relationDraft.fill("Keep this relation draft");
  const relationsSummary = sidebar.getByTestId("card-relations-section").locator("summary");
  await relationsSummary.focus();
  await page.keyboard.press("Space");
  await expect(relationDraft).not.toBeVisible();
  await page.keyboard.press("Enter");
  await expect(relationDraft).toHaveValue("Keep this relation draft");
  // Clear the independent draft before exercising the clean close below.
  await relationDraft.press("Escape");
  await relationDraft.press("Escape");

  await expect(composer).toHaveCount(0);
  await addItem.focus();
  await page.keyboard.press("Enter");
  await expect(composer).toBeFocused();
  await composer.press("Escape");
  await expect(composer).toHaveCount(0);
  await expect(addItem).toBeFocused();

  // Run Escape and claim another control in the same browser task, before
  // the queued restoration frame can run; it must yield to the newer focus.
  await addItem.click();
  const focusBeforeFrame = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Add checklist item"]');
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    for (let i = 0; i < 200 && document.querySelector('input[aria-label="Add checklist item"]'); i += 1) {
      await Promise.resolve();
    }
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close card"]');
    close?.focus();
    return {
      composerGone: !document.querySelector('input[aria-label="Add checklist item"]'),
      closeOwnsFocus: document.activeElement === close,
    };
  });
  expect(focusBeforeFrame).toEqual({ composerGone: true, closeOwnsFocus: true });
  await settleAnimationFrames(page);
  await expect(dialog.getByRole("button", { name: "Close card", exact: true })).toBeFocused();
  await addItem.focus();
  await page.keyboard.press("Enter");
  await composer.fill("Keep this checklist draft");
  await composer.press("Escape");
  await expect(composer).toHaveValue("Keep this checklist draft");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save title & description", exact: true })).toBeDisabled();
  await composer.fill("");
  await composer.press("Escape");
  await expect(addItem).toBeFocused();
  await addItem.click();
  await composer.fill("Review the release notes");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  const item = checklist.getByRole("checkbox", { name: "Review the release notes", exact: true });
  await item.click();
  await expect(item).toBeChecked();
  await expect(checklist.getByRole("progressbar", { name: "Checklist progress" })).toHaveAttribute("aria-valuenow", "100");
  await addSubtask.click();
  await subtasks.getByLabel("Subtask title", { exact: true }).fill("Verify the release candidate");
  await subtasks.getByLabel("Subtask title", { exact: true }).press("Enter");
  await expect(subtasks.getByRole("button", { name: "Open subtask Verify the release candidate", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save title & description", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Compact example")).click();
  await expect(item).toBeChecked();
  await expect(subtasks.getByRole("button", { name: "Open subtask Verify the release candidate", exact: true })).toBeVisible();
});

for (const width of [320, 390]) {
  test(`compact properties keep their labels and long values usable at ${width}px`, async ({ page }) => {
    const boardName = `Compact mobile ${width} ${Date.now()}`;
    const longStatus = "Ready for final review and stakeholder approval";
    await createBoard(page, boardName);
    await page.getByRole("link", { name: boardName, exact: true }).click();
    await addColumn(page, "Todo");
    await addColumn(page, longStatus);
    await addCard(page, "Todo", "A task with detailed context for the next release");
    await page.setViewportSize({ width, height: 844 });
    await cardBody(cardIn(columnByTitle(page, "Todo"), "A task with detailed context for the next release")).click();
    const dialog = page.getByRole("dialog");
    const essentials = dialog.getByTestId("card-essentials");
    const status = essentials.getByRole("button", { name: "Status", exact: true });
    await status.click();
    await dialog.getByRole("option", { name: longStatus, exact: true }).click();
    await expect(status).toContainText(longStatus);

    const rows = essentials.locator(".card-property-row");
    await expect(rows).toHaveCount(5);
    for (const name of ["Status", "Type", "Assignee", "Priority", "Due date"]) {
      const row = rows.filter({ has: page.getByText(name, { exact: true }) });
      await expect(row).toHaveCount(1);
      const control = name === "Due date"
        ? row.getByLabel(name, { exact: true })
        : row.getByRole("button", { name, exact: true });
      await expect(control).toBeVisible();
      const labelBox = await row.locator(".card-property-label").boundingBox();
      const box = await control.boundingBox();
      expect(labelBox).not.toBeNull();
      expect(box).not.toBeNull();
      expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(box!.y);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    const essentialsBox = await essentials.boundingBox();
    const descriptionBox = await dialog.getByRole("heading", { name: "Description", exact: true }).boundingBox();
    expect(essentialsBox).not.toBeNull();
    expect(descriptionBox).not.toBeNull();
    expect(essentialsBox!.y + essentialsBox!.height).toBeLessThanOrEqual(descriptionBox!.y);
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await expect(dialog.getByRole("button", { name: "Save title & description", exact: true })).toBeDisabled();
    const summary = dialog.locator("summary").filter({ hasText: /^Contributors$/ });
    await summary.scrollIntoViewIfNeeded();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByText("Created by:", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  });
}


test("inline comment entry expands and cancels without replacing its textarea or saving card text", async ({ page }) => {
  const boardName = `Inline comment ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName, exact: true }).click();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Inline composer");
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Inline composer")).click();
  const dialog = page.getByRole("dialog");
  const entry = dialog.getByPlaceholder("Add a comment…", { exact: true });
  const submit = dialog.getByRole("button", { name: "Comment", exact: true });
  const save = dialog.getByRole("button", { name: "Save title & description", exact: true });
  await expect(dialog.getByRole("button", { name: "Close card", exact: true })).toBeFocused();
  await expect(entry).toBeVisible();
  await expect(submit).toBeVisible();
  await expect(submit).toBeDisabled();
  const textarea = await entry.elementHandle();
  expect(textarea).not.toBeNull();

  await entry.click();
  await expect(entry).toBeFocused();
  await entry.fill("Comment draft stays separate");
  expect(await entry.evaluate((element, previous) => element === previous, textarea)).toBe(true);
  await expect(save).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(entry).toHaveValue("Comment draft stays separate");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(entry).toHaveValue("");
  await expect(submit).toBeDisabled();
  expect(await entry.evaluate((element, previous) => element === previous, textarea)).toBe(true);

  await entry.click();
  await entry.fill("Persisted through the inline composer");
  await submit.click();
  await expect(entry).toHaveValue("");
  await expect(dialog.getByRole("tabpanel").getByText("Persisted through the inline composer", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  expect(await entry.evaluate((element, previous) => element === previous, textarea)).toBe(true);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Inline composer")).click();
  await expect(dialog.getByRole("tabpanel").getByText("Persisted through the inline composer", { exact: true })).toBeVisible();

  // First Escape collapses the active editor; second Escape from the same
  // retained textarea reaches the modal's clean close behavior.
  await entry.click();
  await entry.press("Escape");
  await expect(entry).toHaveAccessibleName("Add a comment");
  await expect(entry).toBeFocused();
  await entry.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The same route must also reach the dirty guard when card text is edited.
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Inline composer")).click();
  await dialog.getByRole("button", { name: "Edit title", exact: true }).click();
  const title = dialog.getByLabel("Card title", { exact: true });
  await title.fill("Unsaved card title");
  await title.press("Escape");
  await entry.click();
  await entry.press("Escape");
  await expect(entry).toHaveAccessibleName("Add a comment");
  await entry.press("Escape");
  await expect(dialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Unsaved card title", exact: true })).toBeVisible();
});
