import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Every spec registers its own users, so emails must never collide across runs.
 * The default domain is the one the dev Worker treats as admin (`ADMIN_EMAILS`
 * is `*@admin.test`), so helper signups need no invite token. Pass a domain to
 * register a plain user — those do require an invite.
 */
export function uniqueEmail(suffix: string, domain = "admin.test"): string {
  return `e2e-${crypto.randomUUID()}-${suffix}@${domain}`;
}

export const PASSWORD = "foxban-e2e-pw";

/**
 * Yields the page through two animation frames. Focus restores and other
 * deferred `requestAnimationFrame` work is scheduled one frame ahead of the
 * action that causes it, so an assertion about focus must let that frame run
 * before it judges the result.
 */
export async function settleAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** Reveals the compact empty-checklist action through its public control. */
export async function ensureChecklistComposer(dialog: Locator): Promise<Locator> {
  const composer = dialog.getByRole("textbox", { name: "Add checklist item", exact: true });
  if (!(await composer.isVisible())) {
    await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  }
  await expect(composer).toBeVisible();
  return composer;
}

/** Opens an advanced card section through its native disclosure. */
export async function openCardSection(
  dialog: Locator,
  name: "relations" | "attachments",
): Promise<void> {
  const section = dialog.getByTestId(`card-${name}-section`);
  await expect(section).toBeVisible();
  if ((await section.getAttribute("open")) === null) {
    await section.locator("summary").click();
  }
  await expect(section).toHaveAttribute("open", "");
}

/**
 * Fills and submits the signup form, without asserting the outcome: the invite
 * specs also need the refused case.
 */
export async function submitSignup(
  page: Page,
  email: string,
  name = "E2E User",
  invite?: string,
): Promise<void> {
  await page.goto(invite ? `/signup?invite=${invite}` : "/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
}

export async function signup(
  page: Page,
  email: string,
  name = "E2E User",
  invite?: string,
): Promise<void> {
  await submitSignup(page, email, name, invite);
  await openPersonalWorkspace(page);
}

/**
 * Signing in lands on Home. Most specs work inside the person's own workspace,
 * so they step from Home to its board list; the Home spec asserts Home itself.
 */
export async function openPersonalWorkspace(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await openBoardList(page);
}

/** Opens the board list of the person's own workspace, wherever the page is now. */
export async function openBoardList(page: Page): Promise<void> {
  await page.goto(await personalWorkspaceRoute(page));
  await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible();
}

/** Creates a board through the modal and returns its human key from the real row link. */
export async function createBoard(page: Page, name: string, key?: string): Promise<string> {
  if (new URL(page.url()).pathname === "/account-invites") {
    await openBoardList(page);
  }
  const boardKey =
    key ??
    `B${Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("").slice(0, 9).toUpperCase()}`;
  await page.getByRole("button", { name: "New board" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a board" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Board name").fill(name);
  await dialog.getByLabel("Board key").fill(boardKey);
  await dialog.getByRole("button", { name: "Create board" }).click();
  await expect(dialog).toHaveCount(0);
  const link = page.getByRole("link", { name });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  const boardKeyFromUrl = href?.split("/board/")[1];
  if (!boardKeyFromUrl) throw new Error(`board link had no board key: ${href}`);
  return boardKeyFromUrl;
}

/** Reads the internal board UUID from the board settings trigger button on the board list row. */
export async function getBoardUuid(page: Page, boardName: string): Promise<string> {
  const row = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: boardName }) });
  const btn = row.locator("button[data-board-actions-id]");
  await expect(btn).toBeVisible();
  const uuid = await btn.getAttribute("data-board-actions-id");
  if (!uuid) throw new Error(`could not find data-board-actions-id for board ${boardName}`);
  return uuid;
}

/**
 * The route of the workspace a person got at signup: the first one they belong
 * to (`GET /workspaces` lists oldest first). Ids are opaque, so it is found by
 * membership, never by id shape.
 */
