import { expect, test, type Browser, type Page } from "@playwright/test";
import { createBoard, expectLongNameContained, generateAccountInvite, inviteMember, personalWorkspaceRoute, signup, uniqueEmail } from "./helpers";

const sidebar = (page: Page) => page.locator(".boards-sidebar");
const main = (page: Page) => page.getByRole("navigation", { name: "Main navigation" }).filter({ visible: true });

/** Creates a workspace with the plus beside the Workspaces heading and returns the id it landed on. */
async function createWorkspace(page: Page, name: string): Promise<string> {
  const previousPath = new URL(page.url()).pathname;
  await sidebar(page).getByRole("button", { name: "New workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create workspace" });
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).not.toHaveURL(previousPath);
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
  return new URL(page.url()).pathname.replace("/w/", "");
}

/** A plain account an operator invited, in its own cookie jar. */
async function plainUser(browser: Browser, operator: Page, suffix: string, name: string) {
  // A fresh visit, so the invites page lists only the link this call issues.
  await operator.goto("/");
  const { token } = await generateAccountInvite(operator);
  const page = await (await browser.newContext()).newPage();
  const email = uniqueEmail(suffix, "user.test");
  await signup(page, email, name, token);
  const me = (await (await page.request.get("/me")).json()) as { id: string };
  return { page, email, id: me.id };
}

test("the sidebar lists every member workspace without a menu and expands only the route's workspace", async ({ browser, page }) => {
  // Another person's workspace with a board: an instance Admin may reach it as an
  // Operator, but it is not theirs to list.
  const stranger = await (await browser.newContext()).newPage();
  await signup(stranger, uniqueEmail("sidebar-stranger"), "Sidebar Stranger");
  const strangerName = `Stranger space ${Date.now()}`;
  await createWorkspace(stranger, strangerName);
  await createBoard(stranger, `Stranger board ${Date.now()}`);

  await signup(page, uniqueEmail("sidebar-member"), "Sidebar Member");
  const firstName = "Sidebar Member's workspace";
  const firstRoute = await personalWorkspaceRoute(page);
  const secondName = `Second space ${Date.now()}`;
  const secondId = await createWorkspace(page, secondName);

  // Home and Account pages: every member workspace is a row, nothing is expanded, no dropdown.
  for (const path of ["/", "/profile", "/mcp-server"]) {
    await page.goto(path);
    await expect(main(page).getByRole("link", { name: secondName, exact: true })).toHaveAttribute("href", `/w/${secondId}`);
    await expect(main(page).getByRole("link", { name: firstName, exact: true })).toHaveAttribute("href", firstRoute);
    await expect(main(page).getByRole("link", { name: strangerName })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Switch workspace/ })).toHaveCount(0);
    for (const link of ["Boards", "Members", "Settings"]) await expect(sidebar(page).getByRole("link", { name: link, exact: true })).toHaveCount(0);
  }
  await page.goto("/");
  await expect(sidebar(page).getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");

  // On a workspace's own pages only that workspace shows Boards, Members and Settings.
  await page.goto(`/w/${secondId}`);
  for (const link of ["Boards", "Members", "Settings"]) await expect(sidebar(page).getByRole("link", { name: new RegExp(`^${link}`) })).toHaveCount(1);
  await sidebar(page).getByRole("link", { name: "Members", exact: true }).click();
  await expect(page).toHaveURL(`/w/${secondId}/members`);
  await expect(sidebar(page).getByRole("link", { name: "Members", exact: true })).toHaveAttribute("aria-current", "page");

  // Another workspace's name opens its boards page and moves the expansion there.
  await sidebar(page).getByRole("link", { name: firstName, exact: true }).click();
  await expect(page).toHaveURL(firstRoute);
  await expect(sidebar(page).getByRole("link", { name: "Members", exact: true })).toHaveAttribute("href", `${firstRoute}/members`);
  await expect(sidebar(page).getByRole("link", { name: "Members", exact: true })).toHaveCount(1);
  await expect(main(page).getByRole("link", { name: secondName, exact: true })).toHaveAttribute("href", `/w/${secondId}`);

  // A board expands the workspace that owns it.
  await page.goto(`/w/${secondId}`);
  const boardKey = await createBoard(page, `Owned by second ${Date.now()}`);
  await page.goto(`/board/${boardKey}`);
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await expect(sidebar(page).getByRole("link", { name: "Members", exact: true })).toHaveAttribute("href", `/w/${secondId}/members`);
  await expect(sidebar(page).getByRole("link", { name: "Members", exact: true })).toHaveCount(1);
  await stranger.context().close();
});

