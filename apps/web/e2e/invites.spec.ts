import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { PASSWORD, createBoard, generateAccountInvite, openAccountInvites, openBoardList, openPersonalWorkspace, signup, submitSignup, uniqueEmail } from "./helpers";

/** The signup form's message for a missing, unknown or already-used invite. */
const REFUSED = "This signup needs a valid invite link. Ask an admin for a new one.";

/** Every pending invite renders its full link in a readonly input. */
function inviteLinks(page: Page): Locator {
  return page.getByRole("textbox", { name: /^Invite link for / });
}
type Admin = {
  page: Page;
  link: string;
  token: string;
  /** Invites are one shared pool, so the tests count relative to what was there. */
  otherPending: number;
};

/** Registers an admin (dev `ADMIN_EMAILS` is `*@admin.test`) and mints one link. */
async function adminWithInviteLink(browser: Browser, suffix: string): Promise<Admin> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signup(page, uniqueEmail(suffix), "Invite Admin");
  const { link, token, otherPending } = await generateAccountInvite(page);
  return { page, link, token, otherPending };
}
const fixtureDates = {
  oldUse: Date.UTC(2024, 0, 2),
  newUse: Date.UTC(2025, 6, 14),
};
const usedFixtures = [
  { token: "used-older", createdAt: Date.UTC(2025, 11, 1), usedBy: "user-1", usedAt: fixtureDates.oldUse },
  { token: "used-newer", createdAt: Date.UTC(2023, 1, 1), usedBy: "user-2", usedAt: fixtureDates.newUse },
  { token: "used-unknown", createdAt: Date.UTC(2026, 1, 1), usedBy: "user-3", usedAt: null },
];

test("account invite fixtures render populated, active-empty, and completely empty states", async ({ page }) => {
  let fixture = [
    { token: "active-old", createdAt: Date.UTC(2024, 4, 1), usedBy: null, usedAt: null },
    { token: "active-new-one", createdAt: Date.UTC(2025, 4, 1), usedBy: null, usedAt: null },
    ...usedFixtures,
  ];
  await page.route("**/invites", async (route) => {
    if (route.request().resourceType() !== "fetch" || route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { invites: fixture } });
  });
  await signup(page, uniqueEmail("invites-fixtures"), "Invite Fixture Admin");
  const main = await openAccountInvites(page);
  await expect(main.getByRole("heading", { name: "Active links 2" })).toBeVisible();
  await expect(main.getByRole("textbox", { name: "Invite link for active-n" })).toHaveValue(/active-new-one$/);
  await expect(main.getByText("No active invite links")).toHaveCount(0);
  await expect(main.getByRole("heading", { name: "Invite history 3" })).toBeVisible();
  const historyRows = main.locator(".account-invites-timeline li");
  await expect(historyRows).toHaveCount(3);
  await expect(historyRows.nth(0)).toContainText(new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(fixtureDates.newUse));
  await expect(historyRows.nth(1)).toContainText(new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(fixtureDates.oldUse));
  await expect(historyRows.nth(2)).toContainText("Unknown");
  await expect(historyRows.getByRole("textbox")).toHaveCount(0);
  await expect(historyRows.getByRole("button", { name: /^Revoke invite/ })).toHaveCount(0);

  fixture = [...usedFixtures];
  await page.reload();
  await expect(main.getByRole("heading", { name: "Active links 0" })).toBeVisible();
  await expect(main.getByText("No active invite links")).toBeVisible();
  await expect(main.getByRole("heading", { name: "Invite history 3" })).toBeVisible();

  fixture = [];
  await page.reload();
  await expect(main.getByRole("heading", { name: "Active links 0" })).toBeVisible();
  await expect(main.getByText("No active invite links")).toBeVisible();
  await expect(main.getByRole("heading", { name: "Invite history 0" })).toBeVisible();
  await expect(main.getByText("No used invites yet.")).toBeVisible();
});

