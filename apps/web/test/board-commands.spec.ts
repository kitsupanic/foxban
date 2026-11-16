import { expect, test } from "@playwright/test";
import type { Card, ClientMessage } from "@foxban/shared";
import { boardCommands, newCardPosition } from "../src/lib/board-commands";
import type { BoardState } from "../src/lib/apply-mutation";

const card = (id: string, position: string, columnId: string): Card => ({ id, title: id, position, columnId, description: "", taskNumber: 1, taskType: "task", priority: "medium", assigneeId: null, dueDate: null, subtaskDone: false, createdAt: 1, updatedAt: 1 });
const sub = (parent: string, child: string) => ({ id: `${parent}>${child}`, kind: "subtask" as const, sourceCardId: parent, targetCardId: child });
function fixture(): BoardState {
  return {
    workflowRolesExplicit: false,
    columns: [{ id: "todo", title: "Todo", position: "a0", starting: true }, { id: "work", title: "Work", position: "a1" }, { id: "done", title: "Done", position: "a2", completed: true }],
    // P (done) has S (done) and C (todo); Q (todo) has an open child K; R is a root in done.
    cards: [card("P", "a0", "done"), card("S", "a1", "done"), card("R", "a5", "done"), card("C", "a2", "todo"), card("Q", "a3", "todo"), card("K", "a4", "todo"), card("L", "a6", "work")],
    relations: [sub("P", "S"), sub("P", "C"), sub("Q", "K"), { id: "rel", kind: "relates", sourceCardId: "L", targetCardId: "R" }],
    archivedCards: [{ ...card("A", "a0", "work"), archivedAt: 1 } as never], checklistItems: [{ id: "i1", cardId: "L", text: "x", done: false, position: "a0" } as never], attachments: [], comments: [], activities: [],
    labels: [{ id: "lab", name: "bug", color: "red" } as never], cardLabels: [{ id: "j1", cardId: "L", labelId: "lab" } as never],
  };
}
function harness(state: BoardState | undefined = fixture(), connected = true) {
  const sent: ClientMessage[] = [];
  const commands = boardCommands(message => { if (connected) sent.push(message); return connected; }, () => state);
  return { sent, commands };
}
const strip = ({ mutationId, ...rest }: ClientMessage & { mutationId: string }) => (expect(mutationId).toMatch(/^[0-9a-f-]{36}$/), rest);

test("every command mints a fresh mutation id", () => {
  const { sent, commands } = harness();
  commands.deleteRelation("rel"); commands.deleteRelation("rel");
  expect(new Set(sent.map(m => m.mutationId)).size).toBe(2);
});

