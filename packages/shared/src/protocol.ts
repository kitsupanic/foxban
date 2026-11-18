import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";

import {
  ATTACHMENT_POLICY,
  attachmentMaxBytes,
  normalizeAttachmentContentType,
} from "./attachment-policy";

/**
 * Board WebSocket protocol. camelCase on the wire (snake_case lives only in SQL).
 *
 * Clients generate entity ids (`crypto.randomUUID()`) and `position` keys
 * (fractional-indexing) themselves; the DO trusts them. Conflicts resolve
 * last-write-wins, which is adequate for two trusted users (ADR 0007).
 */

/**
 * Wire bounds. The DO broadcasts an accepted client frame verbatim, so validation
 * is the only place these strings are ever limited: without bounds one sender
 * could push arbitrarily large payloads into every other socket and into storage.
 */
export const Identifier = z.string().min(1).max(64);
/** A client-sent fractional-indexing key. The library throws on malformed keys, so a bad one stored once would break every later insert next to it. */
export const Position = Identifier.refine((key) => {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}, "invalid position key");
export const Title = z.string().max(200);
export const DESCRIPTION_MAX_BYTES = 100_000;
/**
 * Advanced whenever an accepted frame or entity changes meaning. Version 4
 * made `subtask` a distinct immutable type and forbade nesting. Version 5 makes
 * parent deletion archive its complete active subtask family, so older clients
 * that remove only the parent cannot remain connected. Version 6 lets
 * `card.create` carry its initial type, priority and assignee. Version 7 adds
 * authorization generations and workspace invalidation frames. Version 8 adds
 * owner-reviewed independent subtasks and explicit starting/completed columns.
 * Version 9 adds guarded atomic family completion. Version 10 removes the
 * inherited subtask mode: `workflow.configure` only sets roles and
 * `subtask.complete` is gone, and the snapshot says whether the workflow roles
 * are explicit. Version 11 drops `activities` from the snapshot (ADR 0073).
 */
export const REALTIME_PROTOCOL_VERSION = "11";
export const TRANSFER_TERMINAL_CODE = "transfer_terminal" as const;
export type TransferTerminalCode = typeof TRANSFER_TERMINAL_CODE;

/**
 * Computes the exact UTF-8 byte length of a string without allocations.
 * Invariant: matches TextEncoder.encode(value).byteLength semantics, including
 * UTF-16 surrogate pairs (+4 bytes, consuming both units) and isolated
 * surrogates (+3 bytes replacement character U+FFFD per code unit).
 */
export function descriptionByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < value.length) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i++;
          continue;
        }
      }
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
const Description = z.string().refine(
  (value) => descriptionByteLength(value) <= DESCRIPTION_MAX_BYTES,
  { message: "Description must be 100,000 bytes or fewer." },
);
/** A comment must have content; `Description` allows empty. */
const CommentBody = z.string().min(1).max(10_000);
/** A newly created subtask must carry real text; whitespace-only is refused here. */
const NewSubtaskTitle = Title.refine((value) => value.trim().length > 0, {
  message: "Title must not be blank.",
});

export const TaskNumber = z.number().int().positive();

export const PrioritySchema = z.enum(["highest", "high", "medium", "low", "lowest"]);

export const TaskTypeSchema = z.enum(["epic", "spike", "task", "bug", "subtask"]);

export const LabelColorSchema = z.enum(["red", "orange", "amber", "green", "teal", "blue", "purple", "pink"]);

export const BoardIconSchema = z.enum([
  "square-kanban",
  "fish",
  "shuffle",
  "briefcase",
  "code",
  "flask",
  "rocket",
  "target",
  "book-open",
  "palette",
  "heart",
  "star",
]);
export type BoardIcon = z.infer<typeof BoardIconSchema>;

export const BoardColorSchema = z.enum([
  "amber",
  "orange",
  "rose",
  "purple",
  "blue",
  "teal",
  "green",
  "slate",
]);
export type BoardColor = z.infer<typeof BoardColorSchema>;