test("invite page keeps content through recoverable request and clipboard failures", async ({ page }) => {
  let getCalls = 0;
  await page.route("**/invites", async (route) => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    if (route.request().method() === "GET") {
      getCalls += 1;
      if (getCalls <= 4) return route.fulfill({ status: 500, json: { error: "synthetic list failure" } });
      return route.fulfill({ json: { invites: [{ token: "retained-active", createdAt: Date.UTC(2025, 1, 1), usedBy: null, usedAt: null }] } });
    }
    if (route.request().method() === "POST") return route.fulfill({ status: 500, json: { error: "synthetic generation failure" } });
    return route.continue();
  });
  await signup(page, uniqueEmail("invites-recovery"), "Invite Recovery Admin");
  await page.getByRole("link", { name: "Account invites" }).filter({ visible: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Could not load invites.");
  await page.getByRole("button", { name: "Try again" }).click();
  const retained = page.getByRole("textbox", { name: "Invite link for retained" });
  await expect(retained).toBeVisible();
  await page.getByRole("button", { name: "Generate invite link" }).click();
  await expect(page.getByRole("alert")).toHaveText("Could not generate an invite link.");
  await expect(retained).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("clipboard unavailable"); } },
    });
  });
  await page.getByRole("button", { name: "Copy invite link for retained" }).click();
  await expect(page.getByText("Invite link copied to clipboard")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy invite link for retained" })).toHaveText(/Copy link/);
});

test("generating before the initial invite list loads keeps the returned link after the stale response", async ({ page }) => {
  const initialReached = Promise.withResolvers<void>();
  const initialRelease = Promise.withResolvers<void>();
  const initialFinished = Promise.withResolvers<void>();
  const refreshRelease = Promise.withResolvers<void>();
  const token = "generated-before-initial-list";
  let getCalls = 0;
  await page.route("**/invites", async (route) => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    if (route.request().method() === "POST") return route.fulfill({ json: { token } });
    if (route.request().method() !== "GET") return route.continue();
    getCalls += 1;
    if (getCalls === 1) {
      initialReached.resolve();
      await initialRelease.promise;
      await route.fulfill({ json: { invites: [] } });
      initialFinished.resolve();
      return;
    }
    await refreshRelease.promise;
    return route.fulfill({ json: { invites: [{ token, createdAt: Date.now(), usedBy: null, usedAt: null }] } });
  });
  await signup(page, uniqueEmail("invites-initial-race"), "Invite Race Admin");
  await page.getByRole("link", { name: "Account invites" }).filter({ visible: true }).click();
  await initialReached.promise;
  await expect(page.getByText("loading invites…")).toBeVisible();
  await page.getByRole("button", { name: "Generate invite link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invite link generated." })).toBeVisible();
  initialRelease.resolve();
  await initialFinished.promise;

  const returnedLink = page.getByRole("textbox", { name: `Invite link for ${token.slice(0, 8)}`, exact: true });
  await expect(returnedLink).toHaveValue(`${new URL(page.url()).origin}/signup?invite=${token}`);
  await expect.poll(() => getCalls).toBe(2);
  await expect(page.getByRole("button", { name: "Generating…" })).toBeDisabled();
  refreshRelease.resolve();
  await expect(page.getByRole("button", { name: "Generate invite link" })).toBeEnabled();
  await expect(returnedLink).toHaveValue(`${new URL(page.url()).origin}/signup?invite=${token}`);
});

