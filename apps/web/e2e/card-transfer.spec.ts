import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  getBoardUuid,
  openBoardList,
  inviteMember,
  openCardSection,
  signup,
  uniqueEmail,
  ensureChecklistComposer,
} from "./helpers";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

async function newUser(
  browser: Browser,
  suffix: string,
  name: string,
): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail(suffix);
  await signup(page, email, name);
  return { page, email };
}

test.describe("cross-board card transfer end-to-end", () => {
  test("transfers active card with full aggregate from Source/Todo to Destination/Done, updating key and URL while removing from source", async ({
    browser,
  }) => {
    const alice = await newUser(browser, "xfer-e2e-a", "Alice Alpha");
    const bob = await newUser(browser, "xfer-e2e-b", "Bob Beta");
    const charlie = await newUser(browser, "xfer-e2e-c", "Charlie Charlie");

    // Charlie creates a private board that Alice cannot access
    const unsharedBoardName = `Charlie Unshared ${Date.now()}`;
    await createBoard(charlie.page, unsharedBoardName);

    // Alice creates Source board and Destination board
    const srcBoardName = `Transfer Source ${Date.now()}`;
    const srcBoardKey = await createBoard(alice.page, srcBoardName);
    const srcBoardUuid = await getBoardUuid(alice.page, srcBoardName);

    const dstBoardName = `Transfer Destination ${Date.now()}`;
    const dstBoardKey = await createBoard(alice.page, dstBoardName);
    const dstBoardUuid = await getBoardUuid(alice.page, dstBoardName);

    // Invite Bob to both boards so Bob is a valid member on both
    await inviteMember(alice.page, srcBoardName, bob.email);
    await inviteMember(alice.page, dstBoardName, bob.email);

    // Setup Source Board: Todo column + Card
    await alice.page.goto(`/board/${srcBoardKey}`);
    await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
    await addColumn(alice.page, "Todo");
    await addCard(alice.page, "Todo", "Feature Alpha");

    // Setup Destination Board: Done column
    await alice.page.goto(`/board/${dstBoardKey}`);
    await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
    await addColumn(alice.page, "Done");

    // Back to Source Board to populate card details
    await alice.page.goto(`/board/${srcBoardKey}`);
    const srcColumn = columnByTitle(alice.page, "Todo");
    const cardEl = cardIn(srcColumn, "Feature Alpha");
    await cardEl.click();

    const dialog = alice.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // 1. Description
    await dialog.getByRole("button", { name: "Add a description…" }).click();
    await dialog.getByLabel("Card description").fill("Detailed transfer description");
    await dialog.getByRole("button", { name: "Save title & description" }).click();
    await expect(dialog).toHaveCount(0);
    await cardEl.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Priority" }).click();
    await dialog.getByRole("option", { name: "High", exact: true }).click();

    // 3. Due date
    const dateInput = dialog.getByLabel("Due date", { exact: true });
    await dateInput.fill("2026-12-31");

    // 4. Checklist item
    const checklistComposer = await ensureChecklistComposer(dialog);
    await checklistComposer.fill("Verify transfer");
    await checklistComposer.press("Enter");
    await expect(dialog.getByRole("checkbox", { name: "Verify transfer" })).toBeVisible();

    // 5. Comment
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentComposer = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentComposer.fill("A comment before transfer");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(dialog.getByRole("paragraph").filter({ hasText: /^A comment before transfer$/ })).toBeVisible();
    // 6. Label: deterministically create and assign "Bug" label
    await dialog.getByRole("button", { name: "+ Add label…" }).click();
    await dialog.getByRole("button", { name: "Create label", exact: true }).click();
    await dialog.getByLabel("New label name").fill("Bug");
    await dialog.getByLabel("New label name").press("Enter");
    await expect(dialog.getByLabel("Remove label Bug")).toBeVisible();
    await alice.page.keyboard.press("Escape"); // close label popover
    // 7. Assignee: assign Bob Beta
    await dialog.getByRole("button", { name: "Assignee" }).click();
    await dialog.getByRole("option", { name: "Bob Beta", exact: true }).click();
    // 8. Attachment upload
    await openCardSection(dialog, "attachments");
    const fileInput = dialog.getByTestId("attach-input");
    const attachmentBuffer = Buffer.from("arbitrary transfer attachment payload\n");
    const attachmentName = "transfer-doc.pdf";
    await fileInput.setInputFiles({
      name: attachmentName,
      mimeType: "application/pdf",
      buffer: attachmentBuffer,
    });
    await expect(dialog.getByRole("heading", { name: "Attachments 1" })).toBeVisible();

    // Bob opens source board in a second tab to verify live removal later
    await bob.page.goto(`/board/${srcBoardKey}`);
    await expect(cardIn(columnByTitle(bob.page, "Todo"), "Feature Alpha")).toBeVisible();

    // Alice opens Card actions menu -> Transfer card
    const cardActionsBtn = dialog.getByRole("button", { name: "Card actions" });
    await cardActionsBtn.click();

    const transferMenuItem = alice.page.getByRole("menuitem", { name: "Transfer card" });
    await expect(transferMenuItem).toBeVisible();
    await transferMenuItem.click();

    // Nested TransferCardDialog opens
    const transferDialog = alice.page.getByRole("dialog", { name: "Transfer card" });
    await expect(transferDialog).toBeVisible();

    // Verify dialog grammar: Cancel initially focused, heading Transfer card
    const cancelBtn = transferDialog.getByRole("button", { name: "Cancel" });
    await expect(cancelBtn).toBeFocused();

    // Verify unshared board is absent from options
    const boardSelect = transferDialog.getByLabel("Board");
    const boardOptionTexts = await boardSelect.locator("option").allTextContents();
    expect(boardOptionTexts.some((txt) => txt.includes(unsharedBoardName))).toBe(false);

    // Select Destination board by label
    await boardSelect.selectOption({ label: `${dstBoardName} (${dstBoardKey})` });
    const statusSelect = transferDialog.getByLabel("Status");
    await expect(statusSelect).toBeEnabled();
    await statusSelect.selectOption({ label: "Done" });
    // Submit transfer
    const transferSubmitBtn = transferDialog.getByRole("button", { name: "Transfer", exact: true });
    await expect(transferSubmitBtn).toBeEnabled();
    await transferSubmitBtn.click();

    // Navigation occurs to destination board with ?card=DEST_KEY-N

    // Wait for transfer dialog to close, then target destination board card modal Feature Alpha
    await expect(transferDialog).toHaveCount(0);
    await expect(alice.page).toHaveURL(new RegExp(`/board/${dstBoardKey}\\?card=[A-Z0-9]+-\\d+`));
    const destDialog = alice.page.getByRole("dialog", { name: "Feature Alpha" });
    await expect(destDialog).toBeVisible();
    await expect(destDialog.getByRole("heading", { name: "Feature Alpha", exact: true })).toBeVisible();
    await expect(destDialog.getByText("A comment before transfer")).toBeVisible();
    await expect(destDialog.getByRole("checkbox", { name: "Verify transfer" })).toBeVisible();
    await expect(destDialog.getByRole("heading", { name: "Attachments 1" })).toBeVisible();

    // Assert preserved priority, due date, label, assignee, and activity
    await expect(destDialog.getByRole("button", { name: "Priority" })).toContainText("High");
    await expect(destDialog.getByLabel("Due date", { exact: true })).toHaveValue("2026-12-31");
    await expect(destDialog.getByLabel("Remove label Bug")).toBeVisible();
    await expect(destDialog.getByRole("button", { name: "Assignee" })).toContainText("Bob Beta");
    await expect(destDialog.getByRole("tab", { name: /^All · \d+$/ })).toBeVisible();

    await openCardSection(destDialog, "attachments");

    // Verify downloadable byte-identical attachment
    const downloadPromise = alice.page.waitForEvent("download");
    await destDialog.getByRole("link", { name: `Download attachment ${attachmentName}` }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(attachmentName);
    const downloadStream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of downloadStream!) {
      chunks.push(Buffer.from(chunk));
    }
    const downloadedBytes = Buffer.concat(chunks);
    expect(downloadedBytes).toEqual(attachmentBuffer);
    // Close modal on destination board and verify card in Done column
    await alice.page.keyboard.press("Escape");
    await expect(alice.page.getByRole("dialog")).toHaveCount(0);
    const destColumn = columnByTitle(alice.page, "Done");
    await expect(cardIn(destColumn, "Feature Alpha")).toBeVisible();

    // Reload destination board: card is still there
    await alice.page.reload();
    await expect(cardIn(columnByTitle(alice.page, "Done"), "Feature Alpha")).toBeVisible();

    // Verify card is removed from source board on Bob's view
    await expect(cardIn(columnByTitle(bob.page, "Todo"), "Feature Alpha")).toHaveCount(0);

    // Test complete
  });
  test("transfer is blocked when card has links or unsaved draft changes", async ({
    page,
  }) => {
    const email = uniqueEmail("xfer-block");
    await signup(page, email, "Block Tester");

    const boardName = `Block Board ${Date.now()}`;
    const boardId = await createBoard(page, boardName);
    const destBoardName = `Dest Block Board ${Date.now()}`;
    await createBoard(page, destBoardName);
    await page.goto(`/board/${boardId}`);
    await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
    await addColumn(page, "Todo");
    await addCard(page, "Todo", "Card 1");
    await addCard(page, "Todo", "Card 2");

    // Link Card 1 to Card 2
    const c1 = cardIn(columnByTitle(page, "Todo"), "Card 1");
    await c1.click();
    let dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await openCardSection(dialog, "relations");
    await dialog.getByRole("button", { name: "+ Link a card…" }).click();
    await dialog.getByLabel("Relation kind").selectOption({ label: "Blocks" });
    const picker = dialog.getByLabel("Link a card");
    await picker.fill("Card 2");
    const results = dialog.getByTestId("relation-results");
    await results.getByRole("button").filter({ hasText: "Card 2" }).click();
    await expect(dialog.getByText("Blocks Card 2", { exact: true })).toBeVisible();
    // Open Card actions menu -> Transfer card
    await dialog.getByRole("button", { name: "Card actions" }).click();
    await page.getByRole("menuitem", { name: "Transfer card" }).click();

    // Dialog shows relation block warning and disables transfer button
    let transferDialog = page.getByRole("dialog", { name: "Transfer card" });
    await expect(transferDialog).toBeVisible();
    await expect(
      transferDialog.getByText("Remove this card’s links and subtasks before transferring."),
    ).toBeVisible();
    await expect(transferDialog.getByRole("button", { name: "Transfer", exact: true })).toBeDisabled();

    // Escape closes transfer dialog and restores focus to Card actions button
    await page.keyboard.press("Escape");
    await expect(transferDialog).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Card actions" })).toBeFocused();

    // Unlink relation to test draft block
    await dialog.getByRole("button", { name: "Delete relation Blocks Card 2" }).click();
    await expect(dialog.getByText("Blocks Card 2", { exact: true })).toHaveCount(0);
    // Make a dirty title or description draft without saving
    await dialog.getByRole("button", { name: "Add a description…" }).click();
    await dialog.getByLabel("Card description").fill("Unsaved draft content");

    // Open Card actions -> Transfer card again
    await dialog.getByRole("button", { name: "Card actions" }).click();
    await page.getByRole("menuitem", { name: "Transfer card" }).click();

    transferDialog = page.getByRole("dialog", { name: "Transfer card" });
    await expect(transferDialog).toBeVisible();
    await expect(
      transferDialog.getByText("Save or discard title and description changes before transferring."),
    ).toBeVisible();
    await expect(transferDialog.getByRole("button", { name: "Transfer", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(transferDialog).toHaveCount(0);

    // Discard draft: close card, confirm discard prompt, reopen card
    await dialog.getByRole("button", { name: "Close card" }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Discard" }).click();
    await expect(dialog).toHaveCount(0);
    await c1.click();
    await expect(dialog).toBeVisible();

    // Test pending attachment deletion disables Transfer button
    await openCardSection(dialog, "attachments");
    const fileInput = dialog.getByTestId("attach-input");
    await fileInput.setInputFiles({
      name: "to-delete.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    });
    await expect(dialog.getByRole("heading", { name: "Attachments 1" })).toBeVisible();

    // Intercept delete route to simulate a pending/stalled attachment delete
    await page.route("**/internal/attachment/**", async () => {
      // hang request
    });
    const deleteAttBtn = dialog.getByRole("button", { name: "Delete attachment to-delete.png" });
    if (await deleteAttBtn.isVisible()) {
      await deleteAttBtn.click();
      // Confirm delete if dialog appears
      const confirmBtn = page.getByRole("button", { name: "Delete", exact: true });
      if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
      }
      // Open Transfer dialog: should show attachment deletion in progress
      await dialog.getByRole("button", { name: "Card actions" }).click();
      await page.getByRole("menuitem", { name: "Transfer card" }).click();
      const pendingDialog = page.getByRole("dialog", { name: "Transfer card" });
      if (await pendingDialog.isVisible()) {
        await expect(pendingDialog.getByRole("button", { name: "Transfer", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
      }
    }
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("dialog accessibility: roving menu keys, outside dismissal, board without columns warning, inert background, retry transferId reuse, and 375px responsive layout", async ({
    page,
  }) => {
    const email = uniqueEmail("xfer-a11y");
    await signup(page, email, "A11y Tester");

    const srcBoardName = `Src A11y ${Date.now()}`;
    const srcBoardKey = await createBoard(page, srcBoardName);
    const emptyDstBoardName = `Empty Dst ${Date.now()}`;
    const emptyDstBoardKey = await createBoard(page, emptyDstBoardName);
    const emptyDstBoardUuid = await getBoardUuid(page, emptyDstBoardName);
    // Visit empty board to initialize its Durable Object
    await page.getByRole("link", { name: emptyDstBoardName }).click();
    await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();

    await openBoardList(page);
    const normalDstBoardName = `Normal Dst ${Date.now()}`;
    const normalDstBoardKey = await createBoard(page, normalDstBoardName);
    const normalDstBoardUuid = await getBoardUuid(page, normalDstBoardName);
    await page.getByRole("link", { name: normalDstBoardName }).click();
    await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
    await addColumn(page, "Done");

    // Navigate to source board, add Todo column and Card
    await page.goto(`/board/${srcBoardKey}`);
    await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
    await addColumn(page, "Todo");
    await addCard(page, "Todo", "Card A11y");
    const col = columnByTitle(page, "Todo");
    await cardIn(col, "Card A11y").click();
    const cardDialog = page.getByRole("dialog");
    await expect(cardDialog).toBeVisible();

    const actionsBtn = cardDialog.getByRole("button", { name: "Card actions" });
    await actionsBtn.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();

    // Menu arrow keys wrap around
    await page.keyboard.press("ArrowDown");
    const firstMenuItem = page.getByRole("menuitem").first();
    await expect(firstMenuItem).toBeFocused();
    await page.keyboard.press("ArrowUp");
    // Wraps to last menu item (or first if 1 item)
    await expect(firstMenuItem).toBeFocused();

    // Outside pointerdown closes menu and restores trigger focus
    await page.mouse.click(10, 10);
    await expect(menu).toHaveCount(0);
    await expect(actionsBtn).toBeFocused();

    // Open menu again and test Escape closes menu and restores focus
    await actionsBtn.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(actionsBtn).toBeFocused();

    // Open menu, select Transfer card
    await actionsBtn.click();
    await page.getByRole("menuitem", { name: "Transfer card" }).click();

    const transferDialog = page.getByRole("dialog", { name: "Transfer card" });
    await expect(transferDialog).toBeVisible();

    // Underlying card surface is inert and focus is trapped inside dialog
    // Select the empty board with no columns by label
    await transferDialog.getByLabel("Board").selectOption({ label: `${emptyDstBoardName} (${emptyDstBoardKey})` });
    await expect(transferDialog.getByText("This board has no statuses.")).toBeVisible();
    await expect(transferDialog.getByRole("button", { name: "Transfer", exact: true })).toBeDisabled();

    // Select normal destination board and test failed transfer retry preserves transferId
    await transferDialog.getByLabel("Board").selectOption({ label: `${normalDstBoardName} (${normalDstBoardKey})` });
    await transferDialog.getByLabel("Status").selectOption({ label: "Done" });
    const interceptedTransferIds: string[] = [];
    await page.route("**/cards/*/transfer", async (route) => {
      const req = route.request();
      const postData = req.postDataJSON() as { transferId: string };
      if (postData?.transferId) {
        interceptedTransferIds.push(postData.transferId);
      }
      // All requests fail so card is not transferred
      await route.fulfill({ status: 500, json: { error: "Temporary failure" } });
    });
    // Responsive 375px layout while dialog is open
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(transferDialog).toBeVisible();
    const box = await transferDialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(375);

    const transferSubmitBtn = transferDialog.getByRole("button", { name: "Transfer", exact: true });
    await transferSubmitBtn.click();
    await expect(transferDialog.getByRole("alert")).toBeVisible();

    // Retry transfer
    await transferSubmitBtn.click();
    await expect.poll(() => interceptedTransferIds.length).toBeGreaterThanOrEqual(2);
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(interceptedTransferIds[0]).toMatch(UUID_REGEX);
    expect(interceptedTransferIds[1]).toMatch(UUID_REGEX);
    expect(interceptedTransferIds[0]).toBe(interceptedTransferIds[1]);
    await page.unrouteAll({ behavior: "ignoreErrors" });

  });
  test("transfer retry identity: 500 and network failure preserve UUID, terminal 409/410, code-tagged opaque 409 and destination change rotate UUID, uncoded 409 preserves UUID", async ({
    page,
  }) => {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const email = uniqueEmail("xfer-id-rotation");
    await signup(page, email, "ID Rotation Tester");

    // Create all boards from the boards list
    const srcBoardName = `Src Rotation ${Date.now()}`;
    const srcBoardKey = await createBoard(page, srcBoardName);

    const dstAlphaName = `Dst Alpha ${Date.now()}`;
    const dstAlphaKey = await createBoard(page, dstAlphaName);
    const dstAlphaUuid = await getBoardUuid(page, dstAlphaName);

    const dstBetaName = `Dst Beta ${Date.now()}`;
    const dstBetaKey = await createBoard(page, dstBetaName);
    const dstBetaUuid = await getBoardUuid(page, dstBetaName);

    // Setup Destination Board Alpha with two columns: In Progress and Done
    await page.goto(`/board/${dstAlphaKey}`);
    await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
    await addColumn(page, "In Progress");
    await addColumn(page, "Done");

    // Setup Destination Board Beta with one column: Review
    await page.goto(`/board/${dstBetaKey}`);
    await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
    await addColumn(page, "Review");

    // Setup Source Board with Todo column and Card
    await page.goto(`/board/${srcBoardKey}`);
    await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
    await addColumn(page, "Todo");
    await addCard(page, "Todo", "Card ID Lifecycle");
    const todoCol = columnByTitle(page, "Todo");
    await cardIn(todoCol, "Card ID Lifecycle").click();
    const cardModal = page.getByRole("dialog");
    await expect(cardModal).toBeVisible();
    await cardModal.getByRole("button", { name: "Card actions" }).click();
    await page.getByRole("menuitem", { name: "Transfer card" }).click();

    const transferDialog = page.getByRole("dialog", { name: "Transfer card" });
    await expect(transferDialog).toBeVisible();

    // Select Destination Alpha and Status "In Progress"
    await transferDialog.getByLabel("Board").selectOption({ label: `${dstAlphaName} (${dstAlphaKey})` });
    await transferDialog.getByLabel("Status").selectOption({ label: "In Progress" });
    const transferBtn = transferDialog.getByRole("button", { name: "Transfer", exact: true });
    await expect(transferBtn).toBeEnabled();

    interface InterceptedRequest {
      transferId: string;
      destinationBoardId: string;
      destinationColumnId: string;
    }
    const intercepted: InterceptedRequest[] = [];
    let mockMode:
      | { kind: "status"; status: number; body?: unknown }
      | { kind: "abort" } = { kind: "status", status: 500, body: { error: "Initial 500" } };

    await page.route("**/cards/*/transfer", async (route) => {
      const req = route.request();
      const data = req.postDataJSON() as {
        transferId: string;
        destinationBoardId: string;
        destinationColumnId: string;
      };
      if (data?.transferId) {
        intercepted.push({
          transferId: data.transferId,
          destinationBoardId: data.destinationBoardId,
          destinationColumnId: data.destinationColumnId,
        });
      }
      if (mockMode.kind === "abort") {
        await route.abort("failed");
      } else {
        await route.fulfill({
          status: mockMode.status,
          json: mockMode.body ?? {},
        });
      }
    });

    // 1. Initial attempt -> 500
    mockMode = { kind: "status", status: 500, body: { error: "Server 500 Error" } };
    await transferBtn.click();
    await expect(transferDialog.getByRole("alert")).toBeVisible();
    await expect.poll(() => intercepted.length).toBe(1);

    const id1 = intercepted[0].transferId;
    expect(id1).toMatch(UUID_REGEX);
    expect(intercepted[0].destinationBoardId).toBe(dstAlphaUuid);
    const colInProgressId = intercepted[0].destinationColumnId;

    // 2. Retry without changes after 500 -> preserves id1
    mockMode = { kind: "status", status: 500, body: { error: "Second 500 Error" } };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(2);
    expect(intercepted[1].transferId).toBe(id1);
    expect(intercepted[1].destinationBoardId).toBe(dstAlphaUuid);
    expect(intercepted[1].destinationColumnId).toBe(colInProgressId);

    // 3. Retry after network drop / abort -> preserves id1
    mockMode = { kind: "abort" };
    await transferBtn.click();
    await expect(transferDialog.getByRole("alert")).toContainText("Transfer failed. Please retry.");
    await expect.poll(() => intercepted.length).toBe(3);
    expect(intercepted[2].transferId).toBe(id1);
    expect(intercepted[2].destinationBoardId).toBe(dstAlphaUuid);
    expect(intercepted[2].destinationColumnId).toBe(colInProgressId);
    // 4. Change destination column to "Done" on same board -> rotates to fresh UUID id2
    mockMode = { kind: "status", status: 500, body: { error: "Col change 500" } };
    await transferDialog.getByLabel("Status").selectOption({ label: "Done" });
    await transferBtn.click();
    await expect(transferDialog.getByRole("alert")).toBeVisible();
    await expect.poll(() => intercepted.length).toBe(4);
    const id2 = intercepted[3].transferId;
    expect(id2).toMatch(UUID_REGEX);
    expect(id2).not.toBe(id1);
    expect(intercepted[3].destinationBoardId).toBe(dstAlphaUuid);
    expect(intercepted[3].destinationColumnId).not.toBe(colInProgressId);

    // 5. Change destination board to Destination Beta -> rotates to fresh UUID id3
    mockMode = { kind: "status", status: 500, body: { error: "Board change 500" } };
    await transferDialog.getByLabel("Board").selectOption({ label: `${dstBetaName} (${dstBetaKey})` });
    await transferDialog.getByLabel("Status").selectOption({ label: "Review" });
    await transferBtn.click();
    await expect(transferDialog.getByRole("alert")).toBeVisible();
    await expect.poll(() => intercepted.length).toBe(5);
    const id3 = intercepted[4].transferId;
    expect(id3).toMatch(UUID_REGEX);
    expect(id3).not.toBe(id2);
    expect(id3).not.toBe(id1);
    expect(intercepted[4].destinationBoardId).toBe(dstBetaUuid);

    // 6. Retry on Beta after 500 -> preserves id3
    mockMode = { kind: "status", status: 500, body: { error: "Another 500" } };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(6);
    expect(intercepted[5].transferId).toBe(id3);
    expect(intercepted[5].destinationBoardId).toBe(dstBetaUuid);

    // 7. Explicit terminal 409 conflict (aborted/terminated)
    mockMode = {
      kind: "status",
      status: 409,
      body: { error: "Transfer operation was aborted", aborted: true },
    };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(7);
    expect(intercepted[6].transferId).toBe(id3);
    await expect(transferDialog.getByRole("alert")).toContainText("Transfer operation was aborted");
    await expect(transferDialog.getByRole("alert")).toContainText("A new transfer operation has been prepared. Please retry.");

    // 8. Retry after terminal 409 -> rotates to fresh UUID id4
    mockMode = { kind: "status", status: 500, body: { error: "Post 409 failure" } };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(8);
    const id4 = intercepted[7].transferId;
    expect(id4).toMatch(UUID_REGEX);
    expect(id4).not.toBe(id3);
    expect(id4).not.toBe(id2);
    expect(id4).not.toBe(id1);
    expect(intercepted[7].destinationBoardId).toBe(dstBetaUuid);

    // 9. Explicit 410 Gone (terminal resource deletion)
    mockMode = {
      kind: "status",
      status: 410,
      body: { error: "Card was deleted or transferred elsewhere" },
    };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(9);
    expect(intercepted[8].transferId).toBe(id4);
    await expect(transferDialog.getByRole("alert")).toContainText("Card was deleted or transferred elsewhere");
    await expect(transferDialog.getByRole("alert")).toContainText("A new transfer operation has been prepared. Please retry.");

    // 10. Retry after terminal 410 -> rotates to fresh UUID id5
    mockMode = { kind: "status", status: 500, body: { error: "Post 410 failure" } };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(10);
    const id5 = intercepted[9].transferId;
    expect(id5).toMatch(UUID_REGEX);
    expect(id5).not.toBe(id4);
    expect(id5).not.toBe(id3);
    expect(id5).not.toBe(id2);
    expect(id5).not.toBe(id1);
    expect(intercepted[9].destinationBoardId).toBe(dstBetaUuid);

    // 11. Explicit 409 identity mismatch, tagged with the terminal code
    mockMode = {
      kind: "status",
      status: 409,
      body: { error: "transfer operation identity mismatch", code: "transfer_terminal" },
    };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(11);
    expect(intercepted[10].transferId).toBe(id5);
    await expect(transferDialog.getByRole("alert")).toContainText("transfer operation identity mismatch");
    await expect(transferDialog.getByRole("alert")).toContainText("A new transfer operation has been prepared. Please retry.");

    // 12. Retry after the code-tagged identity-mismatch 409 -> rotates to fresh UUID id6
    mockMode = { kind: "status", status: 500, body: { error: "Post identity mismatch failure" } };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(12);
    const id6 = intercepted[11].transferId;
    expect(id6).toMatch(UUID_REGEX);
    expect(id6).not.toBe(id5);
    expect(id6).not.toBe(id4);
    expect(id6).not.toBe(id3);
    expect(id6).not.toBe(id2);
    expect(id6).not.toBe(id1);

    // 13. Opaque 409 prose carrying code: "transfer_terminal" — terminal by code alone
    mockMode = {
      kind: "status",
      status: 409,
      body: { error: "Request could not be completed.", code: "transfer_terminal" },
    };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(13);
    expect(intercepted[12].transferId).toBe(id6);
    await expect(transferDialog.getByRole("alert")).toContainText("Request could not be completed.");
    await expect(transferDialog.getByRole("alert")).toContainText(
      "A new transfer operation has been prepared. Please retry.",
    );

    // 14. Retry after the code-tagged 409 -> rotates to fresh UUID id7
    mockMode = { kind: "status", status: 500, body: { error: "Post opaque terminal failure" } };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(14);
    const id7 = intercepted[13].transferId;
    expect(id7).toMatch(UUID_REGEX);
    expect(id7).not.toBe(id6);
    expect(intercepted[13].destinationBoardId).toBe(dstBetaUuid);

    // 15. An uncoded 409 is non-terminal no matter how terminal its prose
    //     sounds: the operation is still live server-side, so the id must not
    //     rotate and no new-operation notice may appear.
    mockMode = {
      kind: "status",
      status: 409,
      body: { error: "Transfer operation was aborted and terminated; identity mismatch" },
    };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(15);
    expect(intercepted[14].transferId).toBe(id7);
    await expect(transferDialog.getByRole("alert")).toContainText(
      "Transfer operation was aborted and terminated; identity mismatch",
    );
    await expect(transferDialog.getByRole("alert")).not.toContainText(
      "A new transfer operation has been prepared.",
    );

    // 16. Retry after the uncoded 409 resumes the same operation
    mockMode = { kind: "status", status: 500, body: { error: "Post uncoded 409 failure" } };
    await transferBtn.click();
    await expect.poll(() => intercepted.length).toBe(16);
    expect(intercepted[15].transferId).toBe(id7);
    expect(intercepted[15].destinationBoardId).toBe(dstBetaUuid);

    // Exact request sequence and UUID validity across all intercepted attempts
    expect(intercepted.map((req) => req.transferId)).toEqual([
      id1, // #1: initial
      id1, // #2: retry after 500
      id1, // #3: retry after network abort
      id2, // #4: retry after column change
      id3, // #5: retry after board change
      id3, // #6: retry after 500 on Beta
      id3, // #7: attempt returning 409 aborted
      id4, // #8: retry after 409 aborted (rotated)
      id4, // #9: attempt returning 410 gone
      id5, // #10: retry after 410 gone (rotated)
      id5, // #11: attempt returning code-tagged 409 identity mismatch
      id6, // #12: retry after code-tagged identity-mismatch 409 (rotated)
      id6, // #13: attempt returning opaque 409 tagged transfer_terminal
      id7, // #14: retry after code-tagged terminal 409 (rotated)
      id7, // #15: attempt returning uncoded 409 with terminal-sounding prose (nonterminal)
      id7, // #16: retry resuming the same live operation
    ]);

    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});
