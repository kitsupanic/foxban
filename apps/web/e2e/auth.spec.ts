import { expect, test, type Request } from "@playwright/test";
import { PASSWORD, personalWorkspaceRoute, signup, uniqueEmail } from "./helpers";

test("signup lands on Home", async ({ page }) => {
  const email = uniqueEmail("auth-signup");
  await page.goto("/signup");

  const passwordInput = page.getByLabel("Password");
  await expect(passwordInput).toHaveAccessibleDescription(
    "Use 8–256 characters; avoid common, repeated, or sequential patterns.",
  );


  let signupFired = false;
  const onSignupRequest = (req: Request) => {
    if (req.url().includes("/auth/signup")) {
      signupFired = true;
    }
  };
  page.on("request", onSignupRequest);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Name").fill("Signup User");
  await page.getByLabel("Password").fill("11111111");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("alert")).toHaveText("Choose a less predictable password.");
  expect(signupFired).toBe(false);
  page.off("request", onSignupRequest);

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page).toHaveURL("/");
  await page.getByRole("button", { name: "Your account" }).click();
  await expect(page.getByText(email)).toBeVisible();
});

test("signing out returns to the login form", async ({ page }) => {
  const email = uniqueEmail("auth-signout");
  await signup(page, email, "Signout User");

  let fulfillLogout!: () => void;
  const logoutPromise = new Promise<void>((resolve) => {
    fulfillLogout = resolve;
  });

  await page.route(
    "**/auth/logout",
    async (route) => {
      await logoutPromise;
      await route.fulfill({ status: 500, json: { error: "Could not sign out." } });
    },
    { times: 1 },
  );

  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  // The popover keeps its Sign out entry and disables it while the request is in
  // flight, so a second submission cannot start.
  const pendingButton = page.getByRole("menuitem", { name: "Sign out" });
  await expect(pendingButton).toBeDisabled();

  fulfillLogout();

  await expect(page.getByRole("alert")).toHaveText("Could not sign out.");
  await expect(page).toHaveURL(await personalWorkspaceRoute(page));
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeEnabled();

  await page.getByRole("menuitem", { name: "Sign out" }).click();

  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("heading", { name: "Sign in to foxban" })).toBeVisible();
});

test("a wrong password shows an error and stays on /login", async ({ page }) => {
  const email = uniqueEmail("auth-wrongpw");
  await signup(page, email, "Wrong Password User");
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(`${PASSWORD}-nope`);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("heading", { name: "Sign in to foxban" })).toBeVisible();
});

test("an unauthenticated visitor is redirected to /login", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("heading", { name: "Sign in to foxban" })).toBeVisible();

  await page.goto("/profile");

  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("heading", { name: "Sign in to foxban" })).toBeVisible();
});

// Regression: the login form seeds the `me` cache from its own response. When it
// only invalidated the query, the `staleTime: "static"` entry kept its stale
// `null` and the root guard bounced the fresh session straight back to /login.
test("signing in on the redirected /login lands on Home", async ({ page }) => {
  const email = uniqueEmail("auth-redirect-login");
  await signup(page, email, "Redirect Login User");
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");

  await page.goto("/");
  await expect(page).toHaveURL("/login");

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The session is established once Home renders.
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page).toHaveURL("/");
});

test("a signed-in visitor to /login is sent back to Home", async ({ page }) => {
  await signup(page, uniqueEmail("auth-signed-in-login"), "Signed In User");

  await page.goto("/login");

  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
});
