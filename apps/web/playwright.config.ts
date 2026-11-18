import { defineConfig, devices } from "@playwright/test";
import type { ReporterDescription } from "@playwright/test";

const apiPort = Number(process.env.API_PORT ?? 8787);
const vitePort = Number(process.env.VITE_PORT ?? 5173);
const githubPort = Number(process.env.GITHUB_STUB_PORT ?? 8788);
if (![apiPort, vitePort, githubPort].every((port) => Number.isInteger(port) && port > 0 && port < 65536)) {
  throw new Error("API_PORT, VITE_PORT, and GITHUB_STUB_PORT must be valid TCP ports");
}
const apiOrigin = `http://localhost:${apiPort}`;
const viteOrigin = `http://localhost:${vitePort}`;
const githubOrigin = `http://localhost:${githubPort}`;
const repoRoot = "../..";

// When a shard runner (e2e/run-shards.mjs) starts the API/Vite/GitHub-stub
// stack itself it must tell Playwright not to launch a second one, and it
// scopes all Playwright state (artifacts/outputDir and, for the coordinator,
// the mergeable blob report) to its own run so concurrent shards cannot
// collide on files.
const managedServices = process.env.E2E_NO_WEBSERVER === "1";
const outputDir = process.env.E2E_OUTPUT_DIR ?? "test-results";

function resolveReporters(): ReporterDescription[] {
  const blobDir = process.env.E2E_BLOB_DIR;
  if (blobDir && process.env.E2E_SUPPRESS_BLOB !== process.env.E2E_SHARD) {
    const blobFile = process.env.E2E_BLOB_FILE;
    if (!blobFile) throw new Error("E2E_BLOB_FILE must be set when E2E_BLOB_DIR is set");
    return [["blob", { outputDir: blobDir, fileName: blobFile }]];
  }
  if (process.env.PLAYWRIGHT_JSON_REPORT) {
    return [["json", { outputFile: process.env.PLAYWRIGHT_JSON_REPORT }]];
  }
  return [["list"]];
}

export default defineConfig({
  testDir: "./e2e",
  // Per shard. 3 was faster but flaked on timing-sensitive tests under load; override with E2E_WORKERS.
  workers: Number(process.env.E2E_WORKERS ?? 2),
  fullyParallel: false,
  forbidOnly: true,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir,
  reporter: resolveReporters(),
  use: { baseURL: process.env.APP_ORIGIN ?? viteOrigin, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: managedServices
    ? undefined
    : [
        { command: "pnpm --filter @foxban/api migrate:local && pnpm --filter @foxban/api dev", cwd: repoRoot, url: `${apiOrigin}/`, reuseExistingServer: false, timeout: 120_000 },
        { command: "pnpm --filter @foxban/web dev", cwd: repoRoot, url: `${viteOrigin}/`, reuseExistingServer: false, timeout: 120_000 },
        { command: "node apps/web/e2e/github-stub.mjs", cwd: repoRoot, url: `${githubOrigin}/`, reuseExistingServer: false, timeout: 120_000 },
      ],
});
