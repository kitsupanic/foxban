# 0043. One-level comment reply threads and tombstone lifecycle

Date: 2026-09-09

## Status

Accepted

## Context

Foxban allows card members to post, edit, and delete comments on cards. Comments are stored as protocol entities owned by `BoardDO` and rendered in the CardModal Activity timeline. As conversations grow on cards, members need to reply to specific points without losing context. Deeply nested comment trees add substantial layout complexity, visual crowding, and recursive data structures. Furthermore, deleting a comment at the root of an ongoing discussion can orphan or delete active replies.

## Decision

1. **One-level thread depth**:
   - Reply depth is strictly capped at one level. Top-level comments have `parentCommentId: null`; replies have `parentCommentId: <root-comment-id>`.
   - Replying to an existing reply flattens client-side: the reply inherits the root comment's identifier as its `parentCommentId`, never the reply's id.
   - `BoardDO` validates `comment.create` on non-null parent targets transactionally: the parent row must exist on the matching `cardId` and must have `parent_comment_id IS NULL`. Any violation is rejected with `"Reply target is unavailable."`.

2. **Tombstone and pruning lifecycle**:
   - When deleting a root comment that has one or more replies, the root is not physically deleted. Instead, it is tombstoned: `body = ''` and `deleted = 1` (`deleted: true` on the wire).
   - Tombstoned roots cannot be edited via `comment.update` (enforced with `WHERE deleted = 0`). They render in the client as a neutral italicized `"Comment deleted"` placeholder without author metadata, timestamps, Markdown content, edit/delete buttons, or a reply trigger.
   - Deleting a reply physically removes the row (`DELETE FROM comments`).
   - If a deleted reply belonged to a tombstoned root, and no remaining replies exist for that root, the tombstoned root is automatically pruned (`DELETE FROM comments`).
   - Deleting a root comment with zero replies immediately physically deletes the root.

3. **Active count and badge projections**:
   - Tab counts (`Comments · N`, `All · N`) and card-front comment badges project only active comments (`deleted === false`).
   - Tombstoned comments are retained purely to keep surviving reply threads anchored in the timeline.

4. **Timeline ordering**:
   - Top-level timeline items (root comments, activities, commits) are sorted by creation date and obey the Activity sort toggle (`Oldest first` vs `Newest first`).
   - Replies beneath a root comment remain strictly ordered in chronological order (`createdAt`, tie-broken by `id`) regardless of the top-level sort toggle, preserving conversational coherence.

## Consequences

- The schema migration (v14) adds nullable `parent_comment_id TEXT` and `deleted INTEGER NOT NULL DEFAULT 0` to `comments`.
- Client and server state transitions remain strictly symmetrical across BoardDO SQL, snapshot queries, transfer import/export bundles, and the web optimistic reducer / rollback handlers.
- Thread navigation and reply composition stay clean and legible across mobile and desktop without unbounded horizontal indentation.
