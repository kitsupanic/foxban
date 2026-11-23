import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("invite hashing migration 0027 (ADR 0085)", () => {
  it("drops unspent rows, whose raw tokens match no lookup now, and keeps the spent ones as the audit trail", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < "0027"));
    await env.DB.prepare(
      `INSERT INTO invites(token, created_by, created_at, used_by, used_at)
       VALUES ('raw-unspent', 'admin', 1, NULL, NULL), ('raw-spent', 'admin', 1, 'user', 2)`,
    ).run();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const { results } = await env.DB.prepare("SELECT token_hash AS hash, used_by AS usedBy, used_at AS usedAt FROM invites").all();
    expect(results).toEqual([{ hash: "raw-spent", usedBy: "user", usedAt: 2 }]);
  });
});
