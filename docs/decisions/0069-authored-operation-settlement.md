# 0069 — One settlement module for authored operations

## Status
Accepted — 2026-11-16.

## Context
ADRs 0060 and 0062 made authored operations acceptance-aware: a draft survives until the server echo or snapshot confirms it. Each editor implemented that by hand. CardModal had 11 copies and BoardView 2, each with its own pending, generation and unsubscribe refs on top of `useBoardSocket`'s `sendMutation` / `subscribeMutation` / `retireTrackedMutation`. The copies drifted: eight `send() === false` paths never retired their subscription, BoardView's finish never retired on unmount, and the comment, reply and save retries ignored discarded drafts. None of it was testable outside Playwright.

## Decision
Authored operations go through one module, `apps/web/src/lib/authored-operation.ts`: a React-free core with a thin hook, sitting on top of `useBoardSocket`'s current interface (`socket.ts` is unchanged).

- One operation owns one lineage: it mints a mutationId per attempt and subscribes before sending. Every attempt stays live until the lineage ends, so a late echo of an unverified or retried attempt still settles it; the lineage retires all its ids when it is accepted, discarded, replaced by a new start, or unmounted. A rejected or unsent attempt is retired at once. Starting an operation that is already pending or uncertain is ignored.
- The caller passes a builder `(mutationId) => ClientMessage | null`, run on every attempt including retry; entity ids are chosen by the caller once per lineage. `null` settles without sending.
- State is `idle | pending | uncertain | failed | settled`. `failed` carries one reason: `rejected` (server text preferred), `unverified` (verified-retry), `not-connected`, or `accepted-gone` (an optional `confirm(liveBoardState)` returned false). Callers map reasons to their existing copy.
- A failed lineage always keeps `retry()`; callers choose whether to show it. `onAccepted(sent)` gets the attempt's snapshot so the caller decides whether the draft is unchanged.
- A scope (one per CardModal, one per BoardView) creates operations, answers `hasActiveWork()`, and retires everything on unmount.

The core is tested service-free in `apps/web/test/authored-operation.spec.ts` with an in-process fake socket (ADR 0049); existing e2e specs guard each migration. User-visible copy and UI do not change, with these deliberate exceptions: every attempt is retired (no leaks on `send() === false` or unmount), retries honour discards, a late acceptance of an earlier attempt settles the lineage in every flow (each caller's `onAccepted` checks the draft is unchanged before clearing or closing it), and a retry that cannot send shows "Not connected — try again." in the recovery strip instead of a second line. A creation dialog closes on a late acceptance even if its fields were edited since, because the entity now exists with the submitted values.

Rejected: a promise-based `await send()` (settlement has non-terminal states: uncertain, then verified-retry, which a promise cannot express without a second channel); moving settlement into `socket.ts` (deferred until every caller has migrated, then reconsider whether `subscribeMutation` / `retireTrackedMutation` stay public); keeping per-flow settlement.

## Consequences
Settlement rules live in one place and are testable without a browser, and CardModal sections can later be split out, each holding only its operations. The upload flow has since moved too (`apps/web/src/lib/attachments.ts`): after the POST, `attachment.create` is one operation whose `onAccepted` resolves the upload's promise and whose `failed` state rejects it. A timeout therefore no longer fails an upload at once; it waits for the reconnect snapshot, and a late acceptance still inserts the image. Because the operation stays subscribed while uncertain, an upload timeout now closes the socket (4000) like every authored timeout; the old hand-rolled flow unsubscribed first and left it open. That close is what brings the snapshot that settles the upload. If the socket halts instead (access denied, or the reconnect budget runs out), open uploads fail with the old "Could not confirm the upload — try again.", so Save is never left disabled; a discarded or disposed-scope upload rejects too. Each upload is a one-shot operation that `scope.release(op)` forgets once it ends. Still open: a timeout on any subscribed mutation (upload, finish, creation included) still forces a reconnect, despite the comment at `socket.ts:216`. That is a separate decision.
