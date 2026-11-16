import { authTest as test, expect, type Page } from "./fixtures";
import { createBoard } from "./helpers";

async function openBoard(page: Page, suffix: string) {
  const name = `Navigation ${suffix} ${Date.now()}`;
  const key = await createBoard(page, name);
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return key;
}

/** Tabs forward until the focused control's accessible text starts with `text`. */
async function tabTo(page: Page, text: string, limit = 25): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "").trim());
    // A row's text starts with its aria-hidden initials tile, so match anywhere.
    if (label.includes(text)) return;
  }
  throw new Error(`Tab never reached a control starting with "${text}"`);
}

test("collapsed navigation explains icons on hover and focus without duplicating expanded labels", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBoard(page, "labels");
  const sidebar = page.locator(".boards-sidebar");
  // A workspace tile's hint is the workspace name; its Boards/Members/Settings links live in the full sidebar.
  const workspaceName = (await sidebar.locator('a[data-expanded="true"] .app-navigation-label').textContent())!.trim();
  const labels = ["Home", workspaceName, "Profile", "MCP server", "Account invites"];
  for (const label of labels) {
    const link = sidebar.getByRole("link", { name: label, exact: true });
    await link.hover();
    const tooltip = page.getByRole("tooltip").filter({ hasText: new RegExp(`^${label}$`) });
    await expect(tooltip).toBeVisible();
    // The hint remains readable when the pointer leaves its icon for the hint.
    await tooltip.hover();
    await expect(tooltip).toBeVisible();
    await page.mouse.move(500, 400);
    await expect(page.getByRole("tooltip").filter({ hasText: new RegExp(`^${label}$`) })).toBeHidden();
  }
  for (const [button, label] of [
    [sidebar.getByRole("button", { name: "New workspace", exact: true }), "New workspace"],
    [sidebar.getByRole("button", { name: "Your account", exact: true }), "Your account"],
  ] as const) {
    await button.hover();
    await expect(page.getByRole("tooltip").filter({ hasText: label })).toBeVisible();
    await page.mouse.move(500, 400);
  }
  const tile = sidebar.getByRole("link", { name: workspaceName, exact: true });
  await tile.focus();
  await expect(page.getByRole("tooltip").filter({ hasText: workspaceName })).toBeVisible();
  const boardUrl = page.url();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip").filter({ hasText: workspaceName })).toBeHidden();
  await expect(tile).toBeFocused();
  expect(page.url()).toBe(boardUrl);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  const members = sidebar.getByRole("link", { name: "Members", exact: true });
  await members.hover();
  await expect(members).toContainText("Members");
  await expect(page.getByRole("tooltip").filter({ hasText: /^Members$/ })).toHaveCount(0);
});

test("workspace rows and the plus work from the keyboard, and a new workspace opens its boards page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const key = await openBoard(page, "workspace keys");
  const targetName = `Qnav ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  const sidebar = page.locator(".boards-sidebar");
  await sidebar.getByRole("button", { name: "New workspace", exact: true }).focus();
  await page.keyboard.press("Enter");
  const create = page.getByRole("dialog", { name: "Create workspace", exact: true });
  await create.getByLabel("Workspace name").fill(targetName);
  await create.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/(?!personal_)[^/]+$/);
  const targetPath = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();

  // Back on the board, the new workspace is a row the keyboard reaches and opens.
  await page.goto(`/board/${key}`);
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  await sidebar.getByRole("button", { name: "New workspace", exact: true }).focus();
  await tabTo(page, targetName);
  await expect(sidebar.getByRole("link", { name: targetName, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(targetPath);
  // The route now names that workspace, so it is the expanded one.
  await expect(sidebar.getByRole("link", { name: "Members", exact: true })).toHaveAttribute("href", `${targetPath}/members`);
  await expect(sidebar.getByRole("link", { name: targetName, exact: true })).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("the phone navigation lists workspaces, returns focus on Escape and stays inside the screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await openBoard(page, "mobile keys");
  const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
  await trigger.press("Enter");
  const nav = page.getByRole("navigation", { name: "Main navigation", exact: true });
  await expect(nav.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "New workspace", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Boards(?: \d+)?$/ })).toBeVisible();
  // Every member workspace is a row, with the board's own expanded.
  await expect(nav.locator(".workspace-row").first()).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("account menu exposes its relationship and shares keyboard navigation", async ({ page }) => {
  await openBoard(page, "account keys");
  const trigger = page.getByRole("button", { name: "Your account", exact: true }).filter({ visible: true });
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  // A pointer hint elsewhere must not consume Escape intended for this menu.
  await page.getByRole("button", { name: "Expand navigation", exact: true }).hover();
  await expect(page.getByRole("tooltip").filter({ hasText: /^Expand navigation$/ })).toBeVisible();
  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const id = await trigger.getAttribute("aria-controls");
  expect(id).toBeTruthy();
  const menu = page.locator(`[id="${id}"]`);
  await expect(menu).toHaveAttribute("role", "menu");
  const items = menu.getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.press("ArrowDown");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await trigger.press("ArrowUp");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/profile");
  await expect(page.getByRole("menu")).toHaveCount(0);
});