test("a long workspace name is cut with an ellipsis and the expanded sidebar keeps its plus and Boards count on a board page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, uniqueEmail("sidebar-long"), "Sidebar Long Name Person");
  const name = "Sidebar Long Name Person's workspace";
  const boardKey = await createBoard(page, `Long name board ${Date.now()}`);
  await page.goto(`/board/${boardKey}`);
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();

  const heading = sidebar(page).locator('.workspace-row[data-expanded="true"] > span:last-child');
  await expectLongNameContained(sidebar(page), heading, sidebar(page).getByRole("button", { name: "New workspace", exact: true }), sidebar(page).locator(".boards-nav-count"), name);
  // The same page without a board, where the sidebar is always expanded, holds the same.
  await page.goto("/");
  const row = sidebar(page).getByRole("link", { name, exact: true }).locator("> span:last-child");
  await expect(row).toHaveAttribute("title", name);
  expect(await row.evaluate((element) => ({ cut: element.scrollWidth > element.clientWidth, overflow: getComputedStyle(element).textOverflow }))).toEqual({ cut: true, overflow: "ellipsis" });
});

test("the plus beside Workspaces creates a workspace and lands on its boards page", async ({ page }) => {
  await signup(page, uniqueEmail("sidebar-plus"), "Plus User");
  const name = `Plus space ${Date.now()}`;
  const id = await createWorkspace(page, name);
  // The route's workspace is the expanded one: its name is a heading row, not a link.
  await expect(sidebar(page).getByText(name, { exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", `/w/${id}/settings`);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("foxban-last-workspace")))).toEqual([]);
});

test("Settings is offered to workspace admins only, and a Guest's workspace is not listed", async ({ browser, page: owner }) => {
  await signup(owner, uniqueEmail("sidebar-owner"), "Sidebar Owner");
  const member = await plainUser(browser, owner, "sidebar-plain", "Plain Member");
  const guest = await plainUser(browser, owner, "sidebar-guest", "Plain Guest");
  const name = `Shared space ${Date.now()}`;
  const workspaceId = await createWorkspace(owner, name);
  const added = await owner.request.post(`/workspaces/${workspaceId}/members`, { data: { userId: member.id, role: "member", operationId: crypto.randomUUID() } });
  expect(added.ok()).toBe(true);
  const boardName = `Guest board ${Date.now()}`;
  const boardKey = await createBoard(owner, boardName);
  await inviteMember(owner, boardName, guest.email);

  await expect(sidebar(owner).getByRole("link", { name: "Settings", exact: true })).toBeVisible();

  await member.page.goto(`/w/${workspaceId}`);
  await expect(sidebar(member.page).getByRole("link", { name: "Members", exact: true })).toBeVisible();
  await expect(sidebar(member.page).getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);

  await guest.page.goto(`/board/${boardKey}`);
  await expect(guest.page.getByRole("heading", { name: boardName })).toBeVisible();
  await guest.page.getByRole("button", { name: "Expand navigation" }).click();
  await expect(sidebar(guest.page).getByRole("link", { name, exact: true })).toHaveCount(0);
  for (const link of ["Boards", "Members", "Settings"]) await expect(sidebar(guest.page).getByRole("link", { name: link, exact: true })).toHaveCount(0);
  await guest.page.goto("/");
  await expect(main(guest.page).getByRole("link", { name, exact: true })).toHaveCount(0);

  for (const user of [member, guest]) await user.page.context().close();
});

test("the sidebar is keyboard reachable and its landmarks are named for what they hold", async ({ page }) => {
  await signup(page, uniqueEmail("sidebar-keys"), "Keys User");
  const firstName = "Keys User's workspace";
  const firstRoute = await personalWorkspaceRoute(page);
  const name = `Keys space ${Date.now()}`;
  const id = await createWorkspace(page, name);
  await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toHaveCount(0);
  await expect(main(page)).toBeVisible();
  const account = page.getByRole("navigation", { name: "Account navigation" }).filter({ visible: true });
  for (const link of ["Profile", "MCP server", "Account invites", "GitHub"]) await expect(account.getByRole("link", { name: link, exact: true })).toBeVisible();

  // Tab order runs Home, the plus, then each workspace row; the open workspace's sub-links follow its name.
  await main(page).getByRole("link", { name: "Home", exact: true }).focus();
  const reached: string[] = [];
  for (let step = 0; step < 8 && !(reached.some((label) => label.includes(firstName)) && reached.some((label) => label.startsWith("Boards"))); step += 1) {
    await page.keyboard.press("Tab");
    reached.push((await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "")).trim());
  }
  expect(reached[0]).toBe("New workspace");
  expect(reached.some((label) => label.startsWith("Boards"))).toBe(true);
  expect(reached.some((label) => label.includes(firstName))).toBe(true);
  await page.getByRole("link", { name: firstName, exact: true }).filter({ visible: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(firstRoute);
  expect(id).not.toBe("");
});

test("the board rail is 64px with Home and one named tile per workspace, and expands to the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signup(page, uniqueEmail("rail-tiles"), "Rail User");
  const firstName = "Rail User's workspace";
  const firstRoute = await personalWorkspaceRoute(page);
  const secondName = `Rail space ${Date.now()}`;
  const secondId = await createWorkspace(page, secondName);
  const boardKey = await createBoard(page, `Rail board ${Date.now()}`);
  await page.goto(`/board/${boardKey}`);

  // Collapsed: 64px wide, Home and a tile per member workspace, no per-workspace sub-links.
  expect((await sidebar(page).boundingBox())!.width).toBe(64);
  await expect(main(page).getByRole("link", { name: "Home", exact: true })).toHaveAttribute("href", "/");
  const second = main(page).getByRole("link", { name: secondName, exact: true });
  const first = main(page).getByRole("link", { name: firstName, exact: true });
  await expect(second).toHaveAttribute("href", `/w/${secondId}`);
  await expect(first).toHaveAttribute("href", firstRoute);
  await expect(main(page).getByRole("link")).toHaveCount(3);
  await expect(second).toHaveAttribute("data-expanded", "true");
  await expect(first).not.toHaveAttribute("data-expanded", "true");
  await expect(second.locator(".workspace-initials")).toHaveText(secondName.slice(0, 2).toUpperCase());
  for (const link of ["Boards", "Members", "Settings"]) await expect(sidebar(page).getByRole("link", { name: link })).toHaveCount(0);

  // Expanded: the full sidebar, where the board's workspace is a heading row, not a link.
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  expect((await sidebar(page).boundingBox())!.width).toBeGreaterThan(150);
  await expect(sidebar(page).getByRole("link", { name: "Members", exact: true })).toHaveAttribute("href", `/w/${secondId}/members`);
  await expect(sidebar(page).getByRole("link", { name: secondName, exact: true })).toHaveCount(0);
  await expect(sidebar(page).getByText(secondName, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();

  // A tile opens its workspace's boards page.
  await second.click();
  await expect(page).toHaveURL(`/w/${secondId}`);
});
