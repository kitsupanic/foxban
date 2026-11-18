import { expect, test, type Browser, type Page } from "@playwright/test";
import { createBoard, generateAccountInvite, settleAnimationFrames, signup, uniqueEmail } from "./helpers";

/**
 * A signed-up account in its own cookie jar, so one test can drive a manager and
 * a member at the same time. The default domain is the operator domain, so pass
 * an invitation token to register a plain user.
 */
async function newUser(
  browser: Browser,
  suffix: string,
  name: string,
  invite?: string,
): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = invite ? uniqueEmail(suffix, "example.test") : uniqueEmail(suffix);
  await signup(page, email, name, invite);
  return { page, email };
}

/** An account a configured operator invited: a plain user, never an operator. */
async function newPlainUser(
  browser: Browser,
  operatorPage: Page,
  suffix: string,
  name: string,
): Promise<{ page: Page; email: string }> {
  const { token } = await generateAccountInvite(operatorPage);
  return newUser(browser, suffix, name, token);
}

/** Creates a workspace with the sidebar plus and returns the id it landed on. */
async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "New workspace", exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create workspace" });
  const previousPath = new URL(page.url()).pathname;
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).not.toHaveURL(previousPath);
  // URL commit precedes the workspace detail query and its navigation render.
  await expect(page.getByRole("link", { name: "Members", exact: true }).filter({ visible: true })).toBeVisible();
  return new URL(page.url()).pathname.replace("/w/", "");
}

