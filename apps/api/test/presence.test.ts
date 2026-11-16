import {
  PresenceServerMessageSchema,
  REALTIME_PROTOCOL_VERSION,
  type PresenceServerMessage,
  type PresenceState,
} from "@foxban/shared";
import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * PresenceDO behaviour driven through real hibernatable WebSockets and the /presence/ws route.
 * D1 bindings in the test pool start empty, so the migrations are applied first.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const PASSWORD = "correct horse battery";
const ORIGIN = "https://foxban.test";

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("response carried no Set-Cookie header");
  return header.split(";")[0]!;
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function patch(path: string, body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string, extra?: HeadersInit): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    headers: { ...(cookie ? { cookie } : {}), ...extra },
  });
}

async function signup(email: string, name = "Presence User"): Promise<string> {
  const response = await post("/auth/signup", { email, name, password: PASSWORD });
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

interface Frame {
  raw: string;
  message: PresenceServerMessage;
}

interface PresenceClient {
  next(): Promise<Frame>;
  nextMatching(predicate: (msg: PresenceServerMessage) => boolean): Promise<Frame>;
  nextUserUpdate(userId: string): Promise<PresenceState>;
  close(): void;
  closed: Promise<CloseEvent>;
}

const openClients: PresenceClient[] = [];

afterEach(() => {
  while (openClients.length > 0) {
    try {
      openClients.pop()?.close();
    } catch {
      // Ignore already-closed sockets
    }
  }
});
async function connectPresenceWs(cookie: string, queryParams?: string): Promise<PresenceClient> {
  const query = new URLSearchParams(queryParams);
  if (!query.has("realtimeVersion")) {
    query.set("realtimeVersion", REALTIME_PROTOCOL_VERSION);
  }
  const url = `/presence/ws?${query.toString()}`;
  const response = await get(url, cookie, {
    Upgrade: "websocket",
  });

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("the presence route did not return a WebSocket");

  const queue: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];

  socket.addEventListener("message", (event: MessageEvent) => {
    const raw = event.data as string;
    const message = PresenceServerMessageSchema.parse(JSON.parse(raw));
    const frame: Frame = { raw, message };
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });

  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });

  socket.accept();
  const client: PresenceClient = {
    closed,
    next() {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<Frame>((resolve) => waiters.push(resolve));
    },
    async nextMatching(predicate) {
      // Check if any frame in queue matches
      const matchIdx = queue.findIndex((f) => predicate(f.message));
      if (matchIdx !== -1) {
        const [matched] = queue.splice(matchIdx, 1);
        return matched!;
      }
      // Otherwise keep consuming until a matching frame arrives
      while (true) {
        const frame = await this.next();
        if (predicate(frame.message)) {
          return frame;
        }
      }
    },
    async nextUserUpdate(userId: string) {
      const frame = await this.nextMatching(
        (msg) => msg.type === "presence.updated" && msg.member.userId === userId,
      );
      if (frame.message.type !== "presence.updated") {
        throw new Error("unexpected frame type");
      }
      return frame.message.member;
    },
    close() {
      socket.close(1000, "test finished");
    },
  };
  openClients.push(client);
  return client;
}

