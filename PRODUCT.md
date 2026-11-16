# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Any small team (software or not) that runs its own foxban instance on its own Cloudflare account. Access is invite-only; Admins (emails in the instance's admin list) create invites. GitHub development info is an optional extra, not the center of the product.

## Product Purpose

A free, real-time Kanban board you run yourself. When a teammate moves a card, everyone on the board sees it move right away. Success: a small team runs its work on it on the free Cloudflare plan, with no setup beyond a deploy.

## Positioning

Self-hosted on the team's own Cloudflare account, free at small-team scale, and live by default: every change syncs instantly through one Durable Object per board. Idle boards hibernate, so cost stays near zero.

## Operating Context

- Boards with columns and cards; cards are dragged between columns.
- Cards carry a task key (`KEY-42`), type, priority, description (markdown), images, checklists, due dates, comments, relations and assignees.
- A member rail shows live presence, last seen and local time per member.
- Optional: an instance GitHub App links branches and pull requests to cards by task key, and can create them from a card.
- Responsive web; no native mobile apps.

## Capabilities and Constraints

- Server is the source of truth; no offline mode, no local board data.
- Column create/rename/reorder/delete is owner/admin-only; members manage cards.
- Non-goals: multi-tenant orgs, billing, public signup, extra roles, SSR/SEO/analytics.
- Terms: Instance, Admin, Task key, GitHub App, Connected repo, Development info (see `GLOSSARY.md`).

## Brand Commitments

- Name: foxban (lower-case). The cartoon fox is the brand mark and app icon.
- Voice (binding, UI included): plain, short, friendly words a young reader understands. Short sentences, no jargon.

## Evidence on Hand

- `docs/images/banner.webp`, `docs/images/screenshot.webp`, fox app icon.
- No testimonials, customer logos or usage numbers exist; do not invent them.

## Product Principles

1. Live first: every change shows up for everyone right away.
2. Simple over powerful: small-team needs, no enterprise features.
3. Cheap to run: nothing that breaks the free-plan cost model.
4. Plain words: if a child can't read the label, rewrite it.

## Accessibility & Inclusion

Best effort; no formal standard. Keep existing keyboard and focus support working.
