import { expect, test, type Route } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  signup,
  uniqueEmail,
} from "./helpers";
import { mobileViewport } from "./fixtures";
declare global {
  interface Window {
    __foxbanSockets?: WebSocket[];
  }
}

test("board metadata failure alert recovers and card modal isolates pending, failed, and retried member loading", async ({
  page,
}) => {
  await signup(page, uniqueEmail("ui-polish"), "Polish User");
  const boardName = `Polish Board ${Date.now()}`;
  const boardId = await createBoard(page, boardName);

  // Install one-shot failure for GET /boards/by-key/:key to verify board metadata alert and recovery.
  await page.route(
    new RegExp(`/boards/by-key/${boardId}(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "synthetic board error" }),
        });
      } else {
        await route.continue();
      }
    },
    { times: 1 },
  );

  // Hold the GET /boards/:id/members request pending until the card modal opens.
  const membersRouteHolder: { route?: Route } = {};
  await page.route(
    new RegExp(`/boards/([^/]+)/members(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET" && !membersRouteHolder.route) {
        membersRouteHolder.route = route;
      } else {
        await route.continue();
      }
    },
  );

  await page.getByRole("link", { name: boardName }).click();

  // In route shell error state (GET /boards/by-key/:key failed with 500), shell renders Could not load board and Retry button
  await expect(page.getByText("Could not load board.")).toBeVisible();
  const retryButton = page.getByRole("button", { name: "Retry" });
  await expect(retryButton).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: boardName })).toHaveCount(0);

  // Click Retry: recovers to BoardView with the workspace navigation and board title
  await retryButton.click();
  await expect(page.getByRole("link", { name: "Boards" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Profile", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: boardName })).toBeVisible();
  // Show the member rail while its query is still held, so the failure below lands
  // in the rail as well as in the card modal.
  await page.getByRole("button", { name: "Show board members" }).click();
  // Add column and card while members query remains pending.
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Member Test Card");
  const todoCol = columnByTitle(page, "Todo");
  await cardIn(todoCol, "Member Test Card").click();

  const cardModal = page.getByRole("dialog", { name: "Member Test Card" });
  await expect(cardModal).toBeVisible();

  // The modal announces pending member loading.
  await expect(cardModal.getByRole("status").filter({ hasText: "Loading board members…" })).toHaveText("Loading board members…");

  // Fail the held members request and verify the modal exposes the alert and Retry while base board is inert.
  const routeToFail = membersRouteHolder.route;
  membersRouteHolder.route = undefined;
  if (!routeToFail) throw new Error("expected held members route to be present");
  await routeToFail.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "synthetic members error" }),
  });

  const modalAlert = cardModal.getByRole("alert");
  await expect(modalAlert).toContainText("Could not load board members.");
  const membersRetry = modalAlert.getByRole("button", { name: "Retry" });
  await expect(membersRetry).toBeVisible();

  // Base board is inert while card modal is open. The member rail renders the member error in
  // the inert background, while the card modal retains its separate actionable alert and retry.
  await expect(page.locator(".boards-shell[inert]")).toBeVisible();
  await expect(page.locator(".board-member-rail")).toContainText("Could not load board members.");
  await expect(modalAlert).toBeVisible();
  // Unroute the members interception so retry can hit the server successfully
  await page.unroute(new RegExp(`/boards/([^/]+)/members(\\?.*)?$`));
  await membersRetry.click();
  await expect(modalAlert).toHaveCount(0);

  const assigneeButton = cardModal.getByRole("button", { name: "Assignee" });
  await expect(assigneeButton).toBeVisible();
  await assigneeButton.click();
  await expect(page.getByRole("option", { name: "Polish User" })).toBeVisible();
  // Escape ladder: first Escape closes the open Assignee picker popover.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option", { name: "Polish User" })).toHaveCount(0);
  await expect(cardModal).toBeVisible();

  // Second Escape closes the card modal itself and restores base board interactivity.
  await page.keyboard.press("Escape");
  await expect(cardModal).toHaveCount(0);
  await expect(page.locator(".boards-shell[inert]")).toHaveCount(0);
});