export const ColumnSchema = z.object({
  id: Identifier,
  title: Title,
  position: Identifier,
  completed: z.boolean().optional(),
  starting: z.boolean().optional(),
});

export const CardSchema = z.object({
  id: Identifier,
  columnId: Identifier,
  title: Title,
  description: Description,
  position: Identifier,
  taskNumber: TaskNumber,
  assigneeId: Identifier.nullable(),
  priority: PrioritySchema,
  taskType: TaskTypeSchema,
  dueDate: z.iso.date().nullable(),
  /**
   * Whether this active card sits in the board's completed column; always
   * derived, never set on its own. An archived card carries the value it had
   * when it was archived.
   */
  subtaskDone: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const CARD_ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const ArchivedCardSchema = CardSchema.extend({
  archivedAt: z.number(),
  archivedColumnTitle: Title,
});

/** One checklist row on a card. `position` orders items within their card. */
export const ChecklistItemSchema = z.object({
  id: Identifier,
  cardId: Identifier,
  text: Title,
  done: z.boolean(),
  position: Identifier,
});

/**
 * One uploaded file on a card. The blob lives in R2 under `boardId/id`; this is
 * only its metadata. Display order is array order (no `position`).
 */
export const AttachmentSchema = z
  .object({
    id: Identifier,
    cardId: Identifier,
    fileName: Title,
    contentType: z.string().max(ATTACHMENT_POLICY.contentTypeMaxLength),
    size: z.number().int().min(0).max(ATTACHMENT_POLICY.fileMaxBytes),
  })
  .refine(
    ({ contentType }) => contentType === normalizeAttachmentContentType(contentType),
    {
      message: "attachment content type is not canonical",
      path: ["contentType"],
    },
  )
  .refine(({ contentType, size }) => size <= attachmentMaxBytes(contentType), {
    message: "attachment exceeds declared-type size limit",
    path: ["size"],
  });

/**
 * Legacy comment attribution remains client-authored for wire compatibility.
 * Immutable activity rows are attributed separately from the authenticated
 * socket identity by the BoardDO.
 */
export const CommentSchema = z
  .object({
    id: Identifier,
    cardId: Identifier,
    authorId: Identifier,
    parentCommentId: Identifier.nullable(),
    deleted: z.boolean(),
    body: z.string().max(10_000),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .superRefine((data, ctx) => {
    if (data.deleted) {
      if (data.body !== "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Deleted comment body must be empty",
          path: ["body"],
        });
      }
    } else if (data.body.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "String must contain at least 1 character(s)",
        path: ["body"],
      });
    }
  });

export const RelationKindSchema = z.enum(["relates", "blocks", "subtask"]);

export const ActivityDetailSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("card.created") }),
  z.strictObject({
    type: z.literal("card.renamed"),
    before: Title,
    after: Title,
  }),
  z.strictObject({ type: z.literal("description.updated") }),
  z.strictObject({
    type: z.literal("card.moved"),
    fromColumn: Title,
    toColumn: Title,
  }),
  z.strictObject({
    type: z.literal("card.reordered"),
    column: Title,
  }),
  z.strictObject({
    type: z.literal("assignee.changed"),
    beforeId: Identifier.nullable(),
    afterId: Identifier.nullable(),
  }),
  z.strictObject({
    type: z.literal("priority.changed"),
    before: PrioritySchema,
    after: PrioritySchema,
  }),
  z.strictObject({
    type: z.literal("taskType.changed"),
    before: TaskTypeSchema,
    after: TaskTypeSchema,
  }),
  z.strictObject({
    type: z.literal("dueDate.changed"),
    before: z.iso.date().nullable(),
    after: z.iso.date().nullable(),
  }),
  z.strictObject({ type: z.literal("label.added"), label: Title }),
  z.strictObject({ type: z.literal("label.removed"), label: Title }),
  z.strictObject({ type: z.literal("checklist.added"), item: Title }),
  z.strictObject({
    type: z.literal("checklist.renamed"),
    before: Title,
    after: Title,
  }),
  z.strictObject({ type: z.literal("checklist.completed"), item: Title }),
  z.strictObject({ type: z.literal("checklist.reopened"), item: Title }),
  z.strictObject({ type: z.literal("checklist.deleted"), item: Title }),
  z.strictObject({ type: z.literal("attachment.added"), fileName: Title }),
  z.strictObject({ type: z.literal("attachment.deleted"), fileName: Title }),
  z.strictObject({
    type: z.literal("relation.added"),
    relationKind: RelationKindSchema,
    side: z.enum(["source", "target"]),
    otherCardTitle: Title,
  }),
  z.strictObject({
    type: z.literal("relation.removed"),
    relationKind: RelationKindSchema,
    side: z.enum(["source", "target"]),
    otherCardTitle: Title,
  }),
  z.strictObject({ type: z.literal("comment.edited") }),
  z.strictObject({ type: z.literal("comment.deleted") }),
  z.strictObject({ type: z.literal("subtask.completed") }),
  z.strictObject({ type: z.literal("subtask.reopened") }),
]);

