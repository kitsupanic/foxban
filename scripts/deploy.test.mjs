import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConfig, newEncryptionKey, parseEnvFile, parseSecretNames, stripJsonc } from "./deploy.mjs";

test("parseEnvFile: comments, blanks, quotes, = in values", () => {
  const env = parseEnvFile('# c\n\nA=1\nB="two words"\nC=\'x\'\nD=a=b\r\n  E = 5 \nnoequals\n');
  assert.deepEqual(env, { A: "1", B: "two words", C: "x", D: "a=b", E: "5" });
});

test("parseEnvFile: multi-line double-quoted value and \\n escapes", () => {
  const env = parseEnvFile('K="-----BEGIN KEY-----\nab=c\n-----END KEY-----"\nN="a\\nb"\nAFTER=1\n');
  assert.deepEqual(env, { K: "-----BEGIN KEY-----\nab=c\n-----END KEY-----", N: "a\nb", AFTER: "1" });
});

test("stripJsonc keeps // inside strings and drops comments", () => {
  const text = '{ // line\n "u": "https://x.test/a", /* block */ "n": 1 /* tail */ }';
  assert.deepEqual(JSON.parse(stripJsonc(text)), { u: "https://x.test/a", n: 1 });
  assert.deepEqual(JSON.parse(stripJsonc('{"q": "say \\"//\\" // not a comment"}')), { q: 'say "//" // not a comment' });
});

test("buildConfig: defaults, custom domain, app origin", () => {
  const base = {
    name: "foxban",
    workers_dev: true,
    d1_databases: [{ binding: "DB", database_name: "foxban" }],
    r2_buckets: [{ binding: "ATTACHMENTS", bucket_name: "foxban-attachments" }],
    ratelimits: [{ name: "R", namespace_id: "1001" }],
    vars: { GITHUB_OAUTH_BASE: "https://github.com" },
  };
  const plain = buildConfig(base, {}, "id1");
  assert.equal(plain.d1_databases[0].database_id, "id1");
  assert.equal(plain.workers_dev, true);
  assert.equal(plain.routes, undefined);
  const custom = buildConfig(base, { WORKER_NAME: "kb", CUSTOM_DOMAIN: "https://kb.example.com/", RATE_LIMIT_NAMESPACE_ID: 1002, APP_ORIGIN: "https://kb.example.com", GITHUB_APP_ID: "old-env-app" }, "id2");
  assert.equal(custom.name, "kb");
  assert.equal(custom.d1_databases[0].database_name, "kb");
  assert.equal(custom.r2_buckets[0].bucket_name, "kb-attachments");
  assert.equal(custom.ratelimits[0].namespace_id, "1002");
  assert.deepEqual(custom.routes, [{ pattern: "kb.example.com", custom_domain: true }]);
  assert.equal(custom.workers_dev, false);
  assert.equal(custom.vars.APP_ORIGIN, "https://kb.example.com");
  // The GitHub App lives in D1 now (ADR 0064): an App id left in the environment is not copied into the config.
  assert.equal(custom.vars.GITHUB_APP_ID, undefined);
  assert.equal(plain.vars.APP_ORIGIN, undefined);
});

test("parseSecretNames reads `wrangler secret list` output, ignoring log noise before the JSON", () => {
  const out = ' ⛅️ wrangler 4.0\n[{"name":"ADMIN_EMAILS","type":"secret_text"},{"name":"GITHUB_APP_ENCRYPTION_KEY","type":"secret_text"}]\n';
  assert.deepEqual(parseSecretNames(out), ["ADMIN_EMAILS", "GITHUB_APP_ENCRYPTION_KEY"]);
  assert.deepEqual(parseSecretNames("[]"), []);
});

test("parseSecretNames throws on output it cannot read, so a key is never generated on a guess", () => {
  assert.throws(() => parseSecretNames(""));
  assert.throws(() => parseSecretNames("Authentication error"));
});

test("newEncryptionKey is 32 random bytes in base64", () => {
  const key = newEncryptionKey();
  assert.equal(Buffer.from(key, "base64").length, 32);
  assert.notEqual(key, newEncryptionKey());
});
