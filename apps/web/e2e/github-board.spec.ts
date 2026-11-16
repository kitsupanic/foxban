import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { addCard, addColumn, cardIn, columnByTitle, createBoard, ensureGitHubApp, signup, uniqueEmail } from "./helpers";

/**
 * GitHub development info on cards (ADR 0064): the instance App and its connected
 * repositories, signed webhooks that put branches and pull requests on cards live, and
 * the write-back from a card. The stub (`github-stub.mjs`) plays GitHub: it hands the
 * instance its App, answers the Worker's reads, and sends signed deliveries to the real
 * Worker, exactly as GitHub would. Nothing here polls, so nothing waits on a clock.
 */
declare const process: { env: Record<string, string | undefined> } | undefined;
const stubPort = Number(typeof process !== "undefined" && process?.env?.GITHUB_STUB_PORT ? process.env.GITHUB_STUB_PORT : 8788);
const stubOrigin = `http://localhost:${stubPort}`;

const OWNER = "example-org";
const REPO = `${OWNER}/example-repo`;
const REPO_ID = 987654;
const SECOND_REPO = `${OWNER}/second-repo`;
const SECOND_REPO_ID = 987655;

async function stubPost(request: APIRequestContext, path: string, data: unknown): Promise<{ status?: number; number?: number }> {
  const response = await request.post(`${stubOrigin}${path}`, { data });
  expect(response.ok()).toBe(true);
  return response.json();
}

/** Sends a signed webhook to the Worker; `secret` other than the App's is a forgery. Resolves with the Worker's status. */
async function deliver(request: APIRequestContext, event: string, payload: unknown, secret?: string): Promise<number> {
  return (await stubPost(request, "/_test/deliver", { event, payload, secret })).status ?? 0;
}

const repoPayload = (id: number, fullName: string) => ({ id, name: fullName.split("/")[1], full_name: fullName, private: false });

/** The owner installing the App on these repositories: GitHub sends `installation`, the Worker connects them. */
async function connectRepositories(request: APIRequestContext, repos: Array<[number, string]> = [[REPO_ID, REPO]]): Promise<void> {
  const status = await deliver(request, "installation", {
    action: "created",
    installation: { id: 12345, account: { login: OWNER } },
    repositories: repos.map(([id, fullName]) => repoPayload(id, fullName)),
  });
  expect(status).toBe(200);
}

/** A pull request on GitHub, then the event that says so. */
async function pullRequestOnGitHub(request: APIRequestContext, fields: { number: number; title: string; head?: string; repo?: string }): Promise<void> {
  await stubPost(request, "/_test/pr", { number: fields.number, title: fields.title, head: fields.head ?? `work-${fields.number}`, repo: fields.repo });
  await changePullRequest(request, fields.number, { state: "open" });
}

async function changePullRequest(
  request: APIRequestContext,
  number: number,
  change: { state?: "open" | "closed" | "merged"; title?: string; draft?: boolean },
): Promise<void> {
  expect((await stubPost(request, "/_test/pr-state", { number, ...change })).status).toBe(200);
}

/** A signed-in Admin on a board with one card, an instance App and a connected repository. */
async function boardWithCard(page: Page, request: APIRequestContext): Promise<{ boardKey: string; taskKey: string; card: Locator }> {
  await request.post(`${stubOrigin}/_test/reset`);
  await signup(page, uniqueEmail("gh-dev"), "GitHub Tester");
  await ensureGitHubApp(page);
  await connectRepositories(request);

  const suffix = Date.now().toString(36).toUpperCase();
  const boardName = `Dev info ${suffix}`;
  const boardKey = `GH${suffix.slice(-4)}`;
  await createBoard(page, boardName, boardKey);
  await page.getByRole("link", { name: boardName }).click();
  await page.waitForURL(new RegExp(`/board/${boardKey}`));
  await addColumn(page, "To Do");
  await addCard(page, "To Do", "Initial task");
  return { boardKey, taskKey: `${boardKey}-1`, card: cardIn(columnByTitle(page, "To Do"), "Initial task") };
}

const badge = (card: Locator) => card.getByTestId("pr-badge");

async function openDevelopment(page: Page, card: Locator): Promise<Locator> {
  await card.click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByRole("heading", { name: "Development" })).toBeVisible();
  return modal;
}

