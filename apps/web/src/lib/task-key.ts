import type { Card } from "@foxban/shared";

/**
 * Formats a Jira-style board task key: `${boardKey}-${taskNumber}`.
 */
export function taskKey(boardKey: string, taskNumber: number): string {
  return `${boardKey}-${taskNumber}`;
}

/**
 * Matches an active card by its canonical task key: `${boardKey}-${card.taskNumber}`.
 * Matches only cards with a positive task number whose exact canonical key matches `value`.
 * Rejects UUIDs, lowercase keys, zero, signs, leading-zero variants, or mismatched board keys.
 */
export function cardForTaskKey(
  cards: readonly Card[],
  boardKey: string,
  value: string,
): Card | undefined {
  if (!value || !boardKey) return undefined;
  return cards.find(
    (card) =>
      card.taskNumber > 0 &&
      taskKey(boardKey, card.taskNumber) === value,
  );
}
/**
 * Searches cards for linking relation candidates.
 * Input can be exact case-insensitive `<BOARD_KEY>-<positive integer>` or exact positive integer,
 * matching that board-local `taskNumber`. Rejects signs, decimals, zero, and leading-zero variants.
 * An exact identifier match sorts first; remaining case-insensitive title-substring matches
 * retain their current order; excludes the open card and caps the final result at eight.
 */
export function relationCardMatches<T extends { id: string; taskNumber: number; title: string }>(
  cards: readonly T[],
  currentCardId: string,
  boardKey: string,
  input: string,
): T[] {
  const trimmed = input.trim();
  const eligible = cards.filter((c) => c.id !== currentCardId);
  if (!trimmed) {
    return eligible.slice(0, 8);
  }

  let matchedByIdentifier: T | undefined;

  const normalizedBoardKey = boardKey.toUpperCase();
  const upperInput = trimmed.toUpperCase();

  const positiveIntRe = /^[1-9]\d*$/;

  if (positiveIntRe.test(trimmed)) {
    const num = Number.parseInt(trimmed, 10);
    matchedByIdentifier = eligible.find((c) => c.taskNumber === num);
  } else if (upperInput.startsWith(`${normalizedBoardKey}-`)) {
    const suffix = upperInput.slice(normalizedBoardKey.length + 1);
    if (positiveIntRe.test(suffix)) {
      const num = Number.parseInt(suffix, 10);
      matchedByIdentifier = eligible.find((c) => c.taskNumber === num);
    }
  }

  const queryLower = trimmed.toLowerCase();
  const titleMatches = eligible.filter(
    (c) => c.id !== matchedByIdentifier?.id && c.title.toLowerCase().includes(queryLower),
  );

  const results: T[] = [];
  if (matchedByIdentifier) {
    results.push(matchedByIdentifier);
  }
  for (const c of titleMatches) {
    if (results.length >= 8) break;
    results.push(c);
  }

  return results;
}
