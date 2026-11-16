import { expect, test, type Browser, type Page } from "@playwright/test";
import { signup, uniqueEmail } from "./helpers";

/**
 * A plain account in its own cookie jar. An `@admin.test` account is a configured
 * operator, who would see every workspace and mask the role under test, so the
 * people here register with an invitation an operator minted.
 */
async function newPlainUser(browser: Browser, operatorPage: Page, suffix: string, name: string) {
  // Minted through the API: the invitations page counts links on screen, which a
  // second invitation in one test (the first now used) would make unreliable.
  const minted = await operatorPage.request.post("/invites", { data: {} });
  expect(minted.status()).toBe(201);
  const { token } = (await minted.json()) as { token: string };
  const page = await (await browser.newContext()).newPage();
  const email = uniqueEmail(suffix, "example.test");
  await signup(page, email, name, token);
  const me = (await (await page.request.get("/me")).json()) as { id: string };
  return { page, email, id: me.id, name };
}
type Person = Awaited<ReturnType<typeof newPlainUser>>;

async function operator(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  await signup(page, uniqueEmail("roles-operator"), "Roles Operator");
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

async function openMembers(page: Page, workspaceId: string) {
  await page.goto(`/w/${workspaceId}/members`);
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
}

const row = (page: Page, person: Person) => page.getByRole("listitem").filter({ hasText: person.email });
const roleSelect = (page: Page, person: Person) => row(page, person).getByLabel(`Role for ${person.name}`);

test("admins make each other admins and members, and the last admin is told to promote someone first", async ({ browser }) => {
  const ops = await operator(browser);
  const creator = await newPlainUser(browser, ops, "roles-creator", `Creator ${Date.now()}`);
  const peer = await newPlainUser(browser, ops, "roles-peer", `Peer ${Date.now()}`);
  const workspaceId = await createWorkspace(creator, `Roles ${Date.now()}`);
  await addMember(creator, workspaceId, peer);

  // The workspace's creator promotes a member. Nobody is labelled "Owner".
  await openMembers(creator.page, workspaceId);
  await expect(creator.page.getByText("Owner", { exact: true })).toHaveCount(0);
  await expect(roleSelect(creator.page, creator)).toHaveValue("admin");
  await roleSelect(creator.page, peer).selectOption("admin");
  await expect(roleSelect(creator.page, peer)).toHaveValue("admin");

  // The new admin has the Settings link and the member controls of any admin, and
  // can make the creator a member.
  await openMembers(peer.page, workspaceId);
  await expect(peer.page.getByRole("link", { name: "Settings", exact: true }).filter({ visible: true }).first()).toBeVisible();
  await roleSelect(peer.page, creator).selectOption("member");
  await expect(roleSelect(peer.page, creator)).toHaveValue("member");

  // The creator now has a member's page: no role controls, no Settings, no add.
  await openMembers(creator.page, workspaceId);
  await expect(creator.page.getByLabel(/^Role for /)).toHaveCount(0);
  await expect(creator.page.getByRole("button", { name: "Add member" })).toHaveCount(0);
  await expect(creator.page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  await creator.page.goto(`/w/${workspaceId}/settings`);
  await expect(creator.page).toHaveURL(`/w/${workspaceId}`);

  // The peer is the last admin: demoting or leaving is refused with what to do.
  await roleSelect(peer.page, peer).selectOption("member");
  await expect(peer.page.getByRole("alert").filter({ hasText: "Promote another member to admin first." })).toBeVisible();
  await expect(roleSelect(peer.page, peer)).toHaveValue("admin");
  await peer.page.getByRole("button", { name: "Leave workspace" }).click();
  const dialog = peer.page.getByRole("dialog", { name: "Leave workspace?" });
  await dialog.getByRole("button", { name: "Leave workspace" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Promote another member to admin first.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(roleSelect(peer.page, peer)).toHaveValue("admin");

  for (const person of [creator, peer]) await person.page.context().close();
  await ops.context().close();
});

test("a member can leave a workspace, and it disappears for them", async ({ browser }) => {
  const ops = await operator(browser);
  const creator = await newPlainUser(browser, ops, "leave-creator", `Leave Creator ${Date.now()}`);
  const member = await newPlainUser(browser, ops, "leave-member", `Leave Member ${Date.now()}`);
  const workspaceId = await createWorkspace(creator, `Leaving ${Date.now()}`);
  await addMember(creator, workspaceId, member);

  await openMembers(member.page, workspaceId);
  // A member sees the people but manages none of them, and can leave.
  await expect(member.page.getByLabel(/^Role for /)).toHaveCount(0);
  await expect(member.page.getByRole("button", { name: `Remove ${creator.name}` })).toHaveCount(0);
  await member.page.getByRole("button", { name: "Leave workspace" }).click();
  const dialog = member.page.getByRole("dialog", { name: "Leave workspace?" });
  await dialog.getByRole("button", { name: "Leave workspace" }).click();

  await expect(member.page).not.toHaveURL(`/w/${workspaceId}/members`);
  expect((await member.page.request.get(`/workspaces/${workspaceId}/members`)).status()).toBe(403);
  // The admin still has the workspace, without the person who left.
  await openMembers(creator.page, workspaceId);
  await expect(row(creator.page, member)).toHaveCount(0);

  for (const person of [creator, member]) await person.page.context().close();
  await ops.context().close();
});
