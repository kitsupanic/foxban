import { expect, test, type Browser, type Page } from "@playwright/test";
import { createBoard, generateAccountInvite, inviteMember, personalWorkspaceRoute, signup, uniqueEmail } from "./helpers";

const accountNav = (page: Page) => page.getByRole("navigation", { name: "Account navigation" }).filter({ visible: true });
const breadcrumb = (page: Page) => page.locator(".boards-breadcrumb");

/** A plain account an Admin invited, in its own cookie jar. */
async function plainUser(browser: Browser, operator: Page, suffix: string) {
  await operator.goto("/");
  const { token } = await generateAccountInvite(operator);
  const page = await (await browser.newContext()).newPage();
  const email = uniqueEmail(suffix, "user.test");
  await signup(page, email, "Plain User", token);
  return { page, email };
}

/** Signs up a second Admin (every address `uniqueEmail` hands out on `@admin.test` is one) with a workspace holding one board. */
async function adminWithBoard(browser: Browser, suffix: string) {
  const page = await (await browser.newContext()).newPage();
  const email = uniqueEmail(suffix);
  await signup(page, email, "Other Admin");
  const boardName = `Other board ${Date.now()}`;
  const boardKey = await createBoard(page, boardName);
  const workspaceId = (await personalWorkspaceRoute(page)).replace("/w/", "");
  return { page, email, boardName, boardKey, workspaceId };
}

test("an Admin finds every workspace on All workspaces and opens one as an Operator", async ({ browser, page }) => {
  const other = await adminWithBoard(browser, "all-other");
  await signup(page, uniqueEmail("all-admin"), "Operator Admin");
  const ownRoute = await personalWorkspaceRoute(page);

  // The Admin's own Home and sidebar hold only their own workspace: the other
  // person's workspace and board are not there.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page.locator(`a[href="/w/${other.workspaceId}"]`)).toHaveCount(0);
  await expect(page.getByText(other.boardName)).toHaveCount(0);

  await accountNav(page).getByRole("link", { name: "All workspaces", exact: true }).click();
  await expect(page).toHaveURL("/all-workspaces");
  await expect(page.getByRole("heading", { name: "All workspaces", exact: true })).toBeVisible();
  const list = page.getByRole("list", { name: "All workspaces" });
  await expect(list.locator(`a[href="${ownRoute}"]`)).toBeVisible();
  const row = list.getByRole("listitem").filter({ has: page.locator(`a[href="/w/${other.workspaceId}"]`) });
  await expect(row).toContainText("Created by Other Admin");
  await expect(row).toContainText("1 board");
  await expect(row).toContainText("Operator");

  // Opening it works and says so, and so does opening its board.
  await row.getByRole("link").first().click();
  await expect(page).toHaveURL(`/w/${other.workspaceId}`);
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
  await expect(breadcrumb(page).getByText("Operator", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: other.boardName }).click();
  await expect(page).toHaveURL(`/board/${other.boardKey}`);
  await expect(breadcrumb(page).getByText(other.boardName, { exact: true })).toBeVisible();
  await expect(breadcrumb(page).getByText("Operator", { exact: true })).toBeVisible();

  // Looking did not move it into the Admin's own lists, and their own pages carry no marker.
  await page.goto("/");
  await expect(page.locator(`a[href="/w/${other.workspaceId}"]`)).toHaveCount(0);
  await expect(page.getByText(other.boardName)).toHaveCount(0);
  await page.goto(ownRoute);
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
  await expect(breadcrumb(page).getByText("Operator", { exact: true })).toHaveCount(0);
});

test("a person who is not an Admin has no All workspaces link, is sent Home and is refused the data", async ({ browser, page: operator }) => {
  await signup(operator, uniqueEmail("all-gate"), "Gate Admin");
  const plain = await plainUser(browser, operator, "all-plain");

  await plain.page.goto("/");
  await expect(plain.page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(plain.page.getByRole("link", { name: "All workspaces" })).toHaveCount(0);
  await plain.page.goto("/all-workspaces");
  await expect(plain.page).toHaveURL("/");
  await expect(plain.page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  expect((await plain.page.request.get("/workspaces/all")).status()).toBe(403);
});

test("a Guest on a board is marked Guest, an Admin added to a board included", async ({ browser, page: owner }) => {
  await signup(owner, uniqueEmail("guest-owner"), "Guest Owner");
  const boardName = `Guest board ${Date.now()}`;
  const boardKey = await createBoard(owner, boardName);
  const guest = await plainUser(browser, owner, "guest-plain");
  const adminGuest = await adminWithBoard(browser, "guest-admin");
  await owner.goto(await personalWorkspaceRoute(owner));
  await inviteMember(owner, boardName, guest.email);
  await inviteMember(owner, boardName, adminGuest.email);

  for (const viewer of [guest.page, adminGuest.page]) {
    // The board is on their Home under Guest, from the server's own list.
    await viewer.goto("/");
    await expect(viewer.getByRole("region", { name: "Guest" }).getByRole("link", { name: boardName })).toBeVisible();
    await viewer.getByRole("region", { name: "Guest" }).getByRole("link", { name: boardName }).click();
    await expect(viewer).toHaveURL(`/board/${boardKey}`);
    await expect(breadcrumb(viewer).getByText(boardName, { exact: true })).toBeVisible();
    await expect(breadcrumb(viewer).getByText("Guest", { exact: true })).toBeVisible();
    await expect(breadcrumb(viewer).getByText("Operator", { exact: true })).toHaveCount(0);
  }
});
