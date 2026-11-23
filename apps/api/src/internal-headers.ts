export const INTERNAL_BOARD_ID_HEADER = "x-foxban-board-id";
export const INTERNAL_USER_ID_HEADER = "x-foxban-user-id";
export const INTERNAL_TIMEZONE_HEADER = "x-foxban-timezone";
export const INTERNAL_IS_ADMIN_HEADER = "x-foxban-is-admin";
export const INTERNAL_CAN_MANAGE_COLUMNS_HEADER = "x-foxban-can-manage-columns";
/** SHA-256 (hex) of the session cookie a socket was opened with, which is also its `sessions.id` (ADR 0084): how a DO names the session without holding the bearer secret (ADR 0082). */
export const INTERNAL_SESSION_HASH_HEADER = "x-foxban-session-hash";

/** Drops every `x-foxban-*` header: a browser's upgrade request is copied to the DO, so none of its own may survive next to the Worker's trusted ones. */
export function stripInternalHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) if (name.startsWith("x-foxban-")) headers.delete(name);
}

/**
 * The browser's upgrade request as a Durable Object may see it: no `x-foxban-*` of the client's, and no credential.
 * The session cookie is the bearer secret the DO must never hold (ADR 0082); the Worker authenticated it already
 * and sets the trusted `x-foxban-*` headers on the result.
 */
export function upgradeHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  stripInternalHeaders(headers);
  headers.delete("cookie");
  headers.delete("authorization");
  return headers;
}
