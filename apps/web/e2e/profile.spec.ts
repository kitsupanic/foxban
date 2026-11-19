import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  ensureGitHubApp,
  generateAccountInvite,
  openAccountInvites,
  openBoardList,
  openPersonalWorkspace,
  PASSWORD,
  personalWorkspaceRoute,
  signup,
  uniqueEmail,
} from "./helpers";

/**
 * GitHub linking through the instance GitHub App and the avatar it feeds. The OAuth hop itself goes to the
 * localhost stub server (`github-stub.mjs`, wired in via `.dev.vars`), so
 * routing `https://github.com/**` only ever intercepts the avatar image — stubbed
 * here for determinism, and itself the proof that the client asks for the
 * documented URL. The app's own assets are never intercepted.
 *
 * No other e2e user connects GitHub, which is why every existing initials
 * assertion still sees the fallback path.
 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const GIF_1X1 = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const AVATAR_HOST = "https://github.com/**";
const OCTOCAT_SRC = 'img[src="https://github.com/octocat.png?size=48"]';

/** The visible account control: the sidebar and the mobile banner both mount one. */
function accountButton(page: Page): Locator {
  return page.getByRole("button", { name: "Your account" }).filter({ visible: true });
}

/** One of the four visible Profile groups, located by its own heading. */
function profileSection(page: Page, name: string): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name }) });
}

/** A profile status message, matched by its own text across sections. */
function profileStatus(page: Page, text: string): Locator {
  return page.getByRole("status").filter({ hasText: text });
}

/** "Connect GitHub" asks for the current password first (ADR 0081); the signed-up account's is `PASSWORD`. */
async function submitConnectGitHub(page: Page, password: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Connect GitHub" });
  await dialog.getByLabel("Current password").fill(password);
  await dialog.getByRole("button", { name: "Connect GitHub" }).click();
}

async function connectGitHub(page: Page): Promise<void> {
  await ensureGitHubApp(page);
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  await submitConnectGitHub(page, PASSWORD);
  await page.waitForURL("**/profile");
  await expect(page.getByText("@octocat")).toBeVisible();
}

test("connecting GitHub puts an avatar on the header, picker, card and comment", async ({
  page,
}) => {
  await page.route(AVATAR_HOST, (route) =>
    route.fulfill({ contentType: "image/png", body: PNG_1X1 }),
  );

  await signup(page, uniqueEmail("profile-set"), "Ada Avatar");

  // The whole verified chain: consent redirect, state round-trip, the Worker's
  // token + /user exchange, the D1 write, and a fresh /me on the way back.
  await connectGitHub(page);
  await expect(accountButton(page).locator(OCTOCAT_SRC)).toBeVisible();

  const boardName = `Profile ${Date.now()}`;
  await openBoardList(page);
  const boardId = await createBoard(page, boardName);
  await page.goto(`/board/${boardId}`);
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "avatar card");

  const card = cardIn(columnByTitle(page, "Todo"), "avatar card");
  await card.click();
  const dialog = page.getByRole("dialog");

  await dialog.getByRole("button", { name: "Assignee" }).click();
  const option = dialog.getByRole("option", { name: "Ada Avatar" });
  await expect(option.locator(OCTOCAT_SRC)).toBeVisible();
  await option.click();
  // The chip keeps its tooltip; the avatar replaces the initials inside it.
  await expect(card.getByTitle("Ada Avatar").locator(OCTOCAT_SRC)).toBeVisible();

  await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("avatar comment");
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();
  const row = dialog.getByRole("listitem").filter({ hasText: "avatar comment" });
  await expect(row.locator(OCTOCAT_SRC)).toBeVisible();

  await page.goto("/profile");
  await expect(page.getByText("@octocat")).toBeVisible();
  const githubSection = profileSection(page, "Connected accounts");
  await githubSection.getByRole("button", { name: "Disconnect" }).click();
  await expect(githubSection.getByRole("status")).toHaveText("GitHub disconnected.");
  await expect(accountButton(page).getByText("AA", { exact: true })).toBeVisible();
  await expect(page.locator('img[src*="github.com"]')).toHaveCount(0);

  // A later owned action (clicking Connect GitHub) clears stale feedback
  await githubSection.getByRole("button", { name: "Connect GitHub" }).click();
  await expect(githubSection.getByRole("status")).toHaveCount(0);
  // A wrong password stays in the dialog and starts nothing.
  await submitConnectGitHub(page, "not the password");
  await expect(page.getByRole("dialog", { name: "Connect GitHub" }).getByRole("alert")).toHaveText("Current password is incorrect.");
  await submitConnectGitHub(page, PASSWORD);
  await page.waitForURL("**/profile");
  await expect(page.getByText("@octocat")).toBeVisible();
});

