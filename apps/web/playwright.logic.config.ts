import { defineConfig } from "@playwright/test";

// Service-free configuration for pure logic specs. These cases exercise
// reducers, reconciliation and task-key helpers directly and request no
// fixtures, so they must not start the API/Vite/GitHub-stub stack, run
// migrations, take an E2E lock or launch a browser.
export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "./test-results-logic",
  projects: [{ name: "logic" }],
});
