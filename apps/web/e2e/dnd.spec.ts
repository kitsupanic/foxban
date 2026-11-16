import { expect, test } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardBody,

  cardIn,
  columnByTitle,
  createBoard,
  dragCardTo,
  inviteMember,
  signup,
  touchDragCardTo,
  uniqueEmail,
} from "./helpers";
import { mobileViewport } from "./fixtures";

test("dragging a card moves it to another column for both users", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signup(owner, uniqueEmail("dnd-owner"), "Dnd Owner");

  const watcherContext = await browser.newContext();
  const watcher = await watcherContext.newPage();
  const watcherEmail = uniqueEmail("dnd-watcher");
  await signup(watcher, watcherEmail, "Dnd Watcher");

  const boardName = `Dnd ${Date.now()}`;
  const boardId = await createBoard(owner, boardName);
  await inviteMember(owner, boardName, watcherEmail);

  await owner.getByRole("link", { name: boardName }).click();
  await expect(owner.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(owner, "Todo");
  await addColumn(owner, "Done");
  await addCard(owner, "Todo", "draggable card");

  await watcher.goto(`/board/${boardId}`);
  await expect(cardIn(columnByTitle(watcher, "Todo"), "draggable card")).toBeVisible();

  const card = cardIn(columnByTitle(owner, "Todo"), "draggable card");
  const doneColumn = columnByTitle(owner, "Done");
  const doneBody = doneColumn.locator("ul");

  // Capture the source rectangle before lift
  const sourceBox = await card.boundingBox();
  expect(sourceBox).not.toBeNull();

  await dragCardTo(owner, card, doneBody, async () => {
    const preview = owner.getByTestId("card-drag-preview");
    await expect(preview).toBeVisible();

    const previewBox = await preview.boundingBox();
    expect(previewBox).not.toBeNull();
    expect(Math.abs(previewBox!.width - sourceBox!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(previewBox!.height - sourceBox!.height)).toBeLessThanOrEqual(1);

    const doneBox = await doneBody.boundingBox();
    expect(doneBox).not.toBeNull();
    const previewCenterX = previewBox!.x + previewBox!.width / 2;
    const previewCenterY = previewBox!.y + previewBox!.height / 2;
    expect(previewCenterX).toBeGreaterThan(doneBox!.x);
    expect(previewCenterX).toBeLessThan(doneBox!.x + doneBox!.width);
    expect(previewCenterY).toBeGreaterThan(doneBox!.y);
    expect(previewCenterY).toBeLessThan(doneBox!.y + doneBox!.height);

    // Title and priority badge remain present (aria-hidden preview uses testid/text queries)
    await expect(preview.getByText("draggable card")).toBeVisible();
    await expect(preview.getByTestId("priority-badge")).toBeVisible();
  });

  // After release: assert preview absent
  await expect(owner.getByTestId("card-drag-preview")).toHaveCount(0);
  // Card in Done once for both users
  await expect(cardIn(columnByTitle(owner, "Done"), "draggable card")).toHaveCount(1);
  await expect(cardIn(columnByTitle(watcher, "Done"), "draggable card")).toHaveCount(1);
  // No card in Todo
  await expect(cardIn(columnByTitle(owner, "Todo"), "draggable card")).toHaveCount(0);
  await expect(cardIn(columnByTitle(watcher, "Todo"), "draggable card")).toHaveCount(0);
  // No modal
  await expect(owner.getByRole("dialog")).toHaveCount(0);
  await expect(watcher.getByRole("dialog")).toHaveCount(0);

  // Reload persistence
  await owner.reload();
  await expect(cardIn(columnByTitle(owner, "Done"), "draggable card")).toHaveCount(1);
  await expect(cardIn(columnByTitle(owner, "Todo"), "draggable card")).toHaveCount(0);

  // Exercise a populated destination by moving back onto an existing Todo card and assert insertion before it
  await addCard(owner, "Todo", "existing card");
  await expect(cardIn(columnByTitle(owner, "Todo"), "existing card")).toBeVisible();
  await expect(cardIn(columnByTitle(watcher, "Todo"), "existing card")).toBeVisible();

  const doneCard = cardIn(columnByTitle(owner, "Done"), "draggable card");
  const targetTodoCard = cardIn(columnByTitle(owner, "Todo"), "existing card");
  await dragCardTo(owner, doneCard, targetTodoCard);

  await expect(owner.getByTestId("card-drag-preview")).toHaveCount(0);
  const ownerTodoCards = columnByTitle(owner, "Todo").locator("li");
  await expect(ownerTodoCards.nth(0)).toContainText("draggable card");
  await expect(ownerTodoCards.nth(1)).toContainText("existing card");

  const watcherTodoCards = columnByTitle(watcher, "Todo").locator("li");
  await expect(watcherTodoCards.nth(0)).toContainText("draggable card");
  await expect(watcherTodoCards.nth(1)).toContainText("existing card");

  await expect(cardIn(columnByTitle(owner, "Done"), "draggable card")).toHaveCount(0);
  await expect(cardIn(columnByTitle(watcher, "Done"), "draggable card")).toHaveCount(0);
  await expect(owner.getByRole("dialog")).toHaveCount(0);
  await expect(watcher.getByRole("dialog")).toHaveCount(0);

  await owner.reload();
  const reloadedOwnerTodoCards = columnByTitle(owner, "Todo").locator("li");
  await expect(reloadedOwnerTodoCards.nth(0)).toContainText("draggable card");
  await expect(reloadedOwnerTodoCards.nth(1)).toContainText("existing card");
  await expect(cardIn(columnByTitle(owner, "Done"), "draggable card")).toHaveCount(0);

  await ownerContext.close();
  await watcherContext.close();
});

test("drag preview keeps its size over unequal-height cards", async ({ page }) => {
  await signup(page, uniqueEmail("dnd-heights"), "Heights User");
  const boardName = `Heights ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");

  const shortTitle = "Short card";
  const tallTitle =
    "Tall card with a very long descriptive multiline title that wraps across several lines in the board column to create a substantial height difference";

  await addCard(page, "Todo", shortTitle);
  await addCard(page, "Todo", tallTitle);

  const todo = columnByTitle(page, "Todo");
  const shortCard = cardIn(todo, shortTitle);
  const tallCard = cardIn(todo, tallTitle);

  // Assert unequal initial heights as fixture precondition
  const initialShortBox = await shortCard.boundingBox();
  const initialTallBox = await tallCard.boundingBox();
  expect(initialShortBox).not.toBeNull();
  expect(initialTallBox).not.toBeNull();
  expect(initialTallBox!.height).toBeGreaterThan(initialShortBox!.height + 20);

  const shortId = await cardBody(shortCard).getAttribute("data-card-id");
  const tallId = await cardBody(tallCard).getAttribute("data-card-id");
  expect(shortId).toBeTruthy();
  expect(tallId).toBeTruthy();

  // Drag tall over short, inspect preview dimensions during hover, then verify reordered DOM ids
  await dragCardTo(page, tallCard, shortCard, async () => {
    const preview = page.getByTestId("card-drag-preview");
    await expect(preview).toBeVisible();
    const previewBox = await preview.boundingBox();
    expect(previewBox).not.toBeNull();
    expect(Math.abs(previewBox!.width - initialTallBox!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(previewBox!.height - initialTallBox!.height)).toBeLessThanOrEqual(1);
  });

  const cardsAfterFirstDrag = todo.locator("li");
  await expect(cardBody(cardsAfterFirstDrag.nth(0))).toHaveAttribute("data-card-id", tallId!);
  await expect(cardsAfterFirstDrag.nth(0)).toContainText(tallTitle);
  await expect(cardBody(cardsAfterFirstDrag.nth(1))).toHaveAttribute("data-card-id", shortId!);
  await expect(cardsAfterFirstDrag.nth(1)).toContainText(shortTitle);

  // Reverse the order with short over tall to protect both scaling directions
  const currentShortBox = await shortCard.boundingBox();
  expect(currentShortBox).not.toBeNull();

  await dragCardTo(page, shortCard, tallCard, async () => {
    const preview = page.getByTestId("card-drag-preview");
    await expect(preview).toBeVisible();
    const previewBox = await preview.boundingBox();
    expect(previewBox).not.toBeNull();
    expect(Math.abs(previewBox!.width - currentShortBox!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(previewBox!.height - currentShortBox!.height)).toBeLessThanOrEqual(1);
  });

  const cardsAfterSecondDrag = todo.locator("li");
  await expect(cardBody(cardsAfterSecondDrag.nth(0))).toHaveAttribute("data-card-id", shortId!);
  await expect(cardsAfterSecondDrag.nth(0)).toContainText(shortTitle);
  await expect(cardBody(cardsAfterSecondDrag.nth(1))).toHaveAttribute("data-card-id", tallId!);
  await expect(cardsAfterSecondDrag.nth(1)).toContainText(tallTitle);
});

test("cancelling a keyboard drag with Escape restores order, focus, and shortcuts", async ({ page }) => {
  await signup(page, uniqueEmail("dnd-cancel"), "Cancel User");
  const boardName = `Cancel ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");

  await addCard(page, "Todo", "first card");
  await addCard(page, "Todo", "second card");

  const todo = columnByTitle(page, "Todo");
  const firstCard = cardIn(todo, "first card");
  const secondCard = cardIn(todo, "second card");

  const firstId = await cardBody(firstCard).getAttribute("data-card-id");
  const secondId = await cardBody(secondCard).getAttribute("data-card-id");
  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();

  // dnd-kit owns the card body, not the row: focus and lift live there.
  const firstBody = cardBody(firstCard);
  await firstBody.focus();
  await expect(firstBody).toBeFocused();
  await page.keyboard.press("Space");
  await expect(firstBody).toHaveAttribute("aria-pressed", "true");

  const preview = page.getByTestId("card-drag-preview");
  await expect(preview).toBeVisible();
  const initialPreviewBox = await preview.boundingBox();
  expect(initialPreviewBox).not.toBeNull();

  // Move with ArrowDown, verify the preview moved
  await expect(async () => {
    await page.keyboard.press("ArrowDown");
    const currentBox = await preview.boundingBox();
    expect(currentBox).not.toBeNull();
    expect(currentBox!.y).toBeGreaterThan(initialPreviewBox!.y);
  }).toPass({ timeout: 5000 });

  // Press Escape
  await page.keyboard.press("Escape");

  // Assert preview gone
  await expect(page.getByTestId("card-drag-preview")).toHaveCount(0);
  await expect(firstBody).not.toHaveAttribute("aria-pressed", "true");

  // Original order and focus retained
  const cards = todo.locator("li");
  await expect(cardBody(cards.nth(0))).toHaveAttribute("data-card-id", firstId!);
  await expect(cards.nth(0)).toContainText("first card");
  await expect(cardBody(cards.nth(1))).toHaveAttribute("data-card-id", secondId!);
  await expect(cards.nth(1)).toContainText("second card");
  await expect(firstBody).toBeFocused();

  // No modal
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // n once again opens the leftmost column's create dialog
  await page.keyboard.press("n");
  const createDialog = page.getByRole("dialog", { name: "Create a card" });
  await expect(createDialog.getByLabel("Title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createDialog).toHaveCount(0);

  // No move should persist after reload
  await page.reload();
  const reloadedCards = columnByTitle(page, "Todo").locator("li");
  await expect(cardBody(reloadedCards.nth(0))).toHaveAttribute("data-card-id", firstId!);
  await expect(reloadedCards.nth(0)).toContainText("first card");
  await expect(cardBody(reloadedCards.nth(1))).toHaveAttribute("data-card-id", secondId!);
  await expect(reloadedCards.nth(1)).toContainText("second card");
});

test("a card dropped into a filtered column keeps its place in the column's full order", async ({
  page,
}) => {
  await signup(page, uniqueEmail("filtered-dnd"), "Filtered DnD User");
  const boardName = `Filtered DnD ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Alpha");
  await addCard(page, "Todo", "Beta");
  await addCard(page, "Todo", "Gamma");

  const todo = columnByTitle(page, "Todo");
  // Label Alpha and Beta; Gamma stays bare and hidden between them under the filter.
  await cardIn(todo, "Alpha").click();
  const alphaModal = page.getByRole("dialog", { name: "Alpha" });
  await alphaModal.getByRole("button", { name: "+ Add label…" }).click();
  await alphaModal.getByRole("button", { name: "Create label", exact: true }).click();
  await alphaModal.getByLabel("New label name").fill("Bug");
  await alphaModal.getByLabel("New label name").press("Enter");
  await expect(alphaModal.getByLabel("Remove label Bug")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(alphaModal).toHaveCount(0);

  await cardIn(todo, "Beta").click();
  const betaModal = page.getByRole("dialog", { name: "Beta" });
  await betaModal.getByRole("button", { name: "+ Add label…" }).click();
  await betaModal.getByLabel("Toggle label Bug").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(betaModal).toHaveCount(0);

  // Filter to Bug: Alpha and Beta render, Gamma is hidden.
  await page.getByRole("button", { name: "Filter cards", exact: true }).click();
  const filterDialog = page.getByRole("dialog", { name: "Filter cards" });
  await filterDialog.getByRole("button", { name: "Filter by label Bug" }).click();
  await page.keyboard.press("Escape");
  await expect(filterDialog).toHaveCount(0);
  await expect(cardIn(todo, "Gamma")).toHaveCount(0);
  await expect(todo.locator("[data-card-title]")).toHaveText(["Alpha", "Beta"]);

  // Beta is dropped onto the visible Alpha: it lands next to Alpha in the
  // column's FULL order (ADR 0025) instead of at the tail of what is on screen,
  // and the hidden Gamma keeps its place after them both.
  await dragCardTo(page, cardIn(todo, "Beta"), cardIn(todo, "Alpha"));
  await expect(todo.locator("[data-card-title]")).toHaveText(["Beta", "Alpha"]);

  // A click dispatched in the drop's own re-render tick can be swallowed, so the
  // clear is retried until the filter is really gone; the full order below is
  // what the drag contract is judged by.
  await expect(async () => {
    if (new URL(page.url()).searchParams.get("labels") !== null) {
      await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    }
    await expect(todo.locator("[data-card-title]")).toHaveText(["Beta", "Alpha", "Gamma"]);
  }).toPass({ timeout: 15_000 });
});

test("mobile touch: short swipe before 250ms scrolls board without accidental drag, and hold >250ms completes deliberate card move", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: mobileViewport,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  await signup(page, uniqueEmail("touch-dnd"), "Touch DnD User");
  const boardKey = await createBoard(page, `Touch DnD Board ${Date.now()}`);
  await page.goto(`/board/${boardKey}`);

  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Col A");
  await addColumn(page, "Col B");

  await addCard(page, "Col A", "Touch Alpha");
  await addCard(page, "Col A", "Touch Beta");

  const colA = columnByTitle(page, "Col A");
  const colB = columnByTitle(page, "Col B");
  let alphaCard = cardIn(colA, "Touch Alpha");
  const betaCard = cardIn(colA, "Touch Beta");

  // Assign representative labels (short and long) to Touch Alpha using existing card modal UI
  await alphaCard.click();
  const alphaDialog = page.getByRole("dialog", { name: "Touch Alpha" });
  await expect(alphaDialog).toBeVisible();
  await alphaDialog.getByRole("button", { name: "+ Add label…" }).click();
  await alphaDialog.getByRole("button", { name: "Create label", exact: true }).click();
  const labelInput = alphaDialog.getByLabel("New label name");
  await labelInput.fill("Bug");
  await labelInput.press("Enter");
  await expect(alphaDialog.getByRole("heading", { name: "Labels 1" })).toBeVisible();
  await alphaDialog.getByRole("button", { name: "Create label", exact: true }).click();
  await labelInput.fill("Long Infrastructure Migration Pipeline");
  await labelInput.press("Enter");
  await expect(alphaDialog.getByRole("heading", { name: "Labels 2" })).toBeVisible();
  await alphaDialog.getByRole("button", { name: "Assignee" }).click();
  await alphaDialog.getByRole("option", { name: "Touch DnD User", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(alphaDialog).toHaveCount(0);

  alphaCard = cardIn(colA, "Touch Alpha");
  const alphaBox = await alphaCard.boundingBox();
  expect(alphaBox).not.toBeNull();
  // 1. Verify affordance is a trailing direct child of the top metadata row, and has compact footprint
  const alphaAffordance = alphaCard.locator("[data-card-drag-affordance]");
  await expect(alphaAffordance).toBeVisible();
  const topMetadataRow = alphaAffordance.locator("xpath=..");
  await expect(topMetadataRow.locator("> [data-card-drag-affordance]")).toHaveCount(1);
  await expect(topMetadataRow.locator("> :last-child")).toHaveAttribute("data-card-drag-affordance", "true");
  await expect(alphaCard.locator("[data-testid=\"badge-row\"] [data-card-drag-affordance]")).toHaveCount(0);
  await expect(alphaCard.locator("[data-testid=\"badge-row\"] ~ [data-card-drag-affordance]")).toHaveCount(0);
  const affordanceBox = await alphaAffordance.boundingBox();
  expect(affordanceBox).not.toBeNull();
  expect(affordanceBox!.width).toBeLessThan(20);

  // Assert DOM vertical order: top row -> title -> label row -> footer
  const order = await alphaCard.evaluate((cardEl) => {
    const topRow = cardEl.querySelector("[data-card-drag-affordance]")?.parentElement;
    const titleEl = cardEl.querySelector("[data-card-title]");
    const pillEl = cardEl.querySelector("[data-testid='label-pill']");
    const labelRow = pillEl?.parentElement;
    const badgeRow = cardEl.querySelector("[data-testid='badge-row']");
    const footerRow = badgeRow?.parentElement;
    return {
      topRowBeforeTitle: Boolean(topRow && titleEl && (topRow.compareDocumentPosition(titleEl) & Node.DOCUMENT_POSITION_FOLLOWING)),
      titleBeforeLabelRow: Boolean(titleEl && labelRow && (titleEl.compareDocumentPosition(labelRow) & Node.DOCUMENT_POSITION_FOLLOWING)),
      labelRowBeforeFooter: Boolean(labelRow && footerRow && (labelRow.compareDocumentPosition(footerRow) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  });
  expect(order.topRowBeforeTitle).toBe(true);
  expect(order.titleBeforeLabelRow).toBe(true);
  expect(order.labelRowBeforeFooter).toBe(true);

  // Assert label pills render in their own row after title, stay within card boundaries, and do not collide with grip or footer
  const pills = alphaCard.getByTestId("label-pill");
  await expect(pills).toHaveCount(2);
  const badgeRow = alphaCard.locator("[data-testid=\"badge-row\"]");
  const badgeRowBox = await badgeRow.boundingBox();
  expect(badgeRowBox).not.toBeNull();
  const assigneeAvatar = alphaCard.getByRole("img", { name: "Assigned to Touch DnD User" });
  await expect(assigneeAvatar).toBeVisible();
  const assigneeBox = await assigneeAvatar.boundingBox();
  expect(assigneeBox).not.toBeNull();

  for (let i = 0; i < 2; i++) {
    const pillBox = await pills.nth(i).boundingBox();
    expect(pillBox).not.toBeNull();
    // Stays horizontally inside card boundaries
    expect(pillBox!.x).toBeGreaterThanOrEqual(alphaBox!.x);
    expect(pillBox!.x + pillBox!.width).toBeLessThanOrEqual(alphaBox!.x + alphaBox!.width + 0.5);
    // Renders vertically below the top-right drag affordance
    expect(pillBox!.y).toBeGreaterThanOrEqual(affordanceBox!.y + affordanceBox!.height - 1);
    // Renders vertically above footer badge row and assignee avatar
    expect(pillBox!.y + pillBox!.height).toBeLessThanOrEqual(badgeRowBox!.y + 1);
    expect(pillBox!.y + pillBox!.height).toBeLessThanOrEqual(assigneeBox!.y + 1);
  }
  // Assert no horizontal document overflow at 375px viewport
  const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(docOverflow).toBe(false);

  // Assert title/content begins near the card's left padding rather than behind a 44px rail
  const titleElement = alphaCard.locator("[data-card-title]").first();
  await expect(titleElement).toBeVisible();
  const titleBox = await titleElement.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(titleBox!.x - alphaBox!.x).toBeLessThan(20);
  // 2. A swipe shorter than the touch delay scrolls the page: it never lifts a card.
  await page.evaluate(() => window.scrollTo(0, 0));
  await alphaCard.scrollIntoViewIfNeeded();
  const freshAlphaBox = await alphaCard.boundingBox();
  expect(freshAlphaBox).not.toBeNull();
  const swipeStartX = Math.round(freshAlphaBox!.x + freshAlphaBox!.width * 0.5);
  const swipeStartY = Math.round(freshAlphaBox!.y + freshAlphaBox!.height * 0.5);

  // A fast sub-250ms vertical swipe on the card body
  const scrollBeforeSwipe = await page.evaluate(() => window.scrollY);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.synthesizeScrollGesture", {
    x: swipeStartX,
    y: swipeStartY,
    xDistance: 0,
    yDistance: -140, // negative yDistance scrolls the document forward
    speed: 1000, // fast sub-250ms gesture
    gestureSourceType: "touch",
  });
  await cdp.detach();

  // The page scrolled, and no drag started.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBeforeSwipe);
  await expect(page.getByTestId("card-drag-preview")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const colACardsBefore = colA.locator("li");
  await expect(colACardsBefore.nth(0)).toContainText("Touch Alpha");
  await expect(colACardsBefore.nth(1)).toContainText("Touch Beta");
  expect(await colB.locator("li").count()).toBe(0);
  const finalAffordanceBox = await alphaAffordance.boundingBox();
  expect(finalAffordanceBox).not.toBeNull();
  expect(finalAffordanceBox!.x).toBeGreaterThanOrEqual(0);
  expect(finalAffordanceBox!.x + finalAffordanceBox!.width).toBeLessThanOrEqual(mobileViewport.width);

  // 3. Deliberate hold beyond 250ms (320ms) starting on card locator followed by touch movement
  // Drag Alpha onto Beta within visible Col A to prove touch card reordering
  await touchDragCardTo(page, alphaCard, betaCard, {
    holdMs: 320,
    steps: 10,
    beforeDrop: async () => {
      // While dragging, assert card-drag-preview is visible and contains zero drag affordances
      const preview = page.getByTestId("card-drag-preview");
      await expect(preview).toBeVisible();
      await expect(preview).toContainText("Touch Alpha");
      await expect(preview.locator("[data-card-drag-affordance]")).toHaveCount(0);
    },
  });
  // 3. Verify Touch Alpha and Touch Beta reordered within Col A
  const colACardsAfter = colA.locator("li");
  await expect(colACardsAfter.nth(0)).toContainText("Touch Beta");
  await expect(colACardsAfter.nth(1)).toContainText("Touch Alpha");

  // 4. Persistence across reload
  await page.reload();
  const reloadedCards = columnByTitle(page, "Col A").locator("li");
  await expect(reloadedCards.nth(0)).toContainText("Touch Beta");
  await expect(reloadedCards.nth(1)).toContainText("Touch Alpha");

  await context.close();
});