async function openMembersPage(page: Page, workspaceId: string): Promise<void> {
  await page.getByRole("link", { name: "Members" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(`/w/${workspaceId}/members`);
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
}

async function memberRow(page: Page, email: string) {
  return page.getByRole("listitem").filter({ hasText: email });
}

/** Looks the account up by its exact address, selects it and submits the add. */
async function addMember(
  page: Page,
  workspaceName: string,
  email: string,
  name: string,
  role?: "admin" | "member",
): Promise<void> {
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog", { name: `Add member to ${workspaceName}` });
  // The dialog opens on its search field, the only thing it needs first.
  await expect(dialog.getByLabel("Search existing users")).toBeFocused();
  await dialog.getByLabel("Search existing users").fill(email);
  await dialog.getByRole("listbox").getByRole("option", { name: new RegExp(name) }).click();
  if (role) await dialog.getByLabel("Role").selectOption(role);
  await dialog.getByRole("button", { name: "Add member" }).click();
  // A committed outcome is the only thing that may be announced.
  await expect(page.getByRole("status").filter({ hasText: `Added ${name} to the workspace.` })).toBeVisible();
  await expect(dialog).toHaveCount(0);
}

test("a manager adds an existing account directly and applies the chosen role", async ({ browser }) => {
  const owner = await newUser(browser, "direct-add-owner", "Direct Owner");
  // The fixture's display name is unique, so a row by name can only mean this run's account.
  const adaName = `Ada Direct ${Date.now()}`;
  const ada = await newPlainUser(browser, owner.page, "direct-add-ada", adaName);
  await owner.page.goto("/");
  const workspaceName = `Direct add ${Date.now()}`;
  const workspaceId = await createWorkspace(owner.page, workspaceName);
  await openMembersPage(owner.page, workspaceId);

  // The dialog opens on its search field, and the shell behind it is inert: the
  // overlay owns the keyboard, Tab cannot reach the page underneath, and no
  // background control can take focus while it is open.
  await owner.page.getByRole("button", { name: "Add member" }).click();
  const draft = owner.page.getByRole("dialog", { name: `Add member to ${workspaceName}` });
  await expect(draft.getByLabel("Search existing users")).toBeFocused();
  await expect(owner.page.locator(".boards-shell")).toHaveAttribute("inert", "");
  for (let press = 0; press < 8; press += 1) {
    await owner.page.keyboard.press("Tab");
    expect(
      await owner.page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
    ).toBe(true);
  }
  expect(
    await owner.page.evaluate(() => {
      document.querySelector<HTMLElement>(".boards-shell button")?.focus();
      return document.activeElement?.closest(".boards-shell") !== null;
    }),
  ).toBe(false);
  await draft.getByLabel("Search existing users").fill(ada.email);
  await draft.press("Escape");
  await expect(draft).toHaveCount(0);
  // Closing hands focus back to the control that opened it.
  await settleAnimationFrames(owner.page);
  await expect(owner.page.getByRole("button", { name: "Add member" })).toBeFocused();
  await expect(await memberRow(owner.page, ada.email)).toHaveCount(0);
  await expect(
    owner.page.getByRole("status").filter({ hasText: `Added ${adaName} to the workspace.` }),
  ).toHaveCount(0);

  await addMember(owner.page, workspaceName, ada.email, adaName, "admin");

  // A committed add closes the dialog and returns focus the same way.
  await settleAnimationFrames(owner.page);
  await expect(owner.page.getByRole("button", { name: "Add member" })).toBeFocused();

  // The row shows the role the server now holds, not just the one the form offered.
  await expect((await memberRow(owner.page, ada.email)).getByLabel(`Role for ${adaName}`)).toHaveValue(
    "admin",
  );

  // The lookup no longer offers her, because adding again is not how a role is
  // changed, and a name finds nobody: only a full address is looked up (ADR 0072).
  await owner.page.getByRole("button", { name: "Add member" }).click();
  const dialog = owner.page.getByRole("dialog", { name: `Add member to ${workspaceName}` });
  await dialog.getByLabel("Search existing users").fill(adaName);
  await expect(dialog.getByText("Type the full email address of an existing account.")).toBeVisible();
  await dialog.getByLabel("Search existing users").fill(ada.email);
  await expect(dialog.getByText("No matching users.")).toBeVisible();
  // The listbox is not rendered at all: the lookup offers nothing, so the role
  // select cannot be mistaken for a candidate.
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // The removal confirmation uses the same overlay contract: the shell is inert
  // while it is open, and cancelling returns focus to the row control that opened it.
  const removeTrigger = (await memberRow(owner.page, ada.email)).getByRole("button", {
    name: `Remove ${adaName}`,
  });
  await removeTrigger.click();
  await expect(owner.page.getByText("Remove workspace member?")).toBeVisible();
  await expect(owner.page.locator(".boards-shell")).toHaveAttribute("inert", "");
  await owner.page.getByRole("button", { name: "Cancel" }).click();
  await expect(owner.page.getByText("Remove workspace member?")).toHaveCount(0);
  await settleAnimationFrames(owner.page);
  await expect(removeTrigger).toBeFocused();
});

test("an added member inherits the workspace's boards but no directory or add rights", async ({
  browser,
}) => {
  const owner = await newUser(browser, "member-access-owner", "Access Owner");
  const bo = await newPlainUser(browser, owner.page, "member-access-bo", "Bo Member");
  // A configured operator with no membership in this workspace.
  const outsider = await newUser(browser, "member-access-outsider", "Outsider Operator");
  await owner.page.goto("/");
  const workspaceName = `Member access ${Date.now()}`;
  const workspaceId = await createWorkspace(owner.page, workspaceName);
  const boardName = `Workspace board ${Date.now()}`;
  const boardKey = await createBoard(owner.page, boardName);
  await openMembersPage(owner.page, workspaceId);

  // No role chosen: the form's default is Member.
  await addMember(owner.page, workspaceName, bo.email, "Bo Member");
  await expect((await memberRow(owner.page, bo.email)).getByLabel("Role for Bo Member")).toHaveValue(
    "member",
  );

  // The member reaches the workspace and the board the workspace grants…
  await bo.page.goto(`/w/${workspaceId}`);
  await expect(bo.page.getByRole("link", { name: boardName })).toBeVisible();
  await bo.page.goto(`/board/${boardKey}`);
  await expect(bo.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();

  // …and gets no part of the add machinery, in the UI or from the server.
  await bo.page.goto(`/w/${workspaceId}/members`);
  await expect(bo.page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  await expect(bo.page.getByRole("button", { name: "Add member" })).toHaveCount(0);
  const directory = await bo.page.request.get(`/workspaces/${workspaceId}/membership-candidates`);
  expect(directory.status()).toBe(403);
  const attempted = await bo.page.request.post(`/workspaces/${workspaceId}/members`, {
    data: { userId: crypto.randomUUID(), operationId: crypto.randomUUID() },
  });
  expect(attempted.status()).toBe(403);

  // An operator's global reach does not include this directory either.
  const operatorDirectory = await outsider.page.request.get(
    `/workspaces/${workspaceId}/membership-candidates`,
  );
  expect(operatorDirectory.status()).toBe(403);

  // An account that does not exist is never added, so nothing can be invented.
  const unknown = await owner.page.request.post(`/workspaces/${workspaceId}/members`, {
    data: { userId: crypto.randomUUID(), operationId: crypto.randomUUID() },
  });
  expect(unknown.status()).toBe(404);
});

test("an unresolved add keeps its operation id across a remount and is retried under it", async ({
  browser,
}) => {
  const owner = await newUser(browser, "direct-add-retry", "Retry Owner");
  const ada = await newPlainUser(browser, owner.page, "direct-add-retry-ada", "Ada Retry");
  await owner.page.goto("/");
  const workspaceName = `Retry add ${Date.now()}`;
  const workspaceId = await createWorkspace(owner.page, workspaceName);
  const boardName = `Retry board ${Date.now()}`;
  await createBoard(owner.page, boardName);
  await openMembersPage(owner.page, workspaceId);

  const posts: { operationId: string; role: string; userId: string }[] = [];
  await owner.page.route("**/workspaces/*/members", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    posts.push(request.postDataJSON() as { operationId: string; role: string; userId: string });
    // The first request never reaches the server, so its outcome is unknown and
    // only the same operation id can settle it.
    if (posts.length === 1) return route.abort("connectionfailed");
    return route.continue();
  });
  // The status endpoint holds no row for that id yet, so polling stops.
  await owner.page.route("**/access-changes/**", (route) =>
    route.fulfill({ status: 404, json: { error: "not found" } }),
  );

  await owner.page.getByRole("button", { name: "Add member" }).click();
  const dialog = owner.page.getByRole("dialog", { name: `Add member to ${workspaceName}` });
  await dialog.getByLabel("Search existing users").fill(ada.email);
  await dialog.getByRole("option", { name: /Ada Retry/ }).click();
  await dialog.getByRole("button", { name: "Add member" }).click();

  // Nothing is announced while the outcome is unknown.
  await expect(dialog.getByRole("status").filter({ hasText: "An add is still being applied." })).toBeVisible();
  await expect(owner.page.getByRole("status").filter({ hasText: "Added Ada Retry to the workspace." })).toHaveCount(0);
  const dialogRetry = dialog.getByRole("button", { name: "Retry add for Ada Retry" });
  await expect(dialogRetry).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // The member list does not pretend the membership exists while the add is unresolved.
  await expect(await memberRow(owner.page, ada.email)).toHaveCount(0);

  // Navigating away and back remounts the page: the draft is gone, the attempt is
  // not, and it is still the thing the retry continues.
  await owner.page.getByRole("link", { name: /^Boards/ }).filter({ visible: true }).first().click();
  await expect(owner.page).toHaveURL(`/w/${workspaceId}`);
  await openMembersPage(owner.page, workspaceId);
  await expect(
    owner.page.getByRole("status").filter({ hasText: "A membership change for Ada Retry" }),
  ).toBeVisible();

  const retry = owner.page.getByRole("button", { name: "Retry change for Ada Retry" });
  await expect(retry).toBeEnabled();
  await retry.click();

  // The retry replays the retained id and payload, and the real outcome — not the
  // click — is what updates the page.
  await expect(
    owner.page.getByRole("status").filter({ hasText: "Added Ada Retry to the workspace." }),
  ).toBeVisible();
  await expect(await memberRow(owner.page, ada.email)).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.operationId).toBe(posts[0]!.operationId);
  expect(posts[1]!.userId).toBe(posts[0]!.userId);
  expect(posts[1]!.role).toBe("member");
});

test("a manager demoted while the dialog is open keeps her page usable", async ({ browser }) => {
  const owner = await newUser(browser, "demote-owner", "Demote Owner");
  const coraName = `Cora Demote ${Date.now()}`;
  const cora = await newPlainUser(browser, owner.page, "demote-cora", coraName);
  await owner.page.goto("/");
  const workspaceName = `Demote ${Date.now()}`;
  const workspaceId = await createWorkspace(owner.page, workspaceName);
  await openMembersPage(owner.page, workspaceId);
  await addMember(owner.page, workspaceName, cora.email, coraName, "admin");

  // The admin opens the dialog on her own page. Her live presence connection is the
  // only thing that can tell her about a change committed in someone else's tab, so
  // the demotion below waits for it rather than for a timer.
  const connected = new Promise<void>((resolve) => {
    cora.page.once("websocket", (socket) => socket.once("framereceived", () => resolve()));
  });
  await cora.page.goto(`/w/${workspaceId}/members`);
  await cora.page.getByRole("button", { name: "Add member" }).click();
  const dialog = cora.page.getByRole("dialog", { name: `Add member to ${workspaceName}` });
  await expect(dialog.getByLabel("Search existing users")).toBeFocused();
  await expect(cora.page.locator(".boards-shell")).toHaveAttribute("inert", "");
  await connected;

  // The owner demotes her mid-draft: the capability the dialog needs is gone, and
  // nobody has touched her page to say so.
  const roleSelect = (await memberRow(owner.page, cora.email)).getByLabel(`Role for ${coraName}`);
  await roleSelect.selectOption("member");
  await expect(roleSelect).toHaveValue("member");

  // A dialog that cannot be shown must not be what keeps the page behind it frozen:
  // it closes with the capability, the shell stops being inert, and the add machinery
  // goes with it.
  await expect(dialog).toHaveCount(0);
  await expect(cora.page.locator(".boards-shell")).not.toHaveAttribute("inert", "");
  await expect(cora.page.getByRole("button", { name: "Add member" })).toHaveCount(0);

  // Focus lands on the page itself, not on the trigger that left with the capability,
  // and the keyboard reaches the page controls again instead of being stranded.
  await settleAnimationFrames(cora.page);
  await expect(cora.page.locator(".boards-heading")).toBeFocused();
  await cora.page.keyboard.press("Shift+Tab");
  expect(
    await cora.page.evaluate(() => {
      const active = document.activeElement;
      return (
        active !== null &&
        active !== document.body &&
        active.closest(".boards-shell") !== null &&
        active.closest("[inert]") === null
      );
    }),
  ).toBe(true);

  // Handing the capability back offers a fresh draft, not the one that was discarded
  // with it: the trigger returns and no dialog the user never asked for comes with it.
  await roleSelect.selectOption("admin");
  await expect(roleSelect).toHaveValue("admin");
  await expect(cora.page.getByRole("button", { name: "Add member" })).toBeVisible();
  await expect(cora.page.getByRole("dialog", { name: `Add member to ${workspaceName}` })).toHaveCount(0);

  // The page answers without a reload.
  await cora.page.getByRole("link", { name: /^Boards/ }).filter({ visible: true }).first().click();
  await expect(cora.page).toHaveURL(`/w/${workspaceId}`);
  await expect(cora.page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
});