test("an avatar that fails to load falls back to the initials circle", async ({ page }) => {
  await page.route(AVATAR_HOST, (route) => route.abort());

  await signup(page, uniqueEmail("profile-fallback"), "Fallback User");
  // The handshake is unaffected by the aborted image: it lives on localhost:8788.
  await connectGitHub(page);

  await expect(accountButton(page).getByText("FU")).toBeVisible();
  await expect(page.locator('img[src*="github.com"]')).toHaveCount(0);
});

test("account settings updates display name, email, and password with credential validation", async ({
  page,
}) => {
  const initialEmail = uniqueEmail("account-settings");
  const initialName = "Initial Name";
  await signup(page, initialEmail, initialName);
  const workspaceRoute = await personalWorkspaceRoute(page);
  await expect(page).toHaveURL(workspaceRoute);

  // Navigate Boards ↔ Profile asserting each route's current header.
  await expect(page.getByRole("link", { name: /^Boards/ })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page).toHaveURL("/profile");
  await expect(page.getByRole("link", { name: "Profile", exact: true })).toHaveAttribute("aria-current", "page");
  // Nothing is expanded on Profile: the workspace is a row in the sidebar.
  await page.locator(`.boards-sidebar a[href="${workspaceRoute}"]`).click();
  await expect(page).toHaveURL(workspaceRoute);
  await expect(page.getByRole("link", { name: /^Boards/ })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page).toHaveURL("/profile");

  const personal = profileSection(page, "Personal details");
  const security = profileSection(page, "Sign-in & security");

  // Personal details: display name update, header avatar initials follow it.
  await expect(accountButton(page).getByText("IN", { exact: true })).toBeVisible();
  const updatedName = "Updated Name";
  const saveName = personal.getByRole("button", { name: "Save changes" });
  await expect(saveName).toBeDisabled();
  await personal.getByLabel("Display name").fill(updatedName);
  await saveName.click();
  await expect(profileStatus(page, "Name updated.")).toHaveText("Name updated.");
  await expect(accountButton(page).getByText("UN", { exact: true })).toBeVisible();
  await expect(accountButton(page).getByText("IN", { exact: true })).toHaveCount(0);

  // Credential editors start collapsed behind their summary action.
  const emailForm = page.getByRole("form", { name: "Change email" });
  const passwordForm = page.getByRole("form", { name: "Change password" });
  await expect(emailForm).toHaveCount(0);
  await expect(passwordForm).toHaveCount(0);
  await expect(security.getByText(initialEmail)).toBeVisible();
  await expect(security.getByText("Update your sign-in password.")).toBeVisible();

  // No credential request may leave the client for a draft that is abandoned.
  let credentialRequests: string[] = [];
  const onCredentialRequest = (request: Request) => {
    if (request.url().includes("/auth/email") || request.url().includes("/auth/password")) {
      credentialRequests.push(request.url());
    }
  };
  page.on("request", onCredentialRequest);

  // Opening a credential modal focuses its first field and inerts the app shell.
  const discardedEmail = uniqueEmail("discarded-draft");
  await security.getByRole("button", { name: "Change email" }).click();
  const emailDialog = page.getByRole("dialog", { name: "Change sign-in email" });
  await expect(emailDialog).toBeVisible();
  await expect(emailForm.getByLabel("New email")).toBeFocused();
  await expect(page.locator(".boards-shell")).toHaveAttribute("inert", "");
  await expect(page.locator(".boards-shell").getByRole("dialog")).toHaveCount(0);
  await emailForm.getByLabel("New email").fill(discardedEmail);

  // Cancel closes without a request and restores the summary action.
  await emailForm.getByRole("button", { name: "Cancel" }).click();
  await expect(emailForm).toHaveCount(0);
  await expect(security.getByRole("button", { name: "Change email" })).toBeFocused();
  expect(credentialRequests).toEqual([]);

  // Reopening starts from the stored account values, not the abandoned draft.
  await security.getByRole("button", { name: "Change email" }).click();
  await expect(emailForm.getByLabel("New email")).toHaveValue(initialEmail);
  await expect(emailForm.getByLabel("Current password")).toHaveValue("");

  // Escape is the other no-request close.
  await emailForm.getByLabel("New email").fill(discardedEmail);
  await page.keyboard.press("Escape");
  await expect(emailForm).toHaveCount(0);
  expect(credentialRequests).toEqual([]);

  // 1. Wrong current password: the editor stays open with the submitted values.
  await security.getByRole("button", { name: "Change email" }).click();
  const rejectedEmail = uniqueEmail("wrong-pw-candidate");
  await emailForm.getByLabel("New email").fill(rejectedEmail);
  await emailForm.getByLabel("Current password").fill("wrong-password");
  await emailForm.getByRole("button", { name: "Change email" }).click();
  await expect(emailForm.getByRole("alert")).toHaveText("Current password is incorrect.");
  await expect(emailForm.getByLabel("New email")).toHaveValue(rejectedEmail);

  // 2. Admin transition rejection
  const nonAdminEmail = uniqueEmail("non-admin", "foxban.test");
  await emailForm.getByLabel("New email").fill(nonAdminEmail);
  await emailForm.getByLabel("Current password").fill(PASSWORD);
  await emailForm.getByRole("button", { name: "Change email" }).click();
  await expect(emailForm.getByRole("alert")).toHaveText("Email changes cannot alter administrator access.");

  // 3. Duplicate email rejection
  const duplicateEmail = uniqueEmail("duplicate-target");
  const otherContext = await page.context().browser()!.newContext();
  const otherPage = await otherContext.newPage();
  await signup(otherPage, duplicateEmail, "Duplicate User");
  await otherContext.close();

  await emailForm.getByLabel("New email").fill(duplicateEmail);
  await emailForm.getByLabel("Current password").fill(PASSWORD);
  await emailForm.getByRole("button", { name: "Change email" }).click();
  await expect(emailForm.getByRole("alert")).toHaveText("That email is already registered.");

  // 4. Successful same-admin-class email change with input normalization
  const newEmailRaw = uniqueEmail("new-email");
  await emailForm.getByLabel("New email").fill(`  ${newEmailRaw.toUpperCase()}  `);
  await emailForm.getByLabel("Current password").fill(PASSWORD);
  await emailForm.getByRole("button", { name: "Change email" }).click();
  await expect(profileStatus(page, "Email updated.")).toHaveText("Email updated.");

  // A successful save closes the modal and updates the summary.
  await expect(emailForm).toHaveCount(0);
  await expect(security.getByText(newEmailRaw.toLowerCase())).toBeVisible();
  await expect(profileStatus(page, "Name updated.")).toHaveText("Name updated.");

  // The account popover reports the changed name and email.
  await accountButton(page).click();
  const accountPopover = page.getByRole("menu");
  await expect(accountPopover.getByText(updatedName)).toBeVisible();
  await expect(accountPopover.getByText(newEmailRaw.toLowerCase())).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(accountPopover).toHaveCount(0);

  // Opening the password modal focuses its first field and preserves other statuses.
  await security.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("dialog", { name: "Change password" })).toBeVisible();
  await expect(passwordForm.getByLabel("Current password")).toBeFocused();
  await passwordForm.getByLabel("Current password").fill("typing-keeps-other-status");
  await expect(profileStatus(page, "Email updated.")).toHaveText("Email updated.");
  await expect(profileStatus(page, "Name updated.")).toHaveText("Name updated.");

  // Password helper text is visible and programmatically describes inputs
  const newPasswordInput = passwordForm.getByLabel("New password", { exact: true });
  const confirmPasswordInput = passwordForm.getByLabel("Confirm new password");
  await expect(newPasswordInput).toHaveAccessibleDescription(
    "Use 8–256 characters; avoid common, repeated, or sequential patterns.",
  );
  await expect(confirmPasswordInput).toHaveAccessibleDescription(
    "Use 8–256 characters; avoid common, repeated, or sequential patterns.",
  );

  // Predictable password shows an error locally without sending a request.
  await passwordForm.getByLabel("Current password").fill(PASSWORD);
  await newPasswordInput.fill("11111111");
  await confirmPasswordInput.fill("11111111");
  await passwordForm.getByRole("button", { name: "Change password" }).click();
  await expect(passwordForm.getByRole("alert")).toHaveText("Choose a less predictable password.");
  expect(credentialRequests.filter((url) => url.includes("/auth/password"))).toEqual([]);

  const newPassword = `${PASSWORD}-rotated`;
  await newPasswordInput.fill(newPassword);
  await confirmPasswordInput.fill(`${newPassword}-mismatch`);
  await passwordForm.getByRole("button", { name: "Change password" }).click();
  await expect(passwordForm.getByRole("alert")).toHaveText("New passwords do not match.");
  expect(credentialRequests.filter((url) => url.includes("/auth/password"))).toEqual([]);

  // Successful password change collapses the editor and revokes other sessions.
  await confirmPasswordInput.fill(newPassword);
  await passwordForm.getByRole("button", { name: "Change password" }).click();
  await expect(profileStatus(page, "Password updated.")).toHaveText(
    "Password updated. Other sessions were signed out.",
  );
  await expect(passwordForm).toHaveCount(0);
  page.off("request", onCredentialRequest);

  // Sign out and verify old credentials fail on login form
  await accountButton(page).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");

  await page.getByLabel("Email").fill(initialEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Incorrect email or password.");

  // Sign in with normalized new email + new password
  await page.getByLabel("Email").fill(newEmailRaw.toLowerCase());
  await page.getByLabel("Password").fill(newPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await openPersonalWorkspace(page);
  await expect(page).toHaveURL(workspaceRoute);

  // Create/open a board after the name change and assert member/assignee surface shows the new name
  const boardName = `Settings ${Date.now()}`;
  const boardId = await createBoard(page, boardName);
  await page.goto(`/board/${boardId}`);
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "settings card");

  const card = cardIn(columnByTitle(page, "Todo"), "settings card");
  await card.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Assignee" }).click();
  await expect(dialog.getByRole("option", { name: updatedName })).toBeVisible();
});

