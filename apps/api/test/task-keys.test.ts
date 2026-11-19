import { describe, expect, it } from "vitest";
import { MAX_TASK_KEYS, extractTaskKeys } from "../src/task-keys";

const keys = (...texts: Array<string | null | undefined>) => extractTaskKeys(texts).map(({ boardKey, taskNumber }) => `${boardKey}-${taskNumber}`);

describe("extractTaskKeys", () => {
  it.each([
    ["finds a key", "fix ABC-12 now", ["ABC-12"]],
    ["does not match ABC-1 inside ABC-12", "ABC-12", ["ABC-12"]],
    ["does not read a longer number as a shorter task", "ABC-123x", []],
    ["names the longer board for XABC-1, not ABC", "XABC-1", ["XABC-1"]],
    ["rejects a leading zero", "ABC-01", []],
    ["rejects a ten-digit number", "ABC-1234567890", []],
    ["accepts a nine-digit number", "ABC-123456789", ["ABC-123456789"]],
    ["reads branch-style names, case-insensitively", "fix/kr-42_login", ["KR-42"]],
    ["lists each key once, in order of first appearance", "B2-1 and A1-2 and b2-1", ["B2-1", "A1-2"]],
  ])("%s", (_name, text, expected) => {
    expect(keys(text)).toEqual(expected);
  });

  it("skips null and undefined texts and reads every text given", () => {
    expect(keys(null, undefined, "AB-1", "CD-2")).toEqual(["AB-1", "CD-2"]);
  });

  it("caps the keys at MAX_TASK_KEYS", () => {
    const text = Array.from({ length: 30 }, (_, index) => `AB-${index + 1}`).join(" ");
    expect(MAX_TASK_KEYS).toBe(20);
    expect(keys(text)).toEqual(Array.from({ length: 20 }, (_, index) => `AB-${index + 1}`));
  });
});