test("at 375px workspace with active query filter summary and reconnecting status fits without horizontal overflow", async ({
  page,
}) => {
  // Install pre-navigation WebSocket wrapper to expose the live board socket for deterministic closure,
  // while leaving other sockets (such as Vite HMR) untouched.
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;
    window.__foxbanSockets = [];
    window.WebSocket = class extends OriginalWebSocket {
      constructor(...args: [string | URL, (string | string[])?]) {
        super(...args);
        const url = String(args[0] ?? "");
        if (/\/boards\/.*\/ws/.test(url)) {
          window.__foxbanSockets?.push(this);
        }
      }
    };
  });

  await signup(page, uniqueEmail("narrow-workspace"), "Narrow User");
  const boardName = `Narrow Board ${Date.now()}`;
  await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Alpha Card");

  // Keep the longest control states present together: exact-scope quick filter
  // active, assignee count visible, title search active, and reconnecting status.
  await cardIn(columnByTitle(page, "Todo"), "Alpha Card").click();
  const cardDialog = page.getByRole("dialog", { name: "Alpha Card" });
  await cardDialog.getByRole("button", { name: "Assignee" }).click();
  await cardDialog.getByRole("option", { name: "Narrow User", exact: true }).click();
  await cardDialog.getByRole("button", { name: "Close card" }).click();

  const assignedToMeButton = page.getByRole("button", {
    name: "Assigned to me",
    exact: true,
  });
  const filtersButton = page.getByRole("button", {
    name: "Filter cards",
    exact: true,
  });
  await assignedToMeButton.click();
  await expect(assignedToMeButton).toHaveAttribute("aria-pressed", "true");
  // The one Filters control counts every active dimension, label or assignee.
  await expect(filtersButton).toHaveText("Filters · 1");

  await page.setViewportSize({ width: 375, height: 667 });

  const searchInput = page.getByPlaceholder("Search cards…").first();
  await searchInput.fill("Alpha");
  await expect(page.getByText("1 of 1 cards", { exact: true })).toBeVisible();
  const clearFiltersButton = page.getByRole("button", { name: "Clear filters" });
  await expect(clearFiltersButton).toBeVisible();

  try {
    // Deterministically close the open WebSocket and set offline to stay in reconnecting status without delays.
    await page.context().setOffline(true);
    await page.evaluate(() => {
      const sockets = window.__foxbanSockets ?? [];
      for (const socket of sockets) {
        socket.close();
      }
    });

    const reconnectingStatus = page.getByText("reconnecting…");
    await expect(reconnectingStatus).toBeVisible();
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBe(clientWidth);

    // Global destinations remain reachable through the compact navigation.
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const boardsLink = page.getByRole("link", { name: "Boards" }).first();
    const titleHeading = page.getByRole("heading", { name: boardName });
    // One Filters control and one help control serve every width.
    const shortcutsButton = page.getByRole("button", { name: "Keyboard shortcuts" });
    await expect(filtersButton).toBeVisible();
    await expect(shortcutsButton).toBeVisible();

    await expect(boardsLink).toBeVisible();
    await page.getByRole("button", { name: "Close navigation", exact: true }).click();
    await expect(titleHeading).toBeVisible();
    await expect(searchInput).toBeVisible();
    await expect(reconnectingStatus).toBeVisible();
    await expect(assignedToMeButton).toBeVisible();
    await expect(clearFiltersButton).toBeVisible();

    // Clear filters clears both URL-backed dimensions without losing any control.
    await clearFiltersButton.click();
    await expect(searchInput).toHaveValue("");
    await expect(assignedToMeButton).toHaveAttribute("aria-pressed", "false");
    await expect(filtersButton).toHaveText("Filters");
    await expect(clearFiltersButton).toHaveCount(0);
    // The unfiltered count is redundant on a phone, so it is hidden there —
    // the element stays in the layout for the desktop readout.
    await expect(page.getByText("of 1 cards")).toBeHidden();
  } finally {
    // Restore context network state; socket reconnection behavior is isolated and covered elsewhere.
    await page.context().setOffline(false);
  }
});

