import {
  type Activity,
  type ActivityDetail,
  type ClientMessage,
  type Priority,
  type TaskType,
} from "@foxban/shared";

export type ActivityDraft = { cardId: string; detail: ActivityDetail };

const DELETED_CARD_TITLE = "(deleted card)";
const DELETED_COLUMN_TITLE = "(deleted column)";

function cardTitle(sql: SqlStorage, cardId: string): string | undefined {
  return sql.exec<{ title: string }>("SELECT title FROM cards WHERE id = ?", cardId).toArray()[0]
    ?.title;
}

function columnTitle(sql: SqlStorage, columnId: string): string {
  return (
    sql.exec<{ title: string }>("SELECT title FROM columns WHERE id = ?", columnId).toArray()[0]
      ?.title ?? DELETED_COLUMN_TITLE
  );
}

/** Derive immutable history from the rows as they exist before a mutation. */
export function activityDrafts(sql: SqlStorage, message: ClientMessage): ActivityDraft[] {
  switch (message.type) {
    case "card.finish": return [{ id: message.id, position: message.position }, ...message.children].flatMap(move => activityDrafts(sql, { type: "card.move", mutationId: message.mutationId, id: move.id, columnId: message.columnId, position: move.position }));
    case "workflow.configure":
    case "column.create":
    case "column.rename":
    case "column.move":
    case "column.delete":
    case "card.delete":
    case "card.purge":
    case "card.restore":
    case "comment.create":
    case "label.create":
    case "label.update":
      return [];

    case "card.create":
      return [{ cardId: message.id, detail: { type: "card.created" } }];

    case "card.update": {
      const card = sql
        .exec<{ title: string; description: string }>(
          "SELECT title, description FROM cards WHERE id = ?",
          message.id,
        )
        .toArray()[0];
      if (!card) return [];

      const drafts: ActivityDraft[] = [];
      if (message.title !== undefined && message.title !== card.title) {
        drafts.push({
          cardId: message.id,
          detail: { type: "card.renamed", before: card.title, after: message.title },
        });
      }
      if (message.description !== undefined && message.description !== card.description) {
        drafts.push({ cardId: message.id, detail: { type: "description.updated" } });
      }
      return drafts;
    }

    case "card.move": {
      const card = sql
        .exec<{ columnId: string; position: string }>(
          "SELECT column_id AS columnId, position FROM cards WHERE id = ?",
          message.id,
        )
        .toArray()[0];
      if (!card) return [];

      if (message.columnId !== card.columnId) {
        return [
          {
            cardId: message.id,
            detail: {
              type: "card.moved",
              fromColumn: columnTitle(sql, card.columnId),
              toColumn: columnTitle(sql, message.columnId),
            },
          },
        ];
      }
      if (message.position !== card.position) {
        return [
          {
            cardId: message.id,
            detail: { type: "card.reordered", column: columnTitle(sql, card.columnId) },
          },
        ];
      }
      return [];
    }

    case "card.assign": {
      const card = sql
        .exec<{ assigneeId: string | null }>(
          "SELECT assignee_id AS assigneeId FROM cards WHERE id = ?",
          message.id,
        )
        .toArray()[0];
      if (!card || card.assigneeId === message.assigneeId) return [];
      return [
        {
          cardId: message.id,
          detail: {
            type: "assignee.changed",
            beforeId: card.assigneeId,
            afterId: message.assigneeId,
          },
        },
      ];
    }

    case "card.prioritize": {
      const card = sql
        .exec<{ priority: Priority }>("SELECT priority FROM cards WHERE id = ?", message.id)
        .toArray()[0];
      if (!card || card.priority === message.priority) return [];
      return [
        {
          cardId: message.id,
          detail: { type: "priority.changed", before: card.priority, after: message.priority },
        },
      ];
    }

    case "card.retype": {
      const card = sql
        .exec<{ taskType: TaskType }>("SELECT task_type AS taskType FROM cards WHERE id = ?", message.id)
        .toArray()[0];
      if (!card || card.taskType === message.taskType) return [];
      return [
        {
          cardId: message.id,
          detail: { type: "taskType.changed", before: card.taskType, after: message.taskType },
        },
      ];
    }
    case "card.schedule": {
      const card = sql
        .exec<{ dueDate: string | null }>(
          "SELECT due_date AS dueDate FROM cards WHERE id = ?",
          message.id,
        )
        .toArray()[0];
      if (!card || card.dueDate === message.dueDate) return [];
      return [
        {
          cardId: message.id,
          detail: { type: "dueDate.changed", before: card.dueDate, after: message.dueDate },
        },
      ];
    }

    case "checklist.create": {
      const cardExists =
        sql.exec<{ present: number }>("SELECT 1 AS present FROM cards WHERE id = ?", message.cardId)
          .toArray().length > 0;
      if (!cardExists) return [];
      return [
        {
          cardId: message.cardId,
          detail: { type: "checklist.added", item: message.text },
        },
      ];
    }

    case "checklist.update": {
      const item = sql
        .exec<{ cardId: string; text: string; done: number }>(
          "SELECT card_id AS cardId, text, done FROM checklist_items WHERE id = ?",
          message.id,
        )
        .toArray()[0];
      if (!item) return [];

      const drafts: ActivityDraft[] = [];
      if (message.text !== undefined && message.text !== item.text) {
        drafts.push({
          cardId: item.cardId,
          detail: { type: "checklist.renamed", before: item.text, after: message.text },
        });
      }
      if (message.done !== undefined && message.done !== (item.done === 1)) {
        drafts.push({
          cardId: item.cardId,
          detail: {
            type: message.done ? "checklist.completed" : "checklist.reopened",
            item: item.text,
          },
        });
      }
      return drafts;
    }

    case "checklist.delete": {
      const item = sql
        .exec<{ cardId: string; text: string }>(
          "SELECT card_id AS cardId, text FROM checklist_items WHERE id = ?",
          message.id,
        )
        .toArray()[0];
      if (!item) return [];
      return [
        {
          cardId: item.cardId,
          detail: { type: "checklist.deleted", item: item.text },
        },
      ];
    }

    case "attachment.create": {
      const cardExists =
        sql.exec<{ present: number }>("SELECT 1 AS present FROM cards WHERE id = ?", message.cardId)
          .toArray().length > 0;
      if (!cardExists) return [];
      return [
        {
          cardId: message.cardId,
          detail: { type: "attachment.added", fileName: message.fileName },
        },
      ];
    }

    case "attachment.delete": {
      const attachment = sql
        .exec<{ cardId: string; fileName: string }>(
          "SELECT card_id AS cardId, file_name AS fileName FROM attachments WHERE id = ?",
          message.id,
        )
        .toArray()[0];
      if (!attachment) return [];
      return [
        {
          cardId: attachment.cardId,
          detail: { type: "attachment.deleted", fileName: attachment.fileName },
        },
      ];
    }

    case "label.assign": {
      const label = sql
        .exec<{ name: string }>(
          `SELECT name
             FROM labels
            WHERE id = ?
              AND EXISTS (SELECT 1 FROM cards WHERE id = ?)
              AND NOT EXISTS (
                SELECT 1 FROM card_labels WHERE card_id = ? AND label_id = ?
              )`,
          message.labelId,
          message.cardId,
          message.cardId,
          message.labelId,
        )
        .toArray()[0];
      if (!label) return [];
      return [
        {
          cardId: message.cardId,
          detail: { type: "label.added", label: label.name },
        },
      ];
    }

    case "label.unassign": {
      const assignment = sql
        .exec<{ cardId: string; label: string; assignmentCount: number }>(
          `SELECT assignment.card_id AS cardId, label.name AS label,
                  (SELECT COUNT(*)
                     FROM card_labels AS duplicate
                    WHERE duplicate.card_id = assignment.card_id
                      AND duplicate.label_id = assignment.label_id) AS assignmentCount
             FROM card_labels AS assignment
             JOIN labels AS label ON label.id = assignment.label_id
             JOIN cards AS card ON card.id = assignment.card_id
            WHERE assignment.id = ?`,
          message.id,
        )
        .toArray()[0];
      if (!assignment || assignment.assignmentCount !== 1) return [];
      return [
        {
          cardId: assignment.cardId,
          detail: { type: "label.removed", label: assignment.label },
        },
      ];
    }

    case "label.delete":
      return sql
        .exec<{ cardId: string; label: string }>(
          `SELECT DISTINCT assignment.card_id AS cardId, label.name AS label
             FROM labels AS label
             JOIN card_labels AS assignment ON assignment.label_id = label.id
             JOIN cards AS card ON card.id = assignment.card_id
            WHERE label.id = ?
            ORDER BY assignment.card_id`,
          message.id,
        )
        .toArray()
        .map(({ cardId, label }) => ({
          cardId,
          detail: { type: "label.removed", label },
        }));

    case "subtask.create": {
      const parentTitle = cardTitle(sql, message.parentCardId);
      const drafts: ActivityDraft[] = [
        { cardId: message.id, detail: { type: "card.created" } },
      ];
      // Conversion keeps its own history on the parent: the item it absorbed.
      if (message.checklistItemId !== undefined) {
        const item = sql
          .exec<{ text: string }>("SELECT text FROM checklist_items WHERE id = ?", message.checklistItemId)
          .toArray()[0];
        if (item) {
          drafts.push({
            cardId: message.parentCardId,
            detail: { type: "checklist.deleted", item: item.text },
          });
        }
      }
      drafts.push({
        cardId: message.parentCardId,
        detail: {
          type: "relation.added",
          relationKind: "subtask",
          side: "source",
          otherCardTitle: message.title,
        },
      });
      drafts.push({
        cardId: message.id,
        detail: {
          type: "relation.added",
          relationKind: "subtask",
          side: "target",
          otherCardTitle: parentTitle ?? DELETED_CARD_TITLE,
        },
      });
      return drafts;
    }

    case "relation.create": {
      const sourceTitle = cardTitle(sql, message.sourceCardId);
      const targetTitle = cardTitle(sql, message.targetCardId);
      const drafts: ActivityDraft[] = [];
      if (sourceTitle !== undefined) {
        drafts.push({
          cardId: message.sourceCardId,
          detail: {
            type: "relation.added",
            relationKind: message.kind,
            side: "source",
            otherCardTitle: targetTitle ?? DELETED_CARD_TITLE,
          },
        });
      }
      if (targetTitle !== undefined) {
        drafts.push({
          cardId: message.targetCardId,
          detail: {
            type: "relation.added",
            relationKind: message.kind,
            side: "target",
            otherCardTitle: sourceTitle ?? DELETED_CARD_TITLE,
          },
        });
      }
      return drafts;
    }

    case "relation.delete": {
      const relation = sql
        .exec<{
          sourceCardId: string;
          targetCardId: string;
          kind: "relates" | "blocks" | "subtask";
        }>(
          `SELECT source_card_id AS sourceCardId, target_card_id AS targetCardId, kind
             FROM card_relations
            WHERE id = ?`,
          message.id,
        )
        .toArray()[0];
      if (!relation) return [];

      const sourceTitle = cardTitle(sql, relation.sourceCardId);
      const targetTitle = cardTitle(sql, relation.targetCardId);
      const drafts: ActivityDraft[] = [];
      if (sourceTitle !== undefined) {
        drafts.push({
          cardId: relation.sourceCardId,
          detail: {
            type: "relation.removed",
            relationKind: relation.kind,
            side: "source",
            otherCardTitle: targetTitle ?? DELETED_CARD_TITLE,
          },
        });
      }
      if (targetTitle !== undefined) {
        drafts.push({
          cardId: relation.targetCardId,
          detail: {
            type: "relation.removed",
            relationKind: relation.kind,
            side: "target",
            otherCardTitle: sourceTitle ?? DELETED_CARD_TITLE,
          },
        });
      }
      return drafts;
    }

    case "comment.update":
    case "comment.delete": {
      // A deleted comment is a tombstone: an edit or a second delete that lost to the first changes nothing and must not log.
      const comment = sql
        .exec<{ cardId: string }>(
          "SELECT card_id AS cardId FROM comments WHERE id = ? AND deleted = 0",
          message.id,
        )
        .toArray()[0];
      if (!comment) return [];
      return [
        {
          cardId: comment.cardId,
          detail: {
            type: message.type === "comment.update" ? "comment.edited" : "comment.deleted",
          },
        },
      ];
    }
  }
}