test("a failed OAuth callback redirects to /profile with an error notice", async ({ page }) => {
  await signup(page, uniqueEmail("profile-oauth-error"), "OAuth Error User");

  await page.goto("/auth/github/callback?code=x&state=wrong");

  await expect(page).toHaveURL("/profile?github=error");
  await expect(page.getByText("GitHub connection failed.")).toBeVisible();
});

test("the notice for a GitHub account that another foxban account already uses", async ({ page }) => {
  await signup(page, uniqueEmail("profile-oauth-taken"), "OAuth Taken User");

  await page.goto("/profile?github=taken");

  await expect(page.getByText("That GitHub account is already linked to another foxban account.")).toBeVisible();
});

test("timezone section supports automatic browser timezone, saving override, reload persistence, resetting, and presence rail updates with deterministic clock", async ({
  page,
}) => {
  // Pin deterministic clock at 2026-09-08T12:00:00Z
  const fixedTime = new Date("2026-09-08T12:00:00Z");
  await page.clock.setFixedTime(fixedTime);

  const email = uniqueEmail("profile-tz");
  const name = "Tz Tester";
  await signup(page, email, name);

  await page.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page).toHaveURL("/profile");

  const tzSection = profileSection(page, "Preferences");
  await expect(tzSection).toBeVisible();

  const tzTrigger = tzSection.getByRole("button", { name: "Timezone" });
  const saveButton = tzSection.getByRole("button", { name: "Save" });

  // Initially "automatic" is selected and save button is disabled
  await expect(tzTrigger).toContainText("Automatic");
  await expect(saveButton).toBeDisabled();

  // Open picker
  await tzTrigger.click();
  await expect(tzTrigger).toHaveAttribute("aria-expanded", "true");

  const searchInput = page.getByRole("combobox", { name: "Search timezones" });
  await expect(searchInput).toBeFocused();
  const listbox = page.getByRole("listbox", { name: "Timezones" });
  await expect(listbox).toBeVisible();

  // Automatic option is pinned as the first option
  const firstOption = listbox.getByRole("option").first();
  await expect(firstOption).toContainText("Automatic");
  await expect(firstOption).toHaveAttribute("aria-selected", "true");

  // Case-insensitive filtering
  await searchInput.fill("tokyo");
  const tokyoOption = listbox.getByRole("option", { name: "Asia/Tokyo" });
  await expect(tokyoOption).toBeVisible();
  // Other non-matching zones are filtered out
  await expect(listbox.getByRole("option", { name: "Europe/London" })).toHaveCount(0);

  // No-result message on unmatched query
  await searchInput.fill("nonexistent-timezone-xyz");
  await expect(page.getByText("No matching timezones")).toBeVisible();
  await expect(listbox.getByRole("option")).toHaveCount(0);

  // Escape ladder: first Escape clears search query
  await page.keyboard.press("Escape");
  await expect(searchInput).toHaveValue("");
  await expect(listbox.getByRole("option").first()).toContainText("Automatic");
  await expect(tzTrigger).toHaveAttribute("aria-expanded", "true");

  // Second Escape closes listbox and returns focus to trigger
  await page.keyboard.press("Escape");
  await expect(tzTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(tzTrigger).toBeFocused();

  // Reopen and test outside dismissal
  await tzTrigger.click();
  await expect(tzTrigger).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("heading", { name: "Preferences" }).click();
  await expect(tzTrigger).toHaveAttribute("aria-expanded", "false");

  // Reopen, Arrow navigation clamped, and Enter selection
  await tzTrigger.click();
  await searchInput.fill("tokyo");
  // Arrow navigation down to the Tokyo option
  await page.keyboard.press("ArrowDown");
  await expect(tokyoOption).toBeFocused();
  // Clamped at bottom
  await page.keyboard.press("ArrowDown");
  await expect(tokyoOption).toBeFocused();
  // Select with Enter
  await page.keyboard.press("Enter");
  await expect(tzTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(tzTrigger).toBeFocused();
  await expect(tzTrigger).toContainText("Asia/Tokyo");
  await expect(saveButton).toBeEnabled();

  // Save the new timezone override
  await saveButton.click();
  await expect(tzSection.getByRole("status")).toHaveText("Timezone updated.");
  await expect(saveButton).toBeDisabled();

  // Reload the page and verify override persistence
  await page.reload();
  await expect(page).toHaveURL("/profile");
  await expect(tzTrigger).toContainText("Asia/Tokyo");
  await expect(saveButton).toBeDisabled();

  // Create a board and verify that the presence rail displays the Tokyo local time for self
  const boardName = `Tz Board ${Date.now()}`;
  await openBoardList(page);
  const boardId = await createBoard(page, boardName);
  await page.goto(`/board/${boardId}`);
  await expect(page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();

  // The members rail starts closed: open it from the board's own control.
  await page.getByRole("button", { name: "Show board members" }).click();
  const desktopRail = page.getByRole("complementary", { name: "Board members" });
  await expect(desktopRail).toBeVisible();
  const selfRow = desktopRail.getByRole("listitem").filter({ hasText: name });
  await expect(selfRow.getByText("Online", { exact: true })).toBeVisible();

  // At 12:00:00 UTC, Asia/Tokyo (UTC+9) is 21:00 (9:00 PM)
  const expectedTokyoTime = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  }).format(fixedTime);
  await expect(selfRow.getByText(expectedTokyoTime)).toBeVisible();

  // Return to profile and reset to automatic
  await page.goto("/profile");
  await expect(page).toHaveURL("/profile");
  await tzTrigger.click();
  const autoOption = listbox.getByRole("option").first();
  await autoOption.click();
  await expect(tzTrigger).toContainText("Automatic");
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect(tzSection.getByRole("status")).toHaveText("Timezone updated.");
  await expect(saveButton).toBeDisabled();

  // Verify reloading retains automatic
  await page.reload();
  await expect(tzTrigger).toContainText("Automatic");
});

