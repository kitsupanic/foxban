import { expect, test, type Page } from "@playwright/test";
import {
  addColumn,
  columnByTitle,
  createBoard,
  personalWorkspaceRoute,
  signup,
  uniqueEmail,
} from "./helpers";

declare global {
  interface Window {
    __foxbanSockets?: WebSocket[];
  }
}

const INVITE_TOKEN = "e2e-join-token-abcdefghijklmnopqrstuvwxyz0123456789";
const FENCE_STATUS = 503;

/**
 * The join page reads an invitation through two requests: the inspection that
 * renders it, and the acceptance whose outcome is the case under test. The
 * inspection is stubbed for every case so each one drives a single accept
 * outcome without inventing a live invitation.
 */
async function openJoinPage(page: Page, workspaceId: string): Promise<void> {
  await page.route("**/invites/inspect", (route) =>
    route.fulfill({ json: { workspaceName: "Invited Workspace", role: "member", expiresAt: Date.now() + 86_400_000 } }),
  );
  await page.goto(`/join-workspace/${workspaceId}#invite=${INVITE_TOKEN}`);
  await expect(page.getByRole("button", { name: "Join workspace" })).toBeVisible();
}

test("an immediate join answer lands from its own response, never from a poll", async ({ page }) => {
  await signup(page, uniqueEmail("join-immediate"), "Join Immediate");
  // The workspace this account owns: a completed join has somewhere real to land.
  const workspaceId = (await personalWorkspaceRoute(page)).slice("/w/".length);
  const accepted: { operationId: string; token: string }[] = [];
  const statusReads: string[] = [];
  await page.route("**/access-changes/**", (route) => {
    statusReads.push(route.request().url());
    // The status endpoint never answers, so a join that needed a poll could not land.
    return route.abort("connectionfailed");
  });
  await page.route("**/invites/accept", (route) => {
    const body = route.request().postDataJSON() as { operationId: string; token: string };
    accepted.push(body);
    return route.fulfill({
      json: { operationId: body.operationId, state: "completed", outcome: "committed", result: null },
    });
  });

  await openJoinPage(page, workspaceId);
  await page.getByRole("button", { name: "Join workspace" }).click();

  // The outcome is definitive, so the page treats the invitation as accepted:
  // it leaves the fragment behind and navigates into the workspace.
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}$`));
  expect(statusReads.length).toBeLessThanOrEqual(1);
  expect(accepted).toEqual([{ operationId: expect.any(String), token: INVITE_TOKEN }]);
});

test("a failed invitation check is not reported as an unusable link", async ({ page }) => {
  await signup(page, uniqueEmail("join-inspect"), "Join Inspect");
  const workspaceId = (await personalWorkspaceRoute(page)).slice("/w/".length);
  let checks = 0;
  await page.route("**/invites/inspect", (route) => {
    checks += 1;
    // The check never reaches the server, which says nothing about the link.
    if (checks === 1) return route.abort("connectionfailed");
    return route.fulfill({
      json: { workspaceName: "Invited Workspace", role: "member", expiresAt: Date.now() + 86_400_000 },
    });
  });

  await page.goto(`/join-workspace/${workspaceId}#invite=${INVITE_TOKEN}`);

  // The failed check is reflected before anything is claimed about the link.
  await expect(page.getByText("Could not check this invitation.")).toBeVisible();
  await expect(page.getByText("This workspace invitation is unavailable.")).toHaveCount(0);
  await page.getByRole("button", { name: "Check invitation" }).click();
  await expect(page.getByRole("button", { name: "Join workspace" })).toBeVisible();
});

test("a 202 join stays unconfirmed and is only reported once the outcome is known", async ({ page }) => {
  await signup(page, uniqueEmail("join-pending"), "Join Pending");
  // The workspace this account owns: a completed join has somewhere real to land.
  const workspaceId = (await personalWorkspaceRoute(page)).slice("/w/".length);
  const accepted: { operationId: string; token: string }[] = [];
  const polled: string[] = [];
  await page.route("**/invites/accept", (route) => {
    const body = route.request().postDataJSON() as { operationId: string; token: string };
    accepted.push(body);
    return route.fulfill({ json: { operationId: body.operationId, state: "preparing", recoveryPending: true } });
  });
  await page.route("**/access-changes/**", (route) => {
    const operationId = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    polled.push(operationId);
    if (polled.length === 1)
      return route.fulfill({ json: { operationId, state: "preparing", recoveryPending: true } });
    return route.fulfill({ json: { operationId, state: "completed", outcome: "committed", result: null } });
  });

  await openJoinPage(page, workspaceId);
  await page.getByRole("button", { name: "Join workspace" }).click();

  // A 202 is not a finished join, and the page says so while it polls the
  // attempt's own operationId.
  await expect(
    page.getByText("The invitation is still being accepted. This is not finished until the server confirms it."),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}$`), { timeout: 20_000 });

  expect(accepted).toHaveLength(1);
  expect(polled.length).toBeGreaterThanOrEqual(2);
  expect(polled.every((operationId) => operationId === accepted[0]!.operationId)).toBe(true);
});

test("a failed join request keeps the invitation retryable and the retried 202 resumes polling", async ({ page }) => {
  await signup(page, uniqueEmail("join-retry"), "Join Retry");
  // The workspace this account owns: a completed join has somewhere real to land.
  const workspaceId = (await personalWorkspaceRoute(page)).slice("/w/".length);
  const accepted: { operationId: string; token: string }[] = [];
  let statusReads = 0;
  await page.route("**/invites/accept", (route) => {
    const body = route.request().postDataJSON() as { operationId: string; token: string };
    accepted.push(body);
    // The first request never reaches the server: its outcome is unknown.
    if (accepted.length === 1) return route.abort("connectionfailed");
    return route.fulfill({ json: { operationId: body.operationId, state: "preparing", recoveryPending: true } });
  });
  await page.route("**/access-changes/**", (route) => {
    statusReads += 1;
    const operationId = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    // The server holds no journal row for the id yet.
    if (statusReads === 1) return route.fulfill({ status: 404, json: { error: "no such operation" } });
    return route.fulfill({ json: { operationId, state: "completed", outcome: "committed", result: null } });
  });

  await openJoinPage(page, workspaceId);
  await page.getByRole("button", { name: "Join workspace" }).click();

  // A failed request says nothing about the link itself.
  await expect(page.getByText("This workspace invitation is unavailable.")).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Retry join" });
  await expect(retry).toBeEnabled();

  // Retrying continues the same attempt instead of starting a rival one, and the
  // 202 it answers with re-arms the polling the 404 had stopped.
  await retry.click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}$`), { timeout: 20_000 });
  expect(accepted).toHaveLength(2);
  expect(accepted[1]!.operationId).toBe(accepted[0]!.operationId);
  expect(accepted.map((body) => body.token)).toEqual([INVITE_TOKEN, INVITE_TOKEN]);
  expect(statusReads).toBeGreaterThanOrEqual(2);
});

