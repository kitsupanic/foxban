import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectBoardAccessDenied, signup, uniqueEmail } from "./helpers";

/**
 * A Private board opens for its board members and for the admins of its workspace
 * (ADR 0066). The people here are plain accounts: an `@admin.test` account is a
 * configured operator, who would reach the board anyway and mask the rule.
 */
async function newPlainUser(browser: Browser, operatorPage: Page, suffix: string, name: string) {
  const minted = await operatorPage.request.post("/invites", { data: {} });
  expect(minted.status()).toBe(201);
  const { token } = (await minted.json()) as { token: string };
  const page = await (await browser.newContext()).newPage();
  await signup(page, uniqueEmail(suffix, "example.test"), name, token);
  const me = (await (await page.request.get("/me")).json()) as { id: string };
  return { page, id: me.id, name };
}
type Person = Awaited<ReturnType<typeof newPlainUser>>;

async function operator(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  await signup(page, uniqueEmail("private-admin-operator"), "Private Admin Operator");
  return page;
}

async function createWorkspace(by: Person, name: string): Promise<string> {
  const response = await by.page.request.post("/workspaces", { data: { name } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { workspace: { id: string } }).workspace.id;
}

async function addMember(by: Person, workspaceId: string, who: Person, role: "admin" | "member" = "member") {
  const response = await by.page.request.post(`/workspaces/${workspaceId}/members`, {
    data: { userId: who.id, role, operationId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(200);
}

async function setRole(by: Person, workspaceId: string, who: Person, role: "admin" | "member") {
  const response = await by.page.request.patch(`/workspaces/${workspaceId}/members/${who.id}`, {
    data: { role, operationId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(200);
}

/** A Private board made by `by`, who is therefore a member of it. Returns the board's key. */
async function createPrivateBoard(by: Person, workspaceId: string, name: string): Promise<string> {
  const key = `Q${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const response = await by.page.request.post("/boards", {
    data: { name, key, workspaceId, accessMode: "restricted" },
  });
  expect(response.status()).toBe(200);
  return key;
}

const boardRow = (page: Page, boardName: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("link", { name: boardName }) });
const adminNote = (page: Page) =>
  page.getByRole("note").filter({ hasText: "You are here as a workspace admin. You were not added to this Private board." });

test("a workspace admin opens a Private board they were not added to and is told why, and a member cannot", async ({ browser }) => {
  const ops = await operator(browser);
  const admin = await newPlainUser(browser, ops, "private-admin", `Admin ${Date.now()}`);
  const author = await newPlainUser(browser, ops, "private-author", `Author ${Date.now()}`);
  const member = await newPlainUser(browser, ops, "private-member", `Member ${Date.now()}`);
  const workspaceId = await createWorkspace(admin, `Private rule ${Date.now()}`);
  await addMember(admin, workspaceId, author);
  await addMember(admin, workspaceId, member);
  const boardName = `Private board ${Date.now()}`;
  const key = await createPrivateBoard(author, workspaceId, boardName);

  // The admin lists it, under the Private label, and manages it from its menu.
  await admin.page.goto(`/w/${workspaceId}`);
  const adminRow = boardRow(admin.page, boardName);
  await expect(adminRow.locator(".board-access-label")).toHaveText("Private");
  await adminRow.getByRole("button", { name: `Board settings for ${boardName}` }).click();
  await expect(adminRow.getByRole("menuitem", { name: "Move workspace" })).toBeVisible();
  await admin.page.keyboard.press("Escape");

  // And opens it, with the note: they are here through the workspace, not a grant.
  await adminRow.getByRole("link", { name: boardName }).click();
  await expect(admin.page).toHaveURL(`/board/${key}`);
  await expect(admin.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await expect(adminNote(admin.page)).toBeVisible();

  // The board member made it: no note for them.
  await author.page.goto(`/board/${key}`);
  await expect(author.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await expect(author.page.getByRole("note")).toHaveCount(0);

  // A workspace member who was not added neither lists it nor opens it.
  await member.page.goto(`/w/${workspaceId}`);
  await expect(member.page.getByRole("button", { name: "New board" })).toBeVisible();
  await expect(boardRow(member.page, boardName)).toHaveCount(0);
  await member.page.goto(`/board/${key}`);
  await expectBoardAccessDenied(member.page, boardName);

  // Adding the admin to the board takes the note away: it shows only for a non-member.
  const { id: boardId } = (await (await author.page.request.get(`/boards/by-key/${key}`)).json()) as { id: string };
  const added = await author.page.request.post(`/boards/${boardId}/members`, { data: { userId: admin.id } });
  expect(added.status()).toBe(200);
  await admin.page.reload();
  await expect(admin.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await expect(admin.page.getByRole("note")).toHaveCount(0);

  for (const person of [admin, author, member]) await person.page.context().close();
  await ops.context().close();
});

test("promoting a member lists the Private board without a reload, and demoting the admin closes it", async ({ browser }) => {
  const ops = await operator(browser);
  const creator = await newPlainUser(browser, ops, "live-creator", `Creator ${Date.now()}`);
  const author = await newPlainUser(browser, ops, "live-author", `Author ${Date.now()}`);
  const peer = await newPlainUser(browser, ops, "live-peer", `Peer ${Date.now()}`);
  const workspaceId = await createWorkspace(creator, `Live roles ${Date.now()}`);
  await addMember(creator, workspaceId, author);
  await addMember(creator, workspaceId, peer);
  const boardName = `Live private board ${Date.now()}`;
  const key = await createPrivateBoard(author, workspaceId, boardName);

  // The member's board list is open and does not show the Private board.
  await peer.page.goto(`/w/${workspaceId}`);
  await expect(peer.page.getByRole("button", { name: "New board" })).toBeVisible();
  await expect(boardRow(peer.page, boardName)).toHaveCount(0);

  // Promoting them lists it in that same page, with no reload.
  await setRole(creator, workspaceId, peer, "admin");
  await expect(boardRow(peer.page, boardName)).toBeVisible();

  // They open it with the board live and the note shown.
  await boardRow(peer.page, boardName).getByRole("link", { name: boardName }).click();
  await expect(peer.page).toHaveURL(`/board/${key}`);
  await expect(peer.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await expect(adminNote(peer.page)).toBeVisible();
  await expect(peer.page.getByText("Live", { exact: true })).toBeVisible();

  // Demoting them closes the connection they hold: the open page falls back to the
  // denial state by itself, and the board leaves the list they would return to.
  await setRole(creator, workspaceId, peer, "member");
  await expectBoardAccessDenied(peer.page, boardName);
  await peer.page.goto(`/w/${workspaceId}`);
  await expect(peer.page.getByRole("button", { name: "New board" })).toBeVisible();
  await expect(boardRow(peer.page, boardName)).toHaveCount(0);

  for (const person of [creator, author, peer]) await person.page.context().close();
  await ops.context().close();
});

test("an Admin who only belongs to the workspace is marked Operator on a Private board they were not added to", async ({ browser }) => {
  const ops = await operator(browser);
  const creator = await newPlainUser(browser, ops, "marker-creator", `Creator ${Date.now()}`);
  const author = await newPlainUser(browser, ops, "marker-author", `Author ${Date.now()}`);
  const workspaceId = await createWorkspace(creator, `Marker rule ${Date.now()}`);
  await addMember(creator, workspaceId, author);
  // An instance Admin who is a plain member of the workspace: it is theirs, this one board is not.
  const adminPage = await (await browser.newContext()).newPage();
  await signup(adminPage, uniqueEmail("marker-admin"), `Member Admin ${Date.now()}`);
  const adminId = ((await (await adminPage.request.get("/me")).json()) as { id: string }).id;
  const joined = await creator.page.request.post(`/workspaces/${workspaceId}/members`, {
    data: { userId: adminId, role: "member", operationId: crypto.randomUUID() },
  });
  expect(joined.status()).toBe(200);
  const boardName = `Marker private board ${Date.now()}`;
  const key = await createPrivateBoard(author, workspaceId, boardName);

  // They open it only through instance-Admin power, and the breadcrumb says so.
  const breadcrumb = adminPage.locator(".boards-breadcrumb");
  await adminPage.goto(`/board/${key}`);
  await expect(adminPage.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await expect(breadcrumb.getByText("Operator", { exact: true })).toBeVisible();

  // Added to the board, they hold it as a member and the marker goes.
  const { id: boardId } = (await (await author.page.request.get(`/boards/by-key/${key}`)).json()) as { id: string };
  const added = await author.page.request.post(`/boards/${boardId}/members`, { data: { userId: adminId } });
  expect(added.status()).toBe(200);
  await adminPage.reload();
  await expect(adminPage.getByRole("heading", { name: boardName, exact: true })).toBeVisible();
  await expect(breadcrumb.getByText("Operator", { exact: true })).toHaveCount(0);

  for (const person of [creator, author]) await person.page.context().close();
  await adminPage.context().close();
  await ops.context().close();
});
