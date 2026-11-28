import { APP_NAME } from "@foxban/shared";
import { z } from "zod";
import { fromBase64, toBase64 } from "./base64url";
import { convertAppManifest } from "./github";

/** Served by the webhook endpoint (ADR 0064); the manifest tells GitHub to deliver here. */
export const GITHUB_WEBHOOK_PATH = "/webhooks/github";
/** The Admin page; GitHub sends people back here after they install the App. */
export const GITHUB_ADMIN_PAGE_PATH = "/account-github";
/** Where GitHub sends the Admin once the App is created, with `code` and `state`. */
export const GITHUB_MANIFEST_CALLBACK_PATH = "/auth/github-app/manifest/callback";
/** User-authorization callbacks: Profile linking (existing route) and Log in with GitHub (ADR 0065). GitHub matches them exactly. */
const USER_CALLBACK_PATHS = ["/auth/github/callback", "/auth/github/login/callback"];

/**
 * The manifest GitHub turns into an App. GitHub sends `installation` events to
 * every App whether or not it subscribes; the spec names them, so they are listed.
 */
export function buildGitHubAppManifest(origin: string) {
  // GitHub App names are unique across all of GitHub, so the host goes in the default name.
  const host = new URL(origin).hostname.replace(/[^a-z0-9]+/gi, "-");
  return {
    name: `${APP_NAME}-${host}`.slice(0, 34).replace(/-+$/, ""),
    url: origin,
    description: "Task board development info, and branches and pull requests created from cards.",
    // GitHub lets only the owner's side authorize a private App, so a private one would lock
    // everyone else out of picture linking and Log in with GitHub. Public means anyone can
    // install it: the webhook handler must ignore installations the owner did not make.
    public: true,
    hook_attributes: { url: `${origin}${GITHUB_WEBHOOK_PATH}`, active: true },
    redirect_url: `${origin}${GITHUB_MANIFEST_CALLBACK_PATH}`,
    callback_urls: USER_CALLBACK_PATHS.map((path) => `${origin}${path}`),
    setup_url: `${origin}${GITHUB_ADMIN_PAGE_PATH}`,
    setup_on_update: true,
    // Metadata: read is implicit. `emails` (the manifest's name for "Email addresses") is the user's own,
    // for signup's check that their GitHub address is not already a foxban account (ADR 0065).
    default_permissions: { contents: "write", pull_requests: "write", emails: "read" },
    // installation and installation_repositories reach every App unasked; GitHub rejects them here.
    default_events: ["pull_request", "push", "create", "delete"],
  };
}

/** The Worker secret that seals the App's secrets in D1: base64 of 32 random bytes. Not in the generated Env until a .dev.vars lists it. */
function encryptionKeyText(env: Env): string {
  return (env as { GITHUB_APP_ENCRYPTION_KEY?: string }).GITHUB_APP_ENCRYPTION_KEY?.trim() ?? "";
}

/** True only when the key imports, so GitHub's one-time code is never spent on an App whose secrets could not be sealed. */
export async function canCreateGitHubApp(env: Env): Promise<boolean> {
  try {
    await sealingKey(env);
    return true;
  } catch {
    return false;
  }
}

async function sealingKey(env: Env): Promise<CryptoKey> {
  const raw = encryptionKeyText(env);
  if (raw === "") throw new Error("GITHUB_APP_ENCRYPTION_KEY is not set");
  return crypto.subtle.importKey("raw", fromBase64(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** The column name is bound in as AAD, so a sealed value cannot be moved to another column. */
const aad = (column: string) => new TextEncoder().encode(`github_app.${column}`);

/** AES-GCM with a fresh IV, stored as `iv.ciphertext` in base64. */
async function seal(env: Env, column: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(column) },
    await sealingKey(env),
    new TextEncoder().encode(plaintext),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(data))}`;
}

async function open(env: Env, column: string, sealed: string): Promise<string> {
  const [iv, data] = sealed.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv ?? ""), additionalData: aad(column) },
    await sealingKey(env),
    fromBase64(data ?? ""),
  );
  return new TextDecoder().decode(plain);
}

/** GitHub's answer to `POST /app-manifests/{code}/conversions`; `webhook_secret` is null when the hook is off. */
const ManifestConversionSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1),
  pem: z.string().min(1),
});

/**
 * Turns the manifest `code` into the instance's App record, sealing the secrets.
 * Returns false when GitHub's answer is unusable or the instance already has an
 * App (the existing record is never replaced). Throws if GitHub can't be reached.
 */
export async function createInstanceGitHubApp(env: Env, code: string): Promise<boolean> {
  const parsed = ManifestConversionSchema.safeParse(await convertAppManifest(env.GITHUB_API_BASE, code));
  if (!parsed.success) return false;
  const app = parsed.data;
  const { meta } = await env.DB.prepare(
    `INSERT INTO github_app (id, app_id, slug, client_id, private_key_enc, webhook_secret_enc, client_secret_enc, created_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      String(app.id),
      app.slug,
      app.client_id,
      await seal(env, "private_key_enc", app.pem),
      await seal(env, "webhook_secret_enc", app.webhook_secret),
      await seal(env, "client_secret_enc", app.client_secret),
      Date.now(),
    )
    .run();
  return meta.changes === 1;
}

/** The App with its secrets decrypted, for server-side use only. Never put this in a response. */
export async function loadInstanceGitHubApp(env: Env) {
  const row = await env.DB.prepare(
    "SELECT app_id, slug, client_id, private_key_enc, webhook_secret_enc, client_secret_enc FROM github_app WHERE id = 1",
  ).first<{
    app_id: string;
    slug: string;
    client_id: string;
    private_key_enc: string;
    webhook_secret_enc: string;
    client_secret_enc: string;
  }>();
  if (!row) return null;
  return {
    appId: row.app_id,
    slug: row.slug,
    clientId: row.client_id,
    privateKey: await open(env, "private_key_enc", row.private_key_enc),
    webhookSecret: await open(env, "webhook_secret_enc", row.webhook_secret_enc),
    clientSecret: await open(env, "client_secret_enc", row.client_secret_enc),
  };
}

/** The public half of the App record, for the Admin page. */
export function getInstanceGitHubAppSummary(env: Env) {
  return env.DB.prepare(
    "SELECT app_id AS appId, slug, client_id AS clientId, created_at AS createdAt FROM github_app WHERE id = 1",
  ).first<{ appId: string; slug: string; clientId: string; createdAt: number }>();
}

/**
 * Forgets the instance App so an Admin can create another (for example under the right owner).
 * Drops its sealed secrets, the connected repos and queued backfills. GitHub keeps the App
 * itself; only its owner can delete it there. Card development info and the PR and branch
 * routes stay: repo and PR ids are GitHub's, so a new App on the same repos picks them up.
 * Returns false when there was no App.
 */
export async function removeInstanceGitHubApp(env: Env): Promise<boolean> {
  const [removed] = await env.DB.batch([
    env.DB.prepare("DELETE FROM github_app WHERE id = 1"),
    env.DB.prepare("DELETE FROM github_repos"),
    env.DB.prepare("DELETE FROM github_backfill_queue"),
  ]);
  return removed!.meta.changes === 1;
}
