/** The card's due date on the wire is a timezone-free ISO `YYYY-MM-DD` day. */
export type DueState = "overdue" | "today" | "upcoming";

/** `YYYY-MM-DD` of a Date in the VIEWER'S local timezone (never toISOString — that is UTC). */
export function localISODate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Lexicographic compare is chronological for ISO dates. */
export function dueState(dueDate: string, today: string = localISODate()): DueState {
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  return "upcoming";
}

/** Parse `YYYY-MM-DD` as a LOCAL date. `new Date("2026-09-05")` is UTC midnight and
 * shifts a day in negative-offset timezones — always split instead. */
export function parseDueDate(dueDate: string): Date {
  const [y, m, d] = dueDate.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Badge text: "Sep 5", with the year only when it differs from the current one. */
export function formatDueDate(dueDate: string): string {
  const date = parseDueDate(dueDate);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString(undefined, opts);
}

export const DUE_STATE_META: Record<DueState, { className: string; prefix: string; label: string }> = {
  overdue: { className: "font-semibold text-destructive", prefix: "Overdue — was due", label: "Overdue" },
  today: { className: "font-semibold text-warning", prefix: "Due today —", label: "Today" },
  upcoming: { className: "", prefix: "Due", label: "" },
};
