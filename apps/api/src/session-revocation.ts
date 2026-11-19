import { Identifier, SESSION_REVOKED_CLOSE } from "@foxban/shared";
import { z } from "zod";
import { INTERNAL_SESSION_HASH_HEADER } from "./internal-headers";

/** The internal route of BoardDO and PresenceDO that closes a user's sockets after a session was revoked (ADR 0082). */
export const REVOKE_SESSIONS_PATH = "/internal/sessions/revoke";

const SESSION_HASH = /^[0-9a-f]{64}$/;
const SessionHash = z.string().regex(SESSION_HASH);

/** The session hash the Worker put on a socket upgrade, or undefined (an upgrade that carries none, or a malformed one, is treated as unattributed and closed by any revocation for its user). */
export function sessionHashOf(headers: Headers): string | undefined {
  const value = headers.get(INTERNAL_SESSION_HASH_HEADER);
  return value !== null && SESSION_HASH.test(value) ? value : undefined;
}

/** Close `userId`'s sockets opened with one of `sessionHashes`, or all of them except `exceptSessionHash`: exactly one of the two. */
export const SessionRevocationSchema = z
  .strictObject({
    userId: Identifier,
    sessionHashes: z.array(SessionHash).min(1).max(100).optional(),
    exceptSessionHash: SessionHash.optional(),
  })
  .refine((revocation) => (revocation.sessionHashes === undefined) !== (revocation.exceptSessionHash === undefined), {
    message: "name sessionHashes or exceptSessionHash, not both",
  });
export type SessionRevocation = z.infer<typeof SessionRevocationSchema>;

/**
 * Closes every open socket of `revocation.userId` that the revocation names, with `SESSION_REVOKED_CLOSE`, and
 * returns how many it closed. A socket accepted before its attachment carried a session hash has none to compare:
 * it counts as named, so a revocation for its user closes it (one extra reconnect for a user's other session,
 * rather than a socket nobody can attribute surviving).
 */
export function closeRevokedSockets(sockets: Iterable<WebSocket>, revocation: SessionRevocation): number {
  let closed = 0;
  for (const socket of sockets) {
    let attachment: unknown = null;
    try {
      attachment = socket.deserializeAttachment();
    } catch {
      // An attachment that cannot be read names no user.
    }
    if (typeof attachment !== "object" || attachment === null || !("userId" in attachment) || attachment.userId !== revocation.userId) continue;
    const hash = "sessionHash" in attachment ? attachment.sessionHash : undefined;
    const named =
      typeof hash !== "string" ||
      (revocation.sessionHashes ? revocation.sessionHashes.includes(hash) : hash !== revocation.exceptSessionHash);
    if (!named) continue;
    try {
      socket.close(SESSION_REVOKED_CLOSE, "Session ended");
      closed += 1;
    } catch {
      // `getWebSockets()` lists sockets that are already closing.
    }
  }
  return closed;
}