export const ActivitySchema = z.strictObject({
  id: Identifier,
  cardId: Identifier,
  actorId: Identifier,
  sequence: z.number().int().positive(),
  createdAt: z.number(),
  detail: ActivityDetailSchema,
});

/** A link between two cards of the same board. `relates` is symmetric —
 * direction is cosmetic. `blocks` reads as "source blocks target"; the
 * target renders it as "blocked by". `subtask` reads "source is the parent of
 * target"; created only by checklist-item conversion, never by the link
 * composer. Unordered (no `position`). */
export const CardRelationSchema = z.object({
  id: Identifier,
  sourceCardId: Identifier,
  targetCardId: Identifier,
  kind: RelationKindSchema,
});

/** A board-scoped label definition. Cards reference it through CardLabel join rows. */
export const LabelSchema = z.object({ id: Identifier, name: Title, color: LabelColorSchema });

/** One label on one card. Carries its own id so unassign stays `WHERE id = ?`. Unordered. */
export const CardLabelSchema = z.object({ id: Identifier, cardId: Identifier, labelId: Identifier });

/**
 * Client -> server. `mutationId` is a client-generated uuid: the sender sees its
 * own mutation come back in the broadcast and reconciles by that id.
 *
 * Every shape is strict: an accepted frame is rebroadcast byte-for-byte, so
 * unknown keys would otherwise be relayed unvalidated to every other client.
 */