test("invite mutation locks survive navigation until generation and revocation settle", async ({ page }) => {
  await signup(page, uniqueEmail("invites-navigation-lock"), "Invite Lock Admin");
  const main = await openAccountInvites(page);
  const seeded = await generateAccountInvite(page);
  const initialCount = await inviteLinks(page).count();

  const postReached = Promise.withResolvers<void>();
  const postRelease = Promise.withResolvers<void>();
  await page.route("**/invites", async (route) => {
    if (route.request().resourceType() !== "fetch" || route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    postReached.resolve();
    await postRelease.promise;
    await route.fulfill({ response });
  }, { times: 1 });
  await main.getByRole("button", { name: "Generate invite link" }).click();
  await postReached.promise;
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  const remountedAfterPost = await openAccountInvites(page);
  await expect(remountedAfterPost.getByRole("button", { name: "Generate invite link" })).toBeDisabled();
  await expect(remountedAfterPost.getByRole("button", { name: /^Revoke invite/ }).first()).toBeDisabled();
  postRelease.resolve();
  await expect(inviteLinks(page)).toHaveCount(initialCount + 1);
  await expect(remountedAfterPost.getByRole("button", { name: "Generate invite link" })).toBeEnabled();

  const generatedLink = await inviteLinks(page).first().inputValue();
  const token = new URL(generatedLink).searchParams.get("invite");
  if (!token) throw new Error(`generated invite link carried no token: ${generatedLink}`);
  const deleteReached = Promise.withResolvers<void>();
  const deleteRelease = Promise.withResolvers<void>();
  await page.route(`**/invites/${token}`, async (route) => {
    const response = await route.fetch();
    deleteReached.resolve();
    await deleteRelease.promise;
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole("button", { name: `Revoke invite ${token.slice(0, 8)}` }).click();
  await deleteReached.promise;
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  const remountedAfterDelete = await openAccountInvites(page);
  await expect(remountedAfterDelete.getByRole("button", { name: "Generate invite link" })).toBeDisabled();
  await expect(remountedAfterDelete.getByRole("button", { name: /^Revoke invite/ }).first()).toBeDisabled();
  deleteRelease.resolve();
  await expect(inviteLinks(page)).toHaveCount(initialCount);
  await expect(remountedAfterDelete.getByRole("button", { name: "Generate invite link" })).toBeEnabled();
  await page.getByRole("button", { name: `Revoke invite ${seeded.token.slice(0, 8)}` }).click();
  await expect(inviteLinks(page)).toHaveCount(initialCount - 1);
});

test("account invites is a reloadable admin workspace route with guarded direct access", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signup(admin, uniqueEmail("invites-route"), "Invite Route Admin");
  await openAccountInvites(admin);
  await expect(admin).toHaveURL("/account-invites");
  await expect(admin.getByRole("link", { name: "Account invites" }).filter({ visible: true })).toHaveAttribute("data-status", "active");
  expect(await admin.getByRole("main").evaluate((node) => Boolean(node.closest("[inert]")))).toBe(false);
  await admin.reload();
  await expect(admin.getByRole("heading", { name: "Account invites", exact: true })).toBeVisible();
  await admin.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(admin).toHaveURL("/profile");
  await openAccountInvites(admin);
  await admin.goBack();
  await expect(admin).toHaveURL("/profile");
  await openBoardList(admin);
  await expect(admin.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
  const boardKey = await createBoard(admin, `Invite Route Board ${Date.now()}`);
  await admin.goto(`/board/${boardKey}`);
  await openAccountInvites(admin);
  await expect(admin).toHaveURL("/account-invites");

  await admin.evaluate(async () => {
    const { queryClient } = await import("/src/lib/query-client.ts");
    const current = queryClient.getQueryData<{ isAdmin: boolean }>(["me"]);
    queryClient.setQueryData(["me"], current ? { ...current, isAdmin: false } : null);
  });
  await expect(admin).not.toHaveURL(/\/account-invites$/);
  await expect(admin.getByRole("heading", { name: "Account invites" })).toHaveCount(0);

  const anonymous = await browser.newPage();
  let anonymousInvitesRequests = 0;
  await anonymous.route("**/invites", async (route) => {
    if (route.request().resourceType() === "fetch") anonymousInvitesRequests += 1;
    await route.continue();
  });
  await anonymous.goto("/account-invites");
  await expect(anonymous).toHaveURL("/login");
  expect(anonymousInvitesRequests).toBe(0);
  await anonymous.close();
  await adminContext.close();
});


test("an admin's invite link registers one plain user and is then spent", async ({ browser }) => {
  const admin = await adminWithInviteLink(browser, "invites-link");
  expect(admin.link).toBe(`${new URL(admin.page.url()).origin}/signup?invite=${admin.token}`);

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  // Straight through the rendered link, not a hand-built URL.
  await guest.goto(admin.link);
  await guest.getByLabel("Email").fill(uniqueEmail("invites-guest", "foxban.test"));
  await guest.getByLabel("Name").fill("Invited Guest");
  await guest.getByLabel("Password").fill(PASSWORD);
  await expect(guest.getByText("Invite link detected.")).toBeVisible();
  await guest.getByRole("button", { name: "Create account" }).click();

  await openPersonalWorkspace(guest);
  await expect(guest.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();

  // The consumed token is inert on the admin's side: listed, but no link to copy.
  await admin.page.reload();
  const invitesDialog = await openAccountInvites(admin.page);
  await expect(invitesDialog.getByText("Used", { exact: true }).first()).toBeVisible();
  await expect(inviteLinks(admin.page)).toHaveCount(admin.otherPending);
  const remaining = await inviteLinks(admin.page).evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLInputElement).value),
  );
  expect(remaining).not.toContain(admin.link);

  await admin.page.context().close();
  await guestContext.close();
});

test("a spent invite link is refused on a second signup", async ({ browser }) => {
  const admin = await adminWithInviteLink(browser, "invites-reuse");

  const firstContext = await browser.newContext();
  const first = await firstContext.newPage();
  await signup(first, uniqueEmail("invites-reuse-first", "foxban.test"), "First Guest", admin.token);

  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  await submitSignup(
    second,
    uniqueEmail("invites-reuse-second", "foxban.test"),
    "Second Guest",
    admin.token,
  );

  await expect(second.getByRole("alert")).toHaveText(REFUSED);
  await expect(second).toHaveURL(`/signup?invite=${admin.token}`);

  await admin.page.context().close();
  await firstContext.close();
  await secondContext.close();
});

test("a revoked invite link is refused", async ({ browser }) => {
  const admin = await adminWithInviteLink(browser, "invites-revoke");

  // The fresh row is the first one, so its Revoke is the first one too.
  await admin.page
    .getByRole("button", { name: `Revoke invite ${admin.token.slice(0, 8)}` })
    .click();
  await expect(
    admin.page.getByRole("status").filter({ hasText: "Invite revoked." }),
  ).toHaveText("Invite revoked.");
  await expect(inviteLinks(admin.page)).toHaveCount(admin.otherPending);
  const remaining = await inviteLinks(admin.page).evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLInputElement).value),
  );
  expect(remaining).not.toContain(admin.link);

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await submitSignup(
    guest,
    uniqueEmail("invites-revoked", "foxban.test"),
    "Revoked Guest",
    admin.token,
  );

  await expect(guest.getByRole("alert")).toHaveText(REFUSED);

  await admin.page.context().close();
  await guestContext.close();
});