test("an unresolved workspace member change is retried under the same operationId", async ({ page }) => {
  await signup(page, uniqueEmail("member-retry"), "Member Retry");
  // The workspace this account owns: a completed join has somewhere real to land.
  const workspaceId = (await personalWorkspaceRoute(page)).slice("/w/".length);
  const roleChanges: { operationId: string; role: string }[] = [];
  let statusReads = 0;
  await page.route("**/workspaces/*/members**", (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({
        json: {
          members: [
            { userId: "member-2", email: "ada@example.test", name: "Ada Lovelace", avatarVersion: null, role: "member" },
          ],
        },
      });
    const body = request.postDataJSON() as { operationId: string; role: string };
    roleChanges.push(body);
    if (roleChanges.length === 1) return route.abort("connectionfailed");
    return route.fulfill({ json: { operationId: body.operationId, state: "preparing", recoveryPending: true } });
  });
  await page.route("**/access-changes/**", (route) => {
    statusReads += 1;
    const operationId = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    if (statusReads === 1) return route.fulfill({ status: 404, json: { error: "no such operation" } });
    return route.fulfill({ json: { operationId, state: "completed", outcome: "committed", result: null } });
  });

  await page.goto(`/w/${workspaceId}/members`);
  await page.getByLabel("Role for Ada Lovelace").selectOption("admin");

  // The rows stay locked while the change is unresolved, so the retry that
  // continues the same attempt has to be a control of its own.
  const retry = page.getByRole("button", { name: "Retry change for Ada Lovelace" });
  await expect(retry).toBeEnabled();
  await expect(page.getByLabel("Role for Ada Lovelace")).toBeDisabled();

  await retry.click();
  await expect.poll(() => statusReads).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Retrying continues the same attempt.")).toHaveCount(0, { timeout: 20_000 });
  expect(roleChanges).toHaveLength(2);
  expect(roleChanges[1]!.operationId).toBe(roleChanges[0]!.operationId);
  expect(roleChanges.map((body) => body.role)).toEqual(["admin", "admin"]);
});

test("a pending metadata read hides the stale board but keeps its mounted card draft", async ({ page }) => {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;
    window.__foxbanSockets = [];
    window.WebSocket = class extends OriginalWebSocket {
      constructor(...args: [string | URL, (string | string[])?]) {
        super(...args);
        if (/\/boards\/.*\/ws/.test(String(args[0] ?? ""))) window.__foxbanSockets?.push(this);
      }
    };
  });

  await signup(page, uniqueEmail("board-fence"), "Board Fence");
  const boardName = `Fenced Board ${Date.now()}`;
  const boardKey = await createBoard(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await addColumn(page, "Todo");
  await expect(page.getByRole("heading", { level: 1, name: boardName })).toBeVisible();

  // A draft that exists only in memory.
  await columnByTitle(page, "Todo").getByRole("button", { name: "Add card", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a card" });
  await dialog.getByLabel("Title").fill("Draft that must survive");

  // The board's authoritative metadata read now reports the server fence.
  let fenced = true;
  let fences = 0;
  await page.route(new RegExp(`/boards/by-key/${boardKey}(\\?.*)?$`), (route) => {
    if (!fenced) return route.continue();
    fences += 1;
    return route.fulfill({ status: FENCE_STATUS, headers: { "retry-after": "2" }, json: { error: "access_change_pending" } });
  });

  // A 4010 close sends the client back to that read while the change prepares.
  await page.evaluate(() => {
    for (const socket of window.__foxbanSockets ?? []) socket.close(4010, "access change");
  });
  await expect(
    page.getByText("Board access is changing… Your unsent drafts remain available while access is checked."),
  ).toBeVisible();
  await expect.poll(() => fences).toBeGreaterThan(0);

  // The board that is mounted is stale, so its content is hidden — but the view
  // and the draft it holds are the same mounted ones, not a route replacement.
  await expect(columnByTitle(page, "Todo")).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue("Draft that must survive");

  // The change is released: the same view comes back with its draft intact.
  fenced = false;
  await expect(columnByTitle(page, "Todo")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByLabel("Title")).toHaveValue("Draft that must survive");
});
