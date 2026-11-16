import { expect, test } from "@playwright/test";
import { addCard, addColumn, cardBody, cardIn, columnByTitle, createBoard, signup, uniqueEmail, ensureChecklistComposer } from "./helpers";

for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 667 }]) {
  test(`card saving separates text drafts from automatic changes at ${viewport.width}px`, async ({ page }) => {
    await signup(page, uniqueEmail(`saving-${viewport.width}`), "Save Author");
    const boardName = `Saving ${viewport.width} ${Date.now()}`;
    await createBoard(page, boardName);
    const textWrites: Record<string, unknown>[] = [];
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload)) as Record<string, unknown>;
        if (frame.type === "card.update" && ("title" in frame || "description" in frame)) textWrites.push(frame);
      });
    });
    await page.getByRole("link", { name: boardName, exact: true }).click();
    await addColumn(page, "Todo");
    await addColumn(page, "Doing");
    await addCard(page, "Todo", "Saving example");
    await page.setViewportSize(viewport);
    await cardBody(cardIn(columnByTitle(page, "Todo"), "Saving example")).click();
    const dialog = page.getByRole("dialog");
    const save = dialog.getByRole("button", { name: "Save title & description", exact: true });
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    await expect(save).toBeDisabled();
    await expect(dialog.getByText("Title and description are up to date.", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Changes here save automatically.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Edit title", exact: true }).click();
    await dialog.getByLabel("Card title", { exact: true }).press("Enter");
    await expect(dialog).toBeVisible();
    await expect(save).toBeDisabled();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(dialog).toBeVisible();
    expect(textWrites).toEqual([]);
    await close.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await cardBody(cardIn(columnByTitle(page, "Todo"), "Saving example")).click();

    // These controls commit independently of the text save action.
    await dialog.getByRole("button", { name: "Status", exact: true }).click();
    await dialog.getByRole("option", { name: "Doing", exact: true }).click();
    await dialog.getByRole("button", { name: "Assignee", exact: true }).click();
    await dialog.getByRole("option", { name: "Save Author", exact: true }).click();
    await ensureChecklistComposer(dialog);
    await dialog.getByPlaceholder("Add an item").fill("Automatically saved checklist item");
    await dialog.getByPlaceholder("Add an item").press("Enter");
    await expect(dialog.getByPlaceholder("Add an item")).toHaveValue("");
    await dialog.getByRole("checkbox", { name: "Automatically saved checklist item" }).click();
    await expect(dialog.getByRole("checkbox", { name: "Automatically saved checklist item" })).toBeChecked();
    await dialog.getByRole("button", { name: "+ Add label…", exact: true }).click();
    await dialog.getByRole("button", { name: "Create label", exact: true }).click();
    await dialog.getByLabel("New label name").fill("Saved label");
    await dialog.getByLabel("New label name").press("Enter");
    await expect(dialog.getByLabel("Remove label Saved label")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(save).toBeDisabled();
    await expect(dialog.getByText("Unsaved", { exact: true })).toHaveCount(0);

    await dialog.getByRole("button", { name: "Edit title", exact: true }).click();
    await dialog.getByLabel("Card title", { exact: true }).fill("Draft title");
    await dialog.getByLabel("Card title", { exact: true }).press("Escape");
    await expect(dialog.getByText("Unsaved title", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Unsaved", { exact: true })).toHaveCount(1);
    await dialog.getByRole("button", { name: "Add a description…", exact: true }).click();
    await dialog.getByLabel("Card description", { exact: true }).fill("Draft **description**");
    await expect(dialog.getByText("Unsaved title and description", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Unsaved", { exact: true })).toHaveCount(2);
    await expect(dialog.getByText("Preview doesn’t save your edits.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Preview description", exact: true }).click();
    await expect(dialog.getByTestId("description-view")).toContainText("Draft description");
    expect(textWrites).toEqual([]);

    // Footer controls remain keyboard accessible and contained on a 320px phone.
    for (const control of [save, close]) {
      await expect(control).toBeInViewport();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    }
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await close.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Changes already saved will stay.", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(close).toBeFocused();
    await expect(dialog.getByRole("heading", { name: "Draft title", exact: true })).toBeVisible();
    await expect(dialog.getByTestId("description-view")).toContainText("Draft description");
    await close.click();
    await dialog.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await cardBody(cardIn(columnByTitle(page, "Doing"), "Saving example")).click();
    await expect(dialog.getByRole("button", { name: "Status", exact: true })).toHaveText("Doing");
    await expect(dialog.getByRole("button", { name: "Assignee", exact: true })).toContainText("Save Author");
    await expect(dialog.getByRole("checkbox", { name: "Automatically saved checklist item" })).toBeChecked();
    await expect(dialog.getByLabel("Remove label Saved label")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add a description…", exact: true })).toBeVisible();
    await expect(save).toBeDisabled();

    // Save writes the actual description draft, then confirmed acceptance closes.
    await dialog.getByRole("button", { name: "Add a description…", exact: true }).click();
    await dialog.getByLabel("Card description", { exact: true }).fill("Persist this description");
    await expect(dialog.getByText("Unsaved description", { exact: true })).toBeVisible();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(textWrites).toHaveLength(1);
    expect(textWrites[0]).toMatchObject({ description: "Persist this description" });
    await page.reload();
    await cardBody(cardIn(columnByTitle(page, "Doing"), "Saving example")).click();
    await expect(dialog.getByTestId("description-view")).toHaveText("Persist this description");
    await expect(save).toBeDisabled();
  });
}

test("other authored drafts keep their own save action when text is unchanged or reverted", async ({ page }) => {
  await signup(page, uniqueEmail("saving-other-drafts"));
  const boardName = `Saving other drafts ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName, exact: true }).click();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Other drafts");
  await cardBody(cardIn(columnByTitle(page, "Todo"), "Other drafts")).click();
  const dialog = page.getByRole("dialog");
  const save = dialog.getByRole("button", { name: "Save title & description", exact: true });
  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("Separate comment draft");
  await expect(save).toBeDisabled();
  await expect(dialog.getByText("Other drafts have their own save actions.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Unsaved", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Edit title", exact: true }).click();
  const title = dialog.getByLabel("Card title", { exact: true });
  await title.fill("Temporary title");
  await expect(save).toBeEnabled();
  await expect(dialog.getByText("Unsaved title", { exact: true })).toBeVisible();
  await title.fill("Other drafts");
  await title.press("Escape");
  await expect(save).toBeDisabled();
  await expect(dialog.getByText("Unsaved", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Other drafts have their own save actions.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue("Separate comment draft");
});
