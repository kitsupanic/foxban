import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  columns,
  createBoard,
  expectBoardAccessDenied,
  generateAccountInvite,
  getBoardUuid,
  inviteMember,
  signup,
  uniqueEmail,
} from "./helpers";

/**
 * Test-only WebSocket instrumentation. It changes *when* a matching outbound
 * mutation frame reaches the server and counts inbound frames. It never
 * inspects, applies, reorders or reconciles board state: all of that stays in
 * the production `useBoardSocket`/`BoardReconciler` path under test.
 */
interface FrameHold {
  /** Parks later outbound frames of `type` instead of sending them. */
  hold: (type: string) => void;
  heldCount: () => number;
  /** Stops parking and flushes parked frames in send order; returns how many. */
  release: () => number;
  /** Inbound frames of `type`, narrowed to those containing `needle` when given. */
  inboundCount: (type: string, needle?: string) => number;
}

declare global {
  interface Window {
    __frameHold: FrameHold;
  }
}
/** A signed-up user in its own browser context (own cookie jar). */
async function newUser(browser: Browser, suffix: string): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail(suffix);
  await signup(page, email, suffix);
  return { page, email };
}

/** As `newUser`, but with the outbound-frame hold installed on every page. */
async function newInstrumentedUser(
  browser: Browser,
  suffix: string,
): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const parked: { socket: WebSocket; data: string }[] = [];
    const inbound: string[] = [];
    let heldType: string | null = null;

    const frameType = (raw: string): string | undefined => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return undefined;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "type" in parsed &&
        typeof parsed.type === "string"
      ) {
        return parsed.type;
      }
      return undefined;
    };

    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data) {
      if (heldType !== null && typeof data === "string" && frameType(data) === heldType) {
        parked.push({ socket: this, data });
        return;
      }
      nativeSend.call(this, data);
    };

    // The board socket assigns `onmessage` directly, so inbound frames are
    // observed by wrapping the accessor rather than by adding a listener.
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
    if (descriptor?.get && descriptor.set) {
      const { get, set } = descriptor;
      Object.defineProperty(WebSocket.prototype, "onmessage", {
        configurable: true,
        get(this: WebSocket) {
          return get.call(this);
        },
        set(this: WebSocket, handler: ((event: MessageEvent) => void) | null) {
          set.call(
            this,
            handler === null
              ? null
              : (event: MessageEvent) => {
                  if (typeof event.data === "string") inbound.push(event.data);
                  handler.call(this, event);
                },
          );
        },
      });
    }

    window.__frameHold = {
      hold: (type) => {
        heldType = type;
      },
      heldCount: () => parked.length,
      release: () => {
        heldType = null;
        const frames = parked.splice(0, parked.length);
        for (const frame of frames) nativeSend.call(frame.socket, frame.data);
        return frames.length;
      },
      inboundCount: (type, needle) =>
        inbound.filter(
          (raw) => frameType(raw) === type && (needle === undefined || raw.includes(needle)),
        ).length,
    };
  });
  const page = await context.newPage();
  const email = uniqueEmail(suffix);
  await signup(page, email, suffix);
  return { page, email };
}

test("a member sees another user's column and card appear live", async ({ browser }) => {
  const alice = await newUser(browser, "sync-a");
  const bob = await newUser(browser, "sync-b");

  const boardName = `Shared ${Date.now()}`;
  const boardId = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);

  await bob.page.goto(`/board/${boardId}`);
  await expect(bob.page.getByRole("heading", { name: boardName, exact: true })).toBeVisible();

  await alice.page.getByRole("link", { name: boardName }).click();
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();

  await addColumn(alice.page, "Doing");
  // No reload: Bob's socket receives the broadcast and patches his cache.
  await expect(bob.page.getByRole("button", { name: "Rename column Doing", exact: true })).toBeVisible();

  await addCard(alice.page, "Doing", "live sync card");
  await expect(cardIn(columnByTitle(bob.page, "Doing"), "live sync card")).toBeVisible();

  await alice.page.context().close();
  await bob.page.context().close();
});

test("a non-member gets the not-a-member state and stops reconnecting", async ({ browser }) => {
  const owner = await newUser(browser, "sync-owner");
  const { token: strangerInvite } = await generateAccountInvite(owner.page);

  const strangerContext = await browser.newContext();
  const strangerPage = await strangerContext.newPage();
  const strangerEmail = uniqueEmail("sync-stranger", "user.test");
  await signup(strangerPage, strangerEmail, "sync-stranger", strangerInvite);
  const stranger = { page: strangerPage, email: strangerEmail };

  const boardName = `Private ${Date.now()}`;
  const boardId = await createBoard(owner.page, boardName);

  await stranger.page.goto(`/board/${boardId}`);

  await expectBoardAccessDenied(stranger.page, boardName);
  // The denial is terminal: after the retry budget would have elapsed, the UI is
  // still the denial and never flips back to a board or a reconnect banner.
  await stranger.page.waitForTimeout(3_000);
  await expectBoardAccessDenied(stranger.page, boardName);
  await expect(stranger.page.getByRole("button", { name: "Add column", exact: true })).toHaveCount(0);
  await expect(stranger.page.getByText("reconnecting…")).toHaveCount(0);

  await owner.page.context().close();
  await stranger.page.context().close();
});

