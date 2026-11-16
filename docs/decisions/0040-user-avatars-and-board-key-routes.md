# 0040. User-Uploaded Profile Avatars and Human Board-Key Public Routes

Date: 2026-09-08

## Context

Two architectural evolutions were required to improve user experience and identity:
1. **User-Uploaded Profile Avatars**: Previously, user avatars were derived exclusively from verified GitHub OAuth accounts or local initials. Users without GitHub accounts or desiring custom profile pictures had no mechanism to upload avatars.
2. **Human-Readable Board URLs**: Previously, public board navigation routes used internal UUIDs (`/board/$boardId`), while cards within boards already used human-readable task keys (`?card=<BOARD_KEY>-<TASK_NUMBER>`). This created inconsistent URLs and exposed raw storage UUIDs in browser history.

## Decisions

### 1. User-Uploaded Avatar Storage and Lifecycle
- **D1 Metadata**: Added `users.avatar_version TEXT` to D1 via migration `0007_user_avatar.sql`. When set, it holds a random UUID string representing the active avatar version.
- **R2 Storage Key Pattern**: Avatar objects are stored in the existing attachments R2 bucket under the deterministic path `avatars/<userId>/<avatarVersion>`. No arbitrary paths or extensions are persisted in D1.
- **Atomic CAS and Rollback**: Uploads (`POST /me/avatar`) write R2 bytes with canonical MIME headers first, then perform compare-and-set updates in D1 against the prior version. If the D1 CAS fails, the newly uploaded R2 object is immediately deleted and a 409 or 500 error returned. Once committed to D1, deletion of the prior avatar version object in R2 is best-effort with fallback to the scheduled reconciliation sweep; prior key deletion failure never invalidates or rolls back the committed avatar. On `DELETE /me/avatar`, CAS concurrency returns the authoritative current user row, clearing only the matching prior version.
- **Authentication & Serving**: `GET /users/:userId/avatar/:version` requires an authenticated session and serves the image with `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, and ETag caching. Stale versions or mismatched user versions return 404.
- **Garbage Collection**: The scheduled R2 attachment reconciliation (`reconcileAttachmentObjects`) inspects `avatars/*` keys, cross-references active `(id, avatar_version)` rows from D1, and purges orphaned or replaced avatar objects without impacting BoardDO attachment operations.
- **Client Fallback Precedence**: The shared `Avatar` component evaluates:
  1. Uploaded avatar (`/users/<userId>/avatar/<avatarVersion>`)
  2. Verified GitHub avatar (`https://github.com/<githubLogin>.png?size=48`)
  3. Initials fallback circle

### 2. Human Board-Key Public Routes and Clean Cutover
- **Public URL Structure**: Board navigation now uses `/board/$boardKey`.
- **API Resolution**: Added `GET /boards/by-key/:key`, protected by authentication and member access checks. Unauthorized requests or non-existent keys return 403 to prevent key enumeration.
- **Route Shell Decoupling**: The TanStack Router route `/board/$boardKey` resolves the human board key to board metadata via `GET /boards/by-key/:key`, renders loading/error/forbidden states, and then mounts `BoardView` with the internal UUID (`boardId`) and resolved metadata.
- **Internal Identity Unchanged**: WebSockets, D1 tables, BoardDO SQLite storage, and cache keys (`["board", boardId]`) remain strictly keyed by UUID.
- **Clean Cutover**: Legacy UUID public routes are completely removed with no dual routing or UUID redirects. Editing a board key intentionally invalidates old bookmarked URLs, consistent with ADR 0037.

## Consequences

- Users can upload PNG, JPEG, GIF, or WebP profile pictures up to 10 MB, resized client-side to WebP 512px at quality 0.8.
- Board URLs match Jira-style readable patterns (`/board/EX?card=EX-1`), eliminating UUID leak in URLs while preserving strong internal UUID referential integrity.