describe("presence HTTP / WebSocket upgrade contract", () => {
  it("rejects unauthenticated upgrade with 401", async () => {
    const response = await get("/presence/ws", undefined, { Upgrade: "websocket" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("authenticated non-upgrade request with current version reaches DO and returns 426", async () => {
    const cookie = await signup("upgrade426@foxban.test", "Non Upgrade User");
    const response = await get(`/presence/ws?realtimeVersion=${REALTIME_PROTOCOL_VERSION}`, cookie);
    expect(response.status).toBe(426);
    expect(await response.text()).toBe("expected websocket upgrade");
  });

  it("rejects presence ws with 409 when realtimeVersion is missing or mismatched", async () => {
    const cookie = await signup("presence-version-gate@foxban.test", "Version Gate User");

    // Missing realtimeVersion query param
    const missingRes = await get("/presence/ws", cookie, { Upgrade: "websocket" });
    expect(missingRes.status).toBe(409);
    expect(await missingRes.json()).toEqual({ error: "realtime client update required" });

    // Mismatched realtimeVersion query param
    const wrongRes = await get("/presence/ws?realtimeVersion=999", cookie, { Upgrade: "websocket" });
    expect(wrongRes.status).toBe(409);
    expect(await wrongRes.json()).toEqual({ error: "realtime client update required" });

    // Precedence: unauthenticated caller gets 401 even with wrong or missing version
    const unauthWrong = await get("/presence/ws?realtimeVersion=999", undefined, {
      Upgrade: "websocket",
    });
    expect(unauthWrong.status).toBe(401);
  });

  it("invalid user id directly on DO returns 400", async () => {
    const stub = env.PRESENCE_DO.get(env.PRESENCE_DO.idFromName("global"));
    const response = await stub.fetch("https://presence.test/ws", {
      headers: {
        Upgrade: "websocket",
      },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid user id");
  });
});

describe("presence live protocol and multi-tab lifecycle", () => {
  it("first socket gets a snapshot and second user gets snapshot and online broadcast", async () => {
    const aliceCookie = await signup("alice-proto@foxban.test", "Alice Proto");
    const aliceId = (await (await get("/me", aliceCookie)).json<{ id: string }>()).id;

    // Alice connects first with an effective timezone
    const aliceClient = await connectPresenceWs(aliceCookie, "timezone=America/New_York");
    const aliceFrame1 = await aliceClient.next();
    expect(aliceFrame1.message.type).toBe("presence.snapshot");
    if (aliceFrame1.message.type === "presence.snapshot") {
      const aliceState = aliceFrame1.message.members.find((m) => m.userId === aliceId);
      expect(aliceState).toBeDefined();
      expect(aliceState?.online).toBe(true);
      expect(aliceState?.timezone).toBe("America/New_York");
      expect(aliceState?.lastSeenAt).toBeNull();
    }

    // Alice also gets her own presence.updated online broadcast
    const aliceFrame2 = await aliceClient.next();
    expect(aliceFrame2.message.type).toBe("presence.updated");
    if (aliceFrame2.message.type === "presence.updated") {
      expect(aliceFrame2.message.member).toMatchObject({
        userId: aliceId,
        online: true,
        timezone: "America/New_York",
        lastSeenAt: null,
      });
    }

    // Bob connects
    const bobCookie = await signup("bob-proto@foxban.test", "Bob Proto");
    const bobId = (await (await get("/me", bobCookie)).json<{ id: string }>()).id;
    const bobClient = await connectPresenceWs(bobCookie, "timezone=Europe/London");

    // Bob gets snapshot containing both Alice and Bob online
    const bobFrame1 = await bobClient.next();
    expect(bobFrame1.message.type).toBe("presence.snapshot");
    if (bobFrame1.message.type === "presence.snapshot") {
      const aliceState = bobFrame1.message.members.find((m) => m.userId === aliceId);
      const bobState = bobFrame1.message.members.find((m) => m.userId === bobId);
      expect(aliceState?.online).toBe(true);
      expect(bobState?.online).toBe(true);
      expect(bobState?.timezone).toBe("Europe/London");
    }

    // Alice receives Bob's online broadcast
    const bobBroadcast = await aliceClient.nextUserUpdate(bobId);
    expect(bobBroadcast).toMatchObject({
      userId: bobId,
      online: true,
      timezone: "Europe/London",
      lastSeenAt: null,
    });

    aliceClient.close();
    bobClient.close();
  });

  it("two tabs for one user maintain online after one closes; final close broadcasts offline with persisted timestamp", async () => {
    const multiCookie = await signup("multi-tab@foxban.test", "Multi Tab User");
    const multiUserId = (await (await get("/me", multiCookie)).json<{ id: string }>()).id;

    // Observer socket to monitor broadcasts
    const observerCookie = await signup("observer@foxban.test", "Observer User");
    const observer = await connectPresenceWs(observerCookie);
    // Drain observer's initial snapshot and online broadcast
    await observer.next();
    await observer.next();

    // Tab 1 connects
    const tab1 = await connectPresenceWs(multiCookie, "timezone=UTC");
    const obsFrame1 = await observer.nextUserUpdate(multiUserId);
    expect(obsFrame1.online).toBe(true);

    // Tab 2 connects for the same user
    const tab2 = await connectPresenceWs(multiCookie, "timezone=UTC");
    const obsFrame2 = await observer.nextUserUpdate(multiUserId);
    expect(obsFrame2.online).toBe(true);

    // Close tab 1: user still has tab 2 connected, so user MUST remain online!
    tab1.close();
    await tab1.closed;

    // Positively prove user is still online after tab 1 closes:
    // A new spectator connecting receives a snapshot with multiUserId still online.
    const spectatorCookie = await signup("spectator@foxban.test", "Spectator User");
    const spectator = await connectPresenceWs(spectatorCookie);
    const specSnapshot = await spectator.nextMatching((m) => m.type === "presence.snapshot");
    if (specSnapshot.message.type === "presence.snapshot") {
      const multiState = specSnapshot.message.members.find((m) => m.userId === multiUserId);
      expect(multiState?.online).toBe(true);
      expect(multiState?.lastSeenAt).toBeNull();
    }
    spectator.close();

    // Close tab 2: now the final socket closes, user must transition to offline with timestamp.
    tab2.close();
    await tab2.closed;

    const offlineState = await observer.nextUserUpdate(multiUserId);
    expect(offlineState.online).toBe(false);
    expect(typeof offlineState.lastSeenAt).toBe("number");
    expect(offlineState.lastSeenAt).toBeGreaterThan(0);
    observer.close();
  });

  it("reconnect returns lastSeenAt timestamp and updated timezone in snapshot", async () => {
    const reconCookie = await signup("reconnect@foxban.test", "Reconnect User");
    const reconUserId = (await (await get("/me", reconCookie)).json<{ id: string }>()).id;
    // Connect and close to set a lastSeenAt timestamp
    const client1 = await connectPresenceWs(reconCookie, "timezone=America/Chicago");
    await client1.nextMatching((m) => m.type === "presence.snapshot");
    await client1.nextUserUpdate(reconUserId);
    client1.close();
    await client1.closed;

    const watcherCookie = await signup("watcher@foxban.test", "Watcher User");
    const watcher = await connectPresenceWs(watcherCookie);
    const snapFrame = await watcher.nextMatching((m) => m.type === "presence.snapshot");
    if (snapFrame.message.type === "presence.snapshot") {
      const reconState = snapFrame.message.members.find((m) => m.userId === reconUserId);
      expect(reconState).toBeDefined();
      expect(reconState?.online).toBe(false);
      expect(typeof reconState?.lastSeenAt).toBe("number");
      expect(reconState?.lastSeenAt).toBeGreaterThan(0);
      expect(reconState?.timezone).toBe("America/Chicago");
    }

    // Reconnect the user with a new timezone
    const client2 = await connectPresenceWs(reconCookie, "timezone=Asia/Tokyo");
    // Watcher sees the online broadcast with new timezone for reconUserId
    const reconUpdated = await watcher.nextUserUpdate(reconUserId);
    expect(reconUpdated).toMatchObject({
      userId: reconUserId,
      online: true,
      lastSeenAt: null,
      timezone: "Asia/Tokyo",
    });

    client2.close();
    watcher.close();
  });

  it("invalid browser timezone falls back to null absent saved override", async () => {
    const noTzCookie = await signup("notz@foxban.test", "No Tz User");
    const noTzUserId = (await (await get("/me", noTzCookie)).json<{ id: string }>()).id;

    // Passing an invalid timezone query param without saved override
    const client = await connectPresenceWs(noTzCookie, "timezone=Invalid/Bogus_Timezone");
    const snap = await client.next();
    if (snap.message.type === "presence.snapshot") {
      const state = snap.message.members.find((m) => m.userId === noTzUserId);
      expect(state?.timezone).toBeNull();
    }
    const update = await client.next();
    if (update.message.type === "presence.updated") {
      expect(update.message.member.timezone).toBeNull();
    }
    client.close();
  });

  it("saved profile timezone override takes precedence over browser query param", async () => {
    const overrideCookie = await signup("tz-override@foxban.test", "Override User");
    const overrideUserId = (await (await get("/me", overrideCookie)).json<{ id: string }>()).id;

    // Set saved override in Profile
    const patchRes = await patch("/me", { timezone: "Europe/Paris" }, overrideCookie);
    expect(patchRes.status).toBe(200);

    // Connect with a different browser timezone query param
    const client = await connectPresenceWs(overrideCookie, "timezone=America/New_York");
    const snap = await client.next();
    if (snap.message.type === "presence.snapshot") {
      const state = snap.message.members.find((m) => m.userId === overrideUserId);
      expect(state?.timezone).toBe("Europe/Paris");
    }
    const update = await client.next();
    if (update.message.type === "presence.updated") {
      expect(update.message.member.timezone).toBe("Europe/Paris");
    }
    client.close();
  });
});
describe("presence protocol strict schemas", () => {
  it("rejects unknown extra top-level and nested keys on server frames", () => {
    // Valid baseline snapshot
    expect(
      PresenceServerMessageSchema.safeParse({
        type: "presence.snapshot",
        members: [{ userId: "user-1", online: true, lastSeenAt: null, timezone: "UTC" }],
      }).success,
    ).toBe(true);

    // Extra top-level key rejected on snapshot
    expect(
      PresenceServerMessageSchema.safeParse({
        type: "presence.snapshot",
        members: [],
        extraField: true,
      }).success,
    ).toBe(false);

    // Extra top-level key rejected on updated
    expect(
      PresenceServerMessageSchema.safeParse({
        type: "presence.updated",
        member: { userId: "user-1", online: true, lastSeenAt: null, timezone: "UTC" },
        bogusTopLevel: 123,
      }).success,
    ).toBe(false);

    // Extra nested key rejected on PresenceState member in snapshot
    expect(
      PresenceServerMessageSchema.safeParse({
        type: "presence.snapshot",
        members: [
          {
            userId: "user-1",
            online: true,
            lastSeenAt: null,
            timezone: "UTC",
            unknownNested: "fail",
          },
        ],
      }).success,
    ).toBe(false);

    // Extra nested key rejected on PresenceState member in updated
    expect(
      PresenceServerMessageSchema.safeParse({
        type: "presence.updated",
        member: {
          userId: "user-1",
          online: true,
          lastSeenAt: null,
          timezone: "UTC",
          extraStateProp: true,
        },
      }).success,
    ).toBe(false);

    // Unknown type rejected
    expect(
      PresenceServerMessageSchema.safeParse({
        type: "presence.invalid",
        members: [],
      }).success,
    ).toBe(false);

    // Negative lastSeenAt rejected
    expect(
      PresenceServerMessageSchema.safeParse({
        type: "presence.updated",
        member: { userId: "user-1", online: false, lastSeenAt: -1, timezone: null },
      }).success,
    ).toBe(false);
  });
});
