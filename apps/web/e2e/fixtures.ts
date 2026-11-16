import { test as base, type StorageState } from "@playwright/test";
import { openPersonalWorkspace, signup, uniqueEmail } from "./helpers";
type WorkerFixtures = {
  authenticatedStorageState: StorageState;
};

/** Opt-in worker identity; tests using this fixture still create fresh boards. */
export const authTest = base.extend<{}, WorkerFixtures>({
  authenticatedStorageState: [async ({ browser }, use, workerInfo) => {
    const baseURL = workerInfo.project.use.baseURL as string;
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto("/signup", { timeout: 15_000 });
    await signup(
      page,
      uniqueEmail(`worker-${workerInfo.parallelIndex}-${crypto.randomUUID()}`),
      `Worker ${workerInfo.parallelIndex}`,
    );
    const state = await context.storageState();
    await context.close();

    await use(state);
  }, { scope: "worker" }],
  context: async ({ browser, authenticatedStorageState }, use, workerInfo) => {
    const baseURL = workerInfo.project.use.baseURL as string;
    const context = await browser.newContext({ baseURL, storageState: authenticatedStorageState });
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await page.goto("/");
    await openPersonalWorkspace(page);
    await use(page);
  },
});

export const mobileViewport = { width: 375, height: 667 };
export { expect } from "@playwright/test";
export type { Page } from "@playwright/test";
