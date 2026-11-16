import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect } from "vitest";
import { createInstanceGitHubApp } from "../src/github-app";

/**
 * Shared by the webhook suites (ADR 0064): the fake GitHub, signed deliveries and
 * the instance's App. GitHub is faked at fetch: `GITHUB_API_BASE` is
 * https://api.github.example. The App the instance owns is made by the real manifest
 * conversion path, with a freshly generated RSA key in the PKCS#1 form GitHub hands
 * out, and the fake GitHub checks every App JWT against that key's public half.
 * Admin status comes from vitest.config.ts's ADMIN_EMAILS (`*@foxban.test`).
 * Call `useFakeGitHub()` once at the top of a test file.
 */
export const ORIGIN = "https://foxban.test";
export const API = "https://api.github.example";
// The string GitHub's webhook docs use for their signature example.
export const WEBHOOK_SECRET = "It's a Secret to Everybody";
export const APP_ID = 424242;
export const OWNER = "Fork-Org";
export const PASSWORD = "correct horse battery";

let appKey: { pem: string; publicKey: CryptoKey };

type FakeRepo = { id: number; full_name: string; private?: boolean };
type FakeInstallation = { id: number; account: string; repos: FakeRepo[]; suspended?: boolean };

/** The fake GitHub: what it knows (`owner`, `installations`) and how it fails. Everything else passes through. */
export const github = { owner: OWNER as string | null, installations: [] as FakeInstallation[], listingDown: false, calls: [] as string[] };
let realFetch: typeof fetch;

/** True when the Bearer value is an RS256 JWT for this App, signed by the generated key. */
async function validAppJwt(token: string): Promise<boolean> {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;
  const fromUrlBase64 = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  const signed = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", appKey.publicKey, fromUrlBase64(signature), new TextEncoder().encode(`${header}.${payload}`));
  const claims = JSON.parse(new TextDecoder().decode(fromUrlBase64(payload))) as { iss: string; exp: number };
  return signed && claims.iss === String(APP_ID) && claims.exp > Date.now() / 1000;
}

async function fakeGitHubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== API) return realFetch(input, init);
  const method = init?.method ?? "GET";
  github.calls.push(`${method} ${url.pathname}`);
  const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
  const unauthorized = () => Response.json({ message: "Bad credentials" }, { status: 401 });

  if (method === "POST" && url.pathname === "/app-manifests/good-code/conversions") {
    return Response.json(
      { id: APP_ID, slug: "foxban-test", client_id: "Iv1.fake", client_secret: "fake-client-secret", webhook_secret: WEBHOOK_SECRET, pem: appKey.pem },
      { status: 201 },
    );
  }
  if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
    if (!(await validAppJwt(bearer))) return unauthorized();
    if (method === "GET" && url.pathname === "/app") {
      if (github.owner === null) return Response.json({ message: "Service Unavailable" }, { status: 503 });
      return Response.json({ id: APP_ID, slug: "foxban-test", owner: { login: github.owner } });
    }
    if (github.listingDown) return Response.json({ message: "Service Unavailable" }, { status: 503 });
    if (method === "GET" && url.pathname === "/app/installations") {
      return Response.json(
        github.installations.map((i) => ({ id: i.id, account: { login: i.account }, suspended_at: i.suspended ? "2026-11-01T00:00:00Z" : null })),
      );
    }
    const mint = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (method === "POST" && mint) return Response.json({ token: `ghs_installation_${mint[1]}` }, { status: 201 });
  }
  if (method === "GET" && url.pathname === "/installation/repositories") {
    if (github.listingDown) return Response.json({ message: "Service Unavailable" }, { status: 503 });
    const installation = github.installations.find((i) => bearer === `ghs_installation_${i.id}`);
    if (!installation) return unauthorized();
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    return Response.json({ total_count: installation.repos.length, repositories: installation.repos.slice((page - 1) * perPage, page * perPage) });
  }
  return Response.json({ message: "Not Found" }, { status: 404 });
}

/** Registers the suite's hooks: migrations and an App key once, then a clean instance and a faked GitHub for each test. */
export function useFakeGitHub(): void {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    // WebCrypto exports PKCS#8; a 2048-bit RSA key's 26-byte header wraps the PKCS#1 body GitHub gives out.
    const pkcs1 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer).slice(26);
    const body = btoa(String.fromCharCode(...pkcs1)).match(/.{1,64}/g)!.join("\n");
    appKey = { pem: `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\n`, publicKey: pair.publicKey };
  });

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM github_repos");
    await env.DB.exec("DELETE FROM github_app");
    Object.assign(github, { owner: OWNER, installations: [], listingDown: false, calls: [] });
    realFetch = globalThis.fetch;
    globalThis.fetch = fakeGitHubFetch as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });
}

export async function request(method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  return SELF.fetch(`${ORIGIN}${path}`, { method, redirect: "manual", body: init.body, headers: init.headers });
}

/** `sha256=` plus the lowercase-hex HMAC-SHA256 of the raw body, as GitHub sends it. */
export async function signature(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Delivers an event the way GitHub does: the raw JSON body, signed with the webhook secret. */
export async function deliver(event: string, payload: unknown, secret = WEBHOOK_SECRET): Promise<Response> {
  const body = JSON.stringify(payload);
  return request("POST", "/webhooks/github", {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": await signature(body, secret),
    },
  });
}

/** Gives the instance its App with a known webhook secret and key, through the real conversion path. */
export async function installApp() {
  expect(await createInstanceGitHubApp(env, "good-code")).toBe(true);
}

let counter = 0;
/** Signs up a fresh admin and returns the session cookie. */
export async function adminSession(): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `hooks-admin-${++counter}@foxban.test`, name: "Admin", password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

export const installation = (id = 7, account = OWNER) => ({ id, account: { login: account } });
export const repo = (id: number, fullName: string, isPrivate = false) => ({ id, name: fullName.split("/")[1], full_name: fullName, private: isPrivate });