test("timezone section renders Automatic (unavailable) and does not fabricate UTC when browser resolved timezone is unavailable", async ({
  browser,
}) => {
  const context = await browser.newContext();
  // Stub Intl.DateTimeFormat().resolvedOptions().timeZone to throw or return empty string
  await context.addInitScript(() => {
    const origDateTimeFormat = Intl.DateTimeFormat;
    // @ts-expect-error test stubbing
    Intl.DateTimeFormat = function (...args: unknown[]) {
      // @ts-expect-error invoke original
      const formatter = new origDateTimeFormat(...args);
      const origResolvedOptions = formatter.resolvedOptions.bind(formatter);
      formatter.resolvedOptions = () => {
        const opts = origResolvedOptions();
        // @ts-expect-error override
        opts.timeZone = "";
        return opts;
      };
      return formatter;
    };
  });

  const page = await context.newPage();
  await signup(page, uniqueEmail("tz-fallback"), "Tz Fallback User");
  await page.goto("/profile");

  const tzSection = profileSection(page, "Preferences");
  const tzTrigger = tzSection.getByRole("button", { name: "Timezone" });

  // Trigger initially displays explicit "Automatic (unavailable)" label
  await expect(tzTrigger).toContainText("Automatic (unavailable)");

  // Open listbox and verify options
  await tzTrigger.click();
  const listbox = page.getByRole("listbox", { name: "Timezones" });
  await expect(listbox).toBeVisible();

  const firstOption = listbox.getByRole("option").first();
  await expect(firstOption).toContainText("Automatic (unavailable)");

  // No option with "Automatic (UTC)" was fabricated as the browser zone fallback
  await expect(listbox.getByRole("option", { name: "Automatic (UTC)" })).toHaveCount(0);
  await context.close();
});

