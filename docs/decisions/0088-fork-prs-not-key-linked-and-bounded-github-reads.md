# 0088 — Fork PRs are not linked by task key; GitHub reads and the nightly sweep stay bounded

## Status
Accepted — 2026-11-25; amends 0064.

## Context
0064 links a connected repo's pull request to every card its branch, title or body names by task key. On a public connected repo anyone can open a PR from a fork, with a title of their choosing, so a stranger's "FOX-1 FOX-2 ..." put a link with attacker-chosen text on cards of private boards. Three smaller faults sat beside it: the Admin re-read stopped after 10 pages of installations and 50 of repos and then dropped every connected repo it had not seen; an `installation_repositories` "added" that arrived after its "removed" connected the repo again; and the nightly attachment sweep made unbounded subrequests, so past about 1000 it threw and began again from the first object the next night, and later boards were never swept.

## Decision
- A `pull_request` event or a backfill list item matches task keys only when its `head.repo.id` equals the connected repo's id. A fork's PR, or one whose head repo is gone (`head.repo` null), links no card by key. A PR already in `github_pr_routes` still updates on every event, whatever its head repo says, and a manual link (0064) still works for a fork PR: the manual link writes the route, which is how later events find it.
- `listAppInstallations` and `listInstallationRepositories` return `{ installations | repos, truncated }`; `truncated` is true when the page cap was reached with a full last page. `refreshConnectedRepos` still connects what it saw but skips both `DELETE`s when either list was truncated.
- Before an `installation_repositories` "added" connects repos, the Worker mints an installation token scoped to those repo ids (`repository_ids`). A 404 or 422 means the installation cannot reach them now (a later "removed" is already applied, or the list is too long to check), so it re-reads the install with `refreshConnectedRepos` instead of connecting.
- The nightly `reconcileAttachmentObjects` counts subrequests the way `drainBackfill` does (the same exported `OPS_CEILING`, 900) and stops before the ceiling, mid-page if need be. It saves the last R2 key it handled in `maintenance_state` (migration 0030, a key and a value) under `attachment_reconcile_after`; the next run lists with `startAfter` that key. A run that reaches the end of the bucket deletes the row.

## Consequences
A fork's contributor no longer gets their PR on a card by naming its key; a maintainer links it by number. Where the same org's own branches open PRs, nothing changes. A repo past the page caps keeps rows GitHub may no longer list until a complete read succeeds. A stale "added" costs one extra GitHub call and, when it is stale, one re-read. Links a fork PR got by key before this change keep their route and keep updating; nothing removes them, so an admin unlinks any unwanted one by hand. A large bucket is swept over several nights instead of never; an object added before the saved key waits for the next full pass.

Rejected: matching a fork PR when its author is a known collaborator (an extra GitHub call per event for a case the manual link covers).
