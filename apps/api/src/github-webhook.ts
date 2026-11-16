import { z } from "zod";
import { loadInstanceGitHubApp } from "./github-app";
import { GitHubApiError, getAppOwnerLogin } from "./github";
import { drainBackfill } from "./github-backfill";
import { handleBranchEvent } from "./github-branches";
import { handlePullRequestEvent } from "./github-development";
import { connectRepos, disconnectInstallation, disconnectRepos, enqueueBackfill, isConnectedRepo } from "./github-repos";

type InstanceApp = NonNullable<Awaited<ReturnType<typeof loadInstanceGitHubApp>>>;

/** Checks GitHub's `X-Hub-Signature-256` (`sha256=` + hex HMAC-SHA256 of the raw body); the compare is constant-time. */
async function verifySignature(secret: string, body: ArrayBuffer, header: string | null): Promise<boolean> {
  const hex = /^sha256=([0-9a-f]{64})$/.exec(header ?? "")?.[1];
  if (!hex) return false;
  const mac = Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, mac, body);
}

const RepoSchema = z
  .object({ id: z.number().int(), full_name: z.string().min(1), private: z.boolean().optional() })
  .transform((repo) => ({ id: repo.id, fullName: repo.full_name, private: repo.private === true }));

/** `installation` carries `repositories`; `installation_repositories` carries what was added and removed. */
const InstallationEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int(), account: z.object({ login: z.string() }) }),
  repositories: z.array(RepoSchema).default([]),
  repositories_added: z.array(RepoSchema).default([]),
  repositories_removed: z.array(RepoSchema).default([]),
});

type WebhookResult = "applied" | "ignored" | "accepted" | "dropped";

/**
 * The App is public, so anyone can install it; only installations on the owner's
 * account count. A GitHub error here propagates: the delivery fails and the Admin page re-read heals it.
 */
async function ownsInstallation(env: Env, app: InstanceApp, account: string): Promise<boolean> {
  const owner = await getAppOwnerLogin(env.GITHUB_API_BASE, app.appId, app.privateKey);
  return owner !== null && owner.toLowerCase() === account.toLowerCase();
}

async function handleInstallation(
  env: Env,
  app: InstanceApp,
  event: "installation" | "installation_repositories",
  payload: unknown,
): Promise<WebhookResult> {
  const { action, installation, repositories, repositories_added, repositories_removed } = InstallationEventSchema.parse(payload);
  // Only an owned installation was ever connected, so removing needs no ownership proof (and no GitHub call).
  if (event === "installation" && (action === "deleted" || action === "suspend")) {
    await disconnectInstallation(env, installation.id);
    return "applied";
  }
  await disconnectRepos(env, installation.id, repositories_removed.map((repo) => repo.id));
  // Every other `installation` action (created, unsuspend, new_permissions_accepted) lists the repos it can reach.
  const added = event === "installation" ? repositories : repositories_added;
  if (added.length === 0) return "applied";
  if (!(await ownsInstallation(env, app, installation.account.login))) return "ignored";
  await connectRepos(env, installation.id, added);
  await enqueueBackfill(env, added.map((repo) => repo.id));
  return "applied";
}

/**
 * Branch, tag and pull request events name one repo; only a connected repo's are kept.
 * Pull request and branch events (push, create, delete) become development info on
 * the boards that hold them.
 */
async function handleRepositoryEvent(env: Env, app: InstanceApp, event: string, payload: unknown): Promise<WebhookResult> {
  const { repository } = z.object({ repository: z.object({ id: z.number().int() }) }).parse(payload);
  if (!(await isConnectedRepo(env, repository.id))) return "dropped";
  if (event === "pull_request") return (await handlePullRequestEvent(env, payload)) ? "applied" : "dropped";
  return (await handleBranchEvent(env, app, event, payload)) ? "applied" : "dropped";
}

function dispatch(env: Env, app: InstanceApp, event: string | null, payload: unknown): Promise<WebhookResult> | WebhookResult {
  switch (event) {
    case "installation":
    case "installation_repositories":
      return handleInstallation(env, app, event, payload);
    case "pull_request":
    case "push":
    case "create":
    case "delete":
      return handleRepositoryEvent(env, app, event, payload);
    default:
      return "ignored";
  }
}

/**
 * The public webhook route (ADR 0064). Nothing is parsed until the signature
 * over the raw body matches the decrypted webhook secret; an event that needs
 * no action still answers 2xx, because GitHub does not retry failed deliveries.
 */
export async function handleGitHubWebhook(env: Env, request: Request, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const app = await loadInstanceGitHubApp(env);
  if (!app) return Response.json({ error: "no GitHub App" }, { status: 404 });
  const body = await request.arrayBuffer();
  if (!(await verifySignature(app.webhookSecret, body, request.headers.get("x-hub-signature-256")))) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }
  try {
    const event = request.headers.get("x-github-event");
    const result = await dispatch(env, app, event, payload);
    // Connecting repos queued their backfill; it runs after the answer (GitHub allows 10 s), and the cron finishes what does not fit.
    if (event === "installation" || event === "installation_repositories") ctx.waitUntil(drainBackfill(env));
    return Response.json({ result });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "unexpected payload" }, { status: 400 });
    if (error instanceof GitHubApiError) return Response.json({ error: "could not reach GitHub" }, { status: 502 });
    throw error;
  }
}