test("circuit breaker stops reconnecting after 3 attempts without a valid snapshot, manual Retry restarts budget", async ({
  browser,
}) => {
  const owner = await newUser(browser, "sync-storm-breaker");
  const boardName = `Storm Breaker ${Date.now()}`;
  const boardKey = await createBoard(owner.page, boardName);
  const boardUuid = await getBoardUuid(owner.page, boardName);
  let connectionAttempts = 0;
  await owner.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
    connectionAttempts += 1;
    // Send a tagged but schema-invalid frame so the socket opens, ServerMessageSchema rejects it,
    // and client drops the socket before receiving a valid snapshot.
    ws.send(JSON.stringify({ type: "snapshot", invalidField: true }));
  });
  await owner.page.goto(`/board/${boardKey}`);

  // Assert Could not connect is visible and circuit breaker trips
  const couldNotConnect = owner.page.getByText("Could not connect.");
  await expect(couldNotConnect).toBeVisible({ timeout: 15_000 });
  expect(connectionAttempts).toBe(3);
  const finalAttemptsBeforeRetry = connectionAttempts;

  // Wait beyond the reconnect window to ensure attempts have stopped
  await owner.page.waitForTimeout(3_000);
  expect(connectionAttempts).toBe(3);

  // Click Retry: restarts attempt budget
  const retryButton = owner.page.getByRole("button", { name: "Retry" });
  await expect(retryButton).toBeVisible();
  await retryButton.click();

  await expect.poll(() => connectionAttempts, { timeout: 15_000 }).toBe(6);
  await expect(couldNotConnect).toBeVisible();

  // Verify no further attempts occur past the new budget
  await owner.page.waitForTimeout(3_000);
  expect(connectionAttempts).toBe(6);
  await owner.page.context().close();
});

