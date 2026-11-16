/// <reference types="node" />
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test, type Page } from "@playwright/test";
import { createBoard, getBoardUuid, signup, uniqueEmail } from "./helpers";

test.use({ trace: "off", screenshot: "off", video: "off" });

const apiPort = Number(process.env.API_PORT ?? 8787);
const transport = (token: string) => new StreamableHTTPClientTransport(new URL(`http://localhost:${apiPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
async function createFreshWorkspace(page: Page) {
  await signup(page, uniqueEmail("mcp-workspace"), "MCP Workspace User");
  const firstName = `MCP Alpha ${crypto.randomUUID()}`;
  const secondName = `MCP Beta ${crypto.randomUUID()}`;
  await createBoard(page, firstName);
  await createBoard(page, secondName);
  return { firstName, secondName, firstId: await getBoardUuid(page, firstName) };
}
async function openGenerator(page: Page) {
  // On a phone the links live in the navigation drawer.
  const menu = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("link", { name: "MCP server" }).filter({ visible: true }).click();
  await expect(page).toHaveURL("/mcp-server");
  await page.getByRole("button", { name: "Generate token" }).click();
  const dialog = page.getByRole("dialog", { name: "Generate MCP token" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("generates a scoped token from the MCP server workspace", async ({ page, context, browser }) => {
  test.setTimeout(90_000);
  const { firstName, secondName, firstId } = await createFreshWorkspace(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const dialog = await openGenerator(page);
  await expect(page.getByRole("link", { name: "MCP server" }).filter({ visible: true })).toHaveAttribute("data-status", "active");
  // The redesigned shell groups the MCP page with the account destinations, so
  // its entry renders in the account navigation rather than the workspace one.
  const accountNavigation = page.getByRole("navigation", { name: "Account navigation" }).filter({ visible: true });
  await expect(accountNavigation.getByRole("link", { name: "MCP server" })).toBeVisible();
  await expect(page.getByLabel("MCP endpoint")).toHaveValue(new URL("/mcp", page.url()).toString());
  await expect(dialog.getByText("0 selected")).toBeVisible();
  await expect(dialog.getByLabel("Read boards and tasks")).toBeChecked();
  await expect(dialog.getByLabel("Create, edit and move tasks")).not.toBeChecked();
  await expect(dialog.getByLabel("Post comments")).not.toBeChecked();
  await expect(dialog.getByLabel("Expires in (days)")).toHaveValue("30");
  await dialog.getByLabel("Token name").fill("Workspace SDK");
  await dialog.getByLabel(firstName).check();
  await dialog.getByLabel("Create, edit and move tasks").check();
  await dialog.getByLabel("Post comments").check();
  const issueResponse = page.waitForResponse((response) => response.url().includes("/me/agent-credentials") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Generate token" }).click();
  expect((await issueResponse).status()).toBe(201);
  const reveal = page.getByRole("dialog", { name: "Token generated" });
  const tokenInput = reveal.getByLabel("MCP token");
  const token = await tokenInput.inputValue();
  expect(token.startsWith("foxban_mcp_")).toBe(true);
  await reveal.getByRole("button", { name: "Copy token" }).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())) === token).toBe(true);
  await reveal.getByRole("button", { name: "Copy generic config" }).click();
  const genericConfig = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as {
    mcpServers?: { foxban?: { url?: string; headers?: { Authorization?: string } } };
  };
  expect(genericConfig.mcpServers?.foxban?.url).toBe(new URL("/mcp", page.url()).toString());
  expect(genericConfig.mcpServers?.foxban?.headers?.Authorization === `Bearer ${token}`).toBe(true);
  await expect(reveal.getByRole("status").filter({ hasText: "Generic MCP config copied" })).toBeVisible();
  await reveal.getByRole("button", { name: "Copy VS Code config" }).click();
  const vscodeConfig = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as {
    servers?: { foxban?: { type?: string; url?: string; headers?: { Authorization?: string } } };
  };
  expect(vscodeConfig.servers?.foxban?.type).toBe("http");
  expect(vscodeConfig.servers?.foxban?.url).toBe(new URL("/mcp", page.url()).toString());
  expect(vscodeConfig.servers?.foxban?.headers?.Authorization === `Bearer ${token}`).toBe(true);
  await expect(reveal.getByRole("status").filter({ hasText: "VS Code MCP config copied" })).toBeVisible();
  expect(page.url().includes(token)).toBe(false);
  expect(await page.evaluate((secret) => ({ local: Object.values(localStorage).includes(secret), session: Object.values(sessionStorage).includes(secret) }), token)).toEqual({ local: false, session: false });

  const client = new Client({ name: "foxban-workspace-e2e", version: "1.0.0" });
  await client.connect(transport(token));
  try {
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(13);
    const boards = await client.callTool({ name: "list_boards", arguments: {} });
    const serialized = JSON.stringify(boards.structuredContent);
    expect(serialized).toContain(firstName);
    expect(serialized).not.toContain(secondName);
  } finally { await client.close(); }

  await reveal.getByLabel("I saved this token").check();
  await reveal.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Workspace SDK", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Workspace SDK", { exact: true })).toBeVisible();
  await expect(page.getByLabel("MCP token")).toHaveCount(0);
  await page.getByRole("button", { name: "Revoke token Workspace SDK" }).click();
  const confirm = page.getByText("Connected tools will lose access on their next request.").locator("..");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Revoke token" }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  const rejected = new Client({ name: "foxban-revoked-e2e", version: "1.0.0" });
  await expect(rejected.connect(transport(token))).rejects.toThrow();

  const otherContext = await browser.newContext({ baseURL: page.url().replace(/\/mcp-server$/, "") });
  const other = await otherContext.newPage();
  await signup(other, uniqueEmail("mcp-other"), "Other MCP User");
  await other.getByRole("link", { name: "MCP server" }).filter({ visible: true }).click();
  await expect(other.getByText("Workspace SDK", { exact: true })).toHaveCount(0);
  await otherContext.close();
  expect(firstId).toBeTruthy();
});

test("validates issuance and preserves manual copy recovery", async ({ page, context }) => {
  const { firstName } = await createFreshWorkspace(page);
  const dialog = await openGenerator(page);
  let posts = 0;
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/me/agent-credentials")) posts += 1; });
  await dialog.getByRole("button", { name: "Generate token" }).click();
  await expect(dialog.getByText("Enter a token name.")).toBeVisible();
  await expect(dialog.getByText("Select at least one board.")).toBeVisible();
  await dialog.getByLabel("Token name").fill("Invalid until complete");
  await dialog.getByLabel(firstName).check();
  await dialog.getByLabel("Read boards and tasks").uncheck();
  await dialog.getByLabel("Expires in (days)").fill("91");
  await dialog.getByRole("button", { name: "Generate token" }).click();
  await expect(dialog.getByText("Select at least one permission.")).toBeVisible();
  await expect(dialog.getByText("Enter a whole number from 1 to 90.")).toBeVisible();
  expect(posts).toBe(0);
  await dialog.getByLabel("Read boards and tasks").check();
  await dialog.getByLabel("Expires in (days)").fill("1");
  await dialog.getByRole("button", { name: "Generate token" }).click();
  const reveal = page.getByRole("dialog", { name: "Token generated" });
  await expect(reveal).toBeVisible();
  await context.clearPermissions();
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () => Promise.reject(new Error("denied")) }));
  await reveal.getByRole("button", { name: "Copy token" }).click();
  await expect(reveal.getByRole("alert")).toContainText("Select the value and copy it manually.");
  await reveal.getByRole("button", { name: "Copy generic config" }).click();
  await expect(reveal.getByRole("alert").filter({ hasText: "Could not copy config." })).toBeVisible();
  await reveal.getByLabel("MCP token").focus();
  await expect(reveal.getByLabel("MCP token")).toBeFocused();
  await reveal.getByLabel("I saved this token").check();
  await reveal.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Revoke token Invalid until complete" }).click();
  await page.getByRole("button", { name: "Revoke token", exact: true }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
});

test("locks a pending issue and reports an ambiguous accepted response", async ({ page }) => {
  const { firstName } = await createFreshWorkspace(page);
  const dialog = await openGenerator(page);
  await dialog.getByLabel("Token name").fill("Ambiguous token");
  await dialog.getByLabel(firstName).check();
  let accepted = 0;
  await page.route("**/me/agent-credentials", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    accepted += 1;
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.abort();
    expect(response.status()).toBe(201);
  });
  await dialog.getByRole("button", { name: "Generate token" }).dblclick();
  await expect(dialog.getByRole("button", { name: "Generating…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (document.querySelector('a[href="/"]') as HTMLElement | null)?.click());
  await expect(page).toHaveURL("/mcp-server");
  await expect(dialog.getByRole("alert")).toContainText("may have created a token");
  expect(accepted).toBe(1);
  await expect(page.getByText("Ambiguous token", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Revoke token Ambiguous token" }).click();
  await page.getByRole("button", { name: "Revoke token", exact: true }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
});

test("keeps the workspace responsive and the MCP proxy exact", async ({ page }) => {
  await signup(page, uniqueEmail("mcp-responsive"), "Responsive MCP User");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("link", { name: "MCP server" }).filter({ visible: true }).click();
  await expect(page).toHaveURL("/mcp-server");
  await expect(page.getByRole("link", { name: "Home", exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("link", { name: "Profile" }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "MCP server" }).filter({ visible: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  const mcp = await page.request.get("/mcp");
  expect(mcp.status()).toBe(401);
  expect(mcp.headers()["content-type"]).toContain("application/json");
  const spa = await page.request.get("/mcp-server");
  expect(spa.status()).toBe(200);
  expect(await spa.text()).toContain("<div id=\"root\"");
  const dialog = await openGenerator(page);
  await expect(dialog.getByLabel("Token name")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Token name")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
