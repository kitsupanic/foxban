import { expect, test, type Browser, type Page } from "@playwright/test";
import { PASSWORD, createBoard, generateAccountInvite, inviteLinkFor, revokeButtonFor, mintedInvite, openAccountInvites, openBoardList, openPersonalWorkspace, signup, submitSignup, uniqueEmail } from "./helpers";

/** The signup form's message for a missing, unknown or already-used invite. */
const REFUSED = "This signup needs a valid invite link. Ask an admin for a new one.";

type Admin = {
  page: Page;
  link: string;
  token: string;
  id: string;
};

/** Registers an admin (an `@admin.test` address from the pool `.dev.vars` lists) and mints one link. */
async function adminWithInviteLink(browser: Browser, suffix: string): Promise<Admin> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signup(page, uniqueEmail(suffix), "Invite Admin");
  const { link, token, id } = await generateAccountInvite(page);
  return { page, link, token, id };
}
const fixtureDates = {
  oldUse: Date.UTC(2024, 0, 2),
  newUse: Date.UTC(2025, 6, 14),
};
// ADR 0085: the list carries the hash as `id` and an expiry, never a token.
const week = 7 * 24 * 60 * 60 * 1000;
const fixtureInvite = (id: string, createdAt: number, usedBy: string | null = null, usedAt: number | null = null) =>
  ({ id, createdAt, expiresAt: createdAt + week, usedBy, usedAt });
const usedFixtures = [
  fixtureInvite("used-older", Date.UTC(2025, 11, 1), "user-1", fixtureDates.oldUse),
  fixtureInvite("used-newer", Date.UTC(2023, 1, 1), "user-2", fixtureDates.newUse),
  fixtureInvite("used-unknown", Date.UTC(2026, 1, 1), "user-3", null),
];

test("account invite fixtures render populated, active-empty, and completely empty states", async ({ page }) => {
  let fixture = [
    fixtureInvite("active-old", Date.UTC(2024, 4, 1)),
    fixtureInvite("active-new-one", Date.UTC(2025, 4, 1)),
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
  // The server keeps no token, so a listed link is never rendered: only its dates and Revoke are.
  await expect(main.getByRole("button", { name: "Revoke invite active-n", exact: true })).toBeVisible();
  await expect(main.getByRole("button", { name: "Revoke invite active-o", exact: true })).toBeVisible();
  await expect(main.getByText("Link not kept")).toHaveCount(2);
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await expect(main.getByText(`expires ${new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(Date.UTC(2025, 4, 1) + week)}`)).toBeVisible();
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
  let generateFails = true;
  const retainedInvite = fixtureInvite("retained-active", Date.UTC(2025, 1, 1));
  const madeInvite = fixtureInvite("clipboard-made", Date.now());
  const madeToken = "clipboard-made-token";
  await page.route("**/invites", async (route) => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    if (route.request().method() === "GET") {
      getCalls += 1;
      if (getCalls <= 4) return route.fulfill({ status: 500, json: { error: "synthetic list failure" } });
      return route.fulfill({ json: { invites: generateFails ? [retainedInvite] : [madeInvite, retainedInvite] } });
    }
    if (route.request().method() === "POST") {
      if (generateFails) return route.fulfill({ status: 500, json: { error: "synthetic generation failure" } });
      return route.fulfill({ json: { ...madeInvite, token: madeToken } });
    }
    return route.continue();
  });
  await signup(page, uniqueEmail("invites-recovery"), "Invite Recovery Admin");
  await page.getByRole("link", { name: "Account invites" }).filter({ visible: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Could not load invites.");
  await page.getByRole("button", { name: "Try again" }).click();
  // A listed row has no link (ADR 0085), so the row itself is what must survive.
  const retained = page.getByRole("button", { name: "Revoke invite retained", exact: true });
  await expect(retained).toBeVisible();
  await page.getByRole("button", { name: "Generate invite link" }).click();
  await expect(page.getByRole("alert")).toHaveText("Could not generate an invite link.");
  await expect(retained).toBeVisible();

  // Copy needs a link, which only a successful generation in this tab provides.
  generateFails = false;
  await page.getByRole("button", { name: "Generate invite link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invite link generated." })).toBeVisible();
  await expect(retained).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("clipboard unavailable"); } },
    });
  });
  await page.getByRole("button", { name: "Copy invite link for clipboar", exact: true }).click();
  await expect(page.getByText("Invite link copied to clipboard")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy invite link for clipboar", exact: true })).toHaveText(/Copy link/);
});

