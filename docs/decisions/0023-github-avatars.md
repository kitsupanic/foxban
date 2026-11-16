# 0023 — GitHub avatars from a claimed username

## Status
Superseded by 0024 — 2026-09-02

## Context
M23 wants real faces instead of initials circles. The only identity foxban stores is the email/password row from ADR 0011, gated by the invites of ADR 0012, and ADR 0008 already rejected third-party identity providers. So the question is narrow: where does an avatar image come from, given that the user table is the whole of the profile.

## Decision
- One nullable column, `users.github_login` (migration 0003), unverified: it is a key for an image URL, not a credential, and nothing else in the product reads it. A user claims one, or has none.
- Avatars are hotlinked from `https://github.com/<login>.png?size=48`, GitHub's documented avatar redirect. No proxying, no caching layer, no stored bytes.
- The initials circle is a permanent fallback, not a loading placeholder: it renders when the username is unset *and* when the image fails (unknown login, offline, GitHub down). The shared `Avatar` component owns both branches and is always `aria-hidden`, so every surface's accessible name stays the text beside it.
- `PATCH /me` is the first mutation of a users row, validating against GitHub's own join rule (`/^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/`); an explicit `null` clears the field. Its response mirrors `GET /me` so the client writes the `me` cache directly — that query is `staleTime: "static"` and never refetches.
- The control lives in the Boards-page header, beside the email. There is no settings route, and inventing one for a single field would be the larger change.

## Consequences
Rejected: GitHub OAuth — it would reopen ADR 0008 for a decoration, and buys nothing an unverified string does not. Rejected: uploaded avatars in R2 — storage plus a crop UI for a two-person board. Rejected: proxying the image through the Worker — there is no CSP to satisfy, so it would add egress and cache work for no gain. The costs accepted instead: GitHub sees a request per avatar render (the browser caches it), a username typo shows initials rather than an error, and a user who renames their GitHub account silently falls back until they update the field.
