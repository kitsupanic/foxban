import { expect, test } from "@playwright/test";
import { accessMarker } from "../src/lib/access-marker";

const board = { id: "b1", workspaceId: "w1" };
const member = [{ id: "w1", access: "member" as const }];
const guest = [{ id: "w1", access: "guest" as const }];

test("a workspace page says how the viewer holds the workspace", () => {
  expect(accessMarker({ workspace: { access: "operator" }, isAdmin: true })).toBe("Operator");
  expect(accessMarker({ workspace: { access: "guest" }, isAdmin: false })).toBe("Guest");
  expect(accessMarker({ workspace: { access: "member" }, isAdmin: true })).toBeNull();
});

test("a board page says nothing until both lists have loaded", () => {
  expect(accessMarker({ board, heldBoards: [], isAdmin: true })).toBeNull();
  expect(accessMarker({ board, workspaces: member, isAdmin: true })).toBeNull();
});

test("a member who holds the board, or whose workspace lists it, carries no marker", () => {
  expect(accessMarker({ board, workspaces: member, heldBoards: [board], isAdmin: false })).toBeNull();
  expect(accessMarker({ board, workspaces: member, heldBoards: [board], isAdmin: true })).toBeNull();
});

test("a board held only as a Guest is marked Guest, an Admin included", () => {
  expect(accessMarker({ board, workspaces: guest, heldBoards: [board], isAdmin: false })).toBe("Guest");
  expect(accessMarker({ board, workspaces: guest, heldBoards: [board], isAdmin: true })).toBe("Guest");
});

test("an Admin outside the workspace who holds nothing on the board is an Operator", () => {
  expect(accessMarker({ board, workspaces: [], heldBoards: [], isAdmin: true })).toBe("Operator");
  expect(accessMarker({ board, workspaces: [], heldBoards: [], isAdmin: false })).toBeNull();
});

test("an Admin who is a plain member of the workspace but holds nothing on the board is an Operator", () => {
  // A Private board they were not added to: the workspace is theirs, this board is open to them only as an Admin.
  expect(accessMarker({ board, workspaces: member, heldBoards: [], isAdmin: true })).toBe("Operator");
  // Without Admin power the same position opens nothing, so there is nothing to mark.
  expect(accessMarker({ board, workspaces: member, heldBoards: [], isAdmin: false })).toBeNull();
});