const clientMessages = [
  z.strictObject({
    type: z.literal("card.finish"), mutationId: Identifier,
    id: Identifier, columnId: Identifier, position: Position,
    scope: z.enum(["parent", "family"]),
    expectedParentColumnId: Identifier, expectedParentPosition: Position,
    expectedFamily: z.array(z.strictObject({ id: Identifier, parentId: Identifier, columnId: Identifier, position: Position })).max(10000),
    children: z.array(z.strictObject({ id: Identifier, position: Position })).max(10000),
  }),
  z.strictObject({
    type: z.literal("workflow.configure"), mutationId: Identifier,
    expectedStartingColumnId: Identifier.nullable(),
    expectedCompletedColumnId: Identifier.nullable(),
    startingColumnId: Identifier, completedColumnId: Identifier,
  }),
  z.strictObject({
    type: z.literal("column.create"),
    mutationId: Identifier,
    id: Identifier,
    title: Title,
    position: Position,
  }),
  z.strictObject({
    type: z.literal("column.rename"),
    mutationId: Identifier,
    id: Identifier,
    title: Title,
  }),
  z.strictObject({
    type: z.literal("column.move"),
    mutationId: Identifier,
    id: Identifier,
    position: Position,
  }),
  z.strictObject({
    type: z.literal("column.delete"),
    mutationId: Identifier,
    id: Identifier,
  }),
  /**
   * Creation carries the whole first draft — title, destination and the
   * optional type/priority/assignee — so one accepted frame produces one
   * configured card. Omitted fields keep the defaults every card has always
   * been created with. `subtask` is deliberately not accepted here: a subtask
   * is created by its parent through `subtask.create`.
   */
  z.strictObject({
    type: z.literal("card.create"),
    mutationId: Identifier,
    id: Identifier,
    columnId: Identifier,
    title: Title,
    position: Position,
    taskType: z.enum(["epic", "spike", "task", "bug"]).optional(),
    priority: PrioritySchema.optional(),
    assigneeId: Identifier.nullable().optional(),
  }),
  z.strictObject({
    type: z.literal("card.update"),
    mutationId: Identifier,
    id: Identifier,
    title: Title.optional(),
    description: Description.optional(),
  }),
  z.strictObject({
    type: z.literal("card.move"),
    mutationId: Identifier,
    id: Identifier,
    columnId: Identifier,
    position: Position,
  }),
  z.strictObject({
    type: z.literal("card.delete"),
    mutationId: Identifier,
    id: Identifier,
  }),
  z.strictObject({
    type: z.literal("card.purge"),
    mutationId: Identifier,
    id: Identifier,
  }),
  z.strictObject({
    type: z.literal("card.restore"),
    mutationId: Identifier,
    id: Identifier,
    columnId: Identifier,
    position: Position,
  }),
  // Assignment is its own mutation rather than a `card.update` field: the
  // partial update COALESCEs absent fields, so a null there could not mean
  // "unassign".
  z.strictObject({
    type: z.literal("card.assign"),
    mutationId: Identifier,
    id: Identifier,
    assigneeId: Identifier.nullable(),
  }),
  // Priority follows card.assign, not card.update: it is an instant-send field,
  // not part of the Save-committed title/description draft.
  z.strictObject({
    type: z.literal("card.prioritize"),
    mutationId: Identifier,
    id: Identifier,
    priority: PrioritySchema,
  }),
  z.strictObject({
    type: z.literal("card.retype"),
    mutationId: Identifier,
    id: Identifier,
    taskType: z.enum(["epic", "spike", "task", "bug"]),
  }),
  // A due date is clearable, so like assignment it cannot ride card.update's
  // COALESCE partial — null must mean "remove the deadline".
  z.strictObject({
    type: z.literal("card.schedule"),
    mutationId: Identifier,
    id: Identifier,
    dueDate: z.iso.date().nullable(),
  }),
  /**
   * A subtask is a real card linked to its parent, so its creation writes the
   * child and the parent→child relation in the same transaction: a card the
   * board never linked, or an item deleted without its child, cannot happen.
   * `checklistItemId` makes the same message the checklist conversion, copying
   * the item's own done value into `subtaskDone` and deleting the item.
   */
  z.strictObject({
    type: z.literal("subtask.create"),
    mutationId: Identifier,
    id: Identifier,
    parentCardId: Identifier,
    relationId: Identifier,
    title: NewSubtaskTitle,
    position: Position,
    checklistItemId: Identifier.optional(),
  }),
  z.strictObject({
    type: z.literal("checklist.create"),
    mutationId: Identifier,
    id: Identifier,
    cardId: Identifier,
    text: Title,
    position: Position,
  }),
  z.strictObject({
    type: z.literal("checklist.update"),
    mutationId: Identifier,
    id: Identifier,
    text: Title.optional(),
    done: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("checklist.delete"),
    mutationId: Identifier,
    id: Identifier,
  }),
  z
    .strictObject({
      type: z.literal("attachment.create"),
      mutationId: Identifier,
      id: Identifier,
      cardId: Identifier,
      fileName: Title,
      contentType: z.string().max(ATTACHMENT_POLICY.contentTypeMaxLength),
      size: z.number().int().min(0).max(ATTACHMENT_POLICY.fileMaxBytes),
    })
    .refine(
      ({ contentType }) => contentType === normalizeAttachmentContentType(contentType),
      {
        message: "attachment content type is not canonical",
        path: ["contentType"],
      },
    )
    .refine(({ contentType, size }) => size <= attachmentMaxBytes(contentType), {
      message: "attachment exceeds declared-type size limit",
      path: ["size"],
    }),
  z.strictObject({
    type: z.literal("attachment.delete"),
    mutationId: Identifier,
    id: Identifier,
  }),
  z.strictObject({
    type: z.literal("comment.create"),
    mutationId: Identifier,
    id: Identifier,
    cardId: Identifier,
    authorId: Identifier,
    parentCommentId: Identifier.nullable(),
    body: CommentBody,
    createdAt: z.number(),
  }),
  z.strictObject({
    type: z.literal("comment.update"),
    mutationId: Identifier,
    id: Identifier,
    body: CommentBody,
    updatedAt: z.number(),
  }),
  z.strictObject({
    type: z.literal("comment.delete"),
    mutationId: Identifier,
    id: Identifier,
  }),
  z.strictObject({
    type: z.literal("relation.create"),
    mutationId: Identifier,
    id: Identifier,
    sourceCardId: Identifier,
    targetCardId: Identifier,
    kind: RelationKindSchema,
  }),
  z.strictObject({
    type: z.literal("relation.delete"),
    mutationId: Identifier,
    id: Identifier,
  }),
  z.strictObject({
    type: z.literal("label.create"),
    mutationId: Identifier,
    id: Identifier,
    name: Title,
    color: LabelColorSchema,
  }),
  z.strictObject({
    type: z.literal("label.update"),
    mutationId: Identifier,
    id: Identifier,
    name: Title.optional(),
    color: LabelColorSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("label.delete"),
    mutationId: Identifier,
    id: Identifier,
  }),
  z.strictObject({
    type: z.literal("label.assign"),
    mutationId: Identifier,
    id: Identifier,
    cardId: Identifier,
    labelId: Identifier,
  }),
  z.strictObject({
    type: z.literal("label.unassign"),
    mutationId: Identifier,
    id: Identifier,
  }),
] as const;