test("timezone section disables trigger and save button while PATCH is pending and re-enables them after completion", async ({
  page,
}) => {
  const email = uniqueEmail("tz-pending");
  await signup(page, email, "Tz Pending User");
  await page.goto("/profile");

  const tzSection = profileSection(page, "Preferences");
  const tzTrigger = tzSection.getByRole("button", { name: "Timezone" });
  const submitButton = tzSection.locator('button[type="submit"]');
  // Open picker and choose a new timezone
  await tzTrigger.click();
  const searchInput = page.getByRole("combobox", { name: "Search timezones" });
  await searchInput.fill("Europe/Paris");
  await page.getByRole("option", { name: "Europe/Paris" }).click();
  await expect(submitButton).toBeEnabled();
  // Intercept PATCH /me to inject a delay
  let continuePatch: () => void = () => {};
  const patchHoldPromise = new Promise<void>((resolve) => {
    continuePatch = resolve;
  });

  await page.route("**/me", async (route) => {
    if (route.request().method() === "PATCH") {
      await patchHoldPromise;
      await route.continue();
    } else {
      await route.continue();
    }
  });

  // Click Save to fire mutation
  await submitButton.click();

  // Assert trigger and save button are disabled during pending request
  await expect(submitButton).toHaveText("Saving…");
  await expect(submitButton).toBeDisabled();
  await expect(tzTrigger).toBeDisabled();

  // Release the held request
  continuePatch();

  // Assert completed state: status updated, trigger re-enabled, save button reflects settled state
  await expect(tzSection.getByRole("status")).toHaveText("Timezone updated.");
  await expect(tzTrigger).toBeEnabled();
  await expect(submitButton).toHaveText("Save");
  await expect(submitButton).toBeDisabled();
});