test("generating before the initial invite list loads keeps the returned link after the stale response", async ({ page }) => {
  const initialReached = Promise.withResolvers<void>();
  const initialRelease = Promise.withResolvers<void>();
  const initialFinished = Promise.withResolvers<void>();
  const refreshRelease = Promise.withResolvers<void>();
  const id = "generated-before-initial-list";
  const token = "token-of-generated-before-initial-list";
  const generated = { id, createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  let getCalls = 0;
  await page.route("**/invites", async (route) => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    if (route.request().method() === "POST") return route.fulfill({ json: { ...generated, token } });
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
    return route.fulfill({ json: { invites: [{ ...generated, usedBy: null, usedAt: null }] } });
  });
  await signup(page, uniqueEmail("invites-initial-race"), "Invite Race Admin");
  await page.getByRole("link", { name: "Account invites" }).filter({ visible: true }).click();
  await initialReached.promise;
  await expect(page.getByText("loading invites…")).toBeVisible();
  await page.getByRole("button", { name: "Generate invite link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invite link generated." })).toBeVisible();
  initialRelease.resolve();
  await initialFinished.promise;

  const returnedLink = page.getByRole("textbox", { name: `Invite link for ${id.slice(0, 8)}`, exact: true });
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

  const postReached = Promise.withResolvers<void>();
  const postRelease = Promise.withResolvers<void>();
  // Never `times: 1` here: the route would be removed just as the held POST settles, and the
  // settle-time GET /invites refetch can land in that gap and hang, keeping the lock on.
  let postHeld = false;
  await page.route("**/invites", async (route) => {
    if (postHeld || route.request().resourceType() !== "fetch" || route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    postHeld = true;
    const response = await route.fetch();
    postReached.resolve();
    await postRelease.promise;
    await route.fulfill({ response });
  });
  const minted = mintedInvite(page);
  await main.getByRole("button", { name: "Generate invite link" }).click();
  await postReached.promise;
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  const remountedAfterPost = await openAccountInvites(page);
  await expect(remountedAfterPost.getByRole("button", { name: "Generate invite link" })).toBeDisabled();
  await expect(remountedAfterPost.getByRole("button", { name: /^Revoke invite/ }).first()).toBeDisabled();
  postRelease.resolve();
  const { id } = await minted;
  // The generating page unmounted while the POST was held, so its one-time link is gone (ADR 0085):
  // the row still lands, as a listed invite without a link.
  await expect(revokeButtonFor(page, id)).toBeVisible();
  await expect(inviteLinkFor(page, id)).toHaveCount(0);
  await expect(remountedAfterPost.getByRole("button", { name: "Generate invite link" })).toBeEnabled();
  const deleteReached = Promise.withResolvers<void>();
  const deleteRelease = Promise.withResolvers<void>();
  let deleteHeld = false;
  await page.route(`**/invites/${id}`, async (route) => {
    if (deleteHeld) {
      await route.fallback();
      return;
    }
    deleteHeld = true;
    const response = await route.fetch();
    deleteReached.resolve();
    await deleteRelease.promise;
    await route.fulfill({ response });
  });
  await revokeButtonFor(page, id).click();
  await deleteReached.promise;
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  const remountedAfterDelete = await openAccountInvites(page);
  await expect(remountedAfterDelete.getByRole("button", { name: "Generate invite link" })).toBeDisabled();
  await expect(remountedAfterDelete.getByRole("button", { name: /^Revoke invite/ }).first()).toBeDisabled();
  deleteRelease.resolve();
  await expect(revokeButtonFor(page, id)).toHaveCount(0);
  await expect(remountedAfterDelete.getByRole("button", { name: "Generate invite link" })).toBeEnabled();
  await revokeButtonFor(page, seeded.id).click();
  await expect(revokeButtonFor(page, seeded.id)).toHaveCount(0);
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

  // The consumed token is inert on the admin's side: listed, but no link to copy or revoke.
  await admin.page.reload();
  const invitesDialog = await openAccountInvites(admin.page);
  await expect(invitesDialog.getByText("Used", { exact: true }).first()).toBeVisible();
  await expect(inviteLinkFor(admin.page, admin.id)).toHaveCount(0);
  await expect(revokeButtonFor(admin.page, admin.id)).toHaveCount(0);

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
  await revokeButtonFor(admin.page, admin.id).click();
  await expect(
    admin.page.getByRole("status").filter({ hasText: "Invite revoked." }),
  ).toHaveText("Invite revoked.");
  await expect(inviteLinkFor(admin.page, admin.id)).toHaveCount(0);
  await expect(revokeButtonFor(admin.page, admin.id)).toHaveCount(0);

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

test("pending invites have distinct id-qualified accessible names and copy reannounces after reversion", async ({
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
  const { link: link1, id: id1 } = await generateAccountInvite(page);
  const { link: link2, id: id2 } = await generateAccountInvite(page);

  expect(id1).not.toBe(id2);
  const short1 = id1.slice(0, 8);
  const short2 = id2.slice(0, 8);
  expect(short1).not.toBe(short2);

  // Prove at least two pending invite inputs have distinct accessible names tied to their own invite id
  const input1 = page.getByRole("textbox", { name: `Invite link for ${short1}`, exact: true });
  const input2 = page.getByRole("textbox", { name: `Invite link for ${short2}`, exact: true });
  await expect(input1).toBeVisible();
  await expect(input2).toBeVisible();
  await expect(input1).toHaveAccessibleName(`Invite link for ${short1}`);
  await expect(input2).toHaveAccessibleName(`Invite link for ${short2}`);
  await expect(input1).toHaveValue(link1);
  await expect(input2).toHaveValue(link2);

  // Distinct Copy and Revoke controls tied to each invite id
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
  const { page, id } = admin;

  // 1. Still-present-row server failure: DELETE fails with 500, but GET still returns the row.
  await page.route(`**/invites/${id}`, (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 500, json: { error: "Database unavailable" } });
    }
    return route.continue();
  });
  const shortToken = id.slice(0, 8);
  const revokeBtn = page.getByRole("button", { name: `Revoke invite ${shortToken}` });
  await revokeBtn.click();

  // Alert is visible and actionable because row is still present
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("Could not revoke that invite.");
  await expect(
    page.getByRole("textbox", { name: `Invite link for ${shortToken}`, exact: true }),
  ).toBeVisible();

  // 2. Disappeared-target revoke: route DELETE failure plus GET response without that token.
  await page.unroute(`**/invites/${id}`);

  await page.route("**/invites*", async (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 500, json: { error: "Failed again" } });
    }
    if (route.request().method() === "GET") {
      const response = await route.fetch();
      const json = (await response.json()) as { invites: Array<{ id: string }> };
      return route.fulfill({
        json: {
          invites: json.invites.filter((inv) => inv.id !== id),
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

test("a generated link is shown once: after a reload the row has no link, only Revoke", async ({ browser }) => {
  const admin = await adminWithInviteLink(browser, "invites-shown-once");
  const { page, id } = admin;

  // The server list never carries a token (ADR 0085).
  const listed = await page.request.get("/invites");
  expect(listed.status()).toBe(200);
  const { invites } = (await listed.json()) as { invites: Array<Record<string, unknown>> };
  const row = invites.find((invite) => invite.id === id);
  expect(row).toBeDefined();
  expect(row).not.toHaveProperty("token");
  expect(typeof row?.expiresAt).toBe("number");
  expect(JSON.stringify(invites)).not.toContain(admin.token);

  await page.reload();
  const main = await openAccountInvites(page);
  await expect(revokeButtonFor(page, id)).toBeVisible();
  await expect(inviteLinkFor(page, id)).toHaveCount(0);
  await expect(main.getByText("Link not kept").first()).toBeVisible();

  // The unseen link still works until revoked: revoking goes by id.
  await revokeButtonFor(page, id).click();
  await expect(main.getByRole("status").filter({ hasText: "Invite revoked." })).toBeVisible();
  await expect(revokeButtonFor(page, id)).toHaveCount(0);

  await page.context().close();
});