export const ClientMessageSchema = z.discriminatedUnion("type", clientMessages);

/** Full board state, sent to a socket immediately after accept. Unordered: clients sort by `position`. Card activity is not in it: clients read one card's history on demand (ADR 0073). */
export const SnapshotSchema = z.object({
  type: z.literal("snapshot"),
  /**
   * False while the board's starting and completed columns follow its ends (the
   * leftmost and rightmost column, none below two); true once an admin chose them.
   */
  workflowRolesExplicit: z.boolean(),
  columns: z.array(ColumnSchema),
  cards: z.array(CardSchema),
  archivedCards: z.array(ArchivedCardSchema),
  checklistItems: z.array(ChecklistItemSchema),
  attachments: z.array(AttachmentSchema),
  comments: z.array(CommentSchema),
  relations: z.array(CardRelationSchema),
  labels: z.array(LabelSchema),
  cardLabels: z.array(CardLabelSchema),
});

/** Sender only. `mutationId` is null when the offending message could not be parsed at all. */
export const ErrorSchema = z.object({
  type: z.literal("error"),
  mutationId: z.string().nullable(),
  message: z.string(),
});

export const ActivityRecordedSchema = z.strictObject({
  type: z.literal("activity.recorded"),
  mutationId: Identifier,
  activities: z.array(ActivitySchema).min(1),
});

export const CardsArchivedSchema = z.strictObject({
  type: z.literal("cards.archived"),
  mutationId: Identifier,
  cards: z.array(ArchivedCardSchema).min(1),
});

export const ArchivePurgedSchema = z.strictObject({
  type: z.literal("archive.purged"),
  cardIds: z.array(Identifier).min(1).max(1000),
});
export const CardNumberedSchema = z.strictObject({
  type: z.literal("card.numbered"),
  mutationId: Identifier,
  id: Identifier,
  taskNumber: TaskNumber,
});


const PositiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * A pull request the per-board integration (ADR 0041) linked to a card by hand. Nothing writes
 * these any more, but a card keeps its row until the Worker adopts it into development info
 * (ADR 0064), so it still travels with the card in a transfer. `revision` is the old link's identity.
 */
export const CardPullRequestAssociationSchema = z.strictObject({
  repositoryId: PositiveSafeInteger,
  number: PositiveSafeInteger,
  revision: z.uuid(),
});

