import { authTest as test, expect } from "./fixtures";
import { addCard, addColumn, cardBody, cardIn, columnByTitle, createBoard, expectLongNameContained } from "./helpers";

test("the phone top bar shows Home and a menu button on every page, with no inline link row", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const key = await createBoard(page, `Mobile pages ${Date.now()}`);
  for (const path of ["/", "/profile", "/mcp-server", `/board/${key}`]) {
    await page.goto(path);
    const bar = page.locator(".boards-mobile-banner");
    await expect(bar.getByRole("link", { name: "Home", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Your account", exact: true })).toBeVisible();
    // Closed, the navigation is not on the page: there is no tab row of links.
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Profile", exact: true }).filter({ visible: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  }
});

test("the phone drawer traps focus, closes on Escape, backdrop and a link, and returns focus to the menu button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = `Mobile drawer ${Date.now()}`;
  const key = await createBoard(page, name);
  await page.getByRole("link", { name, exact: true }).click();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "First task");
  const nav = page.getByRole("navigation", { name: "Main navigation", exact: true });
  const account = page.getByRole("navigation", { name: "Account navigation", exact: true });
  const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
  const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
  const firstCard = cardBody(cardIn(columnByTitle(page, "Todo"), "First task"));
  expect((await firstCard.boundingBox())!.y).toBeLessThan(380);

  await trigger.press("Enter");
  await expect(drawer).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "New workspace", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Boards(?: \d+)?$/ })).toBeVisible();
  await expect(account.getByRole("link", { name: "Profile", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

  // Focus starts inside the drawer and cycles inside it, in both directions.
  const inDrawer = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  expect(await inDrawer()).toBe(true);
  for (const direction of ["Tab", "Shift+Tab"]) {
    for (let step = 0; step < 30; step += 1) {
      await page.keyboard.press(direction);
      expect(await inDrawer()).toBe(true);
    }
  }
  // Board shortcuts do not fire behind it.
  await page.keyboard.press("n");
  await expect(page.getByRole("dialog")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  // The backdrop, which covers the rest of the screen, closes it too.
  await trigger.click();
  await expect(drawer).toBeVisible();
  await page.mouse.click(365, 500);
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  // So does its own close button.
  await trigger.click();
  await drawer.getByRole("button", { name: "Close navigation", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  // Following a link closes it and lands on the page.
  await trigger.click();
  await account.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page).toHaveURL("/profile");
  await expect(drawer).toBeHidden();
  await page.goto(`/board/${key}`);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("the phone drawer cuts a long workspace name with an ellipsis and keeps its plus and Boards count in view", async ({ page }) => {
  // The narrowest phone: the drawer is 86% of the screen there, too narrow for the longest name.
  await page.setViewportSize({ width: 320, height: 640 });
  const name = "Quarterly planning for the platform team";
  const created = await page.request.post("/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  const { workspace } = (await created.json()) as { workspace: { id: string } };
  await page.goto(`/w/${workspace.id}`);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();

  const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
  const nav = drawer.getByRole("navigation", { name: "Main navigation", exact: true });
  await expectLongNameContained(drawer, nav.locator('.workspace-row[data-expanded="true"] > span:last-child'), nav.getByRole("button", { name: "New workspace", exact: true }), nav.locator(".boards-nav-count"), name);
});

test("phone board controls fit at narrow widths and desktop navigation returns", async ({ page }) => {
  const name = `Header widths ${Date.now()}`;
  await createBoard(page, name);
  await page.getByRole("link", { name, exact: true }).click();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Check layout");

  for (const width of [320, 390, 600]) {
    await page.setViewportSize({ width, height: 844 });
    for (const label of ["New card", "Assigned to me", "Filter cards", "Archived cards", "Keyboard shortcuts"]) {
      const control = page.getByRole("button", { name: label, exact: true });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Home", exact: true }).filter({ visible: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeHidden();
  await expect(page.locator(".boards-sidebar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand navigation", exact: true })).toBeVisible();
});
