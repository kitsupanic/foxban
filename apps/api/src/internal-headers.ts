export const INTERNAL_BOARD_ID_HEADER = "x-foxban-board-id";
export const INTERNAL_USER_ID_HEADER = "x-foxban-user-id";
export const INTERNAL_TIMEZONE_HEADER = "x-foxban-timezone";
export const INTERNAL_CAN_MANAGE_COLUMNS_HEADER = "x-foxban-can-manage-columns";

/** One request to a board's Durable Object over the internal channel, naming the board in the header the DO insists on. Other headers (and a `Content-Type` for a body) are the caller's. */
export function boardFetch(env: Env, boardId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(INTERNAL_BOARD_ID_HEADER, boardId);
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId)).fetch(`https://board.internal${path}`, { ...init, headers });
}