test("display name is not editable while its save is pending and shows the saved name after", async ({
  page,
}) => {
  await signup(page, uniqueEmail("name-pending"), "Pending Name");
  await page.goto("/profile");

  const personal = profileSection(page, "Personal details");
  const nameInput = personal.getByLabel("Display name");
  // Scoped by form and type: the button's accessible name changes while pending.
  const saveName = personal.locator('form.profile-name button[type="submit"]');
  let continuePatch: () => void = () => {};
  const patchHoldPromise = new Promise<void>((resolve) => {
    continuePatch = resolve;
  });
  await page.route("**/me", async (route) => {
    if (route.request().method() === "PATCH") await patchHoldPromise;
    await route.continue();
  });

  await nameInput.fill("Submitted Name");
  await saveName.click();
  await expect(saveName).toHaveText("Saving…");
  await expect(saveName).toBeDisabled();
  await expect(nameInput).not.toBeEditable();

  continuePatch();
  await expect(profileStatus(page, "Name updated.")).toHaveText("Name updated.");
  await expect(nameInput).toHaveValue("Submitted Name");
  await expect(accountButton(page).getByText("SN", { exact: true })).toBeVisible();
  await expect(nameInput).toBeEditable();
});

test("uploaded profile avatar flow: upload image, shows across header, picker, card, reload, remove restores fallback, retry on failure", async ({
  page,
}) => {
  const email = uniqueEmail("profile-upload");
  await signup(page, email, "Sammy Sourdough");

  // Verify initial avatar shows initials "SS"
  await expect(accountButton(page).getByText("SS", { exact: true })).toBeVisible();

  // Navigate to profile
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page).toHaveURL("/profile");

  const avatarSection = profileSection(page, "Personal details");
  await expect(avatarSection).toBeVisible();

  // Prepare valid 1x1 gif file payload (GIF preserves bytes in compressImage)
  const gifFile = {
    name: "avatar.gif",
    mimeType: "image/gif",
    buffer: GIF_1X1,
  };

  // 1. Upload new avatar
  const fileInput = avatarSection.locator('input[type="file"]');
  await fileInput.setInputFiles(gifFile);

  // Observe status or upload success
  await expect(avatarSection.getByRole("status")).toHaveText("Avatar updated.");
  // The visible account control now displays the uploaded avatar image
  await expect(accountButton(page).locator('img[src*="/users/"][src*="/avatar/"]')).toBeVisible();
  await expect(avatarSection.getByText("Custom uploaded avatar")).toBeVisible();

  // 2. Open board, create column and card, assign Sammy
  const boardName = `Avatar E2E ${Date.now()}`;
  await openBoardList(page);
  const boardKey = await createBoard(page, boardName);
  await page.goto(`/board/${boardKey}`);
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Avatar task");

  const card = cardIn(columnByTitle(page, "Todo"), "Avatar task");
  await card.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Assignee picker contains uploaded avatar img
  await dialog.getByRole("button", { name: "Assignee" }).click();
  const option = dialog.getByRole("option", { name: "Sammy Sourdough" });
  await expect(option.locator('img[src*="/users/"][src*="/avatar/"]')).toBeVisible();
  await option.click();

  // Card face reflects uploaded avatar img
  await expect(card.locator('img[src*="/users/"][src*="/avatar/"]')).toBeVisible();

  // 3. Reload page on the board page: uploaded avatar persists on card face
  await page.reload();
  const cardAfterReload = cardIn(columnByTitle(page, "Todo"), "Avatar task");
  await expect(cardAfterReload.locator('img[src*="/users/"][src*="/avatar/"]')).toBeVisible();

  // 4. Return to Profile and Remove avatar
  await page.goto("/profile");
  const profileAvatarSection = profileSection(page, "Personal details");
  const removeButton = profileAvatarSection.getByRole("button", { name: /Remove( avatar)?/i });
  await expect(removeButton).toBeVisible();
  await removeButton.click();
  await expect(profileAvatarSection.getByRole("status")).toHaveText("Avatar removed.");

  // Restores initials fallback in the account control
  await expect(accountButton(page).getByText("SS", { exact: true })).toBeVisible();
  await expect(accountButton(page).locator('img[src*="/users/"][src*="/avatar/"]')).toHaveCount(0);
});

