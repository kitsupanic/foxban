# 0041. GitHub App Board Integration

Date: 2026-09-08

## Status
Superseded by [0064](0064-instance-github-app-webhook-development-info.md) — 2026-11-13

## Context

Users requested the ability to link a GitHub repository to a board and perform developer actions directly from cards:
1. Create a task branch on the connected repository from a card.
2. Create a pull request against the default branch from a card.

Prior to this decision, the only GitHub integration in Foxban was user-level profile OAuth linking (`users.github_login`), used strictly for identity verification and avatar display.

## Decisions

### 1. Separation of Profile OAuth and Repository Authority
- **Profile OAuth remains identity-only**: `users.github_login` is not granted repository read/write permissions and is never used to perform code mutations.
- **GitHub App for repository operations**: We use a dedicated least-privilege GitHub App with repository-scoped installation tokens.
- **Permissions**: The GitHub App requests only `Contents: write` and `Pull requests: write`, with implicit `Metadata: read`.
- **No Webhooks**: Foxban reads status idempotently — branch and commit detail when a card is opened, and pull request status on a visible board's refresh cycle (see the section 6 amendment). No webhooks or persistent listeners are enabled, and no GitHub state is projected into durable storage.

### 2. One Repository Per Board in D1
- **D1 Columns**: Migration `0008_board_github_repo.sql` adds four nullable columns to `boards`:
  - `github_installation_id INTEGER`
  - `github_repository_id INTEGER`
  - `github_repository_owner TEXT`
  - `github_repository_name TEXT`
- **Atomic Association**: All four columns are written together on successful verified installation, or set to `NULL` together on disconnect.
- **Installation ID Server-Only**: `BoardRow` exposes only `{ id, owner, name, url }` under `githubRepository`. Installation IDs are kept internal to the API server.
- **Card State Untouched**: BoardDO SQLite and D1 card tables store no GitHub metadata; card development status is derived on demand from GitHub.

### 3. Verified Installation Flow
- GitHub's installation setup URL passes an `installation_id` that is untrusted / spoofable. Furthermore, if a GitHub App is already installed on an account/organization, visiting GitHub's `/apps/<slug>/installations/new` routes directly to installation settings rather than bouncing to Foxban's setup URL.
- To seamlessly support both already-installed Apps and fresh installations without manual URL construction or installation-spoofing risks:
  1. Authenticated session on Foxban.
  2. Board owner or configured account administrator privilege.
  3. Strict input normalization of `owner/repo` or GitHub URL.
  4. Ephemeral 10-minute state record in `github_connection_states` and matching `github_app_state` cookie.
  5. Authorize through the GitHub App OAuth web flow (`/login/oauth/authorize`).
  6. On OAuth callback, exchange code for user access token (`exchangeAppUserCode`) and retrieve the user's accessible installations via `GET /user/installations`.
  7. Candidate installation resolution:
     - If `installation_id` was supplied via setup (fresh install path), require that candidate installation to be present in `GET /user/installations`.
     - If not supplied, iterate through the authorizing user's installations, minting an installation token for each candidate to verify access to the requested repository (`GET /repos/{owner}/{repo}`).
  8. If no existing installation matches the requested repository, recreate the pending state and redirect into GitHub App installation (`/apps/<slug>/installations/new?state=...`), which continues through `/auth/github-app/setup` once the new installation is created.
  9. If a verified candidate matches, verify repository owner and name case-insensitively, and atomically bind the installation ID and canonical repository metadata to the board in D1.
### 4. Immutable Task-Key Branches and Pull Requests
- **Branch Naming**: Derived strictly as `<lowercase-board-key>-<task-number>` (e.g. `KR-42` becomes `kr-42`), independent of mutable card titles.
- **Current authority before writes**: After preparatory GitHub reads, branch and pull request creation recheck current board access, pending access changes, access version, repository binding and active card identity before writing. A completed revocation, disconnect or identity change refuses the request. This narrows the external-write race; D1 and GitHub do not share a transaction.
- **Pull Requests**:
  - Targets the repository's live `default_branch`.
  - Title: `<BOARD_KEY>-<TASK_NUMBER>: <card title>`.
  - Body: `Foxban: <APP_ORIGIN>/board/<BOARD_KEY>?card=<BOARD_KEY>-<TASK_NUMBER>`.
  - Non-draft.
  - If no commits exist on the branch, GitHub returns 422, mapped to 409 with an actionable prompt to push at least one commit.