test("a plain user gets no invites section and cannot sign up without a link", async ({
  browser,
}) => {
  const admin = await adminWithInviteLink(browser, "invites-nonadmin");

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await signup(guest, uniqueEmail("invites-nonadmin-guest", "foxban.test"), "Guest", admin.token);
  await expect(guest.getByRole("heading", { name: "Account invites" })).toHaveCount(0);
  await expect(guest.getByRole("button", { name: "Generate invite link" })).toHaveCount(0);

  const strangerContext = await browser.newContext();
  const stranger = await strangerContext.newPage();
  // The invite-less form stays (admin-domain emails use it), but says so up front.
  await stranger.goto("/signup");
  await expect(
    stranger.getByText("No invite link detected — ask an admin for one if you need an account."),
  ).toBeVisible();
  await submitSignup(stranger, uniqueEmail("invites-stranger", "foxban.test"), "Stranger");

  await expect(stranger.getByRole("alert")).toHaveText(REFUSED);
  await expect(stranger).toHaveURL("/signup");

  await admin.page.context().close();
  await strangerContext.close();
  await guestContext.close();
});

test("pending invites have distinct token-qualified accessible names and copy reannounces after reversion", async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await signup(page, uniqueEmail("invites-token-names"), "Invite Admin");
  await openAccountInvites(page);

  await expect(page.getByRole("heading", { name: "Account invites" })).toBeVisible();
  await expect(page.getByText("loading invites…")).toHaveCount(0);
  const initialPending = await inviteLinks(page).count();

  // Generate first invite link
  await page.getByRole("button", { name: "Generate invite link" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Invite link generated." }),
  ).toHaveText("Invite link generated.");
  await expect(inviteLinks(page)).toHaveCount(initialPending + 1);
  const link1 = await inviteLinks(page).first().inputValue();
  const token1 = new URL(link1).searchParams.get("invite");
  if (!token1) throw new Error(`first invite link had no token: ${link1}`);

  // Generate second invite link
  await page.getByRole("button", { name: "Generate invite link" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Invite link generated." }),
  ).toHaveText("Invite link generated.");
  await expect(inviteLinks(page)).toHaveCount(initialPending + 2);
  const link2 = await inviteLinks(page).first().inputValue();
  const token2 = new URL(link2).searchParams.get("invite");
  if (!token2) throw new Error(`second invite link had no token: ${link2}`);

  expect(token1).not.toBe(token2);
  const short1 = token1.slice(0, 8);
  const short2 = token2.slice(0, 8);
  expect(short1).not.toBe(short2);

  // Prove at least two pending invite inputs have distinct accessible names tied to their own token
  const input1 = page.getByRole("textbox", { name: `Invite link for ${short1}`, exact: true });
  const input2 = page.getByRole("textbox", { name: `Invite link for ${short2}`, exact: true });
  await expect(input1).toBeVisible();
  await expect(input2).toBeVisible();
  await expect(input1).toHaveAccessibleName(`Invite link for ${short1}`);
  await expect(input2).toHaveAccessibleName(`Invite link for ${short2}`);
  await expect(input1).toHaveValue(link1);
  await expect(input2).toHaveValue(link2);

  // Distinct Copy and Revoke controls tied to each token
  const copy1 = page.getByRole("button", { name: `Copy invite link for ${short1}` });
  const copy2 = page.getByRole("button", { name: `Copy invite link for ${short2}` });
  await expect(copy1).toHaveAccessibleName(`Copy invite link for ${short1}`);
  await expect(copy2).toHaveAccessibleName(`Copy invite link for ${short2}`);

  const revoke1 = page.getByRole("button", { name: `Revoke invite ${short1}` });
  const revoke2 = page.getByRole("button", { name: `Revoke invite ${short2}` });
  await expect(revoke1).toHaveAccessibleName(`Revoke invite ${short1}`);
  await expect(revoke2).toHaveAccessibleName(`Revoke invite ${short2}`);

  // Exercise Copy with a deterministic clipboard stub/permission
  await page.evaluate(() => {
    let text = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (val: string) => {
          text = val;
        },
        readText: async () => text,
      },
      configurable: true,
    });
  });

  const copyStatus = page
    .getByRole("status")
    .filter({ hasText: "Invite link copied to clipboard" });

  // Initial copy: exact status appears, button changes to Copied
  await copy1.click();
  await expect(copy1).toHaveText("Copied");
  await expect(copyStatus).toHaveText("Invite link copied to clipboard");

  // Returns from Copied to its idle label and the exact URL is on the clipboard.
  await expect(copy1).toHaveText(/Copy link/, { timeout: 4000 });
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link1);
  await expect(page.getByText("Invite link copied to clipboard")).toHaveCount(0);

  // Later copy produces a fresh announcement
  await copy1.click();
  await expect(copy1).toHaveText("Copied");
  await expect(copyStatus).toHaveText("Invite link copied to clipboard");
  await expect(copy1).toHaveText(/Copy link/, { timeout: 4000 });
  await expect(page.getByText("Invite link copied to clipboard")).toHaveCount(0);

  await context.close();
});

