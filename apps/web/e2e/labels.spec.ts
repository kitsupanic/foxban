import { expect, test, type Page } from "@playwright/test";
import { addCard, addColumn, cardIn, columnByTitle, createBoard, settleAnimationFrames, signup, uniqueEmail } from "./helpers";

async function boardWithCard(page: Page, suffix: string, cardTitle: string): Promise<void> {
  await signup(page, uniqueEmail(suffix), "Label Author");
  const boardName = `Labels ${suffix} ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", cardTitle);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 740 }]) {
  test(`opening labels stays anchored without jumping the scrolled pane at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await boardWithCard(page, "anchor", "Anchored labels");
    await cardIn(columnByTitle(page, "Todo"), "Anchored labels").click();
    const dialog = page.getByRole("dialog", { name: "Anchored labels", exact: true });
    const pane = dialog.locator(viewport.width === 1280 ? ".card-detail-details-pane" : ".card-detail-body");
    const trigger = dialog.getByRole("button", { name: "+ Add label…", exact: true });
    for (const view of viewport.width === 1280 ? ["modal", "full"] : ["modal"]) {
      if (view === "full") await dialog.getByRole("button", { name: "Open full screen", exact: true }).click();
      await pane.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await trigger.scrollIntoViewIfNeeded();
      const scrollBefore = await pane.evaluate(el => el.scrollTop);
      await trigger.click();
      await expect(dialog.getByLabel("Search labels", { exact: true })).toBeFocused();
      await settleAnimationFrames(page);
      const position = await dialog.evaluate(el => {
        const trigger = el.querySelector('[aria-label="+ Add label…"]')!.getBoundingClientRect();
        const picker = el.querySelector('[id^="label-picker-"]')!.getBoundingClientRect();
        return {
          trigger: { top: trigger.top, bottom: trigger.bottom },
          picker: { top: picker.top, bottom: picker.bottom },
          gap: Math.min(Math.abs(picker.top - trigger.bottom - 6), Math.abs(trigger.top - picker.bottom - 6)),
        };
      });
      expect(position.gap, JSON.stringify(position)).toBeLessThanOrEqual(2);
      expect(await pane.evaluate(el => el.scrollTop)).toBeCloseTo(scrollBefore, 0);
      await page.screenshot({ path: testInfo.outputPath(`label-anchor-${view}.png`) });
      await dialog.getByLabel("Search labels", { exact: true }).press("Escape");
    }
  });
}