### 5. WebCrypto RS256 Without Node APIs
- The Workers runtime has no Node crypto or fs APIs.
- Private key import and JWT generation are implemented using `crypto.subtle.importKey("pkcs8", ...)` and `crypto.subtle.sign("RSASSA-PKCS1-v1_5", ...)`.

### 6. Explicit Pull Request Associations and Polled Status (2026-09-11 amendment)

Card-front status and the ability to link a pull request that did not come from a card's generated branch. This amends only *what* is stored and *when* it is read; section 1's installation authority, section 3's verified installation flow and section 4's branch/pull-request semantics are unchanged.

- **One association per card, owned by the BoardDO.** Migration v20 adds `card_github_pull_requests(card_id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL, pull_number INTEGER NOT NULL, revision TEXT NOT NULL)` to board SQLite. `revision` is a compare-and-set token minted on every real write, so a replacement prepared against a stale revision is refused (`pr_link_conflict`) instead of silently overwriting a peer's newer choice. No pull request state, title, body, head, cache projection or token is stored anywhere durable; the summary read is the only source of displayed state.
- **Validation before commit, never a user-supplied fetch.** The accepted forms are a decimal number with an optional `#`, or an `https://github.com/<owner>/<repo>/pull/<number>` URL (query and fragment ignored). Each candidate is read through the board's existing installation token and must report a `base.repo.id` equal to the board's connected repository id. Fork heads and non-default bases are accepted; a URL naming another repository is refused locally. The client never fetches GitHub itself.
- **Explicit beats discovery only for the matching repository.** A card with an association whose `repository_id` equals the connected repository resolves by pull request number. An association naming a different repository stays stored but dormant: the card falls back to generated-branch discovery for the currently connected repository, and Development says the link belongs to another repository. Reconnecting the same repository reactivates it.
- **Association ownership follows the card.** Archive retains the row and rejects writes; restore resumes reads; cross-board transfer carries it in the transfer bundle and re-mints its revision at the destination; permanent purge deletes it with the card aggregate. A transfer is never blocked by an association.
- **Status is polled, not pushed.** Visible boards run one board-owned refresh cycle every 60 seconds (and after a stale focus/visibility restoration), split into sequential batches of at most twenty cards, one installation token per batch, at most four concurrent GitHub calls, deduplicating identical lookups inside a batch. Explicit links read `GET /repos/{owner}/{repo}/pulls/{number}`; every other card keeps the newest-created exact-head `state=all` discovery. State maps `merged_at` over `state: closed`, and a draft stays open. Failed reads are reported as failures with the last known state retained for the same card, task number, repository and revision — never as "no pull request", never by falling back to another pull request. No webhooks, and no persistent GitHub projection.
- **Peer changes arrive as invalidation hints.** The realtime protocol (version 2) adds server-only `github.invalidated` frames for card and repository scope. A frame cancels the running status cycle and marks the caches stale; the next authoritative read installs the truth, and an accepted link change is visible to connected peers without a reload. Writes never seed their own HTTP response into the displayed state, and a reconnect snapshot invalidates the same caches as a missed-event backstop.

## Consequences

- Each board can be connected to at most one repository by the board owner or admin.
- All board members can create task branches and pull requests using the installation's authority, and can link or replace one existing pull request per card.
- External commits, branch deletion, or pull request state changes reach the board through the polled status read: card fronts update within a minute on a visible board, the card modal's own branch/commit detail still refreshes when the card is opened, and a connected peer is told to re-read the moment a link changes.
- One installation token per batch of up to twenty cards is the polling cost per full refresh per viewer: proportional to rendered cards, not to repository history. Rate limits are honored with an honest stale display rather than a silent cap.
