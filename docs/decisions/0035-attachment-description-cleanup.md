# 0035 — Attachment deletion cleans its owner's description

## Status
Accepted — 2026-09-05

## Context
Deleting an attachment removed its metadata and R2 object but left the Markdown embed in the owning card's description, so every member kept a permanently broken image or link. Descriptions are a Save-committed draft (ADR 0020), so the removal has to reach saved text, peers, and open drafts without discarding unsaved prose.

## Decision
- One shared `removeAttachmentReferences(markdown, boardId, attachmentId)` parses with the existing `mdast`/GFM stack and splices the original source by node offsets: matching images and definitions go, matching links keep their original label, and every other byte — code, escapes, literal HTML, CRLF — is preserved. Matching is exact destination equality, never filename or substring.
- The BoardDO applies that cleanup to the owning active card inside the existing `attachment.delete` transaction, stamping `updated_at` only when the description changes. The wire shape and verbatim broadcast are unchanged, and one `attachment.deleted` history entry still covers the whole change.
- Trusted board identity comes from the hibernating socket attachment. A pre-upgrade socket without it is told to reconnect (code 1012) rather than deleting metadata while leaving the reference behind.
- Open drafts are stripped only on **server-accepted** deletion — an own echo, a peer broadcast, or a reconnect snapshot that proves the attachment is gone. An accepted deletion also permanently retires any own pending deletion of the same attachment, so a later rejection or timeout cannot resurrect it. While the outcome is unknown, Save is gated for that card.

## Consequences
A deleted attachment leaves no broken embed anywhere, unsaved prose and titles survive the cleanup, and rejected or timed-out deletions restore both the row and its reference. Single-pass source preservation is deliberate: when deletion joins previously literal delimiters into new syntax, the original bytes win over universal idempotence. Rejected alternatives are regex or stringify-based rewriting, a second `card.update` mutation, stripping drafts on optimistic send, and backfilling historically deleted attachments whose ownership is unknowable.
