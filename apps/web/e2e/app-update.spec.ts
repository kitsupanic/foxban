import { expect, test } from "@playwright/test";
import { addCard, addColumn, cardIn, columnByTitle, createBoard, signup, uniqueEmail } from "./helpers";

test.describe("App update prompt", () => {
  test("shows accessible modal when deployment build id changes and reloads on refresh", async ({
    page,
  }) => {
    let mode: "echo-current" | "failure" | "fixed-new" = "echo-current";
    const fixedNewBuildId = "build-updated-1";

    await page.route("**/foxban-version.json*", async (route) => {
      if (mode === "failure") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify({ error: "internal server error" }),
        });
        return;
      }

      if (mode === "fixed-new") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify({ buildId: fixedNewBuildId }),
        });
        return;
      }

      const url = new URL(route.request().url());
      const currentQueryId = url.searchParams.get("current") ?? "default-build-id";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ buildId: currentQueryId }),
      });
    });

    // 1. Initial navigation performs mount check with matching buildId
    const initialCheckPromise = page.waitForResponse(
      (resp) => resp.url().includes("/foxban-version.json") && resp.status() === 200,
    );
    await page.goto("/login");
    await initialCheckPromise;

    const modalHeading = page.getByRole("heading", {
      name: "Foxban updated",
      exact: true,
    });
    const modalDialog = page.getByRole("dialog");
    const laterButton = page.getByRole("button", { name: "Later", exact: true });
    const refreshButton = page.getByRole("button", {
      name: "Refresh Foxban",
      exact: true,
    });

    // Initially matching build id produces no update prompt
    await expect(modalHeading).toHaveCount(0);
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");

    // 2. Network / server failures do not disturb the current page
    mode = "failure";
    const failureCheckPromise = page.waitForResponse(
      (resp) => resp.url().includes("/foxban-version.json") && resp.status() === 500,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await failureCheckPromise;
    await expect(modalHeading).toHaveCount(0);

    // 3. New build id detected on focus shows the modal
    mode = "fixed-new";
    const updateCheckPromise = page.waitForResponse(
      (resp) => resp.url().includes("/foxban-version.json") && resp.status() === 200,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await updateCheckPromise;

    await expect(modalDialog).toBeVisible();
    await expect(modalDialog).toHaveAttribute("aria-modal", "true");
    await expect(modalHeading).toBeVisible();
    await expect(modalHeading).toHaveText("Foxban updated");
    await expect(
      page.getByText("Refresh the page to use the latest version.", { exact: true }),
    ).toBeVisible();

    // Modal marks #root as inert and gives initial focus to Refresh Foxban
    await expect(page.locator("#root")).toHaveAttribute("inert", "");
    await expect(refreshButton).toBeFocused();

    // 4. Focus trap keeps Tab and Shift+Tab between Refresh Foxban and Later
    // DOM order in AppUpdatePrompt is Later, then Refresh Foxban.
    // Starting on Refresh Foxban: Tab wraps to Later; Shift+Tab wraps back to Refresh.
    await page.keyboard.press("Tab");
    await expect(laterButton).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(refreshButton).toBeFocused();

    await page.keyboard.press("Shift+Tab");
    await expect(laterButton).toBeFocused();

    await page.keyboard.press("Shift+Tab");
    await expect(refreshButton).toBeFocused();

    // 5. Escape dismisses modal and restores #root interactivity
    await page.keyboard.press("Escape");
    await expect(modalDialog).toHaveCount(0);
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");

    // 6. Another check (e.g. window focus) reopens the modal because the tab is still stale
    const reopenCheckPromise = page.waitForResponse(
      (resp) => resp.url().includes("/foxban-version.json") && resp.status() === 200,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await reopenCheckPromise;
    await expect(modalDialog).toBeVisible();
    await expect(page.locator("#root")).toHaveAttribute("inert", "");

    // 7. Clicking "Later" dismisses the modal and restores #root interactivity
    await laterButton.click();
    await expect(modalDialog).toHaveCount(0);
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");

    // 8. Reopen again and click "Refresh Foxban" -> reloads the page
    const finalCheckPromise = page.waitForResponse(
      (resp) => resp.url().includes("/foxban-version.json") && resp.status() === 200,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await finalCheckPromise;
    await expect(modalDialog).toBeVisible();

    // Observe actual page reload navigation
    const [reloadRequest] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/login") && req.isNavigationRequest()),
      refreshButton.click(),
    ]);
    expect(reloadRequest).toBeTruthy();
  });

  test("stacked modal: update prompt inerts lower body portals and traps Escape without propagating to lower handlers", async ({
    page,
  }) => {
    await page.route("**/foxban-version.json*", async (route) => {
      const url = new URL(route.request().url());
      const currentQueryId = url.searchParams.get("current") ?? "default-build-id";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ buildId: currentQueryId }),
      });
    });

    await page.goto("/login");

    // Mount an existing sibling portal dialog onto document.body (simulating a lower modal like DescriptionEditor portal)
    await page.evaluate(() => {
      const lowerModalHost = document.createElement("div");
      lowerModalHost.id = "test-lower-portal-host";
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.id = "test-lower-dialog";
      const button = document.createElement("button");
      button.id = "test-lower-btn";
      button.textContent = "Lower Action";
      dialog.appendChild(button);
      lowerModalHost.appendChild(dialog);
      document.body.appendChild(lowerModalHost);

      (window as unknown as { lowerEscapeHandledCount: number }).lowerEscapeHandledCount = 0;
      (window as unknown as { lowerEscapeReceivedCount: number }).lowerEscapeReceivedCount = 0;

      // Model DescriptionEditor's window capture listener, registered before AppUpdatePrompt opens
      window.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "Escape") {
            (window as unknown as { lowerEscapeReceivedCount: number }).lowerEscapeReceivedCount += 1;
            if (document.documentElement.hasAttribute("data-foxban-update-prompt-active")) {
              // Yields to top update prompt
              return;
            }
            (window as unknown as { lowerEscapeHandledCount: number }).lowerEscapeHandledCount += 1;
          }
        },
        true,
      );
    });
    const lowerHost = page.locator("#test-lower-portal-host");
    await expect(lowerHost).not.toHaveAttribute("inert", "");

    // Now switch version to a new build and trigger update prompt
    await page.route("**/foxban-version.json*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ buildId: "new-stacked-build" }),
      });
    });

    const updateCheckPromise = page.waitForResponse(
      (resp) => resp.url().includes("/foxban-version.json") && resp.status() === 200,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await updateCheckPromise;

    const updateDialog = page.getByRole("dialog", { name: "Foxban updated" });
    await expect(updateDialog).toBeVisible();

    // Verify all sibling body children (both #root and the lower portal host) are marked inert
    await expect(page.locator("#root")).toHaveAttribute("inert", "");
    await expect(lowerHost).toHaveAttribute("inert", "");

    // Verify update prompt itself is inside dedicated portal host and NOT inert
    const updatePortalHost = page.locator("[data-foxban-update-portal-host]");
    await expect(updatePortalHost).toBeAttached();
    await expect(updatePortalHost).not.toHaveAttribute("inert", "");

    // Press Escape: dismisses update prompt; earlier capture listener checks ownership marker and yields
    await page.keyboard.press("Escape");
    await expect(updateDialog).toHaveCount(0);

    const { handledCount, receivedCount } = await page.evaluate(() => ({
      handledCount: (window as unknown as { lowerEscapeHandledCount: number })
        .lowerEscapeHandledCount,
      receivedCount: (window as unknown as { lowerEscapeReceivedCount: number })
        .lowerEscapeReceivedCount,
    }));
    // Lower capture listener observed Escape event, but ownership marker prevented action
    expect(receivedCount).toBeGreaterThanOrEqual(1);
    expect(handledCount).toBe(0);
    // After dismissal, prior inert states are restored (lower portal is no longer inert)
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
    await expect(lowerHost).not.toHaveAttribute("inert", "");
  });

  test("the update prompt accepts its first click above an open label picker", async ({ page }) => {
    let stale = false;
    await page.route("**/foxban-version.json*", async (route) => {
      const current = new URL(route.request().url()).searchParams.get("current") ?? "current-build";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ buildId: stale ? "build-updated-labels" : current }),
      });
    });
    await signup(page, uniqueEmail("update-labels"), "Label Author");
    const boardName = `Update labels ${Date.now()}`;
    await createBoard(page, boardName);
    await page.getByRole("link", { name: boardName }).click();
    await addColumn(page, "Todo");
    await addCard(page, "Todo", "Labelled card");
    await cardIn(columnByTitle(page, "Todo"), "Labelled card").click();
    const cardDialog = page.getByRole("dialog", { name: "Labelled card", exact: true });
    await cardDialog.getByRole("button", { name: "+ Add label…", exact: true }).click();
    await expect(cardDialog.getByLabel("Search labels", { exact: true })).toBeVisible();

    stale = true;
    const updateCheck = page.waitForResponse(response => response.url().includes("/foxban-version.json"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await updateCheck;
    const updateDialog = page.getByRole("dialog", { name: "Foxban updated", exact: true });
    await expect(updateDialog).toBeVisible();
    await updateDialog.getByRole("button", { name: "Later", exact: true }).click();
    await expect(updateDialog).toHaveCount(0);
    await expect(cardDialog).toBeVisible();
    await expect(cardDialog.getByLabel("Search labels", { exact: true })).toHaveCount(0);
  });

  test("refreshing from the update prompt asks before discarding an unsaved card draft", async ({
    page,
  }) => {
    let stale = false;
    await page.route("**/foxban-version.json*", async (route) => {
      const current = new URL(route.request().url()).searchParams.get("current") ?? "default-build-id";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ buildId: stale ? "build-updated-draft" : current }),
      });
    });

    await signup(page, uniqueEmail("update-draft"), "update-draft");
    const boardName = `Update draft ${Date.now()}`;
    await createBoard(page, boardName);
    await page.getByRole("link", { name: boardName }).click();
    await addColumn(page, "Todo");
    await addCard(page, "Todo", "Draft card");
    await cardIn(columnByTitle(page, "Todo"), "Draft card").click();
    const cardDialog = page.getByRole("dialog", { name: "Draft card" });
    await cardDialog.getByRole("button", { name: "Add a description…" }).click();
    await cardDialog.getByLabel("Card description").fill("unsaved words");
    const boardUrl = page.url();

    stale = true;
    const updateCheck = page.waitForResponse(
      (resp) => resp.url().includes("/foxban-version.json") && resp.status() === 200,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await updateCheck;
    const updateDialog = page.getByRole("dialog", { name: "Foxban updated" });
    await expect(updateDialog).toBeVisible();

    let unloadPrompts = 0;
    page.on("dialog", (dialog) => {
      if (dialog.type() === "beforeunload") unloadPrompts += 1;
      void dialog.dismiss();
    });
    await updateDialog.getByRole("button", { name: "Refresh Foxban", exact: true }).click();

    await expect.poll(() => unloadPrompts).toBe(1);
    expect(page.url()).toBe(boardUrl);
    // The update prompt holds #root inert, so read the draft by attribute.
    await expect(page.locator('[aria-label="Card description"]')).toHaveValue("unsaved words");
  });
});
