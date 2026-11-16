# 0064 — One instance GitHub App, key-linked development info, webhooks

## Status
Accepted — 2026-11-13. Supersedes ADR 0041 (and the OAuth App half of 0024/0026). The per-board integration was removed by migration 0020; card fronts and the Development section read this model only.

## Context
Self-hosting foxban (ADR 0063) means making two GitHub apps by hand, an OAuth App for pictures and a GitHub App for repos, then connecting one repo per board. Issue #3 asked whether a per-board token would be simpler. Comparing with Jira's GitHub integration, the friction is the per-board model and the manual setup, not the App itself.

## Decision
- **One GitHub App per instance, created by a button.** An Admin presses "Create GitHub App"; GitHub's app-manifest flow returns its id, private key, webhook secret and client id/secret. The App serves pictures, sign-in (ADR 0065) and repos. The secrets are stored in D1, encrypted with a key the deploy script generates once as a Worker secret; a Worker cannot write its own secrets, and a Cloudflare API token would give it the whole account.
- **Repos belong to the instance.** An Admin installs the App and picks repos. Boards no longer own a repo: the four `boards.github_*` columns and the per-board connect flow go away. Any board member sees development info from any connected repo that mentions their task keys.
- **Linking by task key, then by PR id.** A task key in a branch name, PR title or PR body (case-insensitive, whole word, several keys allowed) links that PR or branch to the card's UUID the first time. After that the link follows the card through board-key edits and transfers, until someone unlinks it on the card. Manual linking stays for PRs that name no key. ADR 0037's "no key aliases" stands.
- **Webhooks, stored in the BoardDO.** GitHub pushes signed events to the Worker. Development info lives in the BoardDO: branches and PRs (repo, name or number, title, state, URL, updated time), plus each branch's latest commit. No full commit list. PR writes apply unless the stored `updated_at` is later than the event's (an equal one applies, since `updated_at` has one-second resolution and a same-second follow-up must win; a write that changes nothing is skipped). Branch events re-read the branch from GitHub, because they carry no timestamp. The 60-second poll goes away.
- **Realtime reuses the card-scope hint, so no protocol bump yet (ADR 0045).** An accepted development-info write broadcasts the existing `github.invalidated` card-scope frame (`revision: null`); the client already parses it and answers with a read of the card's development info. A frame older clients cannot parse would need `REALTIME_PROTOCOL_VERSION` to advance, and this one needs none. If a later ticket adds a frame that carries development data itself, bump then.
- **D1 routing tables, not card data.** `(repo id, PR number, board id)` and `(repo id, branch name, board id)` rows let a webhook for an already-linked PR or branch find its board, even after a board-key edit or a transfer. They hold no card content; the BoardDO maintains them on link, unlink, transfer and purge.
- **Backfill on connect:** open PRs, all branches, and PRs closed in the last 30 days that match a key.
- **Write-back:** create branch and create PR from a card, authored by `foxban[bot]` with "Opened by <name>" in the body. No stored user tokens. Automation such as "merged → Done" is out of scope.
- **Clean break:** existing per-board bindings and the env-configured App are dropped. Admins create the new App with the button.

## Consequences
Rejected: a per-board PAT (#3), because it cannot receive webhooks and the button removes the setup pain. Rejected: user OAuth tokens with `repo` scope, which give a self-hosted Worker too much trust. Rejected: keeping polling, which costs GitHub calls per viewer and cannot see PRs that never got a generated branch. Accepted: repo visibility is instance-wide rather than per board, D1 holds encrypted App secrets, and a PR that still names only an old key after a key edit stays unlinked until someone links it by hand.