export async function personalWorkspaceRoute(page: Page): Promise<string> {
  const body: unknown = await (await page.request.get("/workspaces")).json();
  const list = body !== null && typeof body === "object" && "workspaces" in body && Array.isArray(body.workspaces) ? body.workspaces : [];
  const first: unknown = list.find((item: unknown) => item !== null && typeof item === "object" && "access" in item && item.access === "member");
  if (first === null || typeof first !== "object" || first === undefined || !("id" in first) || typeof first.id !== "string") {
    throw new Error("GET /workspaces returned no workspace the signed-in user belongs to");
  }
  return `/w/${first.id}`;
}

/**
 * The board route answers a missing key and a forbidden one with the same
 * nondisclosing state, so denial is proven by that state plus the absence of
 * the board the caller was refused.
 */
export async function expectBoardAccessDenied(page: Page, boardName: string): Promise<void> {
  await expect(page.getByText("You no longer have access to this board.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: boardName, exact: true })).toHaveCount(0);
}

export async function inviteMember(page: Page, boardName: string, queryOrEmail: string): Promise<void> {
  const row = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: boardName }) });
  await row.getByRole("button", { name: `Board settings for ${boardName}` }).click();
  await row.getByRole("menuitem", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog", { name: `Add member to ${boardName}` });
  await expect(dialog).toBeVisible();

  const searchInput = dialog.getByRole("combobox", { name: "Search registered users" });
  await searchInput.fill(queryOrEmail);

  const option = dialog.getByRole("option").filter({ hasText: queryOrEmail });
  await expect(option).toBeVisible();
  await option.click();

  await dialog.getByRole("button", { name: "Add member" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: /^Added .* as member\.$/ })).toBeVisible();
}

/** Opens the account-invites page and waits for a successful list response. */
export async function openAccountInvites(page: Page): Promise<Locator> {
  if (new URL(page.url()).pathname !== "/account-invites") {
    await page.getByRole("link", { name: "Account invites" }).filter({ visible: true }).click();
  }
  await expect(page).toHaveURL("/account-invites");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Account invites", exact: true })).toBeVisible();
  await expect(main.getByRole("heading", { name: /^Active links/ })).toBeVisible();
  await expect(main.getByRole("alert").filter({ hasText: "Could not load invites." })).toHaveCount(0);
  return main;
}

/** Generates a fresh account invite and leaves the browser on its page. */
export async function generateAccountInvite(
  page: Page,
): Promise<{ link: string; token: string; otherPending: number }> {
  const main = await openAccountInvites(page);
  const links = main.getByRole("textbox", { name: /^Invite link for / });
  const otherPending = await links.count();
  await main.getByRole("button", { name: "Generate invite link" }).click();
  await expect(main.getByRole("status").filter({ hasText: "Invite link generated." })).toHaveText("Invite link generated.");
  await expect(links).toHaveCount(otherPending + 1);
  const link = await links.first().inputValue();
  const token = new URL(link).searchParams.get("invite");
  if (!token) throw new Error(`invite link carried no token: ${link}`);
  return { link, token, otherPending };
}

/** Board columns in board order; each column is one `[data-column-id]` section. */
export function columns(page: Page): Locator {
  return page.locator("[data-column-id]");
}

/** CSS-escapes a selector value: card titles are arbitrary user text. */
function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * One column, by its own title marker. The marker is on the column itself, so
 * this keeps matching while the title is being edited inline.
 */
export function columnByTitle(page: Page, title: string): Locator {
  return page.locator(
    `[data-column-id][data-column-title="${escapeAttributeValue(title)}"]`,
  );
}

/**
 * A card inside a column, matched by its OWN title marker. A child that sits in
 * its parent's column renders nested inside the parent's `li`, so the parent's
 * locator also contains the child's markers: reach the parent's own body through
 * `cardBody`, and a child's through `cardIn` with the child's title.
 */