test("avatar image failure falls back through GitHub to initials circle, and changing version resets failure", async ({
  page,
}) => {
  const email = uniqueEmail("avatar-img-err");
  await signup(page, email, "Error Fallback");

  await page.getByRole("link", { name: "Profile", exact: true }).click();
  const avatarSection = profileSection(page, "Personal details");

  // Intercept avatar route to abort / fail image load
  await page.route("**/users/*/avatar/*", (route) => route.abort());

  const fileInput = avatarSection.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "avatar.gif",
    mimeType: "image/gif",
    buffer: GIF_1X1,
  });
  await expect(avatarSection.getByRole("status")).toHaveText("Avatar updated.");

  // Since uploaded avatar image aborted, fallback to initials "EF"
  await expect(accountButton(page).getByText("EF", { exact: true })).toBeVisible();
});

test("avatar section reflows cleanly at 375px without horizontal scroll", async ({
  page,
}) => {
  await signup(page, uniqueEmail("avatar-mobile"), "Mobile Avatar");
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/profile");

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBe(clientWidth);

  const avatarSection = profileSection(page, "Personal details");
  await expect(avatarSection).toBeVisible();
});

/**
 * The shell extraction moved the invites dialog and every board dialog out of
 * `.boards-shell`. These are the regressions that would silently reappear if a
 * dialog were rendered inside the element the shell marks `inert`.
 */
