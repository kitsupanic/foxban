# 0013 — Markdown card descriptions, rendered client-side

## Status
Accepted — 2026-09-01

UI wording clarified 2026-10-20: Preview names the existing uncommitted-view action; Save title & description names its unchanged persistence boundary.

## Context
M8 wanted Trello-style rich text in the card description, which was a bare
textarea. The choice: a WYSIWYG editor storing HTML (Tiptap) versus storing
Markdown and rendering it on read.

## Decision
- A description stays a plain string in the existing `description` field. No
  protocol, API or DO change — the Markdown is a client-side interpretation of
  data already stored.
- Rendered with `react-markdown` + `remark-gfm`; `@tailwindcss/typography`
  supplies the `prose` styles, loaded via `@plugin` in `index.css` (Tailwind v4
  takes plugins from CSS — no `tailwind.config` file).
- Two security invariants, asserted by `e2e/description.spec.ts`: no
  `rehype-raw`, so raw HTML renders as literal text and never as elements; and
  the default `urlTransform` is left in place, so `javascript:` hrefs are
  stripped to empty.
- View/edit split rather than live WYSIWYG: the rendered body is a click target
  that swaps in a textarea plus toolbar. Toolbar actions are plain inserts with
  no toggle-off. `Preview` returns to the rendered view as an uncommitted preview —
  the description stays Save-committed (ADR 0007/0010 draft split unchanged).

## Consequences
Descriptions remain portable text: greppable, diffable, readable by a client
that has not shipped the renderer. Rejected: Tiptap/WYSIWYG — stores HTML,
makes sanitisation a persistence concern, costs a far larger bundle, and forces
a data migration for a two-user board. Out of scope: description search, image
upload, @-mentions.
