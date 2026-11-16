# 0042 — Cross-platform interface icons with Lucide React

## Status
Accepted — 2026-09-09

## Context
Foxban originally rendered interface status indicators and actions using Unicode text glyphs and emojis (such as `📎`, `📄`, `☑`, `💬`, `⛔`, `🔗`, `🧩`, `📅`, `▶`, `≡`, `⤴`, `←`, `×`, `✓`, `⇈`, `↑`, `↓`, `⇊`, and `⋮⋮`). Because Unicode emojis and symbols are rendered by platform-specific font fallbacks (Apple Color Emoji on macOS/iOS, Segoe UI Emoji on Windows, Noto Color Emoji on Linux), the visual presentation, bounding box dimensions, alignment, and color differed significantly across operating systems.

The web package already included `lucide-react` for newer controls (modal close, fullscreen toggles, calendar icons, edit pencils). A consistent, uniform iconography was needed across all platforms.

## Decision
- Standardize all user-interface glyphs that function as icons onto `lucide-react`.
- Use tree-shakeable named imports (`import { AlignLeft, ... } from "lucide-react"`) exclusively; never wildcard or default import.
- Card priority metadata in `apps/web/src/lib/priority.ts` transitions from a string `glyph` property to a typed Lucide component reference `icon: LucideIcon`. The mapping is:
  - `highest`: `ChevronsUp` (red)
  - `high`: `ArrowUp` (orange)
  - `medium`: `Minus` (amber)
  - `low`: `ArrowDown` (green)
  - `lowest`: `ChevronsDown` (sky)
- Card-front badges in `CardView.tsx` use dedicated Lucide SVGs:
  - Description: `AlignLeft`
  - YouTube video: `Play`
  - Attachments: `Paperclip`
  - Checklist: `ListChecks`
  - Comments: `MessageSquare`
  - Relations: `Link` (or `Ban` when blocked)
  - Subtasks: `Workflow`
  - Due date: `CalendarDays`
- Action, navigation, and state glyphs across pickers and controls migrate to Lucide SVGs:
  - Selected state checks: `Check` (in `PriorityPicker`, `AssigneePicker`, `StatusPicker`, `ProfilePage` timezone picker, `BoardAddMemberDialog`, `BoardView` filters, and `CardModal` label picker)
  - Workspace navigation link: `ArrowLeft` preceding text `Boards`
  - Column move handle: `GripVertical`
  - Column delete: `X`
  - Checklist conversion: `ArrowUpRight`
  - Non-image attachment tile: `File`
  - Markdown toolbar link and image actions: `Link` and `Image`
- Accessibility contract: all Lucide SVGs are rendered as decorative icons with `aria-hidden="true"`. Surrounding containers, buttons, or links provide explicit semantic labels (`aria-label`, `title`, or visible text). Option and button accessible names remain text-only.
- Markdown syntax formatting labels (`B`, `I`, `H`, `•`, `1.`, `</>`) remain typographic text because they directly represent the syntax inserted by the actions rather than abstract pictograms.

## Consequences
- Interface icons render with identical geometry, stroke weight, and responsive alignment on macOS, Windows, and Linux.
- End-to-end tests assert observable user-facing semantics (`aria-label`, visible text, counts, data attributes) rather than platform-specific Unicode strings or SVG DOM structures.