test("the label picker separates creation, searches labels, and keeps multi-selection keyboard accessible", async ({ page }) => {
  await boardWithCard(page, "picker", "Label picker");
  const card = cardIn(columnByTitle(page, "Todo"), "Label picker");
  await card.click();
  const dialog = page.getByRole("dialog", { name: "Label picker", exact: true });
  const trigger = dialog.getByRole("button", { name: "+ Add label…", exact: true });
  await trigger.click();
  const search = dialog.getByLabel("Search labels", { exact: true });
  await expect(search).toBeFocused();
  await expect(dialog.getByLabel("New label name")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Red", exact: true })).toHaveCount(0);

  for (const name of ["Bug", "Frontend"]) {
    await dialog.getByRole("button", { name: "Create label", exact: true }).click();
    await dialog.getByLabel("New label name").fill(name);
    await dialog.getByLabel("New label name").press("Enter");
    await expect(dialog.getByLabel(`Remove label ${name}`, { exact: true })).toBeVisible();
    await expect(search).toBeFocused();
  }
  await search.fill("  bUg  ");
  await expect(dialog.getByRole("button", { name: "Toggle label Bug", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Toggle label Frontend", exact: true })).toHaveCount(0);
  await search.press("ArrowDown");
  const bug = dialog.getByRole("button", { name: "Toggle label Bug", exact: true });
  await expect(bug).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("Remove label Bug", { exact: true })).toHaveCount(0);
  await expect(search).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("Remove label Bug", { exact: true })).toBeVisible();
  await search.focus();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(dialog).toBeVisible();

  await trigger.click();
  await dialog.getByRole("heading", { name: "Label picker", exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await trigger.click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.locator("..").click({ position: { x: 4, y: 4 } });
  await expect(search).toHaveCount(0);
  await expect(dialog).toBeVisible();

  await trigger.click();
  await dialog.getByRole("button", { name: "Create label", exact: true }).click();
  await dialog.getByLabel("New label name").fill("  Retained creation draft  ");
  await dialog.getByRole("heading", { name: "Label picker", exact: true }).click();
  await expect(dialog.getByLabel("New label name")).toHaveCount(0);
  await trigger.click();
  await expect(dialog.getByLabel("New label name")).toHaveValue("  Retained creation draft  ");
  await dialog.getByRole("button", { name: "Cancel label creation", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit label Bug", exact: true }).click();
  await dialog.getByLabel("Label name Bug", { exact: true }).fill("  Retained rename draft  ");
  await dialog.getByRole("heading", { name: "Label picker", exact: true }).click();
  await trigger.click();
  await expect(dialog.getByLabel("Label name Bug", { exact: true })).toHaveValue("  Retained rename draft  ");
  await dialog.getByRole("button", { name: "Cancel label edit", exact: true }).click();
  await expect(dialog.getByLabel("Remove label Bug", { exact: true })).toBeVisible();
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 740 }]) {
  test(`soft label chips and color editor fit a ${viewport.width}px ticket`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width === 320 });
    try {
      const page = await context.newPage();
      await boardWithCard(page, `soft-${viewport.width}`, "Soft labels");
      const card = cardIn(columnByTitle(page, "Todo"), "Soft labels");
      await card.click();
      const dialog = page.getByRole("dialog", { name: "Soft labels", exact: true });
      await dialog.getByRole("button", { name: "+ Add label…", exact: true }).click();
      await dialog.getByRole("button", { name: "Create label", exact: true }).click();
      const longName = "InfrastructureMigration".repeat(6);
      await dialog.getByLabel("New label name").fill(longName);
      await dialog.getByRole("button", { name: "Teal", exact: true }).click();
      if (viewport.width === 320) {
        const swatch = await dialog.getByRole("button", { name: "Teal", exact: true }).boundingBox();
        expect(swatch).not.toBeNull();
        expect(swatch!.width).toBeGreaterThanOrEqual(44);
        expect(swatch!.height).toBeGreaterThanOrEqual(44);
      }
      await expect(dialog.getByRole("button", { name: "Create and add", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Create and add", exact: true }).click();
      await expect(dialog.getByLabel(`Remove label ${longName}`, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`soft-label-picker-${viewport.width}.png`), fullPage: true });
      await dialog.getByLabel("Search labels", { exact: true }).press("Escape");
      expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`soft-label-details-${viewport.width}.png`), fullPage: true });
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(card.getByTestId("label-pill")).toHaveText(longName);
      expect(await card.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`soft-label-card-${viewport.width}.png`), fullPage: true });
    } finally {
      await context.close();
    }
  });
}

for (const control of ["chip", "picker"]) {
  test(`audit 5: one ${control} removal clears concurrent duplicate assignments and survives reconnect`, async ({ page }) => {
    let duplicateNextAssignment = true;
    let acceptedAssignments = 0;
    let acceptedRemovals = 0;
    await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        server.send(message);
        if (frame.type === "label.assign" && duplicateNextAssignment) {
          duplicateNextAssignment = false;
          server.send(JSON.stringify({ ...frame, id: crypto.randomUUID(), mutationId: crypto.randomUUID() }));
        }
      });
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.type === "label.assign") acceptedAssignments++;
        if (frame.type === "label.unassign") acceptedRemovals++;
        ws.send(message);
      });
    });
    await boardWithCard(page, `duplicate-${control}`, "Duplicate labels");
    await cardIn(columnByTitle(page, "Todo"), "Duplicate labels").click();
    const dialog = page.getByRole("dialog", { name: "Duplicate labels" });
    await dialog.getByRole("button", { name: "+ Add label…" }).click();
    await dialog.getByRole("button", { name: "Create label", exact: true }).click();
    await dialog.getByLabel("New label name").fill("Bug");
    await dialog.getByLabel("New label name").press("Enter");
    await expect.poll(() => acceptedAssignments).toBe(2);
    // Reconnect first so both raw assignments are present in the client's snapshot.
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await cardIn(columnByTitle(page, "Todo"), "Duplicate labels").click();
    await expect(dialog.getByLabel("Remove label Bug")).toHaveCount(1);
    if (control === "picker") {
      await dialog.getByRole("button", { name: "+ Add label…" }).click();
      await dialog.getByRole("button", { name: "Toggle label Bug" }).click();
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
    } else {
      await dialog.getByLabel("Remove label Bug").click();
    }
    await expect(dialog.getByLabel("Remove label Bug")).toHaveCount(0);
    await expect.poll(() => acceptedRemovals).toBe(2);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await expect(cardIn(columnByTitle(page, "Todo"), "Duplicate labels").getByTestId("label-pill")).toHaveCount(0);
    await cardIn(columnByTitle(page, "Todo"), "Duplicate labels").click();
    await expect(dialog.getByLabel("Remove label Bug")).toHaveCount(0);
    await dialog.getByRole("button", { name: "+ Add label…" }).click();
    await expect(dialog.getByRole("button", { name: "Toggle label Bug" })).toBeVisible();
  });
}

