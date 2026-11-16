import { expect, test, type Browser, type Page } from "@playwright/test";
import { signup, uniqueEmail } from "./helpers";

/**
 * A plain account: an `@admin.test` one is an operator and would see every workspace.
 * It starts with its first workspace, which is an ordinary workspace like any other.
 */
async function plainUser(browser: Browser, operator: Page, suffix: string, name: string) {
  // Minted through the API: the invitations page counts links on screen, which a second
  // invitation in one test (the first now used) would make unreliable.
  const minted = await operator.request.post("/invites", { data: {} });
  expect(minted.status()).toBe(201);
  const { token } = (await minted.json()) as { token: string };
  const page = await (await browser.newContext()).newPage();
  await signup(page, uniqueEmail(suffix, "example.test"), name, token);
  const me = (await (await page.request.get("/me")).json()) as { id: string };
  return { page, id: me.id, name };
}
type Person = Awaited<ReturnType<typeof plainUser>>;

async function operator(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  await signup(page, uniqueEmail("delete-operator"), "Delete Operator");
  return page;
}

async function createWorkspace(by: Person, name: string): Promise<string> {
  const response = await by.page.request.post("/workspaces", { data: { name } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { workspace: { id: string } }).workspace.id;
}

async function addMember(by: Person, workspaceId: string, who: Person) {
  const response = await by.page.request.post(`/workspaces/${workspaceId}/members`, {
    data: { userId: who.id, role: "member", operationId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(200);
}

async function workspaceIds(by: Person): Promise<string[]> {
  const body = (await (await by.page.request.get("/workspaces")).json()) as { workspaces: Array<{ id: string }> };
  return body.workspaces.map((workspace) => workspace.id);
}

const home = (page: Page) => page.getByRole("heading", { name: "Home", exact: true });
const group = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

async function openSettings(page: Page, workspaceId: string) {
  await page.goto(`/w/${workspaceId}/settings`);
  await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeVisible();
}

test("an admin deletes an empty workspace from Settings and lands on Home without it", async ({ browser }) => {
  const ops = await operator(browser);
  const admin = await plainUser(browser, ops, "delete-admin", `Delete Admin ${Date.now()}`);
  const name = `Doomed ${Date.now()}`;
  const workspaceId = await createWorkspace(admin, name);
  // A pending invitation goes with it.
  const invite = await admin.page.request.post(`/workspaces/${workspaceId}/invites`, { data: { role: "member" } });
  expect(invite.status()).toBe(201);

  await admin.page.goto("/");
  await expect(group(admin.page, name)).toBeVisible();
  await openSettings(admin.page, workspaceId);
  await admin.page.getByRole("button", { name: "Delete workspace", exact: true }).click();

  // Cancel leaves everything as it was.
  const dialog = admin.page.getByRole("alertdialog", { name: `Delete “${name}”?` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await workspaceIds(admin)).toContain(workspaceId);

  await admin.page.getByRole("button", { name: "Delete workspace", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete workspace", exact: true }).click();

  await expect(admin.page).toHaveURL("/");
  await expect(home(admin.page)).toBeVisible();
  await expect(group(admin.page, name)).toHaveCount(0);
  expect(await workspaceIds(admin)).not.toContain(workspaceId);
  // The deleted workspace is gone for real, and nobody can read it any more.
  expect((await admin.page.request.get(`/workspaces/${workspaceId}`)).status()).toBe(403);
});

test("a workspace with a board refuses the delete and says what to do first", async ({ browser }) => {
  const ops = await operator(browser);
  const admin = await plainUser(browser, ops, "delete-busy", `Delete Busy ${Date.now()}`);
  const name = `Busy ${Date.now()}`;
  const workspaceId = await createWorkspace(admin, name);
  const board = await admin.page.request.post("/boards", {
    data: { name: "Keep me", key: `K${Date.now().toString(36).toUpperCase()}`, workspaceId, accessMode: "workspace" },
  });
  expect(board.status()).toBe(200);
  const { id: boardId } = (await board.json()) as { id: string };

  await openSettings(admin.page, workspaceId);
  await admin.page.getByRole("button", { name: "Delete workspace", exact: true }).click();
  const dialog = admin.page.getByRole("alertdialog", { name: `Delete “${name}”?` });
  await dialog.getByRole("button", { name: "Delete workspace", exact: true }).click();

  await expect(dialog.getByRole("alert")).toHaveText("Move or delete this workspace's boards first.");
  await expect(admin.page).toHaveURL(`/w/${workspaceId}/settings`);
  expect(await workspaceIds(admin)).toContain(workspaceId);

  // Once the board is deleted, the same dialog finishes the job.
  const removed = await admin.page.request.delete(`/boards/${boardId}?operationId=${crypto.randomUUID()}`);
  expect(removed.status()).toBe(200);
  await dialog.getByRole("button", { name: "Delete workspace", exact: true }).click();
  await expect(admin.page).toHaveURL("/");
  await expect(group(admin.page, name)).toHaveCount(0);
});

test("deleting the only workspace leaves Home offering Create workspace", async ({ browser }) => {
  const ops = await operator(browser);
  const admin = await plainUser(browser, ops, "delete-only", `Delete Only ${Date.now()}`);
  const [only, ...others] = await workspaceIds(admin);
  expect(others).toEqual([]);

  await openSettings(admin.page, only!);
  await admin.page.getByRole("button", { name: "Delete workspace", exact: true }).click();
  await admin.page.getByRole("alertdialog").getByRole("button", { name: "Delete workspace", exact: true }).click();

  await expect(admin.page).toHaveURL("/");
  await expect(home(admin.page)).toBeVisible();
  await expect(admin.page.getByText("No workspaces yet.")).toBeVisible();
  await expect(admin.page.getByRole("button", { name: "Create workspace" })).toBeVisible();
  expect(await workspaceIds(admin)).toEqual([]);
});

test("a member sees the workspace leave their Home without reloading, and has no way to delete it", async ({ browser }) => {
  const ops = await operator(browser);
  const admin = await plainUser(browser, ops, "delete-live-admin", `Live Admin ${Date.now()}`);
  const member = await plainUser(browser, ops, "delete-live-member", `Live Member ${Date.now()}`);
  const name = `Shared ${Date.now()}`;
  const workspaceId = await createWorkspace(admin, name);
  await addMember(admin, workspaceId, member);

  await member.page.goto("/");
  await expect(group(member.page, name)).toBeVisible();
  // A member's Settings route is closed, so there is no delete control to find.
  await member.page.goto(`/w/${workspaceId}/settings`);
  await expect(member.page).toHaveURL(`/w/${workspaceId}`);
  await expect(member.page.getByRole("button", { name: "Delete workspace" })).toHaveCount(0);
  expect((await member.page.request.delete(`/workspaces/${workspaceId}`)).status()).toBe(403);
  await member.page.goto("/");
  await expect(group(member.page, name)).toBeVisible();

  await openSettings(admin.page, workspaceId);
  await admin.page.getByRole("button", { name: "Delete workspace", exact: true }).click();
  await admin.page.getByRole("alertdialog").getByRole("button", { name: "Delete workspace", exact: true }).click();
  await expect(admin.page).toHaveURL("/");

  await expect(group(member.page, name)).toHaveCount(0);
  await expect(member.page).toHaveURL("/");
});
