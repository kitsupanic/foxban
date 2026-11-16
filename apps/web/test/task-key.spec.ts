import { expect, test } from "@playwright/test";
import type { Card } from "@foxban/shared";
import { cardForTaskKey, taskKey } from "../src/lib/task-key";

function makeCard(id: string, taskNumber: number): Card {
  return {
    id,
    columnId: "col-1",
    title: `Card ${id}`,
    description: "",
    position: "a0",
    taskNumber,
    assigneeId: null,
    priority: "medium",
    taskType: "task",
    dueDate: null,
    subtaskDone: false,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

test.describe("taskKey formatting and cardForTaskKey resolution", () => {
  test("formats board key and task number canonically as <BOARD_KEY>-<TASK_NUMBER>", () => {
    expect(taskKey("FB5", 9)).toBe("FB5-9");
    expect(taskKey("GAME", 1)).toBe("GAME-1");
  });

  test("resolves positive taskNumber matching exact canonical key", () => {
    const card1 = makeCard("card-1", 1);
    const card2 = makeCard("card-2", 2);
    const cards = [card1, card2];

    expect(cardForTaskKey(cards, "FB5", "FB5-1")).toBe(card1);
    expect(cardForTaskKey(cards, "FB5", "FB5-2")).toBe(card2);
  });

  test("rejects UUIDs, lowercase keys, zero, negative, leading zeros, and mismatched board keys", () => {
    const card0 = makeCard("00000000-0000-0000-0000-000000000001", 0);
    const card1 = makeCard("11111111-1111-1111-1111-111111111111", 1);
    const cards = [card0, card1];

    // Rejects UUID lookup
    expect(cardForTaskKey(cards, "FB5", card1.id)).toBeUndefined();

    // Rejects lowercase key
    expect(cardForTaskKey(cards, "FB5", "fb5-1")).toBeUndefined();

    // Rejects sentinel taskNumber 0
    expect(cardForTaskKey(cards, "FB5", "FB5-0")).toBeUndefined();

    // Rejects leading zeros and signs
    expect(cardForTaskKey(cards, "FB5", "FB5-01")).toBeUndefined();
    expect(cardForTaskKey(cards, "FB5", "FB5-+1")).toBeUndefined();

    // Rejects wrong board key
    expect(cardForTaskKey(cards, "OTHER", "FB5-1")).toBeUndefined();
    expect(cardForTaskKey(cards, "FB5", "OTHER-1")).toBeUndefined();

    // Rejects empty/missing inputs
    expect(cardForTaskKey(cards, "", "FB5-1")).toBeUndefined();
    expect(cardForTaskKey(cards, "FB5", "")).toBeUndefined();
  });
});
