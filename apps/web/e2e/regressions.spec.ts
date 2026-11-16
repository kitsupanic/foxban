declare const Buffer: {
  from(str: string, encoding?: string): { buffer: ArrayBuffer };
};
import { test, expect, type Browser, type Page } from "@playwright/test";
import {
  createBoard,
  addColumn,
  addCard,
  cardIn,
  columnByTitle,
  signup,
  uniqueEmail,
  getBoardUuid,
  inviteMember,
  openCardSection,
} from "./helpers";
import { localISODate } from "../src/lib/due-date";
async function newUser(browser: Browser, suffix: string): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail(suffix);
  await signup(page, email, suffix);
  return { page, email };
}

async function newCoarseUser(browser: Browser, suffix: string): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 768, height: 1024 },
  });
  const page = await context.newPage();
  await page.emulateMedia({ media: "screen" });
  const email = uniqueEmail(suffix);
  await signup(page, email, suffix);
  return { page, email };
}

test.describe("editor, draft and layout regressions", () => {
  test("Delayed title Save closes when clean, but preserves existing or active comments across late echo", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-ux1-delay");
    const boardName = `UX1-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);

    // Hold card.update echo briefly to verify pending Save state and composer safety
    let releaseSaveEcho: (() => void) | null = null;
    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "card.update" && releaseSaveEcho === null) {
          releaseSaveEcho = () => ws.send(msg);
          return;
        }
        ws.send(msg);
      });
    });

    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Composer Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Composer Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Start a comment composer with content
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditor.fill("Draft started during save");

    // Start editing title and save while comment composer is open
    await dialog.getByRole("button", { name: "Edit title", exact: true }).click();
    await dialog.getByLabel("Card title").fill("Delayed Title Card");
    await dialog.getByRole("button", { name: "Save title & description" }).click();

    // Release held echo
    await expect.poll(() => releaseSaveEcho).not.toBeNull();
    releaseSaveEcho!();

    // Modal remained open and draft preserved because comment composer was open
    await expect(dialog).toBeVisible();
    await expect(commentEditor).toHaveValue("Draft started during save");

    // Close comment composer; now edit description and Save: modal closes
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.getByRole("button", { name: "Add a description…" }).click();
    await dialog.getByLabel("Card description").fill("Clean description save");
    await dialog.getByRole("button", { name: "Save title & description" }).click();
    await expect(dialog).toHaveCount(0);
    await user.page.context().close();
  });

  test("Authored comment rejection retains exact draft with inline actionable retry", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-f2-reject");
    const boardName = `F2Reject-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);

    let failComment = true;
    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.type === "comment.create" && failComment) {
          failComment = false;
          ws.send(
            JSON.stringify({
              type: "error",
              mutationId: frame.mutationId,
              message: "Server rejected comment per test.",
            }),
          );
          return;
        }
        server.send(message);
      });
      server.onMessage((message) => ws.send(message));
    });

    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Reject Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Reject Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditor.fill("Draft to be rejected");

    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // Rejection error displayed
    await expect(dialog.getByText("Server rejected comment per test.")).toBeVisible();
    await expect(commentEditor).toHaveValue("Draft to be rejected");

    // Clicking Retry unsent comment resends the comment
    const retryBtn = dialog.getByRole("button", { name: "Retry unsent comment", exact: true });
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    // Successful retry clears composer and renders comment
    await expect(dialog.locator("p").filter({ hasText: "Draft to be rejected" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
    await user.page.context().close();
  });

  test("Disconnect with pending mutation settles accepted on snapshot-present and verified-retry on snapshot-absent", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-f2-resync");
    const boardName = `F2Resync-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);

    let dropNextEcho = true;

    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (dropNextEcho && frame.type === "comment.create") {
          // Suppress own echo to simulate in-flight disconnect
          dropNextEcho = false;
          // Close websocket so client must reconnect and receive snapshot
          ws.close({ code: 1012, reason: "simulated disconnect" });
          return;
        }
        ws.send(message);
      });
    });

    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Disconnect Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Disconnect Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditor.fill("Resilient comment across snapshot");

    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // Reconnect snapshot arrives, containing the comment created by server
    // Dialog settles comment as accepted without duplicate entries
    await expect(dialog.locator("p").filter({ hasText: "Resilient comment across snapshot" })).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);

    await user.page.context().close();
  });

  test("Reply target and generation matching prevents clearing replacement replies upon late acceptance", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-f2-reply");
    const boardName = `F2Reply-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);

    let releaseReplyEcho: (() => void) | null = null;
    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "comment.create" && frame.parentCommentId !== null) {
          releaseReplyEcho = () => ws.send(msg);
          return;
        }
        ws.send(msg);
      });
    });

    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Reply Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Reply Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Create a root comment
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("Root Comment One");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(dialog.locator("p").filter({ hasText: "Root Comment One" })).toBeVisible();

    // Reply to Root Comment One with text X
    await dialog.getByRole("button", { name: "Reply to comment" }).click();
    const replyEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await replyEditor.fill("Identical reply text");
    await dialog.getByRole("button", { name: "Reply", exact: true }).click();

    // Now start a root comment composer while reply echo is held
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const newRootEditor = dialog.getByRole("textbox", { name: "Comment", exact: true }).last();
    await newRootEditor.fill("Identical reply text");

    // Release delayed reply echo: it must NOT clear the replacement composer
    expect(releaseReplyEcho).not.toBeNull();
    releaseReplyEcho!();

    // The root composer must remain mounted with its draft intact
    await expect(newRootEditor).toBeVisible();
    await expect(newRootEditor).toHaveValue("Identical reply text");

    await user.page.context().close();
  });

  test("Submitted draft A locks editor while in-flight; rejection or verified-absence retains exact A with Retry and Discard; discard resists resurrection", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-f2-locked-draft");
    const boardName = `LockedRecovery-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);
    const sentCommentPayloads: { type: string; mutationId?: string; body?: string }[] = [];
    let rejectFirstComment = true;
    let dropSecondCommentOnServer = true;
    let triggerCommentReject: (() => void) | null = null;
    let rejectReply = true;
    let triggerReplyReject: (() => void) | null = null;
    let rejectSave = true;
    let triggerSaveReject: (() => void) | null = null;
    let lateWs: { send: (msg: string) => void; close: (opt?: { code?: number; reason?: string }) => void } | null = null;
    let snapshotCount = 0;

    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      lateWs = ws;
      const server = ws.connectToServer();
      ws.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "comment.create") {
          sentCommentPayloads.push(frame);
          if (rejectFirstComment && frame.body === "Comment Draft A") {
            rejectFirstComment = false;
            triggerCommentReject = () => {
              ws.send(
                JSON.stringify({
                  type: "error",
                  mutationId: frame.mutationId,
                  message: "Server rejected Draft A.",
                }),
              );
            };
            return;
          }
          if (dropSecondCommentOnServer && frame.body === "Comment Draft A2") {
            // Drop on server, simulate disconnect so client receives snapshot without it (snapshot-absent)
            dropSecondCommentOnServer = false;
            ws.close({ code: 1012, reason: "simulated disconnect for absent check" });
            return;
          }
          if (rejectReply && frame.parentCommentId !== null && frame.body === "Reply Draft A") {
            rejectReply = false;
            triggerReplyReject = () => {
              ws.send(
                JSON.stringify({
                  type: "error",
                  mutationId: frame.mutationId,
                  message: "Server rejected Reply A.",
                }),
              );
            };
            return;
          }
        }
        if (rejectSave && frame.type === "card.update" && frame.description === "Description Draft A") {
          rejectSave = false;
          triggerSaveReject = () => {
            ws.send(
              JSON.stringify({
                type: "error",
                mutationId: frame.mutationId,
                message: "Server rejected Save A.",
              }),
            );
          };
          return;
        }
        server.send(msg);
      });
      server.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "snapshot") {
          snapshotCount++;
        }
        ws.send(msg);
      });
    });
    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Locked Recovery Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Locked Recovery Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // --- Scenario 1: Comment A submitted -> Editor is locked (readOnly) while pending; rejection unlocks exact A with Retry/Discard ---
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditor.fill("Comment Draft A");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // While in flight, comment editor is readOnly and submit button is disabled
    await expect(commentEditor).toHaveAttribute("readonly", "");
    await expect(dialog.getByRole("button", { name: "Sending…" })).toBeDisabled();

    // Escape and Cancel cannot bypass lock or clear draft
    await commentEditor.press("Escape");
    await expect(commentEditor).toHaveValue("Comment Draft A");
    const pendingCommentCancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await expect(pendingCommentCancel).toBeDisabled();
    // Do not wait for the request deadline to unlock Cancel: attempt the
    // pointer activation while it is disabled and the submitted draft locked.
    await pendingCommentCancel.click({ force: true });
    await expect(commentEditor).toHaveAttribute("readonly", "");
    await expect(commentEditor).toHaveValue("Comment Draft A");

    // Formatting shortcuts cannot mutate draft while locked
    await commentEditor.press("ControlOrMeta+b");
    await expect(commentEditor).toHaveValue("Comment Draft A");
    // Trigger rejection
    await expect.poll(() => triggerCommentReject).not.toBeNull();
    triggerCommentReject!();

    // Error arrives: recovery strip shows server error, editor unlocks with exact A retained
    await expect(dialog.getByText("Server rejected Draft A.")).toBeVisible();
    await expect(commentEditor).not.toHaveAttribute("readonly", "");
    await expect(commentEditor).toHaveValue("Comment Draft A");

    // Click "Retry unsent comment": editor locks again, sends A
    const retryBtn = dialog.getByRole("button", { name: "Retry unsent comment" });
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    // A is accepted and posted as a comment; composer closes cleanly
    await expect(dialog.locator("p").filter({ hasText: "Comment Draft A" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Retry unsent comment" })).toHaveCount(0);

    // --- Scenario 2: Comment A2 submitted, disconnect + snapshot absent -> Discard retires tracking; second resync cannot resurrect ---
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor2 = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditor2.fill("Comment Draft A2");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // Wait for verified-retry recovery strip
    await expect(dialog.getByText("Sync could not verify comment. You can retry sending.")).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText("Unsent comment: Comment Draft A2")).toBeVisible();
    await expect(commentEditor2).toHaveValue("Comment Draft A2");

    // Discard unsent comment removes recovery strip and retires tracking
    await dialog.getByRole("button", { name: "Discard unsent comment" }).click();
    await expect(dialog.getByRole("button", { name: "Discard unsent comment" })).toHaveCount(0);
    await expect(commentEditor2).toHaveValue("Comment Draft A2");

    // Force a second disconnect and wait for positive second authoritative snapshot resync:
    // positively verify that second snapshot without A2 does NOT resurrect recovery strip
    const preSecondSnapshotCount = snapshotCount;
    if (lateWs) {
      lateWs.close({ code: 1012, reason: "second disconnect test" });
    }
    // Positively observe that second authoritative snapshot arrives from server
    await expect.poll(() => snapshotCount, { timeout: 10_000 }).toBeGreaterThan(preSecondSnapshotCount);
    await expect(dialog.getByText("Sync uncertain — reconnecting to verify.")).toHaveCount(0, { timeout: 10_000 });
    await expect(dialog.getByText("Not connected — changes won't send.")).toHaveCount(0, { timeout: 10_000 });
    // Positive assertion: recovery strip remains absent after verified second snapshot resync!
    await expect(dialog.getByText("Sync could not verify comment. You can retry sending.")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Discard unsent comment" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Retry unsent comment" })).toHaveCount(0);
    // Clear composer
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.getByRole("button", { name: "Reply to comment" }).click();
    const replyEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await replyEditor.fill("Reply Draft A");
    await dialog.getByRole("button", { name: "Reply", exact: true }).click();

    // While in flight, reply editor is locked and Reply button indicates sending
    await expect(replyEditor).toHaveAttribute("readonly", "");
    await expect(dialog.getByRole("button", { name: "Sending…" })).toBeDisabled();

    // Attempting Cancel or Escape while locked does not clear reply draft
    await replyEditor.press("Escape");
    await expect(replyEditor).toHaveValue("Reply Draft A");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(replyEditor).toHaveValue("Reply Draft A");
    // Trigger rejection of Reply A
    await expect.poll(() => triggerReplyReject).not.toBeNull();
    triggerReplyReject!();

    // Rejection arrives: recovery strip shows Reply A error, reply editor unlocked with exact A
    await expect(dialog.getByText("Server rejected Reply A.")).toBeVisible();
    await expect(dialog.getByText("Unsent reply: Reply Draft A")).toBeVisible();
    await expect(replyEditor).not.toHaveAttribute("readonly", "");
    await expect(replyEditor).toHaveValue("Reply Draft A");

    // Retry reply
    const retryReplyBtn = dialog.getByRole("button", { name: "Retry unsent reply" });
    await expect(retryReplyBtn).toBeVisible();
    await retryReplyBtn.click();

    // Retry accepted: reply rendered, composer closed
    await expect(dialog.locator("p").filter({ hasText: "Reply Draft A" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Retry unsent reply" })).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);

    // --- Scenario 4: Save Title/Description A submitted -> locked while in flight; rejection unlocks exact A ---
    await dialog.getByRole("button", { name: "Add a description…" }).click();
    const descEditor = dialog.getByLabel("Card description");
    await descEditor.fill("Description Draft A");
    await dialog.getByRole("button", { name: "Save title & description" }).click();

    // While save in flight, description editor is read-only and Save button shows Saving…
    await expect(descEditor).toHaveAttribute("readonly", "");
    await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(dialog.getByRole("status").filter({ hasText: /^Saving…$/ })).toBeVisible();
    await expect(dialog.getByText("Title and description are up to date.", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog.getByText("Leaving won’t cancel changes already submitted.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();

    // Trigger rejection of Save A
    await expect.poll(() => triggerSaveReject).not.toBeNull();
    triggerSaveReject!();

    // Rejection arrives: recovery strip shows Save A error, description editor unlocked with exact A
    await expect(dialog.getByText("Server rejected Save A.")).toBeVisible();
    await expect(dialog.getByText("Title and description are up to date.", { exact: true })).toHaveCount(0);
    await expect(dialog.locator("span").filter({ hasText: "Description:" })).toBeVisible();
    await expect(dialog.getByRole("alert").getByText("Description Draft A")).toBeVisible();
    await expect(descEditor).not.toHaveAttribute("readonly", "");
    await expect(descEditor).toHaveValue("Description Draft A");

    // Navigation while recoverable remains guarded
    await dialog.getByRole("button", { name: "Close card" }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByRole("alert").getByText("Description Draft A")).toBeVisible();

    // Discard unsent save removes recovery strip while keeping exact draft in editor
    await dialog.getByRole("button", { name: "Discard unsent save" }).click();
    await expect(dialog.getByRole("button", { name: "Discard unsent save" })).toHaveCount(0);
    await expect(descEditor).toHaveValue("Description Draft A");
    await expect(dialog.getByRole("button", { name: "Save title & description" })).toBeEnabled();

    // --- Scenario 5: Root comment whitespace normalization & exact wire bodies (F15) ---
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const wsCommentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    const rawWhitespaceDraft = "  Whitespace root comment\n  ";
    await wsCommentEditor.fill(rawWhitespaceDraft);
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // Outgoing payload has trimmed body, while editor clears cleanly once accepted
    await expect.poll(() => sentCommentPayloads.find((p) => p.body === "Whitespace root comment")).toBeDefined();
    await expect(dialog.locator("p").filter({ hasText: "Whitespace root comment" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);

    // Save description and close
    await dialog.getByRole("button", { name: "Save title & description" }).click();
    await expect(dialog).toHaveCount(0);
    await user.page.context().close();
  });

  test("Late authoritative acceptance arrives while recovery A is displayed and settles without duplicate", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-f11-late");
    const boardName = `LateAccept-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);

    let lateFrame: { type: string; mutationId: string; id: string; body: string; [key: string]: unknown } | null = null;
    let lateWs: { send: (msg: string) => void } | null = null;
    let dropForAbsent = true;

    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      lateWs = ws;
      const server = ws.connectToServer();
      ws.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "comment.create" && frame.body === "Comment A for late accept" && dropForAbsent) {
          dropForAbsent = false;
          lateFrame = frame;
          // Drop server echo and simulate disconnect so snapshot arrives without it
          ws.close({ code: 1012, reason: "simulate absent disconnect" });
          return;
        }
        server.send(msg);
      });
      server.onMessage((msg) => ws.send(msg));
    });

    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Late Accept Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Late Accept Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const lateCommentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await lateCommentEditor.fill("Comment A for late accept");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();
    // In-flight: editor is locked
    await expect(lateCommentEditor).toHaveAttribute("readonly", "");

    // Wait for verified-retry recovery strip
    await expect(dialog.getByText("Sync could not verify comment. You can retry sending.")).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText("Unsent comment: Comment A for late accept")).toBeVisible();
    await expect(lateCommentEditor).not.toHaveAttribute("readonly", "");
    await expect(lateCommentEditor).toHaveValue("Comment A for late accept");

    // Authoritative acceptance arrives now (e.g. peer broadcast or late echo)
    if (lateFrame && lateWs) {
      lateWs.send(JSON.stringify(lateFrame));
    }

    // Recovery strip settles automatically because entity is now present in authoritative comments
    await expect(dialog.getByText("Sync could not verify comment. You can retry sending.")).toHaveCount(0);
    await expect(dialog.locator("p").filter({ hasText: "Comment A for late accept" })).toBeVisible();
    // Since Comment A is accepted, composer is canceled/cleared cleanly
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);

    // Close card cleanly
    await dialog.getByRole("button", { name: "Close card" }).click();
    await expect(dialog).toHaveCount(0);

    await user.page.context().close();
  });
  test("While recovery retry is pending, Discard is disabled; accepted echo settles entire lineage and unlocks lane", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-f11-lineage");
    const boardName = `LineageSettle-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);

    let releaseRetryEcho: (() => void) | null = null;
    let rejectFirst = true;

    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "comment.create" && frame.body === "Comment A for retry lineage") {
          if (rejectFirst) {
            rejectFirst = false;
            ws.send(
              JSON.stringify({
                type: "error",
                mutationId: frame.mutationId,
                message: "Server rejected initial attempt.",
              }),
            );
            return;
          }
          // Second attempt (the Retry): hold its echo
          releaseRetryEcho = () => {
            server.send(msg);
          };
          return;
        }
        server.send(msg);
      });
      server.onMessage((msg) => ws.send(msg));
    });

    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Lineage Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Lineage Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Submit Comment A
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditor.fill("Comment A for retry lineage");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // Initial attempt rejected: recovery strip appears with Retry and Discard buttons
    await expect(dialog.getByText("Server rejected initial attempt.")).toBeVisible();
    const discardBtn = dialog.getByRole("button", { name: "Discard unsent comment" });
    const retryBtn = dialog.getByRole("button", { name: "Retry unsent comment" });
    await expect(discardBtn).toBeEnabled();
    await expect(retryBtn).toBeEnabled();

    // Click Retry: retry is now in-flight (held by test)
    await retryBtn.click();

    // Requirement: While recovery Retry attempt is pending/uncertain, Discard is DISABLED
    await expect(dialog.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Discard unsent comment" })).toBeDisabled();
    await expect(commentEditor).toHaveAttribute("readonly", "");

    // Release held retry echo -> server accepts mutation
    await expect.poll(() => releaseRetryEcho).not.toBeNull();
    releaseRetryEcho!();

    // Entire lineage settles: comment is posted, recovery strip clears, composer closes cleanly
    await expect(dialog.locator("p").filter({ hasText: "Comment A for retry lineage" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Discard unsent comment" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Retry unsent comment" })).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);

    // Modal can close cleanly without blocked navigation
    await dialog.getByRole("button", { name: "Close card" }).click();
    await expect(dialog).toHaveCount(0);
    await user.page.context().close();
  });

  test("In-flight upload blocks keyboard and recovery retry submissions until image insertion completes", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-f13-upload-gate");
    const boardName = `UploadGate-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);

    const PNG_1X1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    const sentCommentFrames: { type: string; mutationId?: string; body?: string }[] = [];
    let triggerRecoveryReject: (() => void) | null = null;
    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "comment.create") {
          sentCommentFrames.push(frame);
          if (frame.body?.includes("Comment text before upload")) {
            triggerRecoveryReject = () => {
              ws.send(
                JSON.stringify({
                  type: "error",
                  mutationId: frame.mutationId,
                  message: "Server rejected upload comment.",
                }),
              );
            };
            return;
          }
        }
        server.send(msg);
      });
      server.onMessage((msg) => ws.send(msg));
    });

    // Hold the attachment upload network request
    let resumeUpload!: () => void;
    const uploadHold = new Promise<void>((resolve) => {
      resumeUpload = resolve;
    });
    await user.page.route("**/boards/*/attachments", async (route) => {
      await uploadHold;
      await route.continue();
    });

    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Upload Gate Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Upload Gate Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Open comment composer and type initial draft
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditor.fill("Comment text before upload");

    // Start an image upload in comment composer
    const imageInput = dialog.locator(".card-comment-composer-row").getByTestId("comment-image-input");
    await imageInput.setInputFiles({ name: "held-photo.png", mimeType: "image/png", buffer: PNG_1X1 });

    // While upload is in flight, Comment button is disabled
    await expect(dialog.getByRole("button", { name: "Comment", exact: true })).toBeDisabled();

    // Attempt submission via keyboard shortcut (Ctrl/Cmd+Enter)
    await commentEditor.focus();
    await commentEditor.press("ControlOrMeta+Enter");

    // Assert: no WebSocket frame was sent, editor is NOT locked into read-only
    expect(sentCommentFrames).toHaveLength(0);
    await expect(commentEditor).not.toHaveAttribute("readonly", "");

    // Release the upload hold
    resumeUpload();

    // Image insertion completes and embeds markdown into comment editor
    await expect(commentEditor).toHaveValue(
      /Comment text before upload\n*!\[held-photo\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/,
    );
    await expect(dialog.getByRole("button", { name: "Comment", exact: true })).toBeEnabled();

    await dialog.getByRole("button", { name: "Comment", exact: true }).click();
    await expect.poll(() => triggerRecoveryReject).not.toBeNull();
    triggerRecoveryReject!();

    // Recovery strip appears with Retry unsent comment
    await expect(dialog.getByText("Server rejected upload comment.")).toBeVisible();
    const retryBtn = dialog.getByRole("button", { name: "Retry unsent comment" });
    await expect(retryBtn).toBeEnabled();

    // Start a second image upload while recovery is active
    let resumeSecondUpload!: () => void;
    const secondUploadHold = new Promise<void>((resolve) => {
      resumeSecondUpload = resolve;
    });
    await user.page.route("**/boards/*/attachments", async (route) => {
      await secondUploadHold;
      await route.continue();
    });

    await imageInput.setInputFiles({ name: "second-held.png", mimeType: "image/png", buffer: PNG_1X1 });

    // While second upload is in flight, recovery Retry button is disabled!
    await expect(retryBtn).toBeDisabled();

    // Release second upload
    resumeSecondUpload();
    await expect(retryBtn).toBeEnabled();

    // Discard unsent comment to clean up
    await dialog.getByRole("button", { name: "Discard unsent comment" }).click();
    await expect(dialog.getByRole("button", { name: "Discard unsent comment" })).toHaveCount(0);

    // Close modal cleanly
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.getByRole("button", { name: "Close card" }).click();
    await expect(dialog).toHaveCount(0);
    await user.page.context().close();
  });

  test("Image-only reply upload ownership across target switching, peer deletion orphan recovery, browser history, and verified-absence late acceptance", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-f13-upload-ownership");
    const boardName = `UploadOwnership-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);

    const PNG_1X1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    let releaseCommentAcceptance: (() => void) | null = null;
    let holdPendingCommentEcho = false;
    let releasePendingCommentEcho: (() => void) | null = null;
    let rootBCommentId: string | null = null;
    let childReplyCommentId: string | null = null;
    let simulatePeerDeleteChildReply: (() => void) | null = null;
    let lateEchoCommentX: (() => void) | null = null;
    let dropCommentX = true;
    let simulatePeerDeleteRootB: (() => void) | null = null;
    let activeClientWs: { send: (msg: string) => void } | null = null;
    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      activeClientWs = ws;
      const server = ws.connectToServer();
      ws.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "comment.create" && frame.body === "Comment for verified absence") {
          lateEchoCommentX = () => {
            // Send through the current reconnected WebSocket route
            activeClientWs?.send(
              JSON.stringify({
                type: "comment.create",
                mutationId: frame.mutationId,
                id: frame.id,
                cardId: frame.cardId,
                authorId: frame.authorId,
                parentCommentId: null,
                body: frame.body,
                createdAt: frame.createdAt,
              }),
            );
          };
          if (dropCommentX) {
            dropCommentX = false;
            ws.close({ code: 1012, reason: "simulate disconnect for verified absence" });
            return;
          }
        }
        server.send(msg);
      });
      server.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "comment.create") {
          if (holdPendingCommentEcho && frame.body === "Root comment in progress") {
            releasePendingCommentEcho = () => ws.send(msg);
            return;
          }
          if (releaseCommentAcceptance === null) {
            releaseCommentAcceptance = () => ws.send(msg);
            return;
          }
          if (frame.body === "Root Comment B") {
            simulatePeerDeleteRootB = () => {
              ws.send(
                JSON.stringify({
                  type: "comment.delete",
                  mutationId: crypto.randomUUID(),
                  id: frame.id,
                }),
              );
            };
          }
          if (frame.body === "Child reply on Root A") {
            childReplyCommentId = frame.id;
            simulatePeerDeleteChildReply = () => {
              ws.send(
                JSON.stringify({
                  type: "comment.delete",
                  mutationId: crypto.randomUUID(),
                  id: frame.id,
                }),
              );
            };
          }
        }
        ws.send(msg);
      });
    });

    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Upload Ownership Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Upload Ownership Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // --- Scenario 1: Empty root-comment upload disables text Save and protects Close ---
    let resumeUpload1!: () => void;
    let upload1Hold = new Promise<void>((resolve) => {
      resumeUpload1 = resolve;
    });
    await user.page.route("**/boards/*/attachments", async (route) => {
      await upload1Hold;
      await route.continue();
    });

    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await expect(commentEditor).toHaveValue("");

    const imageInput = dialog.locator(".card-comment-composer-row").getByTestId("comment-image-input");
    await imageInput.setInputFiles({ name: "held-root-image.png", mimeType: "image/png", buffer: PNG_1X1 });

    // No text changes can be saved. Close still protects the active upload.
    await expect(dialog.getByRole("button", { name: "Save title & description" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();

    // In-flight upload is active authored work: modal must remain open and composer must stay mounted!
    await expect(dialog).toBeVisible();
    await expect(commentEditor).toBeVisible();

    // --- Scenario 2: Browser history Back while upload in flight triggers Discard guard; Keep editing preserves upload ---
    await user.page.goBack();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toHaveCount(0);

    // Release upload: inserted Markdown remains visible and editable
    resumeUpload1();
    await expect(commentEditor).toHaveValue(
      /!\[held-root-image\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/,
    );

    // Submit the comment so we have root comment Root A
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();
    await expect.poll(() => releaseCommentAcceptance).not.toBeNull();
    releaseCommentAcceptance!();
    await expect(dialog.getByRole("tabpanel", { name: "Comments ·" }).locator("img[alt^='held-root-image']")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);

    // Create a second root comment Root B
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Comment", exact: true }).fill("Root Comment B");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(dialog.locator("p").filter({ hasText: "Root Comment B" })).toBeVisible();
    // --- Scenario 3: Empty reply upload disables text Save and protects Close ---
    let resumeUpload2!: () => void;
    let upload2Hold = new Promise<void>((resolve) => {
      resumeUpload2 = resolve;
    });
    await user.page.route("**/boards/*/attachments", async (route) => {
      await upload2Hold;
      await route.continue();
    });

    // Find reply button for Root A (first comment)
    const rootAReplyBtn = dialog.getByRole("button", { name: "Reply to comment" }).first();
    const rootBReplyBtn = dialog.getByRole("button", { name: "Reply to comment" }).last();
    await rootAReplyBtn.click();
    const replyEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await expect(replyEditor).toHaveValue("");

    const replyImageInput = dialog.locator(".markdown-editor").filter({ has: user.page.getByRole("textbox", { name: "Comment", exact: true }) }).getByTestId("comment-image-input");
    await replyImageInput.setInputFiles({ name: "held-reply-image.png", mimeType: "image/png", buffer: PNG_1X1 });

    // While replyUploading is true:
    // 1. Reply-to-comment buttons are disabled
    await expect(rootAReplyBtn).toBeDisabled();
    await expect(rootBReplyBtn).toBeDisabled();
    // 2. Cancel in reply composer is disabled
    const replyCancelBtn = dialog.getByRole("button", { name: "Cancel" });
    await expect(replyCancelBtn).toBeDisabled();

    // No text changes can be saved. Close still protects the active upload.
    await expect(dialog.getByRole("button", { name: "Save title & description" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog).toBeVisible();
    await expect(replyEditor).toBeVisible();

    // Browser history Back: guarded by discard strip; Keep editing preserves A and upload
    await user.page.goBack();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toHaveCount(0);

    // Release upload: reply editor gets inserted markdown under Root A
    resumeUpload2();
    await expect(replyEditor).toHaveValue(
      /!\[held-reply-image\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/,
    );
    await expect(rootBReplyBtn).toBeEnabled();

    // Target switching: clicking Reply on Root B while replyDraft has text prompts discard
    await rootBReplyBtn.click();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    // Keep editing keeps Root A reply draft intact
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(replyEditor).toHaveValue(
      /!\[held-reply-image\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/,
    );

    // Submit reply under Root A so we have a live child reply comment
    await replyEditor.fill("Child reply on Root A");
    await dialog.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(dialog.locator("p").filter({ hasText: "Child reply on Root A" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);

    // --- Scenario 3b: Child reply target deleted by peer while upload in flight (Root A survives) -> explicit orphan recovery ---
    let resumeUploadChildOrphan!: () => void;
    const uploadChildOrphanHold = new Promise<void>((resolve) => {
      resumeUploadChildOrphan = resolve;
    });
    await user.page.route("**/boards/*/attachments", async (route) => {
      await uploadChildOrphanHold;
      await route.continue();
    });

    // Start reply targeting the child reply
    const childReplyBtn = dialog.getByRole("button", { name: "Reply to comment" }).nth(1);
    await childReplyBtn.click();
    const replyEditorChild = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await replyImageInput.setInputFiles({ name: "child-orphan-image.png", mimeType: "image/png", buffer: PNG_1X1 });

    // Peer deletes the child reply while upload is in flight (Root A survives!)
    expect(simulatePeerDeleteChildReply).not.toBeNull();
    simulatePeerDeleteChildReply!();

    // While held: modal remains open, Back is guarded by Discard strip, latest typing is preserved
    await replyEditorChild.pressSequentially(" Typed in child reply");
    await expect(replyEditorChild).toHaveValue(" Typed in child reply");

    await user.page.goBack();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toHaveCount(0);

    // Release child reply upload: MUST NOT reanchor or insert into Root A!
    // Goes directly to explicit orphan recovery
    resumeUploadChildOrphan();
    await expect(
      dialog.getByText("Target comment was deleted by a peer. Reply draft preserved (image placed at end):"),
    ).toBeVisible();
    await expect(
      dialog.getByRole("alert").locator("div").filter({ hasText: /Typed in child reply\n\n!\[child-orphan-image\.\w+\]/ }),
    ).toBeVisible();

    // Verify Root A does NOT contain the inserted markdown or draft
    await expect(dialog.locator("p").filter({ hasText: "Typed in child reply" })).toHaveCount(0);
    // No active reply composer is open
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);

    // Explicitly discard the child orphan recovery so following scenarios have a clean slate
    await dialog.getByRole("button", { name: "Discard" }).click();
    await expect(
      dialog.getByText("Target comment was deleted by a peer. Reply draft preserved (image placed at end):"),
    ).toHaveCount(0);
    // --- Scenario 4: Peer deletes target comment while upload in flight -> orphan recovery rendered ---
    let resumeUploadOrphan!: () => void;
    const uploadOrphanHold = new Promise<void>((resolve) => {
      resumeUploadOrphan = resolve;
    });
    await user.page.route("**/boards/*/attachments", async (route) => {
      await uploadOrphanHold;
      await route.continue();
    });

    await rootBReplyBtn.click();
    const replyEditorB = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await replyImageInput.setInputFiles({ name: "orphan-image.png", mimeType: "image/png", buffer: PNG_1X1 });

    // Pre-orphan interval: peer deletes Root Comment B while upload is in flight
    expect(simulatePeerDeleteRootB).not.toBeNull();
    simulatePeerDeleteRootB!();

    // No text changes can be saved. Close still protects the active upload.
    await expect(dialog.getByRole("button", { name: "Save title & description" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog).toBeVisible();

    // Type/edit latest reply text while held
    await replyEditorB.pressSequentially(" Typed while held");
    await expect(replyEditorB).toHaveValue(" Typed while held");

    // Release upload: orphan recovery appears in comments zone with exact latest text + image Markdown
    resumeUploadOrphan();
    await expect(
      dialog.getByText("Target comment was deleted by a peer. Reply draft preserved (image placed at end):"),
    ).toBeVisible();
    await expect(
      dialog.getByRole("alert").locator("div").filter({ hasText: /Typed while held\n\n!\[orphan-image\.\w+\]/ }),
    ).toBeVisible();

    // Orphan recovery counts as dirty: blocks modal Close
    await dialog.getByRole("button", { name: "Close card" }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();

    // Existing orphan blocks every new reply/startReply action:
    // Reply buttons are disabled while orphanedReply exists, and clicking does not open a reply composer
    await expect(rootAReplyBtn).toBeDisabled();
    await rootAReplyBtn.click({ force: true });
    // Composer was not opened: no reply textarea is present
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
    // Move to comment while root comment lane is pending is disabled:
    // Hold root comment acceptance so root lane enters real pending state
    holdPendingCommentEcho = true;
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const rootComposer = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await rootComposer.fill("Root comment in progress");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // Assert root lane is pending: editor is readonly with exact submitted payload
    await expect(rootComposer).toHaveAttribute("readonly", "");
    await expect(rootComposer).toHaveValue("Root comment in progress");

    // Move to comment button is disabled while root composer is pending
    const moveToCommentBtn = dialog.getByRole("button", { name: "Move to comment" });
    await expect(moveToCommentBtn).toBeDisabled();

    // Settle root submission: release pending comment echo
    await expect.poll(() => releasePendingCommentEcho).not.toBeNull();
    releasePendingCommentEcho!();
    await expect(dialog.locator("p").filter({ hasText: "Root comment in progress" })).toBeVisible();
    await expect(rootComposer).toHaveCount(0);

    // Root lane is now settled and clear: Move to comment becomes enabled
    await expect(moveToCommentBtn).toBeEnabled();

    // Explicit disposition: click Move to comment moves draft into root comment composer without mutating prior submitted payload
    await moveToCommentBtn.click();
    await expect(
      dialog.getByText("Target comment was deleted by a peer. Reply draft preserved (image placed at end):"),
    ).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(
      /Typed while held\n\n!\[orphan-image\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/,
    );

    // Cancel root composer
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // --- Scenario 5: Verified-absence recovery -> unlocked user-reachable upload -> late authoritative acceptance ---
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditorAbsence = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditorAbsence.fill("Comment for verified absence");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // Reconnect snapshot arrives without comment -> verified-retry recovery strip appears, editor is UNLOCKED
    await expect(dialog.getByText("Sync could not verify comment. You can retry sending.")).toBeVisible({ timeout: 10_000 });
    await expect(commentEditorAbsence).not.toHaveAttribute("readonly", "");
    // Toolbar Image button in the active comment composer is user-reachable (enabled)
    const toolbarImageBtn = dialog.getByRole("tabpanel", { name: "Comments ·" }).getByRole("button", { name: "Image", exact: true });
    await expect(toolbarImageBtn).toBeEnabled();

    // Start upload via user-reachable Image button / input
    let resumeUploadAbsence!: () => void;
    let uploadAbsenceHold = new Promise<void>((resolve) => {
      resumeUploadAbsence = resolve;
    });
    await user.page.route("**/boards/*/attachments", async (route) => {
      await uploadAbsenceHold;
      await route.continue();
    });

    const imageInputAbsence = dialog.locator(".card-comment-composer-row").getByTestId("comment-image-input");
    await imageInputAbsence.setInputFiles({ name: "held-absence-image.png", mimeType: "image/png", buffer: PNG_1X1 });

    // While upload is in flight, late authoritative acceptance of Comment X arrives through current WebSocket route!
    await expect.poll(() => lateEchoCommentX).not.toBeNull();
    lateEchoCommentX!();

    // Authoritative assertions:
    // 1. Recovery strip disappears automatically
    await expect(dialog.getByText("Sync could not verify comment. You can retry sending.")).toHaveCount(0);
    // 2. Exactly one authoritative comment entity exists in the list
    await expect(dialog.locator("p").filter({ hasText: "Comment for verified absence" })).toHaveCount(1);
    // 3. Composer remains open because upload is in flight
    await expect(commentEditorAbsence).toBeVisible();

    // Release upload: markdown inserts into comment editor
    resumeUploadAbsence();
    await expect(commentEditorAbsence).toHaveValue(
      /Comment for verified absence\n*!\[held-absence-image\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/,
    );

    // Cancel composer and close cleanly without conditional cleanup
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.getByRole("button", { name: "Close card" }).click();
    await expect(dialog).toHaveCount(0);
    await user.page.context().close();
  });
  test("Terminal reconnect failure trips circuit breaker and exposes operable Retry to reconnect while draft remains", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const OriginalWebSocket = window.WebSocket;
      (window as any).__foxbanSockets = [];
      window.WebSocket = class extends OriginalWebSocket {
        constructor(...args: [string | URL, (string | string[])?]) {
          super(...args);
          const url = String(args[0] ?? "");
          if (/\/boards\/.*\/ws/.test(url)) {
            (window as any).__foxbanSockets?.push(this);
          }
        }
      };
    });
    const page = await context.newPage();
    const email = uniqueEmail("rem-ux3-terminal");
    await signup(page, email, "rem-ux3");
    const boardName = `UX3-${Date.now()}`;
    const boardKey = await createBoard(page, boardName);
    const boardUuid = await getBoardUuid(page, boardName);

    let failSockets = false;
    await page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      if (failSockets) {
        // Send invalid snapshot to trip circuit breaker after 3 failures
        ws.send(JSON.stringify({ type: "snapshot", invalidField: true }));
        return;
      }
      const server = ws.connectToServer();
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    await page.goto(`/board/${boardKey}`);
    await addColumn(page, "Todo");
    await addCard(page, "Todo", "Retry Card");

    const card = cardIn(columnByTitle(page, "Todo"), "Retry Card");
    await card.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Type a comment draft
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditor.fill("Draft awaiting terminal retry");

    // Close socket and set failure flag
    failSockets = true;
    await page.evaluate(() => {
      const sockets = (window as any).__foxbanSockets ?? [];
      for (const socket of sockets) {
        socket.close();
      }
    });

    // Wait for circuit breaker to stop at 3 attempts and expose Could not connect + Retry
    const couldNotConnect = dialog.getByText("Could not connect.");
    await expect(couldNotConnect).toBeVisible({ timeout: 15_000 });
    const retryBtn = dialog.getByRole("button", { name: "Retry", exact: true });
    await expect(retryBtn).toBeVisible();
    await expect(commentEditor).toHaveValue("Draft awaiting terminal retry");

    // Repair connection and click Retry
    failSockets = false;
    await retryBtn.click();

    // Reconnected: Could not connect disappears and draft remains completely intact
    await expect(couldNotConnect).toHaveCount(0, { timeout: 10_000 });
    await expect(dialog).toBeVisible();
    await expect(commentEditor).toHaveValue("Draft awaiting terminal retry");

    await page.context().close();
  });

  test("Dirty navigation blocker guards POP and programmatic exits, while Keep editing / typing resets blocker", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-ux4");
    const boardName = `UX4-${Date.now()}`;
    await createBoard(user.page, boardName);
    await user.page.getByRole("link", { name: boardName }).click();
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Nav Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Nav Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Make dirty
    await dialog.getByRole("button", { name: "Edit title", exact: true }).click();
    await dialog.getByLabel("Card title").fill("Dirty Title");

    // Try browser back (POP)
    await user.page.goBack();
    // Discard prompt should appear
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();

    // Keep editing dismisses prompt and stays on card
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toHaveCount(0);
    await expect(dialog.getByLabel("Card title")).toHaveValue("Dirty Title");

    // Typing in title input also resets blocker
    await user.page.goBack();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByLabel("Card title").pressSequentially(" more");
    await expect(dialog.getByText("Discard unsaved changes?")).toHaveCount(0);
    // Discard closes card
    await dialog.getByRole("button", { name: "Close card" }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Discard" }).click();
    await expect(dialog).toHaveCount(0);

    await user.page.context().close();
  });

  test("Focus cycling wraps within active dialog and returns focus upon attachment close", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-ux5-f6");
    const peer = await newUser(browser, "rem-ux5-peer");
    const boardName = `UX5-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    await inviteMember(user.page, boardName, peer.email);
    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Focus Card");
    const card = cardIn(columnByTitle(user.page, "Todo"), "Focus Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Forward Tab wrap test uses the enabled footer action on a clean card.
    const saveBtn = dialog.getByRole("button", { name: "Close", exact: true });
    await saveBtn.focus();
    await expect(saveBtn).toBeFocused();
    await user.page.keyboard.press("Tab");

    const focusedInside = await user.page.evaluate(() => {
      const active = document.activeElement;
      const dlg = document.querySelector('[role="dialog"]');
      return Boolean(dlg && active && dlg.contains(active));
    });
    expect(focusedInside).toBe(true);

    // Reverse Tab (Shift+Tab) wrap test
    await user.page.keyboard.press("Shift+Tab");
    const reverseFocused = await user.page.evaluate(() => {
      const active = document.activeElement;
      const dlg = document.querySelector('[role="dialog"]');
      return Boolean(dlg && active && dlg.contains(active));
    });
    expect(reverseFocused).toBe(true);

    await openCardSection(dialog, "attachments");

    // Test attachment viewer open/close focus return to invoking trigger
    const PNG_1X1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    await dialog
      .getByTestId("attach-input")
      .setInputFiles({ name: "focus-photo.png", mimeType: "image/png", buffer: PNG_1X1 as any });
    const previewBtn = dialog.getByRole("button", { name: "Preview attachment focus-photo.png" });
    await expect(previewBtn).toBeVisible();

    await previewBtn.focus();
    await previewBtn.click();
    const viewer = user.page.getByRole("dialog", { name: "focus-photo.png" });
    await expect(viewer).toBeVisible();

    // Verify Tab cycling inside topmost attachment viewer between Open original and Close preview
    const openOriginalLink = viewer.getByRole("link", { name: "Open original" });
    const viewerCloseBtn = viewer.getByRole("button", { name: "Close preview" });
    await expect(viewerCloseBtn).toBeFocused();
    await user.page.keyboard.press("Tab");
    await expect(openOriginalLink).toBeFocused();
    await user.page.keyboard.press("Tab");
    await expect(viewerCloseBtn).toBeFocused();
    await user.page.keyboard.press("Shift+Tab");
    await expect(openOriginalLink).toBeFocused();
    await user.page.keyboard.press("Shift+Tab");
    await expect(viewerCloseBtn).toBeFocused();
    // Close attachment via Escape: focus returns to the invoking preview button
    await user.page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(previewBtn).toBeFocused();

    // BV-02 test: Rendered draft description embedded image trigger survives URL/render and regains focus on Escape
    await dialog.getByRole("button", { name: "Add a description…" }).click();
    const descInput = dialog.getByTestId("image-input");
    await descInput.setInputFiles({ name: "desc-photo.png", mimeType: "image/png", buffer: PNG_1X1 });
    await expect(dialog.getByLabel("Card description")).toHaveValue(
      /!\[desc-photo\.\w+\]\(\/boards\/[^)]+\/attachments\/[0-9a-f-]+\)/,
    );
    await dialog.getByRole("button", { name: "Preview description" }).click();

    const descPreviewBtn = dialog
      .getByTestId("description-view")
      .getByRole("button", { name: /Preview attachment desc-photo\./ });
    await expect(descPreviewBtn).toBeVisible();

    // Click embedded image button in description
    await descPreviewBtn.click();
    const descViewer = user.page.getByRole("dialog", { name: /desc-photo\./ });
    await expect(descViewer).toBeVisible();

    // Close via Escape: focus returns to the matching description preview button
    await user.page.keyboard.press("Escape");
    await expect(descViewer).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(descPreviewBtn).toBeFocused();

    // BV-02 test: Comment embedded image trigger survives URL/render and regains focus on Close button
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await expect(commentEditor).toBeVisible();
    const commentImageInput = dialog.locator('input[type="file"][accept*="image"]').last();
    await commentImageInput.setInputFiles({ name: "comment-embed.png", mimeType: "image/png", buffer: PNG_1X1 });
    await expect(commentEditor).toContainText("comment-embed.png");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // Wait for the posted comment row to render its own embedded image trigger.
    // Scoped to the comment row: the same upload also lists an attachment row in
    // the sidebar carrying an identically named preview button.
    const commentItem = dialog
      .locator("[data-comment-id]")
      .filter({ has: user.page.getByRole("button", { name: /Preview attachment comment-embed\./ }) });
    await expect(commentItem).toBeVisible();
    const commentPreviewBtn = commentItem.getByRole("button", { name: /Preview attachment comment-embed\./ });
    await expect(commentPreviewBtn).toBeVisible();

    // Click embedded comment image button
    await commentPreviewBtn.click();
    const commentViewer = user.page.getByRole("dialog", { name: /comment-embed\./ });
    await expect(commentViewer).toBeVisible();

    // Close via Close preview button: focus returns to the matching comment preview button
    const commentViewerCloseBtn = commentViewer.getByRole("button", { name: "Close preview" });
    await commentViewerCloseBtn.click();
    await expect(commentViewer).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(commentPreviewBtn).toBeFocused();

    // BV-02 test: Removed invoking-trigger fallback while viewer is open.
    // The invited peer opens the same card in its own context.
    await peer.page.goto(`/board/${boardKey}`);
    await cardIn(columnByTitle(peer.page, "Todo"), "Focus Card").click();
    const peerDialog = peer.page.getByRole("dialog");
    await expect(peerDialog).toBeVisible();
    const peerCommentRow = peerDialog
      .locator("[data-comment-id]")
      .filter({ has: peer.page.getByRole("button", { name: /Preview attachment comment-embed\./ }) });
    await expect(peerCommentRow).toBeVisible();

    // Re-open the comment image viewer, then let the peer delete its invoking comment.
    const commentPreviewHandle = await commentPreviewBtn.elementHandle();
    await commentPreviewBtn.click();
    await expect(commentViewer).toBeVisible();

    await peerCommentRow.getByRole("button", { name: "Delete comment" }).click();
    await expect(peerCommentRow).toHaveCount(0);
    await expect(commentPreviewBtn).toHaveCount(0);
    expect(await user.page.evaluate((btn) => btn?.isConnected, commentPreviewHandle)).toBe(false);
    await peer.page.context().close();

    // Close viewer via Escape: invoking control is gone, fallback settles on operable card control
    await user.page.keyboard.press("Escape");
    await expect(commentViewer).toHaveCount(0);
    await expect(dialog).toBeVisible();
    // Assert fallback focused element is visible, enabled, non-inert, and an operable card control
    const removedFallbackOperable = await user.page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const dlg = document.querySelector('[role="dialog"]');
      if (!active || !dlg || !dlg.contains(active)) return null;
      if (active.closest("[inert]")) return null;
      const isBtnOrInput =
        active instanceof HTMLButtonElement ||
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active.getAttribute("role") === "button" ||
        active.hasAttribute("tabindex");
      return {
        ariaLabel: active.getAttribute("aria-label"),
        tagName: active.tagName.toLowerCase(),
        disabled: active.hasAttribute("disabled") || (active instanceof HTMLButtonElement && active.disabled),
        operable: isBtnOrInput && !active.hasAttribute("disabled") && !active.closest("[inert]"),
      };
    });
    expect(removedFallbackOperable).not.toBeNull();
    expect(removedFallbackOperable?.operable).toBe(true);
    expect(removedFallbackOperable?.disabled).toBe(false);

    // Focus must land on an operable control inside the card modal; verify safe activation
    const editTitleBtn = dialog.getByRole("button", { name: "Edit title", exact: true });
    await expect(editTitleBtn).toBeFocused();
    await user.page.keyboard.press("Enter");
    const cardTitleInput = dialog.getByLabel("Card title");
    await expect(cardTitleInput).toBeVisible();
    await expect(cardTitleInput).toBeFocused();
    // Cancel title edit safely
    await user.page.keyboard.press("Escape");
    await expect(dialog.getByRole("heading", { name: "Focus Card" })).toBeVisible();

    // BV-02 test: Deep-link/no-trigger fallback focuses safe operable card element
    const focusPhotoImg = previewBtn.locator("img");
    const focusPhotoSrc = await focusPhotoImg.getAttribute("src");
    const attachmentIdMatch = focusPhotoSrc ? focusPhotoSrc.split("/").pop() : undefined;
    expect(attachmentIdMatch).toBeTruthy();

    const deepLinkUrl = new URL(user.page.url());
    deepLinkUrl.searchParams.set("attachment", attachmentIdMatch!);
    await user.page.goto(deepLinkUrl.toString());
    const deepViewer = user.page.getByRole("dialog", { name: "focus-photo.png" });
    await expect(deepViewer).toBeVisible();

    // Escape from deep-linked viewer without an invoking trigger
    await user.page.keyboard.press("Escape");
    await expect(deepViewer).toHaveCount(0);
    await expect(dialog).toBeVisible();

    // Focus settles on an operable fallback inside dialog (visible, enabled, non-inert)
    const deepFallbackOperable = await user.page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const dlg = document.querySelector('[role="dialog"]');
      if (!active || !dlg || !dlg.contains(active)) return null;
      if (active.closest("[inert]")) return null;
      const isBtnOrInput =
        active instanceof HTMLButtonElement ||
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active.getAttribute("role") === "button" ||
        active.hasAttribute("tabindex");
      return {
        ariaLabel: active.getAttribute("aria-label"),
        tagName: active.tagName.toLowerCase(),
        disabled: active.hasAttribute("disabled") || (active instanceof HTMLButtonElement && active.disabled),
        operable: isBtnOrInput && !active.hasAttribute("disabled") && !active.closest("[inert]"),
      };
    });
    expect(deepFallbackOperable).not.toBeNull();
    expect(deepFallbackOperable?.operable).toBe(true);
    expect(deepFallbackOperable?.disabled).toBe(false);

    // Verify fallback focus on edit title button and activate it safely
    await expect(editTitleBtn).toBeFocused();
    await user.page.keyboard.press("Enter");
    await expect(cardTitleInput).toBeVisible();
    await expect(cardTitleInput).toBeFocused();
    await user.page.keyboard.press("Escape");
    await expect(dialog.getByRole("heading", { name: "Focus Card" })).toBeVisible();
    await user.page.context().close();
  });

  test("Semantic aria-pressed on filters, visible Today/Overdue cues, and visible task-type badge", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-ux6-ui4-ui6");
    const boardName = `Semantics-${Date.now()}`;
    await createBoard(user.page, boardName);
    await user.page.getByRole("link", { name: boardName }).click();
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Semantic Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Semantic Card");

    // UI-6: Card front has persistent visible task type badge
    const typeBadge = card.locator("[data-testid='task-type-badge']");
    await expect(typeBadge).toBeVisible();
    await expect(typeBadge).toHaveText("Task");

    // UI-4: Schedule overdue and verify visible 'Overdue ·' text cue
    await card.click();
    const dialog = user.page.getByRole("dialog");
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const yesterdayISO = localISODate(yesterday);
    await dialog.getByLabel("Due date").fill(yesterdayISO);
    await dialog.getByRole("button", { name: "Close card" }).click();

    const dueBadge = card.locator("[data-testid='due-badge']");
    await expect(dueBadge).toBeVisible();
    await expect(dueBadge).toHaveText(/Overdue ·/);

    // Schedule Today and verify visible 'Today ·' cue
    await card.click();
    await dialog.getByRole("textbox", { name: "Due date" }).fill(localISODate(today));
    await dialog.getByRole("button", { name: "Close card" }).click();
    await expect(dueBadge).toHaveText(/Today ·/);

    // UX-6: Filter choice exposes aria-pressed
    const filterBtn = user.page.getByRole("button", { name: "Filter cards", exact: true });
    await filterBtn.click();
    const noLabelBtn = user.page.getByRole("button", { name: "Filter by no label" });
    await expect(noLabelBtn).toHaveAttribute("aria-pressed", "false");
    await noLabelBtn.click();
    await expect(noLabelBtn).toHaveAttribute("aria-pressed", "true");

    await user.page.context().close();
  });

  test("Header wraps without clipping at 768px/820px, and coarse touch targets meet 44px", async ({
    browser,
  }) => {
    const user = await newCoarseUser(browser, "rem-ui1-ui2");
    const boardName = `Tablet-${Date.now()}`;
    await createBoard(user.page, boardName);
    await user.page.getByRole("link", { name: boardName }).click();

    // 768px layout check: identity & actions reachable without horizontal document scroll
    await user.page.setViewportSize({ width: 768, height: 1024 });
    const boardsLink = user.page.getByRole("link", { name: "Boards" }).first();
    await expect(boardsLink).toBeVisible();
    const filterBtn = user.page.getByRole("button", { name: "Filter cards", exact: true });
    await expect(filterBtn).toBeVisible();
    const archiveBtn = user.page.getByRole("button", { name: "Archived cards", exact: true });
    await expect(archiveBtn).toBeVisible();

    const titleH1 = user.page.getByRole("heading", { level: 1 });
    const titleBox768 = await titleH1.boundingBox();
    expect(titleBox768).not.toBeNull();
    // In tablet mode (768px/820px), dedicated flex-basis row gives title generous width (>200px), never 19px
    expect(titleBox768!.width).toBeGreaterThanOrEqual(150);

    const docScrollWidth768 = await user.page.evaluate(() => document.documentElement.scrollWidth);
    expect(docScrollWidth768).toBeLessThanOrEqual(768);

    // 820px layout check: all utilities reachable, title readable
    await user.page.setViewportSize({ width: 820, height: 1024 });
    await expect(boardsLink).toBeVisible();
    await expect(filterBtn).toBeVisible();
    await expect(archiveBtn).toBeVisible();

    const titleBox820 = await titleH1.boundingBox();
    expect(titleBox820).not.toBeNull();
    expect(titleBox820!.width).toBeGreaterThanOrEqual(150);

    const docScrollWidth820 = await user.page.evaluate(() => document.documentElement.scrollWidth);
    expect(docScrollWidth820).toBeLessThanOrEqual(820);

    // 1280px desktop check: compact single-row layout
    await user.page.setViewportSize({ width: 1280, height: 800 });
    const docScrollWidth1280 = await user.page.evaluate(() => document.documentElement.scrollWidth);
    expect(docScrollWidth1280).toBeLessThanOrEqual(1280);

    // 375px mobile check: identity and action strip preserved
    await user.page.setViewportSize({ width: 375, height: 667 });
    const docScrollWidth375 = await user.page.evaluate(() => document.documentElement.scrollWidth);
    expect(docScrollWidth375).toBeLessThanOrEqual(375);

    // Global navigation is a disclosure on phones; measure the revealed link.
    await user.page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const boardsBox = await boardsLink.boundingBox();
    expect(boardsBox).not.toBeNull();
    expect(boardsBox!.height).toBeGreaterThanOrEqual(44);
    await user.page.getByRole("button", { name: "Close navigation", exact: true }).click();

    const searchInput = user.page.getByLabel("Search cards");
    const searchBox = await searchInput.boundingBox();
    expect(searchBox).not.toBeNull();
    expect(searchBox!.height).toBeGreaterThanOrEqual(44);

    // Coarse pointer touch targets in CardModal: Add label and comment composer buttons
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Coarse Target Card");
    const card = cardIn(columnByTitle(user.page, "Todo"), "Coarse Target Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const addLabelBtn = dialog.getByRole("button", { name: "+ Add label…" });
    await expect(addLabelBtn).toBeVisible();
    const addLabelBox = await addLabelBtn.boundingBox();
    expect(addLabelBox).not.toBeNull();
    expect(addLabelBox!.height).toBeGreaterThanOrEqual(44);
    // Coarse pointer touch target for Card actions icon button: exactly 44x44
    const cardActionsBtn = dialog.getByRole("button", { name: "Card actions" });
    await expect(cardActionsBtn).toBeVisible();
    const cardActionsBox = await cardActionsBtn.boundingBox();
    expect(cardActionsBox).not.toBeNull();
    expect(cardActionsBox!.height).toBeGreaterThanOrEqual(44);
    expect(cardActionsBox!.width).toBeGreaterThanOrEqual(44);

    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const postCommentBtn = dialog.getByRole("button", { name: "Comment", exact: true });
    const cancelCommentBtn = dialog.getByRole("button", { name: "Cancel", exact: true });
    const postBox = await postCommentBtn.boundingBox();
    const cancelBox = await cancelCommentBtn.boundingBox();
    expect(postBox!.height).toBeGreaterThanOrEqual(44);
    expect(cancelBox!.height).toBeGreaterThanOrEqual(44);
    await user.page.context().close();
  });

  test("Wide Markdown table at 375px renders with local scroll containment without breaking pane layout", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 667 },
    });
    const page = await context.newPage();
    const email = uniqueEmail("rem-f9-table");
    await signup(page, email, "rem-f9");

    const boardName = `WideTable-${Date.now()}`;
    await createBoard(page, boardName);
    await page.getByRole("link", { name: boardName }).click();
    await addColumn(page, "Todo");
    await addCard(page, "Todo", "Table Card");

    const card = cardIn(columnByTitle(page, "Todo"), "Table Card");
    await card.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Add a comment with a wide multi-column table
    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    const wideTable = `| Column 1 Long Header | Column 2 Long Header | Column 3 Long Header | Column 4 Long Header | Column 5 Long Header |\n|---|---|---|---|---|\n| Very long cell value 1 | Very long cell value 2 | Very long cell value 3 | Very long cell value 4 | Very long cell value 5 |`;
    await commentEditor.fill(wideTable);
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // The table is rendered in a block with max-w-full and overflow-x-auto
    const table = dialog.locator("table");
    await expect(table).toBeVisible();

    // Verify observable scroll containment: table scrollWidth exceeds its clientWidth and scrolls horizontally
    const scrollInfo = await table.evaluate((el) => {
      const scrollable = el.scrollWidth > el.clientWidth;
      el.scrollLeft = 50;
      const scrolled = el.scrollLeft > 0;
      return { scrollable, scrolled };
    });
    expect(scrollInfo.scrollable).toBe(true);
    expect(scrollInfo.scrolled).toBe(true);

    // Modal dialog itself does not horizontally overflow viewport
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.width).toBeLessThanOrEqual(375);

    await page.context().close();
  });
  test("Live-open authored mutation timeout initiates authoritative resync; missing request resolves to verified retry", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-f2-missing-req");
    const boardName = `TimeoutReq-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);

    let dropCommentCreate = true;
    let requestDroppedCount = 0;
    let snapshotCount = 0;
    let serverWs: { send: (msg: string | Buffer) => void } | null = null;
    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      serverWs = ws.connectToServer();
      ws.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (dropCommentCreate && frame.type === "comment.create") {
          requestDroppedCount++;
          // Drop outbound request completely while keeping live transport open
          return;
        }
        serverWs?.send(msg);
      });
      serverWs.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "snapshot") {
          snapshotCount++;
        }
        ws.send(msg);
      });
    });

    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Timeout Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Timeout Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditor.fill("Authored Timeout Draft A");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // Editor is locked while in flight
    await expect(commentEditor).toHaveAttribute("readonly", "");

    // Positively assert that the outbound comment request was actually intercepted and dropped
    await expect.poll(() => requestDroppedCount).toBe(1);

    const preReconnectSnapshots = snapshotCount;

    // After 5s mutation timeout, client initiates resync. Reconnect snapshot does not contain comment.
    // Verified-retry recovery strip unlocks exact draft with Retry and Discard.
    await expect(dialog.getByText("Sync could not verify comment. You can retry sending.")).toBeVisible({ timeout: 15_000 });
    await expect(commentEditor).not.toHaveAttribute("readonly", "");
    await expect(commentEditor).toHaveValue("Authored Timeout Draft A");

    // Positively assert that an authoritative reconnect snapshot arrived to verify absence
    expect(snapshotCount).toBeGreaterThan(preReconnectSnapshots);

    // Disable drop for the retry attempt
    dropCommentCreate = false;

    // Click Retry: now request goes through to server and succeeds without duplicate
    const retryBtn = dialog.getByRole("button", { name: "Retry unsent comment" });
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    await expect(dialog.locator("p").filter({ hasText: "Authored Timeout Draft A" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);

    await user.page.context().close();
  });

  test("Live-open authored mutation timeout initiates authoritative resync; missing echo with server acceptance settles accepted without duplicate", async ({
    browser,
  }) => {
    const user = await newUser(browser, "rem-f2-missing-echo");
    const boardName = `TimeoutEcho-${Date.now()}`;
    const boardKey = await createBoard(user.page, boardName);
    const boardUuid = await getBoardUuid(user.page, boardName);

    let dropEcho = true;
    let echoDroppedCount = 0;
    let snapshotCount = 0;
    let heldMutationId: string | null = null;
    await user.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "comment.create") {
          heldMutationId = frame.mutationId;
        }
        server.send(msg);
      });
      server.onMessage((msg) => {
        const frame = JSON.parse(msg.toString());
        if (frame.type === "snapshot") {
          snapshotCount++;
        }
        if (dropEcho && frame.type === "comment.create" && frame.mutationId === heldMutationId) {
          echoDroppedCount++;
          // Server accepted, but outbound echo to client is lost while transport initially stays open
          return;
        }
        ws.send(msg);
      });
    });

    await user.page.goto(`/board/${boardKey}`);
    await addColumn(user.page, "Todo");
    await addCard(user.page, "Todo", "Echo Card");

    const card = cardIn(columnByTitle(user.page, "Todo"), "Echo Card");
    await card.click();
    const dialog = user.page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
    const commentEditor = dialog.getByRole("textbox", { name: "Comment", exact: true });
    await commentEditor.fill("Echo Timeout Draft A");
    await dialog.getByRole("button", { name: "Comment", exact: true }).click();

    // Editor is locked while in flight
    await expect(commentEditor).toHaveAttribute("readonly", "");

    // Positively assert that server accepted and outbound echo was actually intercepted and dropped
    await expect.poll(() => echoDroppedCount).toBe(1);

    const preReconnectSnapshots = snapshotCount;

    // After 5s mutation timeout, client initiates resync. Reconnect snapshot CONTAINS the comment because server accepted it.
    // Client snapshot processing settles mutation as accepted: comment appears, no recovery strip, composer closes, no duplicates.
    await expect(dialog.locator("p").filter({ hasText: "Echo Timeout Draft A" })).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText("Sync could not verify comment. You can retry sending.")).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
    // Positively verify exactly one comment exists (no duplication)
    await expect(dialog.locator("p").filter({ hasText: "Echo Timeout Draft A" })).toHaveCount(1);

    // Positively assert that an authoritative reconnect snapshot arrived to settle the mutation
    expect(snapshotCount).toBeGreaterThan(preReconnectSnapshots);

    await user.page.context().close();
  });
});
