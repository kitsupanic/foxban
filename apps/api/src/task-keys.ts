export type TaskKeyMention = { boardKey: string; taskNumber: number };

/**
 * A board key (2-10 letters or digits, starting with a letter), a hyphen and a task
 * number, not touching other letters or digits. So `kr-42-fix` and `fix/KR-42_login`
 * name KR-42, while `KR-420`, `KR-42x` and `XKR-42` do not (the last names board XKR).
 * A leading zero is not a task number.
 */
const TASK_KEY = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})(?![A-Za-z0-9])/g;

/** More keys than this in one pull request are ignored, so one text cannot link a card on every board. */
export const MAX_TASK_KEYS = 20;

/** The distinct task keys the texts name, uppercased, in order of first appearance, at most `MAX_TASK_KEYS`. */
export function extractTaskKeys(texts: ReadonlyArray<string | null | undefined>): TaskKeyMention[] {
  const found = new Map<string, TaskKeyMention>();
  for (const text of texts) {
    for (const [, boardKey, number] of text?.matchAll(TASK_KEY) ?? []) {
      const key = `${boardKey!.toUpperCase()}-${number}`;
      if (!found.has(key) && found.size < MAX_TASK_KEYS) found.set(key, { boardKey: boardKey!.toUpperCase(), taskNumber: Number(number) });
    }
  }
  return [...found.values()];
}