export function cardIn(column: Locator, title: string): Locator {
  return column
    .locator("li")
    .filter({ has: column.page().locator(`[data-card-title="${escapeAttributeValue(title)}"]`) });
}

/**
 * The live card body is nested one level inside CardFace's visual shell. It is
 * the first marker in the card's `li`; the bodies of children nested below it
 * come after, so `first()` never selects a child.
 */
export function cardBody(columnCard: Locator): Locator {
  return columnCard.locator("[data-card-body]").first();
}

/**
 * Adds a column through the Add a column dialog and waits for the real column:
 * opening the form creates nothing, and the dialog closes only once the board
 * accepted the creation.
 */
export async function addColumn(page: Page, title: string): Promise<void> {
  const before = await columns(page).count();
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a column" });
  await expect(dialog).toBeVisible();
  const nameInput = dialog.getByLabel("Column name");
  await expect(nameInput).toBeFocused();
  await nameInput.fill(title);
  await dialog.getByRole("button", { name: "Add column" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(columns(page)).toHaveCount(before + 1);
  await expect(columnByTitle(page, title)).toHaveCount(1);
}

/** Adds a card through the Create a card dialog, from the column it belongs to. */
export async function addCard(page: Page, columnTitle: string, cardTitle: string): Promise<void> {
  const column = columnByTitle(page, columnTitle);
  await column.getByRole("button", { name: "Add card", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a card" });
  await expect(dialog).toBeVisible();
  const titleInput = dialog.getByLabel("Title");
  await expect(titleInput).toBeFocused();
  await titleInput.fill(cardTitle);
  await dialog.getByRole("button", { name: "Create card" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cardIn(column, cardTitle)).toBeVisible();
}

/**
 * Drags a card onto a column body with a real mouse gesture. dnd-kit's
 * PointerSensor has a 4px activation distance, so the first move after
 * `mouse.down()` is deliberately tiny — it is what starts the drag at all.
 */
export async function dragCardTo(
  page: Page,
  card: Locator,
  targetBody: Locator,
  beforeDrop?: () => Promise<void>,
): Promise<void> {
  const cardBox = await card.boundingBox();
  const targetBox = await targetBody.boundingBox();
  if (!cardBox || !targetBox) throw new Error("drag source or target is not laid out");
  const from = { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 };
  const to = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // A pointerdown and its first pointermove in the same tick can be coalesced.
  await page.waitForTimeout(50);
  await page.mouse.move(from.x + 6, from.y + 2);
  await page.waitForTimeout(50);

  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    // A little jitter keeps the pointer path from looking like a single jump.
    const jitter = step % 2 === 0 ? 1 : -1;
    await page.mouse.move(
      from.x + (to.x - from.x) * ratio + jitter,
      from.y + (to.y - from.y) * ratio + jitter,
    );
  }
  await page.mouse.move(to.x, to.y);
  await page.waitForTimeout(50);
  if (beforeDrop) await beforeDrop();
  await page.mouse.up();
}

/**
 * Simulates a touch drag gesture via Chromium CDP Input.dispatchTouchEvent.
 * Holds for holdMs (> 250ms for dnd-kit TouchSensor activation), then moves in steps to target,
 * and disposes touch. The source locator itself acts as the touch drag surface.
 */
export async function touchDragCardTo(
  page: Page,
  sourceCard: Locator,
  targetBody: Locator,
  options: { holdMs?: number; steps?: number; beforeDrop?: () => Promise<void> } = {},
): Promise<void> {
  const { holdMs = 300, steps = 12, beforeDrop } = options;
  await sourceCard.scrollIntoViewIfNeeded();

  const cardBox = await sourceCard.boundingBox();
  const targetBox = await targetBody.boundingBox();
  if (!cardBox || !targetBox) throw new Error("drag source or target is not laid out");
  const from = { x: Math.round(cardBox.x + cardBox.width / 2), y: Math.round(cardBox.y + cardBox.height / 2) };

  const cdp = await page.context().newCDPSession(page);

  // Touch start at source center
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y, id: 0 }],
  });

  // Hold to satisfy TouchSensor delay (default 250ms)
  if (holdMs > 0) {
    await page.waitForTimeout(holdMs);
  }

  // Move slightly first to overcome tolerance if needed
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: from.x + 4, y: from.y + 4, id: 0 }],
  });
  await page.waitForTimeout(50);

  // Real fingers cannot move to offscreen coordinates. Hold at the visible
  // edge until dnd-kit scrolls the destination into view, then remeasure it.
  const viewport = page.viewportSize()!;
  let current = { x: from.x + 4, y: from.y + 4 };
  for (let attempt = 0; attempt < 80; attempt++) {
    const target = await targetBody.boundingBox();
    if (!target) throw new Error("touch drop target disappeared");
    const center = { x: Math.round(target.x + target.width / 2), y: Math.round(target.y + target.height / 2) };
    if (center.y >= 12 && center.y <= viewport.height - 12 && center.x >= 12 && center.x <= viewport.width - 12) break;
    current = { x: Math.max(12, Math.min(viewport.width - 12, center.x)), y: Math.max(12, Math.min(viewport.height - 12, center.y)) };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...current, id: 0 }] });
    await page.waitForTimeout(25);
  }
  const refreshed = await targetBody.boundingBox();
  if (!refreshed) throw new Error("touch drop target disappeared");
  const destination = { x: Math.round(refreshed.x + refreshed.width / 2), y: Math.round(refreshed.y + refreshed.height / 2) };
  if (destination.y < 0 || destination.y > viewport.height || destination.x < 0 || destination.x > viewport.width) throw new Error("touch auto-scroll did not reveal drop target");
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    const movingTarget = (await targetBody.boundingBox())!;
    destination.x = Math.round(movingTarget.x + movingTarget.width / 2);
    destination.y = Math.round(movingTarget.y + movingTarget.height / 2);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(current.x + (destination.x - current.x) * ratio), y: Math.round(current.y + (destination.y - current.y) * ratio), id: 0 }] });
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(50);

  if (beforeDrop) await beforeDrop();

  // Follow the visible target through any final edge scrolling before release.
  const release = (await targetBody.boundingBox())!;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(release.x + release.width / 2), y: Math.round(release.y + release.height / 2), id: 0 }] });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  await cdp.detach();
}