test.describe("GitHub development info", () => {
  test("an Admin's App reaches the instance's repositories, and the Admin page lists them", async ({ page, request }) => {
    await signup(page, uniqueEmail("gh-admin"), "GitHub Admin");
    await ensureGitHubApp(page);
    await connectRepositories(request);

    await page.goto("/account-github");
    await expect(page.getByRole("heading", { name: /^(Connected to|GitHub is connected)/ })).toBeVisible();
    await expect(page.getByRole("list", { name: "Connected repos" }).getByText(REPO)).toBeVisible();
    await expect(page.getByRole("link", { name: "Add repos" })).toHaveAttribute("href", /\/apps\/foxban-stub\/installations\/new/);
  });

  test("a signed webhook puts a pull request on its card and its front, and a later one moves it, without a reload", async ({ page, request }) => {
    const { taskKey, card } = await boardWithCard(page, request);
    await expect(badge(card)).toHaveCount(0);

    await pullRequestOnGitHub(request, { number: 7, title: `${taskKey} fix the login` });
    await expect(badge(card)).toHaveAttribute("aria-label", "Pull request #7: Open");

    const modal = await openDevelopment(page, card);
    const pullRequests = modal.getByRole("list", { name: "Pull requests" });
    await expect(pullRequests.getByText(`${taskKey} fix the login`)).toBeVisible();
    await expect(pullRequests.getByText(`${REPO}#7 · Open`)).toBeVisible();
    await expect(pullRequests.getByRole("link", { name: /fix the login/ })).toHaveAttribute("href", `https://github.com/${REPO}/pull/7`);

    // The merge arrives while the card is open: both the section and the front follow.
    await changePullRequest(request, 7, { state: "merged" });
    await expect(pullRequests.getByText(`${REPO}#7 · Merged`)).toBeVisible();
    await modal.getByRole("button", { name: "Close card" }).click();
    await expect(badge(card)).toHaveAttribute("aria-label", "Pull request #7: Merged");
  });

  test("a forged webhook is refused and changes nothing", async ({ page, request }) => {
    const { taskKey, card } = await boardWithCard(page, request);

    await stubPost(request, "/_test/pr", { number: 8, title: `${taskKey} forged`, head: "forged" });
    const forged = await deliver(request, "pull_request", {
      action: "opened",
      number: 8,
      repository: { id: REPO_ID, full_name: REPO },
      pull_request: { number: 8, title: `${taskKey} forged`, state: "open", html_url: `https://github.com/${REPO}/pull/8`, updated_at: new Date().toISOString(), head: { ref: "forged" } },
    }, "not-the-webhook-secret");
    expect(forged).toBe(401);

    // A genuine delivery afterwards is the marker: once its badge shows, the forged one has had its chance to.
    await pullRequestOnGitHub(request, { number: 9, title: `${taskKey} genuine` });
    await expect(badge(card)).toHaveAttribute("aria-label", "Pull request #9: Open");
    const modal = await openDevelopment(page, card);
    await expect(modal.getByRole("list", { name: "Pull requests" }).getByRole("listitem")).toHaveCount(1);
  });

  test("a member links a pull request that names no key, unlinks it, and it stays unlinked", async ({ page, request }) => {
    const { taskKey, card } = await boardWithCard(page, request);
    await stubPost(request, "/_test/pr", { number: 20, title: "Refactor the importer", head: "importer" });
    const modal = await openDevelopment(page, card);

    await modal.getByTestId("pr-link-trigger").click();
    await modal.getByLabel("Pull request URL or number").fill("20");
    await modal.getByRole("button", { name: "Link pull request" }).last().click();
    const pullRequests = modal.getByRole("list", { name: "Pull requests" });
    await expect(pullRequests.getByText("Refactor the importer")).toBeVisible();
    await expect(modal.getByRole("status").filter({ hasText: "Pull request linked." })).toBeVisible();
    await expect(badge(card)).toHaveAttribute("aria-label", "Pull request #20: Open");

    await modal.getByRole("button", { name: "Unlink pull request #20" }).click();
    await expect(pullRequests).toHaveCount(0);
    await expect(badge(card)).toHaveCount(0);

    // Its title now names the key, but the member said it does not belong: key matching must not bring it back.
    await changePullRequest(request, 20, { title: `${taskKey} importer` });
    await pullRequestOnGitHub(request, { number: 21, title: `${taskKey} marker` });
    await expect(pullRequests.getByText(`${taskKey} marker`)).toBeVisible();
    await expect(pullRequests.getByRole("listitem")).toHaveCount(1);
  });

  test("a member unlinks a branch, and it stays unlinked when the branch is pushed again", async ({ page, request }) => {
    const { boardKey, taskKey, card } = await boardWithCard(page, request);
    const branchName = `${boardKey.toLowerCase()}-1`;
    const modal = await openDevelopment(page, card);
    await modal.getByRole("button", { name: "Create branch" }).click();
    const branches = modal.getByRole("list", { name: "Branches" });
    await expect(branches.getByText(branchName, { exact: true })).toBeVisible();

    await modal.getByRole("button", { name: `Unlink branch ${branchName}` }).click();
    await expect(branches).toHaveCount(0);

    // The branch moves on GitHub and GitHub says so: the member said it does not belong, so it does not come back.
    await stubPost(request, "/_test/commit", { branch: branchName, message: "More work" });
    expect(await deliver(request, "push", { ref: `refs/heads/${branchName}`, repository: repoPayload(REPO_ID, REPO) })).toBe(200);
    // A later event for the card is the marker: once it shows, the push has had its chance to bring the branch back.
    await pullRequestOnGitHub(request, { number: 30, title: `${taskKey} marker` });
    await expect(modal.getByRole("list", { name: "Pull requests" }).getByText(`${taskKey} marker`)).toBeVisible();
    await expect(branches).toHaveCount(0);
  });

  test("a refused link says why and keeps what was typed", async ({ page, request }) => {
    const { card } = await boardWithCard(page, request);
    const modal = await openDevelopment(page, card);

    await modal.getByTestId("pr-link-trigger").click();
    const field = modal.getByLabel("Pull request URL or number");
    await field.fill("999");
    await modal.getByRole("button", { name: "Link pull request" }).last().click();
    await expect(modal.getByRole("alert")).toContainText("could not be read on GitHub");
    await expect(field).toHaveValue("999");

    await field.fill("https://github.com/stranger/elsewhere/pull/1");
    await modal.getByRole("button", { name: "Link pull request" }).last().click();
    await expect(modal.getByRole("alert")).toContainText("not connected");
  });

  test("a card creates its branch and then its pull request in the repository it picks", async ({ page, request }) => {
    const { boardKey, taskKey, card } = await boardWithCard(page, request);
    const branchName = `${boardKey.toLowerCase()}-1`;
    const modal = await openDevelopment(page, card);

    await expect(modal.getByLabel("Repository")).toHaveValue(String(REPO_ID));
    await expect(modal.getByRole("button", { name: "Create pull request" })).toBeDisabled();
    await modal.getByRole("button", { name: "Create branch" }).click();
    // GitHub tells the Worker about the new branch, which is how it reaches the card.
    await expect(modal.getByText(`Created branch ${branchName}.`)).toBeVisible();
    const branches = modal.getByRole("list", { name: "Branches" });
    await expect(branches.getByText(branchName, { exact: true })).toBeVisible();

    // Nothing has been pushed to the branch yet, so GitHub refuses the pull request and the card says what to do.
    await modal.getByRole("button", { name: "Create pull request" }).click();
    await expect(modal.getByRole("alert")).toContainText(`Push at least one commit to ${branchName}`);
    await stubPost(request, "/_test/commit", { branch: branchName, message: "Start the work" });

    await modal.getByRole("button", { name: "Create pull request" }).click();
    await expect(modal.getByText(/Opened pull request #\d+\./)).toBeVisible();
    const pullRequests = modal.getByRole("list", { name: "Pull requests" });
    await expect(pullRequests.getByText(`${taskKey}: Initial task`)).toBeVisible();
    await modal.getByRole("button", { name: "Close card" }).click();
    await expect(badge(card)).toHaveAttribute("aria-label", /^Pull request #\d+: Open$/);
  });

  test("the repository picker offers every connected repository, and a card creates its branch in the one picked", async ({ page, request }) => {
    const { boardKey, card } = await boardWithCard(page, request);
    await stubPost(request, "/_test/repository", { owner: OWNER, name: "second-repo", id: SECOND_REPO_ID });
    await connectRepositories(request, [[REPO_ID, REPO], [SECOND_REPO_ID, SECOND_REPO]]);
    await page.reload();
    const modal = await openDevelopment(page, card);

    const picker = modal.getByLabel("Repository");
    await expect(picker.getByRole("option")).toHaveText([REPO, SECOND_REPO]);
    await picker.selectOption(String(SECOND_REPO_ID));
    await modal.getByRole("button", { name: "Create branch" }).click();
    await expect(modal.getByRole("list", { name: "Branches" }).getByText(`${SECOND_REPO}`, { exact: false })).toBeVisible();
    await expect(modal.getByRole("list", { name: "Branches" }).getByText(`${boardKey.toLowerCase()}-1`, { exact: true })).toBeVisible();
  });
});