/**
 * Development info (ADR 0064): a pull request a webhook linked to a card. A draft
 * is its own state here; `merged` wins over `closed`. `updatedAt` is GitHub's
 * `updated_at` in epoch milliseconds, the clock that orders writes.
 */
export const DevelopmentPullRequestStateSchema = z.enum(["open", "draft", "merged", "closed"]);

/** Longest PR title or commit message line kept; what GitHub sends past it is cut before it is stored. */
export const DEVELOPMENT_TEXT_MAX = 300;

export const DevelopmentPullRequestSchema = z.strictObject({
  repositoryId: PositiveSafeInteger,
  /** `owner/name` as of the last accepted write. */
  repository: z.string().min(1).max(200),
  number: PositiveSafeInteger,
  title: z.string().max(DEVELOPMENT_TEXT_MAX),
  state: DevelopmentPullRequestStateSchema,
  // Rendered as a link, so only web URLs.
  url: z.url({ protocol: /^https?$/ }).max(2048),
  updatedAt: z.number().int().positive(),
});

/** A branch's latest commit only, no history. `committedAt` is the commit's own time in epoch ms. */
export const DevelopmentBranchSchema = z.strictObject({
  repositoryId: PositiveSafeInteger,
  /** `owner/name` as of the last accepted write. */
  repository: z.string().min(1).max(200),
  name: z.string().min(1).max(255),
  // Rendered as a link, so only web URLs.
  url: z.url({ protocol: /^https?$/ }).max(2048),
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  /** The commit message's first line. */
  message: z.string().max(DEVELOPMENT_TEXT_MAX),
  committedAt: z.number().int().nonnegative(),
});

/** What a card's Development section reads. Link changes announce themselves with a card-scope `github.invalidated` hint. */
export const CardDevelopmentSchema = z.strictObject({
  pullRequests: z.array(DevelopmentPullRequestSchema),
  branches: z.array(DevelopmentBranchSchema),
});

/** What the card fronts read: the pull requests of each card that has any, in one answer per board. */
export const BoardDevelopmentSchema = z.strictObject({
  cards: z.array(z.strictObject({ cardId: Identifier, pullRequests: z.array(DevelopmentPullRequestSchema).min(1) })),
});

/**
 * Server -> client: a card's development info changed (ADR 0064). A hint, never data and never
 * client-writable: the client answers it with an authoritative read. `revision` is always null
 * now; it stays so older clients, which parse it, keep working (ADR 0045).
 */
export const GithubInvalidatedSchema = z.strictObject({
  type: z.literal("github.invalidated"),
  scope: z.literal("card"),
  cardId: Identifier,
  revision: Identifier.nullable(),
});

/**
 * Server -> client: the snapshot, errors, and every applied client mutation
 * forwarded verbatim to all sockets (sender included).
 */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  SnapshotSchema,
  ErrorSchema,
  ActivityRecordedSchema,
  CardsArchivedSchema,
  ArchivePurgedSchema,
  CardNumberedSchema,
  GithubInvalidatedSchema,
  ...clientMessages,
]);

export type Column = z.infer<typeof ColumnSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
export type ActivityDetail = z.infer<typeof ActivityDetailSchema>;
export type Card = z.infer<typeof CardSchema>;
export type ArchivedCard = z.infer<typeof ArchivedCardSchema>;
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type CardRelation = z.infer<typeof CardRelationSchema>;
export type Label = z.infer<typeof LabelSchema>;
export type CardLabel = z.infer<typeof CardLabelSchema>;
export type LabelColor = z.infer<typeof LabelColorSchema>;
export type RelationKind = z.infer<typeof RelationKindSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type CardNumbered = z.infer<typeof CardNumberedSchema>;
export type BoardDevelopment = z.infer<typeof BoardDevelopmentSchema>;
export type CardPullRequestAssociation = z.infer<typeof CardPullRequestAssociationSchema>;
export type DevelopmentBranch = z.infer<typeof DevelopmentBranchSchema>;
export type DevelopmentPullRequest = z.infer<typeof DevelopmentPullRequestSchema>;
export type CardDevelopment = z.infer<typeof CardDevelopmentSchema>;