/**
 * A long workspace name must neither push its neighbours out of the navigation nor
 * be clipped mid-letter: the plus and the Boards count stay inside `container`,
 * and the name is cut with an ellipsis, in full for anyone who hovers or reads it.
 */
export async function expectLongNameContained(container: Locator, label: Locator, plus: Locator, count: Locator, name: string): Promise<void> {
  const bounds = (await container.boundingBox())!;
  for (const locator of [label, plus, count]) {
    await expect(locator).toBeVisible();
    const box = (await locator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  }
  await expect(label).toHaveText(name);
  await expect(label).toHaveAttribute("title", name);
  expect(await label.evaluate((element) => ({ cut: element.scrollWidth > element.clientWidth, overflow: getComputedStyle(element).textOverflow }))).toEqual({ cut: true, overflow: "ellipsis" });
}

/**
 * Makes sure the instance has its GitHub App, as an Admin pressing "Create GitHub
 * App" would (ADR 0064): the signed-in user is an admin, and the stub answers the
 * manifest conversion. Profile linking is off until it exists. Safe to repeat.
 */
export async function ensureGitHubApp(page: Page): Promise<void> {
  const start = await page.request.post("/github-app/manifest", { data: {} });
  if (start.status() === 409) return;
  expect(start.ok()).toBe(true);
  const state = new URL((await start.json()).url).searchParams.get("state");
  const done = await page.request.get(`/auth/github-app/manifest/callback?code=stub-manifest-code&state=${state}`, { maxRedirects: 0 });
  expect(done.headers().location).toContain("githubApp=created");
}
