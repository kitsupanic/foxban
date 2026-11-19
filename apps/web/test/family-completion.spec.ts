import { createBoardReconciler } from "./reconciler-helpers";
import { expect, test } from "@playwright/test";
import type { Card } from "@foxban/shared";
import { applyMutation, type BoardState } from "../src/lib/apply-mutation";
import { completionFamily, finishMessage } from "../src/lib/family-completion";

const card = (id: string, columnId: string, position: string): Card => ({ id, columnId, position, title: id, description: "", taskNumber: 1, taskType: "task", subtaskDone: false, priority: "medium", assigneeId: null, dueDate: null, createdAt: 0, updatedAt: 0 });
function fixture(): BoardState {
  return { columns: [{id:"todo",title:"Todo",position:"a0",starting:true},{id:"work",title:"Work",position:"a1"},{id:"done",title:"Done",position:"a2",completed:true}], cards: [card("parent","work","a0"),card("z-first","todo","a0"),card("a-second","work","a1"),card("finished","done","a0")], relations: [{id:"r1",kind:"subtask",sourceCardId:"parent",targetCardId:"z-first"},{id:"r2",kind:"subtask",sourceCardId:"z-first",targetCardId:"a-second"},{id:"r3",kind:"subtask",sourceCardId:"parent",targetCardId:"finished"}], archivedCards: [], checklistItems: [], attachments: [], comments: [], commentCounts: {}, labels: [], cardLabels: [] };
}
test("completion counts the entire active family across columns, including historical depth", () => {
  const state = fixture(); expect(completionFamily(state,"parent").open.map(c=>c.id).sort()).toEqual(["a-second","z-first"]);
  const message = finishMessage(state,"parent","done","a1","family");
  expect(message.children.map(c=>c.id)).toEqual(["z-first","a-second"]);
  const next = applyMutation(state,message); expect(next.cards.every(c=>c.columnId==="done")).toBe(true);
  expect(next.cards.find(c=>c.id==="finished")).toBe(state.cards.find(c=>c.id==="finished"));
});
test("parent scope and reopening each leave child statuses alone", () => {
  const state=fixture(), message=finishMessage(state,"parent","done","a1","parent"); expect(message.children).toEqual([]);
  const next=applyMutation(state,message); expect(next.cards.slice(1)).toEqual(state.cards.slice(1));
  const reopened=applyMutation(next,{type:"card.move",mutationId:"reopen",id:"parent",columnId:"todo",position:"a0"}); expect(reopened.cards.slice(1)).toEqual(state.cards.slice(1));
});
test("family rollback restores placements while retaining unrelated peer edits", () => {
  const state = fixture();
  const message = finishMessage(state, "parent", "done", "a1", "family");
  const session = createBoardReconciler("board", state);
  session.sendOptimistic(message);
  session.applyServerMessage({ type: "card.update", mutationId: "peer", id: "z-first", title: "Peer edit" });
  const restored = session.rollback(message.mutationId).cacheState!;
  expect(restored.cards.map(c => [c.id, c.columnId, c.position])).toEqual(state.cards.map(c => [c.id, c.columnId, c.position]));
  expect(restored.cards.find(c => c.id === "z-first")?.title).toBe("Peer edit");
});