test("preserves healthy reconnect when connection drops after a valid snapshot", async ({
  browser,
}) => {
  const owner = await newUser(browser, "sync-healthy-reconnect");
  const boardName = `Healthy Reconnect ${Date.now()}`;
  const boardId = await createBoard(owner.page, boardName);

  let connectionAttempts = 0;
  let dropFirstConnection: (() => void) | null = null;

  await owner.page.routeWebSocket(/\/boards\/[^/]+\/ws/, (ws) => {
    connectionAttempts += 1;
    const server = ws.connectToServer();
    server.onMessage((msg) => ws.send(msg));
    ws.onMessage((msg) => server.send(msg));

    if (connectionAttempts === 1) {
      dropFirstConnection = () => {
        ws.close();
      };
    }
  });

  await owner.page.goto(`/board/${boardId}`);
  await expect(owner.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await expect(owner.page.getByText("live")).toBeVisible();

  // Drop the first connection after it is live and synchronized
  expect(dropFirstConnection).not.toBeNull();
  dropFirstConnection!();

  // Client reconnects with exponential backoff and synchronizes again
  await expect.poll(() => connectionAttempts, { timeout: 10_000 }).toBe(2);
  await expect(owner.page.getByText("live")).toBeVisible();
  await expect(owner.page.getByText("Could not connect.")).toHaveCount(0);

  await owner.page.context().close();
});

test("circuit breaker stops reconnect loop when valid snapshot is followed by immediate disconnect", async ({
  browser,
}) => {
  const owner = await newUser(browser, "sync-valid-snapshot-drop");
  const boardName = `Valid Drop ${Date.now()}`;
  const boardKey = await createBoard(owner.page, boardName);
  const boardUuid = await getBoardUuid(owner.page, boardName);

  let connectionAttempts = 0;
  await owner.page.routeWebSocket(new RegExp(`/boards/${boardUuid}/ws`), (ws) => {
    connectionAttempts += 1;
    // Send a valid minimal snapshot
    const validSnapshot = {
      type: "snapshot",
      columns: [],
      cards: [],
      archivedCards: [],
      checklistItems: [],
      attachments: [],
      comments: [],
      relations: [],
      labels: [],
      cardLabels: [],
    };
    ws.send(JSON.stringify(validSnapshot));
    // Immediately close the socket before 10s stability is reached
    ws.close();
  });

  await owner.page.goto(`/board/${boardKey}`);

  // Assert Could not connect is visible after circuit breaker stops
  const couldNotConnect = owner.page.getByText("Could not connect.");
  await expect(couldNotConnect).toBeVisible({ timeout: 15_000 });

  // Assert exactly three total attempts occurred
  expect(connectionAttempts).toBe(3);

  // Wait beyond the reconnect window to verify no fourth attempt occurs
  await owner.page.waitForTimeout(3_000);
  expect(connectionAttempts).toBe(3);

  await owner.page.context().close();
});

test("a peer mutation accepted between an optimistic mutation and its own frame converges every client on the server-ordered last write", async ({
  browser,
}) => {
  // Alice's outbound rename is parked *after* her UI applied it optimistically,
  // so Bob's conflicting rename is the first one the real BoardDO accepts and
  // broadcasts; Alice's frame is then released and lands second.
  const alice = await newInstrumentedUser(browser, "sync-lww-a");
  const bob = await newUser(browser, "sync-lww-b");

  const boardName = `Convergence ${Date.now()}`;
  const boardKey = await createBoard(alice.page, boardName);
  await inviteMember(alice.page, boardName, bob.email);

  await alice.page.goto(`/board/${boardKey}`);
  await expect(alice.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(alice.page, "Race");

  await bob.page.goto(`/board/${boardKey}`);
  await expect(bob.page.getByRole("button", { name: "Rename column Race", exact: true })).toBeVisible();
  await expect(alice.page.getByText("live")).toBeVisible();
  await expect(bob.page.getByText("live")).toBeVisible();

  const aliceColumn = columns(alice.page).first();
  const bobColumn = columns(bob.page).first();
  const snapshotsBefore = await alice.page.evaluate(() =>
    window.__frameHold.inboundCount("snapshot"),
  );
  expect(snapshotsBefore).toBe(1);

  // Alice mutates first locally: the UI applies it, the frame never leaves.
  await alice.page.evaluate(() => {
    window.__frameHold.hold("column.rename");
  });
  await aliceColumn.getByRole("button", { name: "Rename column Race", exact: true }).click();
  const aliceTitleInput = aliceColumn.locator("header input");
  await aliceTitleInput.fill("Alice Wins");
  await aliceTitleInput.press("Enter");
  await expect(
    aliceColumn.getByRole("button", { name: "Rename column Alice Wins", exact: true }),
  ).toBeVisible();
  expect(await alice.page.evaluate(() => window.__frameHold.heldCount())).toBe(1);

  // Bob's conflicting rename reaches the DO and is accepted while Alice's is pending.
  await bobColumn.getByRole("button", { name: "Rename column Race", exact: true }).click();
  const bobTitleInput = bobColumn.locator("header input");
  await bobTitleInput.fill("Bob Wins");
  await bobTitleInput.press("Enter");
  await expect(
    bobColumn.getByRole("button", { name: "Rename column Bob Wins", exact: true }),
  ).toBeVisible();

  // Alice's socket has received Bob's accepted rename: the DO ordered Bob first.
  await expect
    .poll(
      () =>
        alice.page.evaluate(() => window.__frameHold.inboundCount("column.rename", "Bob Wins")),
      { timeout: 4_000 },
    )
    .toBe(1);
  // Her own optimistic value survives the peer update while it is still pending.
  await expect(
    aliceColumn.getByRole("button", { name: "Rename column Alice Wins", exact: true }),
  ).toBeVisible();

  expect(await alice.page.evaluate(() => window.__frameHold.release())).toBe(1);

  // Bob converges onto Alice's later, server-ordered value.
  await expect(
    bobColumn.getByRole("button", { name: "Rename column Alice Wins", exact: true }),
  ).toBeVisible();
  await expect(
    bobColumn.getByRole("button", { name: "Rename column Bob Wins", exact: true }),
  ).toHaveCount(0);

  // Past the 5s pending-mutation rollback window: Alice's echo settled her cache
  // instead of her optimistic rename being reverted to Bob's value.
  await alice.page.waitForTimeout(6_000);
  await expect(
    aliceColumn.getByRole("button", { name: "Rename column Alice Wins", exact: true }),
  ).toBeVisible();
  await expect(
    aliceColumn.getByRole("button", { name: "Rename column Bob Wins", exact: true }),
  ).toHaveCount(0);

  // Both sockets stayed up: still live, no reconnect banner, and no second
  // snapshot (a reconnect would have resynchronized instead of converging).
  await expect(alice.page.getByText("live")).toBeVisible();
  await expect(bob.page.getByText("live")).toBeVisible();
  await expect(alice.page.getByText("reconnecting…")).toHaveCount(0);
  await expect(alice.page.getByText("Could not connect.")).toHaveCount(0);
  expect(await alice.page.evaluate(() => window.__frameHold.inboundCount("snapshot"))).toBe(1);

  // A freshly opened client takes its snapshot from the DO and sees the same value.
  const fresh = await bob.page.context().newPage();
  await fresh.goto(`/board/${boardKey}`);
  await expect(
    columns(fresh).first().getByRole("button", { name: "Rename column Alice Wins", exact: true }),
  ).toBeVisible();
  await expect(fresh.getByRole("button", { name: "Rename column Bob Wins", exact: true })).toHaveCount(0);

  await alice.page.context().close();
  await bob.page.context().close();
});
