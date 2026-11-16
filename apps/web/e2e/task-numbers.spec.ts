import { expect, test } from "@playwright/test";
import {
  cardBody,
addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  openCardSection,
  inviteMember,
  signup,
  uniqueEmail,
} from "./helpers";

function randomBoardKey(prefix = "K"): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 8)
    .toUpperCase();
  return `${prefix}${rand}`;
}

test.describe("task numbers", () => {
  test("creates board with unique key, renders key-1 and key-2 on card fronts, displays in modal and fullscreen, survives archive and restore", async ({
    page,
  }) => {
    await signup(page, uniqueEmail("task-nums"), "Task Number User");

    const boardKey = randomBoardKey("G");
    const boardName = `Game Project ${Date.now()}`;
    const boardId = await createBoard(page, boardName, boardKey);

    // Board row displays muted key
    const boardLink = page.getByRole("link", { name: boardName });
    await expect(boardLink).toBeVisible();
    const boardRow = page.getByRole("listitem").filter({ has: boardLink });
    await expect(boardRow.getByText(boardKey)).toBeVisible();

    await boardLink.click();
    await expect(page).toHaveURL(`/board/${boardKey}`);
    await expect(page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
    await expect(page.getByText(boardKey)).toBeVisible();

    await addColumn(page, "Todo");
    await addCard(page, "Todo", "First Task");
    await addCard(page, "Todo", "Second Task");

    const expected1 = `${boardKey}-1`;
    const expected2 = `${boardKey}-2`;

    // Card fronts display key-1 and key-2
    const todoCol = columnByTitle(page, "Todo");
    const firstCard = cardIn(todoCol, "First Task");
    const secondCard = cardIn(todoCol, "Second Task");
    await expect(firstCard.getByText(expected1)).toBeVisible();
    await expect(secondCard.getByText(expected2)).toBeVisible();

    // Open second card modal and assert URL carries exact canonical human key
    await secondCard.click();
    await expect(page).toHaveURL(new RegExp(`\\?card=${expected2}$`));
    const dialog = page.getByRole("dialog", { name: "Second Task" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(expected2)).toBeVisible();

    // Switch to fullscreen: view=full is appended, card param is retained
    await dialog.getByRole("button", { name: "Open full screen" }).click();
    await expect(page).toHaveURL(new RegExp(`\\?card=${expected2}&view=full$`));
    const fullscreenDialog = page.getByRole("dialog", { name: "Second Task" });
    await expect(fullscreenDialog.getByText(expected2)).toBeVisible();
    await expect(fullscreenDialog.getByRole("heading", { name: "Second Task" })).toBeVisible();

    // Return to modal: view is dropped, card param is retained
    await fullscreenDialog.getByRole("button", { name: "Exit full screen" }).click();
    await expect(page).toHaveURL(new RegExp(`\\?card=${expected2}$`));

    // Archive the card
    await dialog.getByRole("button", { name: "Delete card" }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(secondCard).toHaveCount(0);
    await expect(page).not.toHaveURL(/card=/);

    // Open Archived cards dialog and check key-2
    const archiveBtn = page.getByRole("button", { name: /archive/i });
    await archiveBtn.click();
    const archiveDialog = page.getByRole("dialog", { name: "Archived cards" });
    await expect(archiveDialog).toBeVisible();
    await expect(archiveDialog.getByText(expected2)).toBeVisible();
    await expect(archiveDialog.getByRole("heading", { name: "Second Task" })).toBeVisible();

    // Restore the card
    await archiveDialog.getByRole("button", { name: "Restore Second Task" }).click();
    await archiveDialog.getByRole("button", { name: "Close archived cards" }).click();
    await expect(archiveDialog).not.toBeVisible();

    // Second task restored with same key-2 identifier
    const restoredCard = cardIn(columnByTitle(page, "Todo"), "Second Task");
    await expect(restoredCard).toBeVisible();
    await expect(restoredCard.getByText(expected2)).toBeVisible();
  });

  test("two connected members observe authoritative numbering for a newly created card live without reload", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    const memberPage = await memberContext.newPage();

    const ownerEmail = uniqueEmail("num-owner");
    const memberEmail = uniqueEmail("num-member");
    await signup(ownerPage, ownerEmail, "Owner");
    await signup(memberPage, memberEmail, "Member");

    const boardName = `Collab ${Date.now()}`;
    const boardKey = randomBoardKey("C");
    const boardId = await createBoard(ownerPage, boardName, boardKey);
    await inviteMember(ownerPage, boardName, memberEmail);

    await ownerPage.getByRole("link", { name: boardName }).click();
    await memberPage.goto(`/board/${boardKey}`);

    await addColumn(ownerPage, "Backlog");
    await addCard(ownerPage, "Backlog", "Task One");
    await addCard(ownerPage, "Backlog", "Task Two");

    const memberBacklog = columnByTitle(memberPage, "Backlog");
    await expect(cardIn(memberBacklog, "Task One")).toBeVisible();
    await expect(cardIn(memberBacklog, "Task Two")).toBeVisible();

    // Member creates third card
    await addCard(memberPage, "Backlog", "Task Three");

    // Both observe exact <KEY>-3 live
    const expectedKey = `${boardKey}-3`;
    const ownerBacklog = columnByTitle(ownerPage, "Backlog");
    await expect(cardIn(ownerBacklog, "Task Three").getByText(expectedKey)).toBeVisible();
    await expect(cardIn(memberBacklog, "Task Three").getByText(expectedKey)).toBeVisible();

    await ownerContext.close();
    await memberContext.close();
  });

  test("no horizontal overflow at 375px on board create, card front, modal, and archive", async ({
    page,
  }) => {
    await signup(page, uniqueEmail("num-responsive"), "Responsive User");

    const boardName = `Resp ${Date.now()}`;
    const boardKey = randomBoardKey("R");

    await page.setViewportSize({ width: 375, height: 667 });

    const assertNoOverflow = async (targetSelector?: string) => {
      const scrollW = await page.evaluate(
        (sel) => (sel ? document.querySelector(sel)?.scrollWidth : document.documentElement.scrollWidth),
        targetSelector,
      );
      const clientW = await page.evaluate(
        (sel) => (sel ? document.querySelector(sel)?.clientWidth : document.documentElement.clientWidth),
        targetSelector,
      );
      expect(scrollW).toBeDefined();
      expect(clientW).toBeDefined();
      expect(scrollW!).toBeLessThanOrEqual(clientW!);
    };

    // Verify the initial BoardListPage layout
    await assertNoOverflow();

    const createButton = page.getByRole("button", { name: "New board" });
    await expect(createButton).toBeVisible();

    // Create board through the responsive modal.
    await createBoard(page, boardName, boardKey);
    await assertNoOverflow();

    // Open board
    await page.getByRole("link", { name: boardName }).click();
    await addColumn(page, "Todo");
    await addCard(page, "Todo", "Responsive Card");

    const expectedId = `${boardKey}-1`;
    const card = cardIn(columnByTitle(page, "Todo"), "Responsive Card");
    await expect(card.getByText(expectedId)).toBeVisible();

    // Measure card front
    const cardEl = card.first();
    const cardBox = await cardEl.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.width).toBeLessThanOrEqual(375);

    // Open the card modal
    await card.click();
    const dialog = page.getByRole("dialog", { name: "Responsive Card" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(expectedId)).toBeVisible();
    await assertNoOverflow("[role='dialog']");


    // Archive card from modal
    await dialog.getByRole("button", { name: "Delete card" }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).not.toBeVisible();

    // Open Archived cards dialog
    const archiveBtn = page.getByRole("button", { name: /archive/i });
    await archiveBtn.click();
    const archiveDialog = page.getByRole("dialog", { name: "Archived cards" });
    await expect(archiveDialog).toBeVisible();
    await expect(archiveDialog.getByText(expectedId)).toBeVisible();
    await assertNoOverflow("[role='dialog']");

    // Close archive
    await archiveDialog.getByRole("button", { name: "Close archived cards" }).click();
    await expect(archiveDialog).not.toBeVisible();
  });

  test("card URLs use exact canonical keys, preserve history across modal/fullscreen/reload/Back/card-to-card, clean invalid keys while preserving filters, and restore focus to UUID element", async ({
    page,
  }) => {
    await signup(page, uniqueEmail("task-url-history"), "Task URL User");

    const boardKey = randomBoardKey("H");
    const boardName = `History Board ${Date.now()}`;
    const boardId = await createBoard(page, boardName, boardKey);

    await page.getByRole("link", { name: boardName }).click();
    await expect(page).toHaveURL(`/board/${boardKey}`);
    await addColumn(page, "Backlog");
    await addCard(page, "Backlog", "Card Alpha");
    await addCard(page, "Backlog", "Card Beta");

    const keyAlpha = `${boardKey}-1`;
    const keyBeta = `${boardKey}-2`;
    const backlogCol = columnByTitle(page, "Backlog");
    const alphaCard = cardIn(backlogCol, "Card Alpha");
    const betaCard = cardIn(backlogCol, "Card Beta");

    // Read the internal UUID from the DOM element of Card Beta
    const betaUuid = await cardBody(betaCard).getAttribute("data-card-id");
    expect(betaUuid).toBeTruthy();
    expect(betaUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // 1. Click second card: opens with ?card=<KEY>-2, never exposing UUID
    await betaCard.click();
    await expect(page).toHaveURL(new RegExp(`/board/${boardKey}\\?card=${keyBeta}$`));
    const betaModal = page.getByRole("dialog", { name: "Card Beta" });
    await expect(betaModal).toBeVisible();

    // Switch to fullscreen: URL adds &view=full
    await betaModal.getByRole("button", { name: "Open full screen" }).click();
    await expect(page).toHaveURL(new RegExp(`/board/${boardKey}\\?card=${keyBeta}&view=full$`));
    const betaFullscreen = page.getByRole("dialog", { name: "Card Beta" });
    await expect(betaFullscreen).toBeVisible();

    // Reload in fullscreen: persists fullscreen mode and card key
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/board/${boardKey}\\?card=${keyBeta}&view=full$`));
    const reloadedFullscreen = page.getByRole("dialog", { name: "Card Beta" });
    await expect(reloadedFullscreen).toBeVisible();

    // Exit fullscreen back to modal
    await reloadedFullscreen.getByRole("button", { name: "Exit full screen" }).click();
    await expect(page).toHaveURL(new RegExp(`/board/${boardKey}\\?card=${keyBeta}$`));

    // Link Alpha from Beta to exercise card-to-card navigation inside modal
    await openCardSection(betaModal, "relations");
    await betaModal.getByRole("button", { name: "+ Link a card…" }).click();
    await betaModal.getByLabel("Relation kind").selectOption({ label: "Blocks" });
    const relationPicker = betaModal.getByLabel("Link a card");
    await relationPicker.fill("Alpha");
    const relationResults = betaModal.getByTestId("relation-results");
    await relationResults.getByRole("button").filter({ hasText: "Card Alpha" }).click();
    await expect(betaModal.getByText("Blocks Card Alpha", { exact: true })).toBeVisible();

    // Navigate from Beta to Alpha inside the card modal
    await betaModal.getByRole("button", { name: "Open Card Alpha" }).click();
    await expect(page).toHaveURL(new RegExp(`/board/${boardKey}\\?card=${keyAlpha}$`));
    const alphaModal = page.getByRole("dialog", { name: "Card Alpha" });
    await expect(alphaModal).toBeVisible();

    // Browser Back returns to Card Beta
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/board/${boardKey}\\?card=${keyBeta}$`));
    await expect(page.getByRole("dialog", { name: "Card Beta" })).toBeVisible();

    // Closing restores focus to the UUID-backed card DOM element
    await page.getByRole("dialog", { name: "Card Beta" }).getByRole("button", { name: "Close card" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(`/board/${boardKey}`);
    await expect(page.locator(`[data-card-id="${betaUuid}"]`)).toBeFocused();

    // 2. Deep-link scrubbing: invalid keys scrub card/view/attachment but preserve filters
    // Set up search query filter
    const searchInput = page.getByLabel("Search cards");
    await searchInput.fill("Alpha");
    await expect(page).toHaveURL(new RegExp(`/board/${boardKey}\\?q=Alpha$`));

    // Case A: UUID in card param is rejected and scrubbed
    await page.goto(`/board/${boardKey}?card=${betaUuid}&view=full&attachment=some-att&q=Alpha`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(`/board/${boardKey}?q=Alpha`);
    await expect(searchInput).toHaveValue("Alpha");

    // Case B: Lowercase key is rejected and scrubbed
    const lowercaseKey = keyBeta.toLowerCase();
    await page.goto(`/board/${boardKey}?card=${lowercaseKey}&view=full&attachment=some-att&q=Alpha`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(`/board/${boardKey}?q=Alpha`);

    // Case C: Wrong board key is rejected and scrubbed
    await page.goto(`/board/${boardKey}?card=WRONGKEY-1&view=full&attachment=some-att&q=Alpha`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(`/board/${boardKey}?q=Alpha`);

    // Case D: Missing / nonexistent task number on same board is rejected and scrubbed
    await page.goto(`/board/${boardKey}?card=${boardKey}-999&view=full&attachment=some-att&q=Alpha`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(`/board/${boardKey}?q=Alpha`);

    // Case E: Archived card key is rejected and scrubbed while preserving labels and assignees
    // First open Alpha, archive it
    await searchInput.fill("");
    await alphaCard.click();
    const toArchiveModal = page.getByRole("dialog", { name: "Card Alpha" });
    await toArchiveModal.getByRole("button", { name: "Delete card" }).click();
    await toArchiveModal.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(toArchiveModal).not.toBeVisible();

    // Deep link to archived card with assignees=none&labels=none&q=test
    await page.goto(
      `/board/${boardKey}?card=${keyAlpha}&view=full&attachment=fake-att&assignees=none&labels=none&q=test`,
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => {
      const current = new URL(page.url());
      return {
        pathname: current.pathname,
        hasCard: current.searchParams.has("card"),
        hasView: current.searchParams.has("view"),
        hasAttachment: current.searchParams.has("attachment"),
        assignees: current.searchParams.get("assignees"),
        labels: current.searchParams.get("labels"),
        q: current.searchParams.get("q"),
      };
    }).toEqual({
      pathname: `/board/${boardKey}`,
      hasCard: false,
      hasView: false,
      hasAttachment: false,
      assignees: "none",
      labels: "none",
      q: "test",
    });
  });

  test("optimistic unnumbered card click never exposes UUID and opens on the next click after card.numbered arrives", async ({
    page,
  }) => {
    // Intercept WebSocket before document creation: hold card.numbered frame for the upcoming card
    const heldNumberedFrames: Array<() => void> = [];
    await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.type === "card.numbered") {
          heldNumberedFrames.push(() => ws.send(message));
          return;
        }
        ws.send(message);
      });
    });

    await signup(page, uniqueEmail("task-timing"), "Timing User");

    const boardKey = randomBoardKey("T");
    const boardName = `Timing Board ${Date.now()}`;
    const boardId = await createBoard(page, boardName, boardKey);

    await page.getByRole("link", { name: boardName }).click();
    await expect(page).toHaveURL(`/board/${boardKey}`);
    await addColumn(page, "Queue");

    const queueCol = columnByTitle(page, "Queue");
    await queueCol.getByRole("button", { name: "Add card", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "Create a card" });
    await createDialog.getByLabel("Title").fill("Pending Card");
    await createDialog.getByRole("button", { name: "Create card" }).click();
    // The accepted create closes the dialog; the numbering frame is what the proxy holds.
    await expect(createDialog).toHaveCount(0);
    // Wait until the server emitted card.numbered and our proxy held it
    await expect.poll(() => heldNumberedFrames.length).toBeGreaterThanOrEqual(1);

    // The card is rendered optimistically in the column without a rendered task key
    const pendingCard = cardIn(queueCol, "Pending Card");
    await expect(pendingCard).toBeVisible();
    const cardUuid = await cardBody(pendingCard).getAttribute("data-card-id");
    expect(cardUuid).toBeTruthy();
    const expectedKey = `${boardKey}-1`;
    await expect(pendingCard.getByText(expectedKey)).toHaveCount(0);

    // Click while unnumbered (taskNumber is 0): MUST NOT navigate or expose UUID in URL
    await pendingCard.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const currentUrl = new URL(page.url());
    expect(currentUrl.pathname).toBe(`/board/${boardKey}`);
    expect(currentUrl.searchParams.has("card")).toBe(false);
    expect(page.url()).not.toContain(cardUuid!);

    // Release held card.numbered frame(s) to the client
    while (heldNumberedFrames.length > 0) {
      heldNumberedFrames.shift()!();
    }
    // Authoritative key appears on the card front
    await expect(pendingCard.getByText(expectedKey)).toBeVisible();

    // Next click succeeds and opens with the canonical human task key
    await pendingCard.click();
    await expect(page).toHaveURL(new RegExp(`/board/${boardKey}\\?card=${expectedKey}$`));
    const dialog = page.getByRole("dialog", { name: "Pending Card" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(expectedKey)).toBeVisible();
  });
});
