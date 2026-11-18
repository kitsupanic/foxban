import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// pool-workers >= 0.22 (the Vitest 4 line) is a Vite plugin, not the old
// `defineWorkersConfig` + `test.poolOptions.workers` shape.
// Tests get the real schema: D1 bindings in the pool start empty, so the
// migrations are read here (Node side) and applied per test file.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.jsonc" },
      // ADMIN_EMAILS is a secret in production and absent from wrangler.jsonc. Only
      // exact addresses count (ADR 0071): the exact entry is written in a different
      // case, and the wildcard must stay ignored. The suite's own admins on
      // @foxban.test add themselves at signup (test/admin-signups.ts). The rate
      // limiter needs no override — `SELF.fetch` sends no CF-Connecting-IP, so
      // the middleware has no client to key on and stands aside.
      // The GitHub bases are pinned too, so the redirect assertions are
      // self-contained rather than reading wrangler.jsonc's defaults.
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          ADMIN_EMAILS: "*@wild.test, Mixed@Case.Test",
          GITHUB_OAUTH_BASE: "https://github.example",
          GITHUB_API_BASE: "https://api.github.example",
          APP_ORIGIN: "https://app.example",
          MCP_API_ORIGIN: "https://foxban.test",
          // Seals the instance GitHub App's secrets in D1 (base64 of 32 bytes; a test-only key).
          GITHUB_APP_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        },
      },
    }),
  ],
  // The full suite runs ~760 tests in one pool; DO restarts under that load push some past the 5 s default.
  test: { setupFiles: ["./test/admin-signups.ts"], testTimeout: 20_000 },
});
