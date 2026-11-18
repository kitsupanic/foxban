import { expect, test, type Browser, type Page } from "@playwright/test";
import { createBoard, generateAccountInvite, inviteMember, personalWorkspaceRoute, signup, uniqueEmail } from "./helpers";

type WorkspaceRow = { id: string; name: string; access: string };

async function workspaces(page: Page): Promise<WorkspaceRow[]> {
  const body = (await (await page.request.get("/workspaces")).json()) as { workspaces: WorkspaceRow[] };
  return body.workspaces;
}

async function personalWorkspaceName(page: Page): Promise<string> {
  const id = (await personalWorkspaceRoute(page)).replace("/w/", "");
  const found = (await workspaces(page)).find((item) => item.id === id);
  if (!found) throw new Error("no personal workspace");
  return found.name;
}

/** Signs up a plain (non-operator) user, which needs an account invite from an operator. */
async function plainUser(browser: Browser, operator: Page, suffix: string): Promise<{ page: Page; email: string }> {
  const { token } = await generateAccountInvite(operator);
  const page = await (await browser.newContext()).newPage();
  const email = uniqueEmail(suffix, "user.test");
  await signup(page, email, "Plain User", token);
  return { page, email };
}

const homeHeading = (page: Page) => page.getByRole("heading", { name: "Home", exact: true });

test("Home groups a member's boards by workspace and creates boards where it is clicked", async ({ browser, page }) => {
  const stranger = await (await browser.newContext()).newPage();
  await signup(stranger, uniqueEmail("home-stranger"), "Stranger");
  const strangerBoard = `Stranger board ${Date.now()}`;
  await createBoard(stranger, strangerBoard);

  await signup(page, uniqueEmail("home-member"), "Home Member");
  const personalName = await personalWorkspaceName(page);
  const personalBoard = `Personal board ${Date.now()}`;
  await createBoard(page, personalBoard);

  await page.getByRole("button", { name: "New workspace", exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create workspace" });
  await dialog.getByLabel("Workspace name").fill("Second workspace");
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/w\/(?!personal_)[^/]+$/);
  const secondId = new URL(page.url()).pathname.replace("/w/", "");
  const secondBoard = `Second board ${Date.now()}`;
  await createBoard(page, secondBoard);

  await page.goto("/");
  await expect(homeHeading(page)).toBeVisible();
  await expect(page).toHaveURL("/");
  const personal = page.getByRole("region", { name: personalName });
  const second = page.getByRole("region", { name: "Second workspace" });
  await expect(personal.getByRole("link", { name: personalBoard })).toBeVisible();
  await expect(second.getByRole("link", { name: secondBoard })).toBeVisible();
  await expect(personal.getByRole("link", { name: secondBoard })).toHaveCount(0);
  await expect(second.getByRole("link", { name: personalBoard })).toHaveCount(0);
  await expect(second.getByRole("link", { name: "Second workspace" })).toHaveAttribute("href", `/w/${secondId}`);
  await expect(personal.getByRole("link", { name: personalName, exact: true })).toHaveAttribute("href", await personalWorkspaceRoute(page));
  // Each board says who can open it, and no Guest heading appears without guest boards.
  await expect(second.getByRole("listitem").filter({ hasText: secondBoard }).locator(".board-access-label")).toHaveText("Workspace");
  await expect(page.getByRole("region", { name: "Guest" })).toHaveCount(0);
  // An instance Admin's own Home never lists another person's workspace or boards.
  await expect(page.getByText(strangerBoard)).toHaveCount(0);

  // New board in a group creates the board in that workspace, not the other one.
  const created = `Created from Home ${Date.now()}`;
  await second.getByRole("button", { name: "New board" }).click();
  const create = page.getByRole("dialog", { name: "Create a board" });
  await create.getByLabel("Board name").fill(created);
  await create.getByLabel("Board key").fill(`H${Date.now().toString(36).toUpperCase().slice(-8)}`);
  await create.getByRole("button", { name: "Create board" }).click();
  await expect(create).toHaveCount(0);
  await expect(second.getByRole("link", { name: created })).toBeVisible();
  await expect(personal.getByRole("link", { name: created })).toHaveCount(0);
  await expect(page).toHaveURL("/");

  // Same on a phone: still Home, still no redirect.
  await page.setViewportSize({ width: 375, height: 667 });
  await page.reload();
  await expect(homeHeading(page)).toBeVisible();
  await expect(page).toHaveURL("/");
});

test("Home lists boards shared by explicit grant under Guest, with their workspace name", async ({ browser, page: owner }) => {
  await signup(owner, uniqueEmail("home-guest-owner"), "Guest Owner");
  const ownerWorkspace = await personalWorkspaceName(owner);
  const boardName = `Shared board ${Date.now()}`;
  await createBoard(owner, boardName);
  const guest = await plainUser(browser, owner, "home-guest");
  await owner.goto(await personalWorkspaceRoute(owner));
  await inviteMember(owner, boardName, guest.email);

  await guest.page.goto("/");
  await expect(homeHeading(guest.page)).toBeVisible();
  const guestSection = guest.page.getByRole("region", { name: "Guest" });
  await expect(guestSection.getByRole("link", { name: boardName })).toBeVisible();
  await expect(guestSection.getByRole("listitem").filter({ hasText: boardName })).toContainText(ownerWorkspace);
  // The guest does not belong to that workspace: no group linking to it and no New board for it.
  // (The owner's first workspace is found by its route, not by name.)
  await expect(guest.page.locator(`a[href="${await personalWorkspaceRoute(owner)}"]`)).toHaveCount(0);
  await expect(guestSection.getByRole("button", { name: "New board" })).toHaveCount(0);
  // Their own workspace is a normal group, and the shared board is not in it.
  const own = (await workspaces(guest.page)).find((item) => item.access === "member");
  if (!own) throw new Error("guest has no workspace");
  await expect(guest.page.getByRole("region", { name: own.name, exact: true }).getByRole("link", { name: boardName })).toHaveCount(0);
  await expect(guest.page.getByRole("region", { name: own.name, exact: true }).getByRole("link", { name: own.name, exact: true })).toHaveAttribute("href", `/w/${own.id}`);
});

test("Home offers Create workspace to a person with no workspaces", async ({ page }) => {
  await signup(page, uniqueEmail("home-none"), "No Workspaces");
  await page.route("**/workspaces", (route) => route.fulfill({ json: { workspaces: [] } }));
  await page.route("**/boards", (route) => route.fulfill({ json: { boards: [] } }));
  await page.goto("/");
  await expect(homeHeading(page)).toBeVisible();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("No workspaces yet.")).toBeVisible();
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("dialog", { name: "Create workspace" })).toBeVisible();
});