test("app shell keeps page dialogs interactive outside its inert subtree", async ({ page }) => {
  await signup(page, uniqueEmail("shell-dialogs"), "Shell Admin");
  await expect(page).toHaveURL(await personalWorkspaceRoute(page));
  const shellInert = () =>
    page.getByRole("main").evaluate((node) => Boolean(node.closest("[inert]")));

  // Boards: the create dialog stays interactive while the shell behind it is inert.
  const boardName = `Shell Board ${Date.now()}`;
  const boardKey = `S${Date.now().toString(36).toUpperCase().slice(-5)}`;
  await page.getByRole("button", { name: "New board" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create a board" });
  await expect(createDialog).toBeVisible();
  expect(await shellInert()).toBe(true);
  await createDialog.getByLabel("Board name").fill(boardName);
  await createDialog.getByLabel("Board key").fill(boardKey);
  await createDialog.getByRole("button", { name: "Create board" }).click();
  await expect(createDialog).toHaveCount(0);
  await expect(page.getByRole("link", { name: boardName })).toBeVisible();
  expect(await shellInert()).toBe(false);

  // Boards: the edit dialog is page-owned in the same way.
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: boardName }) });
  await row.getByRole("button", { name: `Board settings for ${boardName}` }).click();
  await row.getByRole("menuitem", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit board" });
  await expect(editDialog).toBeVisible();
  expect(await shellInert()).toBe(true);
  await editDialog.getByLabel("Board name").fill(`${boardName} edited`);
  await expect(editDialog.getByLabel("Board name")).toHaveValue(`${boardName} edited`);
  await editDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(editDialog).toHaveCount(0);
  expect(await shellInert()).toBe(false);

  // Account invites is a page destination, never an inert overlay.
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page).toHaveURL("/profile");
  expect(await shellInert()).toBe(false);
  const invitesMain = await openAccountInvites(page);
  expect(await shellInert()).toBe(false);
  await invitesMain.getByRole("button", { name: "Generate invite link" }).click();
  await expect(
    invitesMain.getByRole("status").filter({ hasText: "Invite link generated." }),
  ).toHaveText("Invite link generated.");
  await page.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page).toHaveURL("/profile");
  expect(await shellInert()).toBe(false);
});

test("a non-admin profile exposes no invites surface", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signup(adminPage, uniqueEmail("shell-invites-admin"), "Shell Invites Admin");
  const { token } = await generateAccountInvite(adminPage);
  await adminContext.close();

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signup(memberPage, uniqueEmail("shell-nonadmin", "user.test"), "Shell Member", token);
  await memberPage.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(memberPage).toHaveURL("/profile");
  await expect(memberPage.getByRole("heading", { name: "Personal details" })).toBeVisible();
  await expect(memberPage.getByRole("link", { name: "Account invites" })).toHaveCount(0);
  await memberPage.goto("/account-invites");
  await expect(memberPage).toHaveURL("/");
  await expect(memberPage.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(memberPage.getByRole("heading", { name: "Account invites" })).toHaveCount(0);

  await memberContext.close();
});

test("account routes expand no workspace and the sidebar does not overflow", async ({ page }) => {
  // 601px is the narrowest width that still shows the sidebar; below it the drawer takes over.
  await page.setViewportSize({ width: 601, height: 830 });
  await signup(page, uniqueEmail("account-workspace-context"), "Account Workspace User");
  await page.getByRole("button", { name: "New workspace", exact: true }).filter({ visible: true }).click();
  const createWorkspace = page.getByRole("dialog", { name: "Create workspace" });
  await createWorkspace.getByLabel("Workspace name").fill("Account Context");
  await createWorkspace.getByRole("button", { name: "Create workspace" }).click();
  // The new workspace is the route's, so it is the expanded one.
  await expect(page.getByRole("link", { name: "Members", exact: true }).filter({ visible: true })).toBeVisible();


  for (const route of [
    { name: "Profile", path: "/profile" },
    { name: "MCP server", path: "/mcp-server" },
    { name: "Account invites", path: "/account-invites" },
  ] as const) {
    await page.getByRole("link", { name: route.name, exact: true }).filter({ visible: true }).click();
    await expect(page).toHaveURL(route.path);
    // Account pages belong to no workspace: it is a single row, nothing expanded.
    await expect(page.getByRole("link", { name: "Account Context", exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Members", exact: true }).filter({ visible: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(601);
  }
});
