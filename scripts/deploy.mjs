#!/usr/bin/env node
// Deploys foxban to your own Cloudflare account: ensures the D1 database and R2
// bucket exist, writes a git-ignored wrangler config with your values, then
// builds, migrates, deploys and uploads secrets. See .env.deploy.example.
//
//   node scripts/deploy.mjs [--dry-run]
//
// Node >= 20, no dependencies. Runs on a laptop or in CI, never in Workers.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = "wrangler.generated.jsonc";

/**
 * KEY=VALUE lines; `#` comments and blanks ignored; one pair of surrounding quotes stripped.
 * A double-quoted value may span lines (a pasted PEM key), and `\n` inside double quotes
 * becomes a newline.
 */
export function parseEnvFile(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && (value.length === 1 || !value.endsWith('"'))) {
      while (i + 1 < lines.length && !value.endsWith('"')) value += `\n${lines[++i].trimEnd()}`;
    }
    if (/^"[\s\S]*"$/.test(value)) value = value.slice(1, -1).replace(/\\n/g, "\n");
    else if (/^'.*'$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/** The key that seals the instance GitHub App's secrets in D1. Generated once, never rotated: a new key would orphan them. */
const ENCRYPTION_KEY_SECRET = "GITHUB_APP_ENCRYPTION_KEY";

/** Names from `wrangler secret list` JSON. Throws on anything else, so a key is never generated on a guess. */
export function parseSecretNames(stdout) {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error("no JSON list in the secret list output");
  return JSON.parse(stdout.slice(start)).map((secret) => secret.name);
}

/** 32 random bytes, base64: an AES-256 key. */
export function newEncryptionKey() {
  return randomBytes(32).toString("base64");
}

/** Removes // and /* *\/ comments without touching string contents (URLs contain //). */
export function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) throw new Error("unterminated block comment");
    } else out += c;
  }
  return out;
}

/** The committed config with this instance's values filled in. */
export function buildConfig(base, env, d1Id) {
  const name = env.WORKER_NAME || "foxban";
  const cfg = structuredClone(base);
  cfg.name = name;
  cfg.d1_databases = base.d1_databases.map((d) => ({
    ...d,
    database_name: env.D1_DATABASE_NAME || name,
    database_id: d1Id,
  }));
  cfg.r2_buckets = base.r2_buckets.map((b) => ({ ...b, bucket_name: env.R2_BUCKET_NAME || `${name}-attachments` }));
  cfg.ratelimits = base.ratelimits.map((r) => ({ ...r, namespace_id: String(env.RATE_LIMIT_NAMESPACE_ID || r.namespace_id) }));
  cfg.vars = { ...base.vars };
  if (env.APP_ORIGIN) cfg.vars.APP_ORIGIN = env.APP_ORIGIN;
  const domain = env.CUSTOM_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (domain) {
    cfg.workers_dev = false;
    cfg.routes = [{ pattern: domain, custom_domain: true }];
  }
  return cfg;
}

function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const envFile = join(root, ".env.deploy");
  const env = { ...(existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {}), ...process.env };

  // Deploy to Cloudflare button (Workers Builds sets WORKERS_CI=1): the button has already
  // provisioned D1/R2 into the committed wrangler.jsonc and prompted for ADMIN_EMAILS as a secret.
  if (!env.ADMIN_EMAILS && env.WORKERS_CI) {
    const r = spawnSync("pnpm", ["run", "deploy:button"], { cwd: root, stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
  if (!env.ADMIN_EMAILS) fail("ADMIN_EMAILS is required (set it in .env.deploy or the environment).");

  const wrangler = (args, opts = {}) => {
    console.log(`> wrangler ${args.join(" ")}`);
    if (dryRun) return { status: 0, stdout: "" };
    const r = spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, ...opts });
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    return r;
  };
  const must = (r, what) => r.status === 0 || fail(`${what} failed`);

  const base = JSON.parse(stripJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")));
  const name = env.WORKER_NAME || "foxban";
  const d1Name = env.D1_DATABASE_NAME || name;
  const bucket = env.R2_BUCKET_NAME || `${name}-attachments`;

  const findD1 = () => {
    const r = wrangler(["d1", "list", "--json"]);
    must(r, "d1 list");
    return dryRun ? "<d1-id>" : JSON.parse(r.stdout.slice(r.stdout.indexOf("["))).find((d) => d.name === d1Name)?.uuid;
  };
  console.log(`deploy: ensuring D1 database ${d1Name} and R2 bucket ${bucket}`);
  let d1Id = findD1();
  if (!d1Id) {
    must(wrangler(["d1", "create", d1Name]), "d1 create");
    d1Id = findD1() || fail(`D1 database ${d1Name} not found after creating it`);
  }
  const r2 = wrangler(["r2", "bucket", "create", bucket]);
  if (r2.status !== 0 && !/already exists/i.test(`${r2.stdout}${r2.stderr}`)) fail("r2 bucket create failed");

  const cfg = buildConfig(base, env, d1Id);
  const generated = join(root, GENERATED);
  console.log(`deploy: ${dryRun ? "would write" : "writing"} ${GENERATED}`);
  const json = JSON.stringify(cfg, null, 2);
  if (dryRun) console.log(json);
  else writeFileSync(generated, `${json}\n`);

  const step = (label, cmd, args, opts) => {
    console.log(`deploy: ${label}`);
    console.log(`> ${cmd} ${args.join(" ")}`);
    if (dryRun) return { status: 0, stdout: "" };
    return spawnSync(cmd, args, { cwd: root, stdio: "inherit", env, ...opts });
  };
  must(step("building web", "pnpm", ["--filter", "@foxban/web", "build"]), "web build");
  must(wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", GENERATED]), "migrations");
  const dep = wrangler(["deploy", "-c", GENERATED]);
  must(dep, "wrangler deploy");

  const secrets = { ADMIN_EMAILS: env.ADMIN_EMAILS };
  // Added only when the Worker has none, and only after reading its secret list successfully.
  if (dryRun) console.log(`deploy: would add ${ENCRYPTION_KEY_SECRET} if the Worker has none`);
  else {
    const listed = wrangler(["secret", "list", "-c", GENERATED]);
    must(listed, "secret list");
    let names;
    try {
      names = parseSecretNames(listed.stdout);
    } catch {
      fail(`could not read the Worker's secret list, so ${ENCRYPTION_KEY_SECRET} was not generated`);
    }
    if (!names.includes(ENCRYPTION_KEY_SECRET)) secrets[ENCRYPTION_KEY_SECRET] = newEncryptionKey();
  }
  console.log(`deploy: uploading secrets ${Object.keys(secrets).join(", ")}`);
  if (dryRun) console.log("> wrangler secret bulk <temp file> -c " + GENERATED);
  else {
    const dir = mkdtempSync(join(tmpdir(), "foxban-"));
    let r;
    try {
      const file = join(dir, "secrets.json");
      writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
      r = wrangler(["secret", "bulk", file, "-c", GENERATED]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    must(r, "secret bulk"); // after cleanup: process.exit would skip `finally`
  }

  const domain = cfg.routes?.[0]?.pattern;
  const url = domain ? `https://${domain}` : dep.stdout?.match(/https:\/\/\S+\.workers\.dev/)?.[0];
  console.log(url ? `Open ${url}` : "deploy: done (see the URL printed by wrangler above)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
