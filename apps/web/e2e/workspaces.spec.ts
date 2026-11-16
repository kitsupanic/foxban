import { expect, test, type Browser, type Page } from "@playwright/test";
import { createBoard, generateAccountInvite, inviteMember, signup, uniqueEmail } from "./helpers";

/** Creates a workspace with the plus beside the Workspaces heading; resolves once its boards page is open. */
async function createWorkspaceFromSidebar(page: Page, name: string): Promise<string> {
  await page.locator(".boards-sidebar").getByRole("button", { name: "New workspace", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create workspace" });
  await create.getByLabel("Workspace name").fill(name);
  // Creating lands on the new workspace, but this page is not evidence of that:
  // another workspace's boards page shows the same heading.
  const previousPath = new URL(page.url()).pathname;
  await create.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).not.toHaveURL(previousPath);
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
  return new URL(page.url()).pathname.replace("/w/", "");
}

test("creates a workspace, creates a board, and moves between workspaces in the sidebar", async ({ page }) => {
  await signup(page, uniqueEmail("workspace-switch"), "Workspace Owner");
  const workspaceAId = await createWorkspaceFromSidebar(page, "Workspace A");
  const boardKey = await createBoard(page, "Workspace A board");

  await createWorkspaceFromSidebar(page, "Workspace B");
  await expect(page.getByRole("link", { name: "Workspace A board" })).toHaveCount(0);

  // Workspace names are not unique, so go back to the one this test created by id.
  await page.locator(`.boards-sidebar a[href="/w/${workspaceAId}"]`).click();
  await expect(page).toHaveURL(`/w/${workspaceAId}`);
  await expect(page.getByRole("link", { name: "Workspace A board" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: "Workspace A board" })).toBeVisible();
  await page.goto(`/board/${boardKey}`);
  await expect(page.getByRole("heading", { name: "Workspace A board" })).toBeVisible();
});

test("workspace pages stay usable at narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await signup(page, uniqueEmail("workspace-mobile"));
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 320);
  await expect(page.getByRole("link", { name: "Home", exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("button", { name: "New workspace", exact: true }).filter({ visible: true })).toBeVisible();
});

async function newUserPage(browser: Browser, suffix: string, name: string, invite?: string) {
  const page = await (await browser.newContext()).newPage();
  // An @admin.test account is a configured operator; a guest must be an
  // ordinary account, which needs an account invite to register.
  const email = invite ? uniqueEmail(suffix, "user.test") : uniqueEmail(suffix);
  await signup(page, email, name, invite);
  return { page, email };
}

test("a board expands its own workspace in the sidebar, and a board-only grant stays a guest", async ({ browser }) => {
  const owner = await newUserPage(browser, "board-ws-owner", "Board Owner");
  const { token } = await generateAccountInvite(owner.page);
  const guest = await newUserPage(browser, "board-ws-guest", "Board Guest", token);
  expect(await (await guest.page.request.get("/me")).json()).toMatchObject({ isAdmin: false });

  const workspaceId = await createWorkspaceFromSidebar(owner.page, "Owned workspace");
  const boardName = `Owned board ${Date.now()}`;
  const boardKey = await createBoard(owner.page, boardName);
  await inviteMember(owner.page, boardName, guest.email);

  await owner.page.goto(`/board/${boardKey}`);
  await expect(owner.page.getByRole("heading", { name: boardName })).toBeVisible();
  await owner.page.getByRole("button", { name: "Expand navigation" }).click();
  const ownerSidebar = owner.page.locator(".boards-sidebar");
  await expect(ownerSidebar.getByText("Owned workspace", { exact: true })).toBeVisible();
  await expect(ownerSidebar.getByRole("link", { name: "Members", exact: true })).toHaveAttribute("href", `/w/${workspaceId}/members`);
  await ownerSidebar.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(owner.page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();

  // The guest's board is open, but its workspace is not theirs to list or manage.
  await guest.page.goto(`/board/${boardKey}`);
  await expect(guest.page.getByRole("heading", { name: boardName })).toBeVisible();
  await guest.page.getByRole("button", { name: "Expand navigation" }).click();
  const guestSidebar = guest.page.locator(".boards-sidebar");
  await expect(guestSidebar.getByText("Owned workspace", { exact: true })).toHaveCount(0);
  await expect(guestSidebar.getByRole("link", { name: "Members", exact: true })).toHaveCount(0);
  await expect(guestSidebar.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);

  await owner.page.context().close();
  await guest.page.context().close();
});