test("a failed revoke preserves actionable alert while row remains and clears it when row disappears on refetch", async ({
  browser,
}) => {
  const admin = await adminWithInviteLink(browser, "invites-fail-revoke");
  const { page, token } = admin;

  // 1. Still-present-row server failure: DELETE fails with 500, but GET still returns the row.
  await page.route(`**/invites/${token}`, (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 500, json: { error: "Database unavailable" } });
    }
    return route.continue();
  });
  const shortToken = token.slice(0, 8);
  const revokeBtn = page.getByRole("button", { name: `Revoke invite ${shortToken}` });
  await revokeBtn.click();

  // Alert is visible and actionable because row is still present
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("Could not revoke that invite.");
  await expect(
    page.getByRole("textbox", { name: `Invite link for ${shortToken}`, exact: true }),
  ).toBeVisible();

  // 2. Disappeared-target revoke: route DELETE failure plus GET response without that token.
  await page.unroute(`**/invites/${token}`);

  await page.route("**/invites*", async (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 500, json: { error: "Failed again" } });
    }
    if (route.request().method() === "GET") {
      const response = await route.fetch();
      const json = (await response.json()) as { invites: Array<{ token: string }> };
      return route.fulfill({
        json: {
          invites: json.invites.filter((inv) => inv.token !== token),
        },
      });
    }
    return route.continue();
  });

  await revokeBtn.click();

  // The row disappears on refetch, and the component's useEffect clears the stale revoke alert
  await expect(
    page.getByRole("textbox", { name: `Invite link for ${shortToken}`, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.unroute("**/invites*");
  await page.context().close();
});
