import { expect, test } from "@playwright/test";
import { signup, uniqueEmail } from "./helpers";

test("creates a workspace invitation without exposing old link secrets", async ({ page }) => {
  await signup(page, uniqueEmail("workspace-invite"), "Workspace Owner");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Create link" }).click();
  const link = page.getByRole("textbox", { name: "Workspace invitation link" });
  await expect(link).toBeVisible();
  await expect(link).toHaveValue(/\/join-workspace\/[^#]+#invite=/);
  await expect(page.getByText(/expires/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();
});

test("creating an invitation replaces a pending initial list request", async ({ page }) => {
  await signup(page, uniqueEmail("workspace-invite-race"), "Workspace Owner");
  let releaseInitial!: () => void;
  const held = new Promise<void>((resolve) => { releaseInitial = resolve; });
  let initialStarted!: () => void;
  const started = new Promise<void>((resolve) => { initialStarted = resolve; });
  let first = true;
  await page.route("**/workspaces/*/invites", async (route) => {
    if (route.request().method() !== "GET" || !first) return route.fallback();
    first = false;
    const response = await route.fetch();
    initialStarted();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("link", { name: "Settings" }).click();
  await started;
  try {
    await page.getByRole("button", { name: "Create link" }).click();
    await expect(page.getByRole("textbox", { name: "Workspace invitation link" })).toHaveValue(/#invite=/);
    // The new GET must finish while the older, empty list is still held.
    await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();
  } finally {
    releaseInitial();
  }
  await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();
});

test("workspace join token remains in the fragment", async ({ page }) => {
  await page.goto("/join-workspace/example#invite=abcdefghijklmnopqrstuvwxyzABCDEFGH123456789");
  await expect(page.getByRole("heading", { name: "Join a workspace" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login#workspaceInvite=/);
  expect(new URL(page.url()).search).toBe("");
});

test("invitation list and revoke failures are announced and recoverable", async ({ page }) => {
  await signup(page, uniqueEmail("workspace-invite-fail"), "Workspace Owner");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Create link" }).click();
  const revokeButton = page.getByRole("button", { name: "Revoke" });
  await expect(revokeButton).toBeVisible();

  let failList = true;
  await page.route("**/workspaces/*/invites", async (route) => {
    if (route.request().method() === "GET" && failList) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
      return;
    }
    await route.fallback();
  });
  await page.reload();
  // The query retries before it settles as an error.
  await expect(page.getByRole("alert").filter({ hasText: "Could not load invitation links." })).toBeVisible({
    timeout: 20_000,
  });
  await expect(revokeButton).toHaveCount(0);
  failList = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(revokeButton).toBeVisible();
  await expect(page.getByText("Could not load invitation links.")).toHaveCount(0);

  await page.route("**/workspaces/*/invites/*", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
      return;
    }
    await route.fallback();
  });
  await revokeButton.click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not revoke that invitation." })).toBeVisible();
  await expect(revokeButton).toBeVisible();
  await expect(page.getByText(/expires/)).toBeVisible();
});