/** Insert one ordered activity batch and return its complete wire rows. */
export function insertActivities(
  sql: SqlStorage,
  drafts: readonly ActivityDraft[],
  actorId: string,
  createdAt: number,
): Activity[] {
  const activities: Activity[] = [];
  for (const draft of drafts) {
    const id = crypto.randomUUID();
    const inserted = sql
      .exec<{ sequence: number }>(
        `INSERT INTO activities(id, card_id, actor_id, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING sequence`,
        id,
        draft.cardId,
        actorId,
        JSON.stringify(draft.detail),
        createdAt,
      )
      .toArray()[0];
    if (!inserted) throw new Error("activity insert did not return a sequence");
    activities.push({ id, cardId: draft.cardId, actorId, sequence: inserted.sequence, createdAt, detail: draft.detail });
  }
  return activities;
}

/** Read every immutable activity row. Details were validated when written, so a read only parses the JSON: this runs on every snapshot. */
export function readActivities(sql: SqlStorage): Activity[] {
  return sql
    .exec<{
      id: string;
      cardId: string;
      actorId: string;
      sequence: number;
      createdAt: number;
      detailJson: string;
    }>(
      `SELECT id, card_id AS cardId, actor_id AS actorId, sequence,
              created_at AS createdAt, detail_json AS detailJson
         FROM activities
        ORDER BY card_id, sequence`,
    )
    .toArray()
    .map(({ detailJson, ...row }) => ({
      ...row,
      detail: JSON.parse(detailJson) as ActivityDetail,
    }));
}