const table: { name: string; run: (c: ReturnType<typeof boardCommands>) => unknown; result: unknown; sent: Record<string, unknown>[] }[] = [
  { name: "assign to someone new", run: c => c.assign("L", "u1"), result: "sent", sent: [{ type: "card.assign", id: "L", assigneeId: "u1" }] },
  { name: "assign to the current assignee", run: c => c.assign("L", null), result: "no-op", sent: [] },
  { name: "prioritize unchanged", run: c => c.prioritize("L", "medium"), result: "no-op", sent: [] },
  { name: "retype", run: c => c.retype("L", "bug"), result: "sent", sent: [{ type: "card.retype", id: "L", taskType: "bug" }] },
  { name: "schedule", run: c => c.schedule("L", "2026-12-01"), result: "sent", sent: [{ type: "card.schedule", id: "L", dueDate: "2026-12-01" }] },
  { name: "unassign an assigned label", run: c => c.toggleLabel("L", "lab"), result: "sent", sent: [{ type: "label.unassign", id: "j1" }] },
  { name: "duplicate relation", run: c => c.createRelation("relates", "R", "L"), result: "no-op", sent: [] },
  { name: "reversed blocked-by relation", run: c => c.createRelation("blocked-by", "L", "C"), result: "sent", sent: [{ type: "relation.create", sourceCardId: "C", targetCardId: "L", kind: "blocks" }] },
  { name: "empty label update", run: c => c.updateLabel("lab", {}), result: "no-op", sent: [] },
  { name: "restore lands at the flat tail", run: c => c.restoreCard("A", "work"), result: "sent", sent: [{ type: "card.restore", id: "A", columnId: "work", position: "a7" }] },
  { name: "restore of a live card", run: c => c.restoreCard("L", "work"), result: "no-op", sent: [] },
  { name: "column moved right lands after the target", run: c => c.moveColumn("todo", "work"), result: "sent", sent: [{ type: "column.move", id: "todo", position: "a1V" }] },
  { name: "rename a column", run: c => c.renameColumn("work", "Doing"), result: "sent", sent: [{ type: "column.rename", id: "work", title: "Doing" }] },
  { name: "configure workflow against the current roles", run: c => c.configureWorkflow("work", "done"), result: "sent", sent: [{ type: "workflow.configure", startingColumnId: "work", completedColumnId: "done", expectedStartingColumnId: "todo", expectedCompletedColumnId: "done" }] },
  { name: "column dropped on itself", run: c => c.moveColumn("todo", "todo"), result: "no-op", sent: [] },
  // Placement: same peer rules as a drag onto the column body.
  { name: "completing a subtask whose parent is in Done lands after its last sibling", run: c => c.moveCard("C", { columnId: "done" }), result: "sent", sent: [{ type: "card.move", id: "C", columnId: "done", position: "a2" }] },
  { name: "a root lands after the last root, not a nested child's key", run: c => c.moveCard("L", { columnId: "done" }), result: "sent", sent: [{ type: "card.move", id: "L", columnId: "done", position: "a6" }] },
  { name: "a drag's own position is kept", run: c => c.moveCard("L", { columnId: "todo", position: "Zz" }), result: "sent", sent: [{ type: "card.move", id: "L", columnId: "todo", position: "Zz" }] },
  { name: "a move to the current column without a position", run: c => c.moveCard("L", { columnId: "work" }), result: "no-op", sent: [] },
  // Family-finish gate: no path sends this move.
  { name: "a parent with open children entering Done", run: c => c.moveCard("Q", { columnId: "done" }), result: { needsFinish: { columnId: "done", position: "a6" } }, sent: [] },
  { name: "a dragged parent with open children entering Done", run: c => c.moveCard("Q", { columnId: "done", position: "Zz" }), result: { needsFinish: { columnId: "done", position: "Zz" } }, sent: [] },
  { name: "the same parent reordered inside its own column", run: c => c.moveCard("Q", { columnId: "todo", position: "a9" }), result: "sent", sent: [{ type: "card.move", id: "Q", columnId: "todo", position: "a9" }] },
];
for (const row of table) {
  test(`command table: ${row.name}`, () => {
    const { sent, commands } = harness();
    expect(row.run(commands)).toEqual(row.result);
    expect(sent.map(m => strip(m))).toMatchObject(row.sent);
    expect(sent).toHaveLength(row.sent.length);
  });
}

test("assigning a new label and creating one both mint entity ids", () => {
  const { sent, commands } = harness();
  expect(commands.toggleLabel("C", "lab")).toBe("sent");
  expect(commands.createAndAssignLabel("C", "ux", "blue")).toBe("sent");
  const [assign, create, assignNew] = sent as Extract<ClientMessage, { id: string }>[];
  expect(assign).toMatchObject({ type: "label.assign", cardId: "C", labelId: "lab" });
  expect(create).toMatchObject({ type: "label.create", name: "ux", color: "blue" });
  expect(assignNew).toMatchObject({ type: "label.assign", cardId: "C", labelId: create!.id });
  expect(new Set([assign!.id, create!.id, assignNew!.id]).size).toBe(3);
});
test("offline: commands report not-sent and the label pair stops at the definition", () => {
  const { commands } = harness(fixture(), false);
  expect(commands.deleteCard("L")).toBe("not-sent");
  expect(commands.createAndAssignLabel("C", "ux", "blue")).toBe("not-sent");
  expect(commands.moveCard("L", { columnId: "done" })).toBe("not-sent");
});
test("no board yet: nothing is sent", () => {
  const sent: ClientMessage[] = [];
  const commands = boardCommands(message => (sent.push(message), true), () => undefined);
  expect(commands.moveCard("L", { columnId: "done" })).toBe("not-sent");
  expect(sent).toHaveLength(0);
});
test("a new card's key is past every card in its column, so it never ties an existing key", () => {
  const state = fixture();
  expect(newCardPosition(state, "done")).toBe("a6");
  expect(newCardPosition({ ...state, cards: [] }, "done")).toBe("a0");
});
test("a label update never sends an undefined field", () => {
  const { sent, commands } = harness();
  expect(commands.updateLabel("lab", { name: undefined, color: undefined })).toBe("no-op");
  expect(commands.updateLabel("lab", { name: undefined, color: "blue" })).toBe("sent");
  expect(Object.keys(sent[0]!)).not.toContain("name");
});
