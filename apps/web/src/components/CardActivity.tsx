import { useMemo, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type SetStateAction } from "react";
import { CalendarArrowDown, CalendarArrowUp, MessageSquare, Pencil, Reply, X } from "lucide-react";
import type { Activity, Comment } from "@foxban/shared";
import { cn } from "../lib/utils";
import { activitySentence, activityTimeline, type ActivityTimelineItem } from "../lib/activity";
import type { Member } from "../lib/api";
import type { User } from "../lib/auth";
import type { BoardCommands } from "../lib/board-commands";
import type { CommentThread } from "../lib/comment-thread";
import { Avatar } from "./Avatar";
import { MarkdownContent, MarkdownEditor } from "./MarkdownEditor";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export type ActivityView = "all" | "comments" | "history";
export type ActivitySortOrder = "asc" | "desc";

export const ACTIVITY_TABS: readonly { view: ActivityView; label: string }[] = [
  { view: "all", label: "All" },
  { view: "comments", label: "Comments" },
  { view: "history", label: "History" },
];

/**
 * The card's activity (ADR 0015, 0043): the history, the comment thread with its one-level
 * replies, and the composer that adds a comment. The view and sort order stay the modal's, so
 * they survive the two shells remounting this body; the thread's drafts and writes are the
 * hook's.
 */
