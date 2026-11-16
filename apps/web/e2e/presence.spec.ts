import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  generateAccountInvite,
  inviteMember,
  openBoardList,
  PASSWORD,
  signup,
  uniqueEmail,
} from "./helpers";
/** A signed-up user in its own browser context (own cookie jar). */
async function newUser(
  browser: Browser,
  suffix: string,
  name?: string,
): Promise<{ page: Page; email: string; name: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail(suffix);
  const displayName = name ?? suffix;
  await signup(page, email, displayName);
  return { page, email, name: displayName };
}

test("desktop presence rail displays online members, configured timezone local time, and transitions offline on close and back on reopen", async ({
  browser,
}) => {
  // Alice is in UTC, Bob is in America/New_York
  const alice = await newUser(browser, "presence-alice", "Alice Presence");
  const bob = await newUser(browser, "presence-bob", "Bob Presence");

  // Alice sets timezone to Europe/London on Profile
  await alice.page.getByRole("link", { name: "Profile", exact: true }).click();
  const aliceTzSection = alice.page
    .locator("section")
    .filter({ has: alice.page.getByRole("heading", { name: "Preferences" }) });
  await aliceTzSection.getByRole("button", { name: "Timezone" }).click();
  const aliceTzSearch = alice.page.getByRole("combobox", { name: "Search timezones" });
  await aliceTzSearch.fill("Europe/London");
  await alice.page.getByRole("option", { name: "Europe/London" }).click();
  await aliceTzSection.getByRole("button", { name: "Save" }).click();
  await expect(aliceTzSection.getByRole("status")).toHaveText("Timezone updated.");

  // Alice stays on Boards page
  await openBoardList(alice.page);
  await expect(alice.page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();

  // Bob creates a shared board and invites Alice
  const boardName = `Presence Board ${Date.now()}`;
  const boardId = await createBoard(bob.page, boardName);
  await inviteMember(bob.page, boardName, alice.email);

  // Bob navigates to the shared board
  await bob.page.goto(`/board/${boardId}`);
  await expect(bob.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();

  // The rail starts hidden: Members is the control that shows it.
  const desktopRail = bob.page.getByRole("complementary", { name: "Board members" });
  await expect(desktopRail).toBeHidden();
  const desktopToggle = bob.page.getByRole("button", { name: "Show board members" });
  await expect(desktopToggle).toBeVisible();
  await expect(desktopToggle).toHaveAttribute("aria-expanded", "false");
  await desktopToggle.click();
  await expect(desktopRail).toBeVisible();
  const openToggle = bob.page.getByRole("button", { name: "Hide board members" });
  await expect(openToggle).toHaveAttribute("aria-expanded", "true");
  // Bob sees Alice "Online" even though Alice is on the Boards page, not viewing this board
  const aliceRow = desktopRail.getByRole("listitem").filter({ hasText: "Alice Presence" });
  await expect(aliceRow).toBeVisible();
  await expect(aliceRow.getByText("Online", { exact: true })).toBeVisible();

  // Bob also sees himself "Online"
  const bobRow = desktopRail.getByRole("listitem").filter({ hasText: "Bob Presence" });
  await expect(bobRow).toBeVisible();
  await expect(bobRow.getByText("Online", { exact: true })).toBeVisible();

  // Bob sees Alice's local time based on her configured Europe/London timezone
  const now = new Date();
  const expectedAliceTime = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(now);
  await expect(aliceRow.getByText(expectedAliceTime)).toBeVisible();

  // Alice closes her final browser context (simulates closing all tabs)
  await alice.page.context().close();

  // Bob's rail shows Alice offline with "Last online just now" without reloading Bob's page
  await expect(aliceRow.getByText("Last online just now")).toBeVisible();
  await expect(aliceRow.getByText("Online", { exact: true })).toHaveCount(0);

  // Alice reopens in a new context, signs back in, and presence updates live without reload
  const aliceReopenedContext = await browser.newContext();
  const aliceReopenedPage = await aliceReopenedContext.newPage();
  await aliceReopenedPage.goto("/login");
  await aliceReopenedPage.getByLabel("Email").fill(alice.email);
  await aliceReopenedPage.getByLabel("Password").fill(PASSWORD);
  await aliceReopenedPage.getByRole("button", { name: "Sign in" }).click();

  // Bob's rail shows Alice back online live
  await expect(aliceRow.getByText("Online", { exact: true })).toBeVisible();
  await expect(aliceRow.getByText("Last online just now")).toHaveCount(0);

  // Verify desktop rail toggle: hide rail, reclaim width, persist via reload, show restores rail
  const kanbanViewport = bob.page.locator(".board-canvas");
  const widthWithRail = await kanbanViewport.evaluate((el) => el.getBoundingClientRect().width);

  // Click toggle hides rail and reclaims width for Kanban
  await openToggle.click();
  await expect(desktopRail).toBeHidden();
  const desktopToggleHidden = bob.page.getByRole("button", { name: "Show board members" });
  await expect(desktopToggleHidden).toBeVisible();
  await expect(desktopToggleHidden).toHaveAttribute("aria-expanded", "false");
  await expect(desktopToggleHidden).toHaveAttribute("aria-label", "Show board members");
  const widthWithoutRail = await kanbanViewport.evaluate((el) => el.getBoundingClientRect().width);
  expect(widthWithoutRail).toBeGreaterThan(widthWithRail);

  // Reload preserves hidden state via localStorage
  await bob.page.reload();
  await expect(bob.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await expect(desktopRail).toBeHidden();
  const desktopToggleAfterReload = bob.page.getByRole("button", { name: "Show board members" });
  await expect(desktopToggleAfterReload).toBeVisible();
  await expect(desktopToggleAfterReload).toHaveAttribute("aria-expanded", "false");

  // Click show restores the rail
  await desktopToggleAfterReload.click();
  await expect(desktopRail).toBeVisible();
  const desktopToggleRestored = bob.page.getByRole("button", { name: "Hide board members" });
  await expect(desktopToggleRestored).toBeVisible();
  await expect(desktopToggleRestored).toHaveAttribute("aria-expanded", "true");
  await expect(desktopToggleRestored).toHaveAttribute("aria-label", "Hide board members");
  const widthRestored = await kanbanViewport.evaluate((el) => el.getBoundingClientRect().width);
  expect(widthRestored).toBeLessThan(widthWithoutRail);
  await aliceReopenedContext.close();
  await bob.page.context().close();
});

test("mobile viewport at 375px has no fixed rail, provides accessible modal drawer with focus restore, and suppresses board shortcuts", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await context.newPage();
  const email = uniqueEmail("presence-mobile");
  await signup(page, email, "Mobile User");

  const boardName = `Mobile Board ${Date.now()}`;
  const boardId = await createBoard(page, boardName);
  await page.goto(`/board/${boardId}`);
  await expect(page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await addColumn(page, "Todo");

  // 1. Desktop rail is hidden at 375px
  const desktopRail = page.getByRole("complementary", { name: "Board members" });
  await expect(desktopRail).toBeHidden();

  // 2. Members trigger button is visible in the header
  const membersTrigger = page.getByRole("button", { name: /^Members/ });
  await expect(membersTrigger).toBeVisible();
  await expect(membersTrigger).toHaveAttribute("aria-haspopup", "dialog");
  await expect(membersTrigger).toHaveAttribute("aria-expanded", "false");

  // 3. Click trigger opens drawer dialog and initially focuses close button
  await membersTrigger.click();
  await expect(membersTrigger).toHaveAttribute("aria-expanded", "true");

  const drawerDialog = page.getByRole("dialog", { name: "Board members" });
  await expect(drawerDialog).toBeVisible();
  await expect(drawerDialog).toHaveAttribute("aria-modal", "true");

  const closeButton = drawerDialog.getByRole("button", { name: "Close board members" });
  await expect(closeButton).toBeFocused();

  // 4. Board shortcuts are suppressed while the drawer is open
  await page.keyboard.press("n");
  // No create dialog appears at all while the drawer owns the keyboard.
  await expect(page.getByRole("dialog", { name: "Create a card" })).toHaveCount(0);
  // 5. Escape closes the drawer and restores focus to the trigger
  await page.keyboard.press("Escape");
  await expect(drawerDialog).toHaveCount(0);
  await expect(membersTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(membersTrigger).toBeFocused();

  // 6. Viewport resize to >=md (desktop) closes drawer, and the same control becomes the rail toggle
  await membersTrigger.click();
  await expect(drawerDialog).toBeVisible();
  await expect(page.locator(".boards-shell[inert]")).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(drawerDialog).toBeHidden();
  await expect(page.locator(".boards-shell[inert]")).toHaveCount(0);
  const railToggle = page.getByRole("button", { name: "Show board members" });
  await expect(railToggle).toBeVisible();
  await railToggle.click();
  await expect(desktopRail).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide board members" })).toBeFocused();

  // Board shortcuts are usable again on desktop
  await page.keyboard.press("n");
  const createDialog = page.getByRole("dialog", { name: "Create a card" });
  await expect(createDialog.getByLabel("Title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createDialog).toHaveCount(0);

  // 7. Mobile drawer open then route/history navigation restores a valid ?card=<key> URL
  // Assert drawer closes, exactly one card dialog remains, and Escape/focus behavior is coherent
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(desktopRail).toBeHidden();

  await addCard(page, "Todo", "Mobile Deep Link Card");
  const card = cardIn(columnByTitle(page, "Todo"), "Mobile Deep Link Card");
  await expect(card).toBeVisible();

  // Open the card to establish history entry with ?card=<key>
  await card.click();
  const cardModal = page.getByRole("dialog");
  await expect(cardModal).toHaveCount(1);
  const cardUrl = page.url();
  expect(cardUrl).toContain("card=");

  // Close the card dialog via Escape to return to board URL
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Open member drawer
  await membersTrigger.click();
  await expect(drawerDialog).toBeVisible();
  await expect(membersTrigger).toHaveAttribute("aria-expanded", "true");

  // Simulate same-document route-state restoration to the card URL while the drawer is open
  await page.evaluate((targetUrl) => {
    window.history.pushState(null, "", targetUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, cardUrl);
  await expect(page).toHaveURL(cardUrl);

  // Assert member drawer closed, its trigger ref cleared, and exactly one card dialog remains
  await expect(drawerDialog).toHaveCount(0);
  await expect(membersTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog")).toHaveCount(1);

  // Escape closes the card dialog cleanly without resurrecting drawer or broken focus
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await context.close();
});

test("owner and admin role pills appear in desktop rail and mobile drawer beside member names", async ({
  browser,
}) => {
  // Admin email creates board (so is both Owner and Admin)
  const adminOwner = await newUser(browser, "admin-owner", "Admin Owner");
  const { token } = await generateAccountInvite(adminOwner.page);
  const plainMemberContext = await browser.newContext();
  const plainMemberPage = await plainMemberContext.newPage();
  const plainMemberEmail = uniqueEmail("plain-member", "user.test");
  await signup(plainMemberPage, plainMemberEmail, "Plain Member", token);
  const plainMember = { page: plainMemberPage, email: plainMemberEmail, name: "Plain Member" };
  const boardName = `Roles Board ${Date.now()}`;
  const boardKey = await createBoard(adminOwner.page, boardName);
  await inviteMember(adminOwner.page, boardName, plainMember.email);

  await adminOwner.page.goto(`/board/${boardKey}`);
  await adminOwner.page.getByRole("button", { name: "Show board members" }).click();
  const desktopRail = adminOwner.page.getByRole("complementary", { name: "Board members" });
  await expect(desktopRail).toBeVisible();

  // Admin Owner row shows Owner pill and Admin pill
  const adminRow = desktopRail.getByRole("listitem").filter({ hasText: "Admin Owner" });
  await expect(adminRow.getByText("Owner", { exact: true })).toBeVisible();
  await expect(adminRow.getByText("Admin", { exact: true })).toBeVisible();

  // Plain member row shows neither Owner nor Admin
  const plainRow = desktopRail.getByRole("listitem").filter({ hasText: "Plain Member" });
  await expect(plainRow.getByText("Owner", { exact: true })).toHaveCount(0);
  await expect(plainRow.getByText("Admin", { exact: true })).toHaveCount(0);

  // Mobile viewport: resize page and open mobile drawer
  await adminOwner.page.setViewportSize({ width: 375, height: 667 });
  await adminOwner.page.getByRole("button", { name: /^Members( · \d+)?$/ }).click();
  const drawer = adminOwner.page.getByRole("dialog", { name: "Board members" });
  await expect(drawer).toBeVisible();

  const drawerAdminRow = drawer.getByRole("listitem").filter({ hasText: "Admin Owner" });
  await expect(drawerAdminRow.getByText("Owner", { exact: true })).toBeVisible();
  await expect(drawerAdminRow.getByText("Admin", { exact: true })).toBeVisible();

  await plainMemberContext.close();
  await adminOwner.page.context().close();
});

test("circuit breaker stops presence reconnects after 3 attempts with invalid presence snapshot", async ({
  browser,
}) => {
  const user = await newUser(browser, "presence-breaker", "Breaker User");
  const boardName = `Presence Breaker ${Date.now()}`;
  const boardKey = await createBoard(user.page, boardName);

  let presenceAttempts = 0;
  await user.page.routeWebSocket(/\/presence\/ws/, (ws) => {
    presenceAttempts += 1;
    // Send a tagged but schema-invalid frame so the socket opens, PresenceServerMessageSchema rejects it,
    // and client drops the socket before receiving a valid snapshot.
    ws.send(JSON.stringify({ type: "presence.snapshot", invalidField: true }));
  });
  await user.page.goto(`/board/${boardKey}`);
  await expect(user.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  // Wait for the circuit breaker to stop reconnecting after 3 consecutive failures
  await expect.poll(() => presenceAttempts, { timeout: 15_000 }).toBe(3);
  await user.page.waitForTimeout(4_000);
  expect(presenceAttempts).toBe(3);
  await expect(user.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await expect(user.page.getByText("Could not connect.")).toHaveCount(0);
  await user.page.context().close();
});
