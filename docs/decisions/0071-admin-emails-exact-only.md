# 0071 — `ADMIN_EMAILS` takes exact addresses only

## Status
Accepted — 2026-11-18. Amends ADR 0012.

## Context
Admin is derived from an account's email (ADR 0012), and nobody verifies an email at signup. A `*@domain` entry in `ADMIN_EMAILS` therefore let any stranger sign up as an admin by typing an address on that domain: signup skips the invite for an admin address, and an admin reads every board as an Operator (ADR 0033) and makes invites.

## Decision
- `ADMIN_EMAILS` is a comma-separated list of exact addresses, compared case-insensitively. An entry that starts with `*@` is skipped: it never matches. One function, `adminEmails` in `apps/api/src/auth.ts`, reads the list for `isAdminEmail` and for the operator SQL in `access-changes.ts`, so the two cannot disagree.
- A listed address may still sign up without an invite, as before. A list with no usable entry (empty, or wildcards only) answers a no-invite signup with `ADMIN_NOT_CONFIGURED`.
- Signing up with GitHub still never makes an Admin (ADR 0065). If the account's no-reply address is itself listed, the signup is refused.
- The operator SQL binds the list as one JSON array (`json_each`), not one bound parameter per entry, so a long list cannot reach the D1 limit.

## Consequences
An address on the list that nobody has registered can be claimed by whoever signs up with it first. The README tells the deployer to sign up with their admin address right after deploying.

An instance that relied on a wildcard stops having admins from it on the next deploy: its admins list their addresses. Existing accounts on that domain keep their data and lose only the Admin power.

Tests no longer get admin from a domain. The API suite lists each `@foxban.test` address as it signs up (`apps/api/test/admin-signups.ts`); the config keeps a `*@wild.test` entry to prove a wildcard is ignored.