export function CardActivity({
  commentThread,
  comments,
  activities,
  members,
  me,
  commands,
  previewImages,
  onOpenImage,
  activityView,
  setActivityView,
  activitySortOrder,
  setActivitySortOrder,
  activityTabRefs,
  onActivityTabKeyDown,
}: {
  commentThread: CommentThread;
  /** This card's comments, oldest first; the live cache, not a draft. */
  comments: Comment[];
  /** This card's immutable history in server sequence order. */
  activities: Activity[];
  members: Member[];
  me: User | null;
  commands: Pick<BoardCommands, "deleteComment">;
  /** Previewable images currently attached to the card, keyed by canonical URL. */
  previewImages: ReadonlyMap<string, { id: string; fileName: string }>;
  /** Opens the card's fullscreen attachment viewer for an embedded image. */
  onOpenImage: (attachmentId: string, trigger?: HTMLElement | null) => void;
  activityView: ActivityView;
  setActivityView: (view: ActivityView) => void;
  activitySortOrder: ActivitySortOrder;
  setActivitySortOrder: Dispatch<SetStateAction<ActivitySortOrder>>;
  activityTabRefs: { current: Record<ActivityView, HTMLButtonElement | null> };
  onActivityTabKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, current: ActivityView) => void;
}) {
  const {
    composing: composingComment,
    draft: commentDraft,
    feedbackResetToken: commentFeedbackResetToken,
    uploading: commentUploading,
    composer,
    replyingCommentId,
    replyDraft,
    replyUploading,
    orphanedReply,
    reply: replyLane,
    editingCommentId,
    editDraft: editCommentDraft,
    edit,
    editedCommentDeleted,
    replyButtonRefs,
    openComposer,
    setDraft,
    cancelComposer,
    submitComment,
    retryCommentRecovery,
    discardCommentRecovery,
    uploadCommentImage,
    startReply,
    setReplyDraft,
    cancelReplyComposer,
    submitReply,
    retryReplyRecovery,
    discardReplyRecovery,
    uploadReplyImage,
    moveOrphanedReplyToComment,
    discardOrphanedReply,
    startEdit,
    setEditDraft,
    saveCommentEdit,
    cancelCommentEdit,
    moveEditToComment,
    uploadEditedCommentImage,
  } = commentThread;
  const { pending: commentPending, uncertain: commentUncertain, error: commentError, recovery: commentRecovery } = composer;
  const { pending: replyPending, uncertain: replyUncertain, error: replyError, recovery: replyRecovery } = replyLane;
  const { uncertain: commentEditUncertain, error: commentEditError } = edit;
  const commentEditPending = edit.pendingId !== null;
  const membersById = useMemo(
    () => new Map(members.map((member) => [member.id, member])),
    [members],
  );
  const activityRows = useMemo((): ActivityTimelineItem[] => {
    const oldestFirst =
      activityView === "all"
        ? activityTimeline(comments, activities)
        : activityView === "comments"
          ? activityTimeline(comments, [])
          : activityTimeline([], activities);
    if (activitySortOrder === "desc") {
      return [...oldestFirst].reverse();
    }
    return oldestFirst;
  }, [activityView, comments, activities, activitySortOrder]);
  const activeCommentCount = useMemo(
    () => comments.filter((comment) => !comment.deleted).length,
    [comments],
  );
  const activityCounts: Record<ActivityView, number> = {
    all: activeCommentCount + activities.length,
    comments: activeCommentCount,
    history: activities.length,
  };
  const emptyActivityCopy =
    activityView === "all"
      ? "No activity yet."
      : activityView === "comments"
        ? "No comments yet."
        : "No history yet.";
  const renderReplyComposer = (rootId: string) => (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-xs">
      {replyError && (
        <div role="alert" className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>{replyError}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => submitReply(rootId)}
            className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
          >
            Retry
          </Button>
        </div>
      )}
      <MarkdownEditor
        value={replyDraft}
        readOnly={replyPending || replyUncertain}
        onChange={setReplyDraft}
        onSubmit={() => submitReply(rootId)}
        onEscape={cancelReplyComposer}
        onUploadImage={uploadReplyImage}
        ariaLabel="Comment"
        rows={4}
        imageInputTestId="comment-image-input"
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => submitReply(rootId)}
          disabled={replyDraft.trim() === "" || replyUploading || replyPending || replyUncertain || replyRecovery !== null}
          className="pointer-coarse:min-h-11 pointer-coarse:px-4"
        >
          {replyPending ? "Sending…" : "Reply"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={replyUploading}
          onClick={() => cancelReplyComposer()}
          className="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-4"
        >
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h3 className="card-section-title text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <MessageSquare aria-hidden="true" className="card-section-icon" />Activity
      </h3>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Activity view" className="flex flex-wrap gap-1">
          {ACTIVITY_TABS.map((tab) => {
            const selected = activityView === tab.view;
            return (
              <button
                key={tab.view}
                id={`card-activity-${tab.view}-tab`}
                ref={(element) => {
                  activityTabRefs.current[tab.view] = element;
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="card-activity-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => setActivityView(tab.view)}
                onKeyDown={(event) => onActivityTabKeyDown(event, tab.view)}
                className={cn(
                  "whitespace-nowrap rounded-md border px-2 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  selected
                    ? "border-input bg-card font-medium text-foreground shadow-xs"
                    : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {tab.label} · {activityCounts[tab.view]}
              </button>
            );
          })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={
            activitySortOrder === "asc"
              ? "Sort activity by date: Oldest first"
              : "Sort activity by date: Newest first"
          }
          onClick={() =>
            setActivitySortOrder((current) =>
              current === "asc" ? "desc" : "asc",
            )
          }
        >
          {activitySortOrder === "asc" ? (
            <CalendarArrowUp aria-hidden className="size-4" />
          ) : (
            <CalendarArrowDown aria-hidden className="size-4" />
          )}
          {activitySortOrder === "asc" ? "Oldest first" : "Newest first"}
        </Button>
      </div>
      <div
        id="card-activity-panel"
        role="tabpanel"
        aria-labelledby={`card-activity-${activityView}-tab`}
        className="flex min-w-0 flex-col gap-2"
      >
        {activityRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyActivityCopy}</p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            <ul className="flex min-w-0 flex-col gap-2">
            {activityRows.map((item) => {
              if (item.kind === "history") {
                const actor = membersById.get(item.activity.actorId) ?? null;
                const createdAtDate = new Date(item.createdAt);
                const isCreatedAtValid = !Number.isNaN(createdAtDate.getTime());
                return (
                  <li
                    key={item.key}
                    className="flex min-w-0 items-start gap-2 text-sm text-foreground"
                  >
                    {actor ? (
                      <Avatar name={actor.name} githubLogin={actor.githubLogin} />
                    ) : (
                      <span aria-hidden="true" className="size-5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <span className="sr-only">History entry: </span>
                      <p className="min-w-0 [overflow-wrap:anywhere] text-foreground">
                        <span className="min-w-0 [overflow-wrap:anywhere] font-medium">{actor?.name ?? "former member"}</span>{" "}
                        {activitySentence(item.activity.detail, members)}
                      </p>
                      <time
                        {...(isCreatedAtValid ? { dateTime: createdAtDate.toISOString() } : {})}
                        className="text-xs text-muted-foreground"
                      >
                        {isCreatedAtValid ? createdAtDate.toLocaleString() : "Invalid date"}
                      </time>
                    </div>
                  </li>
                );
              }

              const { comment, replies } = item;

              const renderCommentRow = (c: Comment) => {
                const cAuthor = membersById.get(c.authorId) ?? null;
                const cCreatedAtDate = new Date(c.createdAt);
                const cIsCreatedAtValid = !Number.isNaN(cCreatedAtDate.getTime());

                if (c.deleted) {
                  return (
                    <div
                      key={c.id}
                      data-comment-id={c.id}
                      className="group flex min-w-0 items-start gap-2 text-sm text-foreground"
                    >
                      <span aria-hidden="true" className="size-5 shrink-0" />
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-xs italic text-muted-foreground">
                        Comment deleted
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={c.id}
                    data-comment-id={c.id}
                    className="group flex min-w-0 items-start gap-2 text-sm text-foreground"
                  >
                    {cAuthor ? (
                      <Avatar name={cAuthor.name} githubLogin={cAuthor.githubLogin} />
                    ) : (
                      <span aria-hidden="true" className="size-5 shrink-0" />
                    )}
                    <div className="card-comment-content flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-xs">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="sr-only">Comment by </span>
                        <span className="min-w-0 [overflow-wrap:anywhere] font-medium">
                          {cAuthor?.name ?? "former member"}
                        </span>
                        <time
                          {...(cIsCreatedAtValid ? { dateTime: cCreatedAtDate.toISOString() } : {})}
                          className="text-xs text-muted-foreground"
                          title={cIsCreatedAtValid ? cCreatedAtDate.toLocaleString() : "Invalid date"}
                          aria-label={cIsCreatedAtValid ? cCreatedAtDate.toLocaleString() : "Invalid date"}
                        >
                          {cIsCreatedAtValid ? cCreatedAtDate.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            ...(cCreatedAtDate.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
                          }) : "Invalid date"}
                        </time>
                        {c.updatedAt > c.createdAt && (
                          <span className="text-xs text-muted-foreground">(edited)</span>
                        )}
                        <span className="flex-1" />
                        {me !== null && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Reply to comment"
                            ref={(el) => {
                              replyButtonRefs.current[c.id] = el;
                            }}
                            disabled={replyUploading || orphanedReply !== null}
                            onClick={() => startReply(c)}
                            className="size-7 pointer-coarse:size-11 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                          >
                            <Reply aria-hidden className="size-3.5" />
                          </Button>
                        )}
                        {/* Legacy comment permissions remain UI-only (ADR 0029). */}
                        {me?.id === c.authorId && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Edit comment"
                            disabled={commentEditPending || commentUploading}
                            onClick={() => startEdit(c)}
                            className="size-7 pointer-coarse:size-11 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                          >
                            <Pencil aria-hidden className="size-3.5" />
                          </Button>
                        )}
                        {me !== null && (me.id === c.authorId || me.isAdmin) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Delete comment"
                            disabled={editingCommentId === c.id}
                            onClick={() => commands.deleteComment(c.id)}
                            className="size-7 pointer-coarse:size-11 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                          >
                            <X aria-hidden className="size-3.5" />
                          </Button>
                        )}
                      </div>
                      {editingCommentId === c.id ? (
                        <div className="flex min-w-0 flex-col gap-2">
                          <MarkdownEditor
                            value={editCommentDraft}
                            onChange={setEditDraft}
                            onSubmit={saveCommentEdit}
                            onEscape={cancelCommentEdit}
                            readOnly={commentEditPending}
                            onUploadImage={uploadEditedCommentImage}
                            ariaLabel="Comment"
                            rows={4}
                            imageInputTestId="comment-image-input"
                          />
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="default"
                              size="sm"
                              onClick={saveCommentEdit}
                              disabled={editCommentDraft.trim() === "" || commentUploading || commentEditPending}
                              className="pointer-coarse:min-h-11 pointer-coarse:px-4"
                            >
                              Save comment
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={cancelCommentEdit}
                              disabled={commentUploading || commentEditPending}
                              className="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-4"
                            >
                              Cancel
                            </Button>
                          </div>
                          {commentEditError && <p role="alert" className="text-xs text-destructive">{commentEditError}</p>}
                          {commentEditPending && <p role="status" className="text-xs text-muted-foreground">{commentEditUncertain ? "Checking whether comment edit completed…" : "Saving comment…"}</p>}
                          {commentUploading && (
                            <p role="status" className="text-xs text-muted-foreground">
                              Converting and uploading image…
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="prose prose-sm min-w-0 max-w-none break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
                          <MarkdownContent
                            value={c.body}
                            previewImages={previewImages}
                            onOpenImage={onOpenImage}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              };

              return (
                <li key={item.key} className="flex min-w-0 flex-col gap-2">
                  {renderCommentRow(comment)}
                  {replyRecovery && replyRecovery.parentCommentId === comment.id && (
                    <div className="pl-7">
                      <div
                        role="alert"
                        className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
                      >
                        <div className="flex items-center justify-between gap-2 font-medium">
                          <span>{replyRecovery.error}</span>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={retryReplyRecovery}
                              disabled={replyUploading || replyPending || replyUncertain}
                              className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
                            >
                              {replyPending ? "Retrying…" : "Retry unsent reply"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              disabled={replyPending || replyUncertain}
                              onClick={discardReplyRecovery}
                              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
                            >
                              Discard unsent reply
                            </Button>
                          </div>
                        </div>
                        <div className="rounded border border-border/50 bg-background/50 p-2 text-foreground font-mono text-[11px] whitespace-pre-wrap break-words">
                          <span className="font-semibold text-muted-foreground">Unsent reply: </span>
                          {replyRecovery.rawDraft}
                        </div>
                      </div>
                    </div>
                  )}
                  {replyingCommentId === comment.id && (
                    <div className="pl-7">
                      {renderReplyComposer(comment.id)}
                    </div>
                  )}
                  {replies.length > 0 && (
                    <div className="flex min-w-0 flex-col gap-2 pl-7">
                      {replies.map((reply) => (
                        <div key={reply.id} className="flex min-w-0 flex-col gap-2">
                          {renderCommentRow(reply)}
                          {replyingCommentId === reply.id && (
                            <div className="pl-7">
                              {renderReplyComposer(comment.id)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
            </ul>
          </div>
        )}
        {replyingCommentId !== null && !comments.some((c) => c.id === replyingCommentId && !c.deleted) && replyUploading && (
          <div className="pl-7">
            {renderReplyComposer(replyingCommentId)}
          </div>
        )}
        {editedCommentDeleted && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
            <span>Edited comment was deleted. Your draft is preserved.</span>
            <Textarea aria-label="Preserved comment edit" readOnly value={editCommentDraft} rows={4} className="w-full rounded border border-border bg-background p-2 font-mono text-foreground" />
            <div className="flex gap-2">
              <Button
                type="button" variant="outline" size="xs"
                disabled={commentUploading || commentEditPending || commentPending || commentUncertain || commentRecovery !== null}
                onClick={moveEditToComment}
              >Move to comment</Button>
              <Button type="button" variant="ghost" size="xs" disabled={commentUploading || commentEditPending} onClick={cancelCommentEdit}>Discard edit</Button>
            </div>
            {commentUploading && <p role="status">Uploading image into preserved draft…</p>}
            {commentEditPending && <p role="status">{commentEditUncertain ? "Checking whether comment edit completed…" : "Saving comment…"}</p>}
            {commentEditError && <p>{commentEditError}</p>}
          </div>
        )}
        {orphanedReply && (
          <div
            role="alert"
            className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
          >
            <div className="flex items-center justify-between gap-2 font-medium">
              <span>Target comment was deleted by a peer. Reply draft preserved (image placed at end):</span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={
                    commentPending ||
                    commentUncertain ||
                    commentUploading ||
                    commentRecovery !== null
                  }
                  onClick={moveOrphanedReplyToComment}
                  className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
                >
                  Move to comment
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={discardOrphanedReply}
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-3"
                >
                  Discard
                </Button>
              </div>
            </div>
            <div className="rounded border border-border/50 bg-background/50 p-2 text-foreground font-mono text-[11px] whitespace-pre-wrap break-words">
              {orphanedReply.text}
            </div>
          </div>
        )}
        {activityView !== "history" &&
          me !== null && (
            <div className="card-comment-composer-row flex min-w-0 items-start gap-2" data-expanded={composingComment || commentRecovery !== null || commentError !== null || commentUploading || commentPending || commentUncertain}>
              <Avatar name={me.name} githubLogin={me.githubLogin} userId={me.id} avatarVersion={me.avatarVersion} />
              <div className="min-w-0 flex-1">
                  <div className="card-comment-composer flex min-w-0 flex-col gap-2">
                    {commentRecovery && (
                      <div
                        role="alert"
                        className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
                      >
                        <div className="flex items-center justify-between gap-2 font-medium">
                          <span>{commentRecovery.error}</span>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={retryCommentRecovery}
                              disabled={commentUploading || commentPending || commentUncertain}
                              className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
                            >
                              {commentPending ? "Retrying…" : "Retry unsent comment"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              disabled={commentPending || commentUncertain}
                              onClick={discardCommentRecovery}
                              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
                            >
                              Discard unsent comment
                            </Button>
                          </div>
                        </div>
                        <div className="rounded border border-border/50 bg-background/50 p-2 text-foreground font-mono text-[11px] whitespace-pre-wrap break-words">
                          <span className="font-semibold text-muted-foreground">Unsent comment: </span>
                          {commentRecovery.rawDraft}
                        </div>
                      </div>
                    )}
                    {commentError && (
                      <div role="alert" className="flex items-center justify-between gap-2 text-xs text-destructive">
                        <span>{commentError}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={submitComment}
                          className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
                        >
                          Retry
                        </Button>
                      </div>
                    )}
                    <MarkdownEditor
                      autoFocus={false}
                      feedbackResetToken={commentFeedbackResetToken}
                      compact={!composingComment && !commentRecovery && !commentError && !commentUploading && !commentPending && !commentUncertain}
                      placeholder="Add a comment…"
                      onFocus={openComposer}
                      onClick={openComposer}
                      value={commentDraft}
                      readOnly={commentPending || commentUncertain}
                      onChange={setDraft}
                      onSubmit={submitComment}
                      onEscape={composingComment || commentUploading ? cancelComposer : undefined}
                      onUploadImage={uploadCommentImage}
                      ariaLabel={composingComment ? "Comment" : "Add a comment"}
                      rows={4}
                      imageInputTestId="comment-image-input"
                    />
                    <div className="card-comment-actions flex gap-2">
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={submitComment}
                        disabled={commentDraft.trim() === "" || commentUploading || commentPending || commentUncertain || commentRecovery !== null}
                        className="pointer-coarse:min-h-11 pointer-coarse:px-4"
                      >
                        {commentPending ? "Sending…" : "Comment"}
                      </Button>
                      {composingComment && <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={commentUploading || commentPending || commentUncertain}
                        onClick={() => cancelComposer()}
                        className="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-4"
                      >
                        Cancel
                      </Button>}
                    </div>
                  </div>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
