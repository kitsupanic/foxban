# 0017 — Card due dates as an optional date-only string, set by its own mutation

## Status
Accepted — 2026-09-01

## Context
M12 wanted deadlines on cards. The user chose a date only (no time of day) and,
unlike priority, an optional and clearable field — the Assignee shape rather
than the Jira always-set one. The card front is to colour the deadline red once
it has passed and amber on the day itself.

## Decision
- The wire field is `dueDate: string | null`, an ISO `YYYY-MM-DD` day validated
  by `z.iso.date().nullable()` — not epoch milliseconds. A bare day is
  timezone-free (the deadline "2026-09-05" is the same day for every member), it
  is byte-identical to a native `<input type="date">` value so nothing is parsed
  in either direction, and lexicographic string order is chronological, so
  overdue/today are string compares.
- Storage is a nullable `due_date TEXT` column in the DO's `cards` table (schema
  v6). No DEFAULT: existing rows and every `card.create` take SQL NULL, which is
  exactly the "no deadline" the optimistic client reducer seeds.
- Setting it is its own mutation, `card.schedule`, per the `card.assign`
  precedent: `card.update` COALESCEs absent fields, so a null there could never
  mean "clear the deadline". Concurrent sets are last-write-wins by mutation
  order (ADR 0007).
- The input is the browser's native `<input type="date">` with a `×` button
  beside it, adding no datepicker dependency. Urgency (`overdue` / `today` /
  `upcoming`) is computed in each viewer's local timezone by comparing the day
  string against the viewer's own local `YYYY-MM-DD`.

## Consequences
Most cards have no deadline, so the 📅 badge is conditional — unlike the
priority glyph. Urgency being viewer-local means that near midnight two members
in different timezones may briefly see different colours for the same card;
that is the chosen behaviour, since "overdue" is a statement about the viewer's
day. Existing boards gain the nullable column when their DO runs the v6 batch on
first access after deploy. During a rolling deploy an old-bundle tab receiving a
`card.schedule` broadcast fails its `ServerMessageSchema` parse and
reconnect-loops until refreshed (the M9–M11 window); the new snapshot key is
stripped harmlessly by the old non-strict `CardSchema`. Ordering stays manual
fractional-index — no sorting, filtering or notifications by due date. Rejected:
an epoch-ms datetime (the user chose date-only, and milliseconds invite
cross-timezone day-shift bugs), and the due date as a `card.update` field.