test("at 580px the board keeps one navigation surface and its account menu in view", async ({
  page,
}) => {
  await signup(page, uniqueEmail("board-580"), "Narrow Shell User");
  const boardName = `Narrow Shell ${Date.now()}`;
  const boardKey = await createBoard(page, boardName);
  await page.goto(`/board/${boardKey}`);
  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();

  // The board switches to its banner below 600px, so the desktop sidebar goes
  // with it and the banner exposes navigation through one disclosure.
  await page.setViewportSize({ width: 580, height: 800 });
  await expect(page.locator(".board-app-shell .boards-sidebar")).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeHidden();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Account navigation" })).toBeVisible();
  // The drawer sits inside the screen and leaves no horizontal scroll.
  const drawerBox = await page.getByRole("dialog", { name: "Navigation" }).boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox!.x).toBeGreaterThanOrEqual(0);
  expect(drawerBox!.x + drawerBox!.width).toBeLessThanOrEqual(580);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.keyboard.press("Escape");

  // The board still reads as one page, with no duplicate navigation above it.
  const boardHeading = page.getByRole("heading", { name: boardName, exact: true });
  const headingBox = await boardHeading.boundingBox();
  expect(headingBox).not.toBeNull();
  expect(headingBox!.y).toBeLessThan(300);

  // The account menu opens inside the viewport from the banner trigger.
  const account = page.getByRole("button", { name: "Your account" }).filter({ visible: true });
  await account.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(580);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test("mobile touch: Filter cards sheet combines label and assignee filters, updates URL, restores focus on Escape, and stays within viewport", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: mobileViewport,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  await signup(page, uniqueEmail("mobile-filters"), "Filter Mobile User");
  const boardName = `Mobile Filter Board ${Date.now()}`;
  const boardKey = await createBoard(page, boardName);
  await page.goto(`/board/${boardKey}`);

  await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(page, "Backlog");
  await addCard(page, "Backlog", "Card Alpha");
  await addCard(page, "Backlog", "Card Beta");

  // Setup: Add "Bug" label to Card Alpha and assign to user; leave Card Beta unassigned/unlabeled
  const backlogCol = columnByTitle(page, "Backlog");
  await cardIn(backlogCol, "Card Alpha").click();
  const cardDialog = page.getByRole("dialog", { name: "Card Alpha" });
  await expect(cardDialog).toBeVisible();

  // Assign to user
  await cardDialog.getByRole("button", { name: "Assignee" }).click();
  await cardDialog.getByRole("option", { name: "Filter Mobile User", exact: true }).click();

  // Add label "Bug" using real label UX
  await cardDialog.getByRole("button", { name: "+ Add label…" }).click();
  await cardDialog.getByRole("button", { name: "Create label", exact: true }).click();
  await cardDialog.getByLabel("New label name").fill("Bug");
  await cardDialog.getByLabel("New label name").press("Enter");
  await expect(cardDialog.getByLabel("Remove label Bug")).toBeVisible();
  await cardDialog.getByRole("button", { name: "Done", exact: true }).click();
  await cardDialog.getByRole("button", { name: "Close card" }).click();
  await expect(cardDialog).toHaveCount(0);

  // On mobile header, "Filters" button trigger opens the Filter cards sheet
  const filtersTrigger = page.getByRole("button", { name: "Filter cards" });
  await expect(filtersTrigger).toBeVisible();
  await filtersTrigger.click();

  // Verify sheet dialog opens with role="dialog", aria-modal="true", and name "Filter cards"
  const filterSheet = page.getByRole("dialog", { name: "Filter cards" });
  await expect(filterSheet).toBeVisible();
  await expect(filterSheet).toHaveAttribute("aria-modal", "true");

  // Verify filter sheet edges fit strictly inside 375x667 viewport
  const sheetBox = await filterSheet.boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(sheetBox!.x).toBeGreaterThanOrEqual(0);
  expect(sheetBox!.x + sheetBox!.width).toBeLessThanOrEqual(mobileViewport.width + 1);
  expect(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(mobileViewport.height + 1);

    // Select label "Bug" and assignee "Filter Mobile User" via button accessible names in the mobile sheet
    const bugButton = filterSheet.getByRole("button", { name: "Filter by label Bug" });
    await expect(bugButton).toBeVisible();
    await bugButton.click();

    const userButton = filterSheet.getByRole("button", { name: /Filter Mobile User/i });
    await expect(userButton).toBeVisible();
    await userButton.click();
    // Verify URL parameters reflect both selections using URL searchParams (tokens are IDs)
    await expect.poll(() => {
      const url = new URL(page.url());
      const labels = url.searchParams.get("labels");
      const assignees = url.searchParams.get("assignees");
      return Boolean(labels && labels.length > 0 && assignees && assignees.length > 0);
    }).toBe(true);
  // Close filter sheet via Escape
  await page.keyboard.press("Escape");
  await expect(filterSheet).toHaveCount(0);

  // Verify focus is restored to the Filters trigger
  await expect(filtersTrigger).toBeFocused();

  // Verify filtered result: Card Alpha is visible, Card Beta is hidden, matching count shows "1 of 2 cards"
  await expect(cardIn(backlogCol, "Card Alpha")).toBeVisible();
  await expect(cardIn(backlogCol, "Card Beta")).toHaveCount(0);
  await expect(page.getByText("1 of 2 cards", { exact: true })).toBeVisible();

  // Confirm document width equals client width (no horizontal body overflow)
  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  expect(overflow).toBe(false);

  await context.close();
});
