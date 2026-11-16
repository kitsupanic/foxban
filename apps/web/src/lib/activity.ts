import type { Activity, ActivityDetail, Comment } from "@foxban/shared";
import type { Member } from "./api";
import { formatDueDate } from "./due-date";
import { PRIORITY_META } from "./priority";
import { TASK_TYPE_META } from "./task-type";

export type CommentTimelineItem = {
  kind: "comment";
  key: string;
  createdAt: number;
  comment: Comment;
  replies: Comment[];
};

export type ActivityTimelineItem =
  | CommentTimelineItem
  | { kind: "history"; key: string; createdAt: number; activity: Activity };

/** Merge comments and immutable history in stable oldest-first order. */
export function activityTimeline(
  comments: readonly Comment[],
  activities: readonly Activity[],
): ActivityTimelineItem[] {
  // Separate root comments and replies
  const roots = comments.filter((c) => c.parentCommentId === null);
  const repliesByParent = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.parentCommentId !== null) {
      const list = repliesByParent.get(c.parentCommentId);
      if (list) list.push(c);
      else repliesByParent.set(c.parentCommentId, [c]);
    }
  }

  // Sort replies oldest-first: createdAt, then id
  for (const list of repliesByParent.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  const commentItems: ActivityTimelineItem[] = roots.map((root) => ({
    kind: "comment",
    key: `comment:${root.id}`,
    createdAt: root.createdAt,
    comment: root,
    replies: repliesByParent.get(root.id) ?? [],
  }));

  const timeline: ActivityTimelineItem[] = [
    ...commentItems,
    ...activities.map(
      (activity): ActivityTimelineItem => ({
        kind: "history",
        key: `activity:${activity.id}`,
        createdAt: activity.createdAt,
        activity,
      }),
    ),
  ];

  return timeline.sort((a, b) => {
    const timestampOrder = a.createdAt - b.createdAt;
    if (timestampOrder !== 0) return timestampOrder;
    if (a.kind === "history" && b.kind === "history") {
      return a.activity.sequence - b.activity.sequence;
    }
    return a.key.localeCompare(b.key);
  });
}

/** Returns the actor on the lowest-sequence `card.created` activity for the card. */
export function cardCreatorId(cardId: string, activities: readonly Activity[]): string | null {
  const cardActivities = activities.filter(
    (a) => a.cardId === cardId && a.detail.type === "card.created",
  );
  if (cardActivities.length === 0) return null;
  cardActivities.sort((a, b) => a.sequence - b.sequence);
  return cardActivities[0].actorId;
}

/**
 * Collects non-null beforeId and afterId from assignee.changed activities for the card,
 * includes the current assignee, deduplicates, and orders users by first assignment sequence.
 */
export function cardAssigneeHistory(
  cardId: string,
  activities: readonly Activity[],
  currentAssigneeId: string | null,
): string[] {
  const assignmentActivities = activities
    .filter(
      (a) =>
        a.cardId === cardId &&
        a.detail.type === "assignee.changed",
    )
    .sort((a, b) => a.sequence - b.sequence);

  const seen = new Set<string>();
  const orderedAssignees: string[] = [];

  for (const act of assignmentActivities) {
    if (act.detail.type === "assignee.changed") {
      if (act.detail.beforeId !== null && !seen.has(act.detail.beforeId)) {
        seen.add(act.detail.beforeId);
        orderedAssignees.push(act.detail.beforeId);
      }
      if (act.detail.afterId !== null && !seen.has(act.detail.afterId)) {
        seen.add(act.detail.afterId);
        orderedAssignees.push(act.detail.afterId);
      }
    }
  }

  if (currentAssigneeId !== null && !seen.has(currentAssigneeId)) {
    seen.add(currentAssigneeId);
    orderedAssignees.push(currentAssigneeId);
  }

  return orderedAssignees;
}

/** Format one neutral, actor-free activity sentence. */
export function activitySentence(detail: ActivityDetail, members: readonly Member[]): string {
  switch (detail.type) {
    case "card.created":
      return "created this card";
    case "card.renamed":
      return `renamed this card from “${detail.before}” to “${detail.after}”`;
    case "description.updated":
      return "updated the description";
    case "card.moved":
      return `moved this card from ${detail.fromColumn} to ${detail.toColumn}`;
    case "card.reordered":
      return `reordered this card in ${detail.column}`;
    case "assignee.changed": {
      const before =
        detail.beforeId === null
          ? "Unassigned"
          : (members.find((member) => member.id === detail.beforeId)?.name ?? "former member");
      const after =
        detail.afterId === null
          ? "Unassigned"
          : (members.find((member) => member.id === detail.afterId)?.name ?? "former member");
      if (detail.beforeId === null && detail.afterId !== null) {
        return `assigned this card to ${after}`;
      }
      if (detail.beforeId !== null && detail.afterId === null) {
        return `unassigned this card from ${before}`;
      }
      return `changed the assignee from ${before} to ${after}`;
    }
    case "priority.changed":
      return `changed priority from ${PRIORITY_META[detail.before].label} to ${PRIORITY_META[detail.after].label}`;
    case "taskType.changed":
      return `changed type from ${TASK_TYPE_META[detail.before].label} to ${TASK_TYPE_META[detail.after].label}`;
    case "dueDate.changed":
      if (detail.before === null && detail.after !== null) {
        return `set due date to ${formatDueDate(detail.after)}`;
      }
      if (detail.before !== null && detail.after === null) {
        return `removed due date ${formatDueDate(detail.before)}`;
      }
      return `changed due date from ${detail.before === null ? "no due date" : formatDueDate(detail.before)} to ${detail.after === null ? "no due date" : formatDueDate(detail.after)}`;
    case "label.added":
      return `added label ${detail.label}`;
    case "label.removed":
      return `removed label ${detail.label}`;
    case "checklist.added":
      return `added checklist item “${detail.item}”`;
    case "checklist.renamed":
      return `renamed checklist item from “${detail.before}” to “${detail.after}”`;
    case "checklist.completed":
      return `completed “${detail.item}”`;
    case "checklist.reopened":
      return `reopened “${detail.item}”`;
    case "checklist.deleted":
      return `deleted checklist item “${detail.item}”`;
    case "attachment.added":
      return `attached “${detail.fileName}”`;
    case "attachment.deleted":
      return `deleted attachment “${detail.fileName}”`;
    case "comment.edited":
      return "edited a comment";
    case "comment.deleted":
      return "deleted a comment";
    case "subtask.completed":
      return "Completed this subtask";
    case "subtask.reopened":
      return "Reopened this subtask";
    case "relation.added": {
      const other = `“${detail.otherCardTitle}”`;
      if (detail.relationKind === "relates") return `linked this card to ${other}`;
      if (detail.relationKind === "blocks") {
        return detail.side === "source"
          ? `marked this card as blocking ${other}`
          : `marked this card as blocked by ${other}`;
      }
      return detail.side === "source"
        ? `added ${other} as a subtask`
        : `made this card a subtask of ${other}`;
    }
    case "relation.removed": {
      const other = `“${detail.otherCardTitle}”`;
      if (detail.relationKind === "relates") return `removed relation to ${other}`;
      if (detail.relationKind === "blocks") {
        return detail.side === "source"
          ? `removed blocking relation to ${other}`
          : `removed blocked-by relation to ${other}`;
      }
      return detail.side === "source"
        ? `removed subtask ${other}`
        : `removed this card from parent ${other}`;
    }
  }
  detail satisfies never;
  throw new Error("unreachable activity detail");
}
