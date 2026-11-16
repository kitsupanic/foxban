import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    /** Extra binding injected by vitest.config.ts, test-only. */
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