test("a label created in the picker pills the modal and the card front, survives a reload, and unassigns", async ({
  page,
}) => {
  await boardWithCard(page, "create", "Alpha");

  let column = columnByTitle(page, "Todo");
  let alpha = cardIn(column, "Alpha");
  await expect(alpha.getByTestId("label-pill")).toHaveCount(0);

  await alpha.click();
  let dialog = page.getByRole("dialog", { name: "Alpha" });
  // The picker is collapsed until asked for, like the link composer.
  await dialog.getByRole("button", { name: "+ Add label…" }).click();
  await dialog.getByRole("button", { name: "Create label", exact: true }).click();
  await dialog.getByLabel("New label name").fill("Bug");
  await dialog.getByLabel("New label name").press("Enter");

  await expect(dialog.getByRole("heading", { name: "Labels 1" })).toBeVisible();
  await expect(dialog.getByLabel("Remove label Bug")).toBeVisible();
  await expect(dialog.getByLabel("New label name")).toHaveCount(0);
  await expect(dialog.getByLabel("Search labels", { exact: true })).toBeFocused();
  // Assigning leaves the picker open, so the definition row is there.
  await expect(dialog.getByRole("button", { name: "Toggle label Bug" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const labelPill = alpha.getByTestId("label-pill");
  await expect(labelPill).toHaveText("Bug");
  const taskKeyLocator = alpha.getByTestId("task-key").first();
  await expect(taskKeyLocator).toBeVisible();
  const affordanceLocator = alpha.locator("[data-card-drag-affordance]");
  await expect(affordanceLocator).toBeVisible();
  const topMetadataRow = affordanceLocator.locator("xpath=..");
  await expect(topMetadataRow.locator("> [data-card-drag-affordance]")).toHaveCount(1);
  // Assert DOM order: top row (task key & drag affordance) -> title -> labels -> footer badge-row
  const assertCardLayoutOrder = async (cardLocator: typeof alpha) => {
    const order = await cardLocator.evaluate((cardEl) => {
      const topRow = cardEl.querySelector("[data-card-drag-affordance]")?.parentElement;
      const taskKeyEl = cardEl.querySelector('[data-testid="task-key"]');
      const gripEl = cardEl.querySelector("[data-card-drag-affordance]");
      const titleEl = cardEl.querySelector("[data-card-title]");
      const pillEl = cardEl.querySelector("[data-testid='label-pill']");
      const labelRow = pillEl?.parentElement;
      const badgeRow = cardEl.querySelector("[data-testid='badge-row']");
      const footerRow = badgeRow?.parentElement;
      const inTopRow = (el: Element | null) => Boolean(el && topRow && topRow.contains(el));
      return {
        taskKeyInTopRow: inTopRow(taskKeyEl),
        gripInTopRow: inTopRow(gripEl),
        pillNotInTopRow: !inTopRow(pillEl),
        pillNotInFooter: Boolean(pillEl && footerRow && !footerRow.contains(pillEl)),
        topRowBeforeTitle: Boolean(topRow && titleEl && (topRow.compareDocumentPosition(titleEl) & Node.DOCUMENT_POSITION_FOLLOWING)),
        titleBeforeLabelRow: Boolean(titleEl && labelRow && (titleEl.compareDocumentPosition(labelRow) & Node.DOCUMENT_POSITION_FOLLOWING)),
        labelRowBeforeFooter: Boolean(labelRow && footerRow && (labelRow.compareDocumentPosition(footerRow) & Node.DOCUMENT_POSITION_FOLLOWING)),
      };
    });
    expect(order.taskKeyInTopRow).toBe(true);
    expect(order.gripInTopRow).toBe(true);
    expect(order.pillNotInTopRow).toBe(true);
    expect(order.pillNotInFooter).toBe(true);
    expect(order.topRowBeforeTitle).toBe(true);
    expect(order.titleBeforeLabelRow).toBe(true);
    expect(order.labelRowBeforeFooter).toBe(true);
  };
  await assertCardLayoutOrder(alpha);
  await page.reload();
  column = columnByTitle(page, "Todo");
  alpha = cardIn(column, "Alpha");
  await expect(alpha.getByTestId("label-pill")).toHaveText("Bug");
  await expect(alpha.locator("[data-card-title]").first()).toHaveText("Alpha");
  await assertCardLayoutOrder(alpha);
  await alpha.click();
  dialog = page.getByRole("dialog", { name: "Alpha" });
  await dialog.getByLabel("Remove label Bug").click();
  await expect(dialog.getByRole("heading", { name: "Labels", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Remove label Bug")).toHaveCount(0);
  // Unassigning keeps the board-scoped definition: the picker still offers it.
  await dialog.getByRole("button", { name: "+ Add label…" }).click();
  await expect(dialog.getByRole("button", { name: "Toggle label Bug" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alpha.getByTestId("label-pill")).toHaveCount(0);
});

test("renaming, recoloring and deleting a label definition propagates to every card", async ({
  page,
}) => {
  await boardWithCard(page, "propagate", "Alpha");
  await addCard(page, "Todo", "Beta");

  let column = columnByTitle(page, "Todo");
  let alpha = cardIn(column, "Alpha");
  let beta = cardIn(column, "Beta");

  await alpha.click();
  let dialog = page.getByRole("dialog", { name: "Alpha" });
  await dialog.getByRole("button", { name: "+ Add label…" }).click();
  await dialog.getByRole("button", { name: "Create label", exact: true }).click();
  await dialog.getByLabel("New label name").fill("Bug");
  await dialog.getByLabel("New label name").press("Enter");
  await expect(dialog.getByRole("heading", { name: "Labels 1" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The second card assigns the same definition through the toggle row.
  await beta.click();
  dialog = page.getByRole("dialog", { name: "Beta" });
  await dialog.getByRole("button", { name: "+ Add label…" }).click();
  await dialog.getByLabel("Toggle label Bug").click();
  await expect(dialog.getByRole("heading", { name: "Labels 1" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alpha.getByTestId("label-pill")).toHaveText("Bug");
  await expect(beta.getByTestId("label-pill")).toHaveText("Bug");

  // Editing the definition from either card rewrites it everywhere.
  await alpha.click();
  dialog = page.getByRole("dialog", { name: "Alpha" });
  await dialog.getByRole("button", { name: "+ Add label…" }).click();
  await dialog.getByLabel("Edit label Bug").click();
  await dialog.getByLabel("Label name Bug").fill("Fix");
  await dialog.getByLabel("Teal").click();
  await dialog.getByLabel("Save label Bug").click();
  await expect(dialog.getByLabel("Remove label Fix")).toBeVisible();
  // Focus is still inside the picker, so the ladder collapses it first.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alpha.getByTestId("label-pill")).toHaveText("Fix");
  await expect(beta.getByTestId("label-pill")).toHaveText("Fix");

  await alpha.click();
  dialog = page.getByRole("dialog", { name: "Alpha" });
  await dialog.getByRole("button", { name: "+ Add label…" }).click();
  await dialog.getByLabel("Edit label Fix").click();
  await dialog.getByLabel("Delete label Fix").click();
  // Deleting a definition is destructive board-wide, so it sits behind a confirm.
  await expect(dialog.getByText("Remove this label from every card?")).toBeVisible();
  await dialog.getByLabel("Confirm delete label Fix").click();
  await expect(dialog.getByRole("heading", { name: "Labels", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Toggle label Fix")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alpha.getByTestId("label-pill")).toHaveCount(0);
  await expect(beta.getByTestId("label-pill")).toHaveCount(0);

  await page.reload();
  column = columnByTitle(page, "Todo");
  alpha = cardIn(column, "Alpha");
  beta = cardIn(column, "Beta");
  await expect(alpha.getByTestId("label-pill")).toHaveCount(0);
  await expect(beta.getByTestId("label-pill")).toHaveCount(0);
});

test("the board header filters cards by label, ORs the selections, and round-trips through the URL", async ({
  page,
}) => {
  await boardWithCard(page, "filter", "Alpha");
  await addCard(page, "Todo", "Beta");
  await addCard(page, "Todo", "Gamma");

  let column = columnByTitle(page, "Todo");
  // Creating a label from a card's picker also assigns it; Gamma stays bare.
  await cardIn(column, "Alpha").click();
  const alphaModal = page.getByRole("dialog", { name: "Alpha" });
  await alphaModal.getByRole("button", { name: "+ Add label…" }).click();
  await alphaModal.getByRole("button", { name: "Create label", exact: true }).click();
  await alphaModal.getByLabel("New label name").fill("Bug");
  await alphaModal.getByLabel("New label name").press("Enter");
  await expect(alphaModal.getByLabel("Remove label Bug")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(alphaModal).toHaveCount(0);

  await cardIn(column, "Beta").click();
  const betaModal = page.getByRole("dialog", { name: "Beta" });
  await betaModal.getByRole("button", { name: "+ Add label…" }).click();
  await betaModal.getByRole("button", { name: "Create label", exact: true }).click();
  await betaModal.getByLabel("New label name").fill("Chore");
  await betaModal.getByLabel("New label name").press("Enter");
  await expect(betaModal.getByLabel("Remove label Chore")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(betaModal).toHaveCount(0);

  const filterButton = page.getByRole("button", { name: "Filter cards", exact: true });
  const filterDialog = page.getByRole("dialog", { name: "Filter cards" });
  await expect(filterButton).toHaveAttribute("aria-haspopup", "dialog");
  await expect(filterButton).toHaveAttribute("aria-expanded", "false");
  await expect(filterDialog).toHaveCount(0);
  await filterButton.click();
  await expect(filterButton).toHaveAttribute("aria-expanded", "true");
  await expect(filterDialog).toBeVisible();
  await expect(filterDialog.getByRole("button", { name: "Close filter cards" })).toBeFocused();

  // Escape restores focus to the trigger button.
  await page.keyboard.press("Escape");
  await expect(filterButton).toHaveAttribute("aria-expanded", "false");
  await expect(filterDialog).toHaveCount(0);
  await expect(filterButton).toBeFocused();

  // Backdrop dismissal: a pointer outside the panel closes it.
  await filterButton.click();
  await expect(filterButton).toHaveAttribute("aria-expanded", "true");
  await expect(filterDialog).toBeVisible();
  await expect(filterDialog.getByRole("button", { name: "Close filter cards" })).toBeFocused();
  await page.locator(".board-filter-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(filterButton).toHaveAttribute("aria-expanded", "false");
  await expect(filterDialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter by label Bug" })).toHaveCount(0);

  await filterButton.click();
  await expect(filterButton).toHaveAttribute("aria-expanded", "true");
  await expect(filterDialog).toBeVisible();
  await page.getByRole("button", { name: "Filter by label Bug" }).click();
  await expect(cardIn(column, "Alpha")).toBeVisible();
  await expect(cardIn(column, "Beta")).toHaveCount(0);
  await expect(cardIn(column, "Gamma")).toHaveCount(0);
  await expect(filterButton).toHaveText("Filters · 1");
  await expect(page.getByText("1 of 3 cards", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/labels=/);
  const bugToken = new URL(page.url()).searchParams.get("labels");
  if (!bugToken) throw new Error("expected bug label token in URL");

  // A second label widens the selection: any-of, never all-of.
  await page.getByRole("button", { name: "Filter by label Chore" }).click();
  await expect(cardIn(column, "Alpha")).toBeVisible();
  await expect(cardIn(column, "Beta")).toBeVisible();
  await expect(cardIn(column, "Gamma")).toHaveCount(0);
  await expect(page.getByText("2 of 3 cards", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Filter by no label" }).click();
  await expect(cardIn(column, "Gamma")).toBeVisible();
  await expect(filterButton).toHaveText("Filters · 3");
  await expect(page.getByText("3 of 3 cards", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Filter by label Bug" }).click();
  await page.getByRole("button", { name: "Filter by label Chore" }).click();
  await expect(cardIn(column, "Gamma")).toBeVisible();
  await expect(cardIn(column, "Alpha")).toHaveCount(0);
  await expect(cardIn(column, "Beta")).toHaveCount(0);
  await expect(page.getByText("1 of 3 cards", { exact: true })).toBeVisible();

  await expect(page).toHaveURL(/labels=none/);
  await page.reload();
  // Reload replaces every node: re-resolve the column, and let the snapshot land.
  column = columnByTitle(page, "Todo");
  await expect(column.getByRole("heading", { name: "Todo" })).toBeVisible();
  await expect(cardIn(column, "Gamma")).toBeVisible();
  await expect(cardIn(column, "Alpha")).toHaveCount(0);
  await expect(cardIn(column, "Beta")).toHaveCount(0);
  await expect(page.getByText("1 of 3 cards", { exact: true })).toBeVisible();

  const filterAfterReload = page.getByRole("button", { name: "Filter cards", exact: true });
  await expect(filterAfterReload).toHaveText("Filters · 1");
  await expect(filterAfterReload).toHaveAttribute("aria-haspopup", "dialog");
  await expect(filterAfterReload).toHaveAttribute("aria-expanded", "false");
  await expect(filterDialog).toHaveCount(0);
  await filterAfterReload.click();
  await expect(filterAfterReload).toHaveAttribute("aria-expanded", "true");
  await expect(filterDialog).toBeVisible();
  await filterDialog.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(cardIn(column, "Alpha")).toBeVisible();
  await expect(cardIn(column, "Beta")).toBeVisible();
  await expect(cardIn(column, "Gamma")).toBeVisible();
  await expect(filterAfterReload).toHaveText("Filters");
  await page.keyboard.press("Escape");
  await expect(filterAfterReload).toHaveAttribute("aria-expanded", "false");
  await expect(filterDialog).toHaveCount(0);
  await expect(filterAfterReload).toBeFocused();
  // Nothing is filtered, so no clear action is offered; the toolbar count is a
  // permanent readout of real state, not a filter summary.
  await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
  await expect(page).not.toHaveURL(/labels=/);

  // A URL containing only a missing label token remains unchanged in the address bar
  // while no active match summary or "Clear filters" action appears.
  const boardUrl = page.url();
  await page.goto(`${boardUrl}?labels=missing-label-token`);
  await expect(page).toHaveURL(/labels=missing-label-token/);
  await expect(filterAfterReload).toHaveText("Filters");
  await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
  column = columnByTitle(page, "Todo");
  await expect(cardIn(column, "Alpha")).toBeVisible();
  await expect(cardIn(column, "Beta")).toBeVisible();
  await expect(cardIn(column, "Gamma")).toBeVisible();

  // A URL containing the same valid label token twice preserves the raw URL tokens,
  // filters effectively once, counts as one active dimension, and does not overcount the summary.
  const cleanBoardUrl = boardUrl.split("?")[0];
  await page.goto(`${cleanBoardUrl}?labels=${bugToken},${bugToken}`);
  await expect(page).toHaveURL(new RegExp(`labels=${bugToken},${bugToken}`));
  await expect(filterAfterReload).toHaveText("Filters · 1");
  await expect(page.getByText("1 of 3 cards", { exact: true })).toBeVisible();
  column = columnByTitle(page, "Todo");
  await expect(cardIn(column, "Alpha")).toBeVisible();
  await expect(cardIn(column, "Beta")).toHaveCount(0);
  await expect(cardIn(column, "Gamma")).toHaveCount(0);

  // The unlabeled filter token `none` also deduplicates when repeated in the URL.
  await page.goto(`${cleanBoardUrl}?labels=none,none`);
  await expect(page).toHaveURL(/labels=none,none/);
  await expect(filterAfterReload).toHaveText("Filters · 1");
  await expect(page.getByText("1 of 3 cards", { exact: true })).toBeVisible();
  column = columnByTitle(page, "Todo");
  await expect(cardIn(column, "Gamma")).toBeVisible();
  await expect(cardIn(column, "Alpha")).toHaveCount(0);
  await expect(cardIn(column, "Beta")).toHaveCount(0);
});
