import { DurableObject } from "cloudflare:workers";
import {
  type PresenceSnapshotMessage,
  type PresenceState,
  type PresenceUpdatedMessage,
  type WorkspaceInvalidated,
} from "@foxban/shared";
import { INTERNAL_TIMEZONE_HEADER, INTERNAL_USER_ID_HEADER } from "./internal-headers";

type SocketAttachment = {
  userId: string;
  timezone: string | null;
};

type PresenceRow = {
  userId: string;
  lastSeenAt: number | null;
  timezone: string | null;
};

export class PresenceDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS presence (
          user_id TEXT PRIMARY KEY,
          last_seen_at INTEGER,
          timezone TEXT
        )
      `);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/workspaces/invalidate") {
      if (request.method !== "POST") return new Response("method not allowed", {status:405});
      const raw:unknown=await request.json().catch(()=>null);
      if(!raw||typeof raw!=="object"||!("targets" in raw)||!Array.isArray(raw.targets))return new Response("invalid request",{status:400});
      // Every frame carries only the contexts its own recipient may know: a move
      // between workspaces must not hand a board id to members who were never
      // invited to it, so the fan-out cannot share one payload.
      const frames=new Map<string,string>();
      for(const target of raw.targets){
        if(!target||typeof target!=="object")return new Response("invalid request",{status:400});
        const entry=target as Record<string,unknown>;
        if(typeof entry.userId!=="string"||!Array.isArray(entry.workspaceIds)||!Array.isArray(entry.boardIds))return new Response("invalid request",{status:400});
        const frame:WorkspaceInvalidated={type:"workspace.invalidated",
          workspaceIds:entry.workspaceIds.filter((id):id is string=>typeof id==="string"),
          boardIds:entry.boardIds.filter((id):id is string=>typeof id==="string")};
        frames.set(entry.userId,JSON.stringify(frame));
      }
      for(const socket of this.ctx.getWebSockets()){
        const attachment=this.getAttachment(socket);
        if(!attachment)continue;
        const encoded=frames.get(attachment.userId);
        if(encoded===undefined)continue;
        try{socket.send(encoded);}catch{}
      }
      return Response.json({ok:true});
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const userId = request.headers.get(INTERNAL_USER_ID_HEADER);
    if (!userId || userId.length > 64) {
      return new Response("invalid user id", { status: 400 });
    }

    const timezoneHeader = request.headers.get(INTERNAL_TIMEZONE_HEADER);
    const timezone = timezoneHeader && timezoneHeader.length > 0 ? timezoneHeader : null;

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    const attachment: SocketAttachment = { userId, timezone };
    server.serializeAttachment(attachment);

    // Upsert SQLite presence row: clear last_seen_at as online-cycle marker and update latest known timezone
    this.ctx.storage.sql.exec(
      `INSERT INTO presence (user_id, last_seen_at, timezone)
       VALUES (?, NULL, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         last_seen_at = NULL,
         timezone = excluded.timezone`,
      userId,
      timezone,
    );

    // Send full snapshot to new socket
    const snapshotFrame = JSON.stringify(this.getSnapshot());
    try {
      server.send(snapshotFrame);
    } catch {
      // Socket failed immediately
    }

    // Broadcast that this user is online
    this.broadcastUser(userId, true);

    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Presence protocol is server-owned; client messages are ignored.
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    const attachment = this.getAttachment(ws);
    const sendable = code === 1000 || (code >= 3000 && code <= 4999);
    try {
      ws.close(sendable ? code : 1000);
    } catch {
      // Ignore errors closing socket
    }

    if (attachment) {
      this.handleSocketDisconnect(attachment.userId, ws);
    }
  }

  override webSocketError(ws: WebSocket, _error: unknown): void {
    const attachment = this.getAttachment(ws);
    // Reserved status codes like 1006 cannot be passed to ws.close; use 1011 (internal error) or 1000
    try {
      ws.close(1011, "websocket error");
    } catch {
      // Ignore errors closing socket
    }

    if (attachment) {
      this.handleSocketDisconnect(attachment.userId, ws);
    }
  }

  private getAttachment(ws: WebSocket): SocketAttachment | null {
    try {
      const data = ws.deserializeAttachment() as SocketAttachment | null;
      if (data && typeof data.userId === "string") {
        return data;
      }
    } catch {
      // Attachment could not be deserialized
    }
    return null;
  }

  private getConnectedUserIds(excludeSocket?: WebSocket): Set<string> {
    const connected = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (excludeSocket && ws === excludeSocket) continue;
      const att = this.getAttachment(ws);
      if (att) {
        connected.add(att.userId);
      }
    }
    return connected;
  }

  private handleSocketDisconnect(userId: string, closingSocket?: WebSocket): void {
    // Check if user still has other open sockets, excluding the one currently closing
    const connected = this.getConnectedUserIds(closingSocket);
    if (!connected.has(userId)) {
      // Check current persisted state: only write and broadcast if not already marked offline
      const row = this.ctx.storage.sql
        .exec<PresenceRow>(
          `SELECT user_id AS userId, last_seen_at AS lastSeenAt, timezone
             FROM presence
            WHERE user_id = ?`,
          userId,
        )
        .toArray()[0];

      // If user row has no last_seen_at, they are transitioning from online to offline
      if (row && row.lastSeenAt === null) {
        const now = Date.now();
        this.ctx.storage.sql.exec(
          `UPDATE presence SET last_seen_at = ? WHERE user_id = ?`,
          now,
          userId,
        );
        this.broadcastUser(userId, false, now, closingSocket);
      }
    }
  }

  private getSnapshot(): PresenceSnapshotMessage {
    const connected = this.getConnectedUserIds();
    const rows = this.ctx.storage.sql
      .exec<PresenceRow>(
        `SELECT user_id AS userId, last_seen_at AS lastSeenAt, timezone
           FROM presence`,
      )
      .toArray();

    const members: PresenceState[] = rows.map((row) => ({
      userId: row.userId,
      online: connected.has(row.userId),
      lastSeenAt: connected.has(row.userId) ? null : row.lastSeenAt,
      timezone: row.timezone,
    }));

    return {
      type: "presence.snapshot",
      members,
    };
  }

  private broadcastUser(
    userId: string,
    online: boolean,
    offlineLastSeenAt?: number,
    excludeSocket?: WebSocket,
  ): void {
    const row = this.ctx.storage.sql
      .exec<PresenceRow>(
        `SELECT user_id AS userId, last_seen_at AS lastSeenAt, timezone
           FROM presence
          WHERE user_id = ?`,
        userId,
      )
      .toArray()[0];

    const timezone = row?.timezone ?? null;
    const lastSeenAt = online ? null : (offlineLastSeenAt ?? row?.lastSeenAt ?? null);

    const frame: PresenceUpdatedMessage = {
      type: "presence.updated",
      member: {
        userId,
        online,
        lastSeenAt,
        timezone,
      },
    };

    const payload = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) {
      if (excludeSocket && socket === excludeSocket) continue;
      try {
        socket.send(payload);
      } catch {
        // Broadcast failures are isolated per socket
      }
    }
  }
}