test("Board access reads Workspace and Private, each with who can open the board", async ({ page }) => {
  await signup(page, uniqueEmail("home-access"), "Access Reader");
  const route = await personalWorkspaceRoute(page);
  const privateBoard = `Private board ${Date.now()}`;
  await page.goto(route);
  await page.getByRole("button", { name: "New board" }).click();
  const create = page.getByRole("dialog", { name: "Create a board" });
  await create.getByLabel("Board name").fill(privateBoard);
  await create.getByLabel("Board key").fill(`P${Date.now().toString(36).toUpperCase().slice(-8)}`);
  const access = create.getByLabel("Board access");
  await expect(access.locator("option")).toHaveText([
    "Workspace: every workspace member can open it",
    "Private: only board members and workspace admins can open it",
  ]);
  await access.selectOption({ label: "Private: only board members and workspace admins can open it" });
  await create.getByRole("button", { name: "Create board" }).click();
  await expect(create).toHaveCount(0);
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: privateBoard }) });
  await expect(row.locator(".board-access-label")).toHaveText("Private");
  await expect(row.locator(".board-access-label")).toHaveAttribute("title", "Private: only board members and workspace admins can open it");

  // Moving a board makes it Private; the dialog says so in the same words.
  await page.getByRole("button", { name: "New workspace", exact: true }).filter({ visible: true }).click();
  const newWorkspace = page.getByRole("dialog", { name: "Create workspace" });
  await newWorkspace.getByLabel("Workspace name").fill("Destination");
  await newWorkspace.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/w\/(?!personal_)[^/]+$/);
  await page.goto(route);
  await row.getByRole("button", { name: `Board settings for ${privateBoard}` }).click();
  await row.getByRole("menuitem", { name: "Move workspace" }).click();
  const move = page.getByRole("dialog", { name: `Move ${privateBoard}` });
  await move.getByLabel("Destination workspace").selectOption({ label: "Destination" });
  await expect(move).toContainText("The board becomes Private in its destination: only board members and workspace admins can open it.");
  await move.getByRole("button", { name: "Cancel" }).click();

  // The workspace default offers the same two choices.
  await page.goto(`${route}/settings`);
  const defaultAccess = page.getByLabel("Default access for new boards");
  await expect(defaultAccess.locator("option")).toHaveText([
    "Workspace: every workspace member can open it",
    "Private: only board members and workspace admins can open it",
  ]);
  await expect(page.locator("body")).not.toContainText("Restricted");
});
