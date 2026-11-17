import {
  CommentSchema,
  Identifier,
  LabelColorSchema,
  PrioritySchema,
  TaskTypeSchema,
  Title,
  descriptionByteLength,
} from "@foxban/shared";
import { z } from "zod";

export const AgentScopeSchema = z.enum(["boards:read", "tasks:write", "comments:write"]);
export type AgentScope = z.infer<typeof AgentScopeSchema>;

export const BoardKeySchema = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/);
const TaskKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^([A-Z][A-Z0-9]{1,9})-([1-9][0-9]*)$/)
  .refine((value) => Number.isSafeInteger(Number(value.slice(value.lastIndexOf("-") + 1))));
export const BoardRefSchema = z.union([
  z.strictObject({ id: Identifier }),
  z.strictObject({ key: BoardKeySchema }),
]);
export const TaskRefSchema = z.union([
  z.strictObject({ id: Identifier }),
  z.strictObject({ key: TaskKeySchema }),
]);
export const PageInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
const CommentPageInputSchema = PageInputSchema.extend({
  limit: z.number().int().min(1).max(50).optional(),
});
const SubtaskPageInputSchema = PageInputSchema.extend({
  limit: z.number().int().min(1).max(50).optional(),
});
export const PlacementSchema = z.union([
  z.strictObject({ before: TaskRefSchema }),
  z.strictObject({ after: TaskRefSchema }),
]);
const OperationKeySchema = z.uuid().transform((value) => value.toLowerCase());
const McpTitleSchema = z.string().trim().min(1).max(200);
const DescriptionSchema = z
  .string()
  .refine((value) => descriptionByteLength(value) <= 100_000, "Description must be 100,000 bytes or fewer.");

export const ListBoardsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(2048).optional(),
});
export const GetBoardInputSchema = z.strictObject({
  board: BoardRefSchema,
  columns: PageInputSchema.optional(),
  members: PageInputSchema.optional(),
  labels: PageInputSchema.optional(),
});
export const ListTasksInputSchema = z.strictObject({
  board: BoardRefSchema,
  query: z.string().max(200).optional(),
  columnId: Identifier.optional(),
  assigneeId: Identifier.nullable().optional(),
  state: z.enum(["active", "archived", "all"]).default("active"),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(2048).optional(),
});
export const GetTaskInputSchema = z.strictObject({
  board: BoardRefSchema,
  task: TaskRefSchema,
  comments: CommentPageInputSchema.optional(),
  checklist: PageInputSchema.optional(),
  subtasks: SubtaskPageInputSchema.optional(),
  labels: PageInputSchema.optional(),
});
export const CreateTaskInputSchema = z.strictObject({
  board: BoardRefSchema,
  operationKey: OperationKeySchema,
  columnId: Identifier,
  title: McpTitleSchema,
  taskType: z.enum(["epic", "spike", "task", "bug"]).default("task"),
  priority: PrioritySchema.default("medium"),
  assigneeId: Identifier.nullable().default(null),
});
export const UpdateTaskInputSchema = z
  .strictObject({
    board: BoardRefSchema,
    operationKey: OperationKeySchema,
    task: TaskRefSchema,
    title: McpTitleSchema.optional(),
    description: DescriptionSchema.optional(),
  })
  .refine((value) => value.title !== undefined || value.description !== undefined, {
    message: "at least one update field is required",
  });
export const MoveTaskInputSchema = z.strictObject({
  board: BoardRefSchema,
  operationKey: OperationKeySchema,
  task: TaskRefSchema,
  columnId: Identifier,
  placement: PlacementSchema.optional(),
});
export const AddCommentInputSchema = z.strictObject({
  board: BoardRefSchema,
  operationKey: OperationKeySchema,
  task: TaskRefSchema,
  body: z.string().min(1).max(10_000),
});
export const CompleteSubtaskInputSchema = z.strictObject({
  board: BoardRefSchema,
  operationKey: OperationKeySchema,
  task: TaskRefSchema,
  done: z.boolean(),
});
export const CreateLabelInputSchema = z.strictObject({
  board: BoardRefSchema,
  operationKey: OperationKeySchema,
  name: McpTitleSchema,
  color: LabelColorSchema,
});
export const UpdateLabelInputSchema = z
  .strictObject({
    board: BoardRefSchema,
    operationKey: OperationKeySchema,
    labelId: Identifier,
    name: McpTitleSchema.optional(),
    color: LabelColorSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: "at least one update field is required",
  });
export const AssignLabelInputSchema = z.strictObject({
  board: BoardRefSchema,
  operationKey: OperationKeySchema,
  task: TaskRefSchema,
  labelId: Identifier,
});
export const UnassignLabelInputSchema = z.strictObject({
  board: BoardRefSchema,
  operationKey: OperationKeySchema,
  task: TaskRefSchema,
  cardLabelId: Identifier,
});

export const McpBoardIdentitySchema = z.strictObject({
  id: Identifier,
  key: BoardKeySchema,
  name: z.string().min(1).max(200),
  appOrigin: z.url(),
});
export type McpBoardIdentity = z.infer<typeof McpBoardIdentitySchema>;

export const McpCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("create_task"), operationKey: OperationKeySchema,
    columnId: Identifier, title: McpTitleSchema,
    taskType: z.enum(["epic", "spike", "task", "bug"]), priority: PrioritySchema,
    assigneeId: Identifier.nullable(),
  }),
  z.strictObject({
    operation: z.literal("update_task"), operationKey: OperationKeySchema,
    task: TaskRefSchema, title: McpTitleSchema.optional(), description: DescriptionSchema.optional(),
  }).refine((value) => value.title !== undefined || value.description !== undefined),
  z.strictObject({
    operation: z.literal("move_task"), operationKey: OperationKeySchema,
    task: TaskRefSchema, columnId: Identifier, placement: PlacementSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("add_comment"), operationKey: OperationKeySchema,
    task: TaskRefSchema, body: z.string().min(1).max(10_000),
  }),
  z.strictObject({
    operation: z.literal("complete_subtask"), operationKey: OperationKeySchema,
    task: TaskRefSchema, done: z.boolean(),
  }),
  z.strictObject({
    operation: z.literal("create_label"), operationKey: OperationKeySchema,
    name: McpTitleSchema, color: LabelColorSchema,
  }),
  z.strictObject({
    operation: z.literal("update_label"), operationKey: OperationKeySchema,
    labelId: Identifier, name: McpTitleSchema.optional(), color: LabelColorSchema.optional(),
  }).refine((value) => value.name !== undefined || value.color !== undefined),
  z.strictObject({
    operation: z.literal("assign_label"), operationKey: OperationKeySchema,
    task: TaskRefSchema, labelId: Identifier,
  }),
  z.strictObject({
    operation: z.literal("unassign_label"), operationKey: OperationKeySchema,
    task: TaskRefSchema, cardLabelId: Identifier,
  }),
]);
export type McpCommand = z.infer<typeof McpCommandSchema>;

export const McpCommandRequestSchema = z.strictObject({
  credentialId: Identifier,
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  board: McpBoardIdentitySchema,
  command: McpCommandSchema,
});
export type McpCommandRequest = z.infer<typeof McpCommandRequestSchema>;

export const McpTaskListRequestSchema = z.strictObject({
  board: McpBoardIdentitySchema,
  query: z.string().max(200).default(""),
  columnId: Identifier.optional(),
  assigneeId: Identifier.nullable().optional(),
  state: z.enum(["active", "archived", "all"]),
  limit: z.number().int().min(1).max(100),
  cursor: z.string().min(1).max(2048).optional(),
});
export const McpTaskReadRequestSchema = z.strictObject({
  board: McpBoardIdentitySchema,
  task: TaskRefSchema,
  comments: CommentPageInputSchema.optional(),
  checklist: PageInputSchema.optional(),
  subtasks: SubtaskPageInputSchema.optional(),
  labels: PageInputSchema.optional(),
});
export const McpBoardReadRequestSchema = z.strictObject({
  board: McpBoardIdentitySchema,
  columns: PageInputSchema.optional(),
  labels: PageInputSchema.optional(),
});

export const TaskIdentitySchema = z.strictObject({
  id: Identifier, boardId: Identifier, taskNumber: z.number().int().positive(),
  key: TaskKeySchema, url: z.url(),
});
export const TaskSummarySchema = TaskIdentitySchema.extend({
  title: z.string().max(200), priority: PrioritySchema, taskType: TaskTypeSchema,
  assigneeId: Identifier.nullable(), dueDate: z.iso.date().nullable(), subtaskDone: z.boolean(),
  position: Identifier, createdAt: z.number(), updatedAt: z.number(),
  storedColumnId: Identifier, effectiveColumnId: Identifier.nullable(),
  archivedAt: z.number().nullable(), archivedColumnTitle: z.string().max(200).nullable(),
});
export const TaskRecordSchema = TaskSummarySchema.extend({
  description: DescriptionSchema,
  column: z.strictObject({ id: Identifier, title: z.string().max(200) }).nullable(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const McpErrorCodeSchema = z.enum([
  "forbidden", "unauthorized", "invalid_cursor", "task_not_found", "invalid_task_key",
  "column_not_found", "label_not_found", "label_assignment_not_found", "assignee_not_member",
  "task_archived", "transfer_conflict", "subtask_unavailable",
  "invalid_placement", "position_conflict", "idempotency_conflict",
  "board_deleted", "result_too_large", "internal_error",
]);
export const McpErrorSchema = z.strictObject({ code: McpErrorCodeSchema, message: z.string(), retryable: z.boolean() });
export type McpError = z.infer<typeof McpErrorSchema>;
export const McpFailureSchema = z.strictObject({ ok: z.literal(false), error: McpErrorSchema });
export const McpSuccessSchema = z.strictObject({ ok: z.literal(true), data: z.unknown() });
export const McpToolResultSchema = z.union([McpSuccessSchema, McpFailureSchema]);
export type McpToolResult<T = unknown> = { ok: true; data: T } | { ok: false; error: McpError };

export const McpCommentResultSchema = z.strictObject({
  operationKey: z.uuid(), task: TaskIdentitySchema, comment: CommentSchema,
});

const PageSchema = <Item extends z.ZodType>(item: Item) => z.strictObject({
  items: z.array(item),
  nextCursor: z.string().nullable(),
});
const LabelSchema = z.strictObject({
  id: Identifier,
  name: Title,
  color: LabelColorSchema,
});
const BoardListItemSchema = z.strictObject({
  id: Identifier,
  key: BoardKeySchema,
  name: z.string().min(1).max(200),
  url: z.url(),
});
const BoardDataSchema = BoardListItemSchema.extend({
  columns: PageSchema(z.strictObject({
    id: Identifier, title: z.string().max(200), position: Identifier,
    starting: z.boolean().optional(), completed: z.boolean().optional(),
  })),
  members: PageSchema(z.strictObject({ id: Identifier, name: z.string().max(200) })),
  labels: PageSchema(LabelSchema),
});
const TaskMutationDataSchema = z.strictObject({
  operationKey: z.uuid(),
  task: TaskRecordSchema,
});
const TaskReadDataSchema = z.strictObject({
  task: TaskRecordSchema,
  parent: TaskSummarySchema.nullable(),
  comments: PageSchema(CommentSchema),
  checklist: PageSchema(z.strictObject({
    id: Identifier,
    cardId: Identifier,
    text: z.string().max(200),
    done: z.boolean(),
    position: Identifier,
  })),
  subtasks: PageSchema(TaskSummarySchema),
  labels: PageSchema(z.strictObject({
    id: Identifier,
    cardId: Identifier,
    labelId: Identifier,
    name: Title,
    color: LabelColorSchema,
  })),
});
const LabelMutationDataSchema = z.strictObject({
  operationKey: z.uuid(),
  label: LabelSchema,
});
const AssignLabelDataSchema = z.strictObject({
  operationKey: z.uuid(),
  task: TaskIdentitySchema,
  cardLabel: z.strictObject({ id: Identifier, cardId: Identifier, labelId: Identifier }),
});
const UnassignLabelDataSchema = z.strictObject({
  operationKey: z.uuid(),
  task: TaskIdentitySchema,
  cardLabelId: Identifier,
});
const toolOutputSchema = <Data extends z.ZodType>(data: Data) => z.union([
  z.strictObject({ ok: z.literal(true), data }),
  McpFailureSchema,
]);
export const ListBoardsOutputSchema = toolOutputSchema(PageSchema(BoardListItemSchema));
export const GetBoardOutputSchema = toolOutputSchema(BoardDataSchema);
export const ListTasksOutputSchema = toolOutputSchema(PageSchema(TaskSummarySchema));
export const GetTaskOutputSchema = toolOutputSchema(TaskReadDataSchema);
export const TaskMutationOutputSchema = toolOutputSchema(TaskMutationDataSchema);
export const AddCommentOutputSchema = toolOutputSchema(McpCommentResultSchema);
export const LabelMutationOutputSchema = toolOutputSchema(LabelMutationDataSchema);
export const AssignLabelOutputSchema = toolOutputSchema(AssignLabelDataSchema);
export const UnassignLabelOutputSchema = toolOutputSchema(UnassignLabelDataSchema);

const CursorPayloadSchema = z.strictObject({
  v: z.literal(1),
  kind: z.string().min(1),
  boardId: z.string().optional(),
  taskId: z.string().optional(),
  filters: z.unknown().optional(),
  after: z.unknown(),
});

export type CursorPayload = {
  v: 1;
  kind: string;
  boardId?: string;
  taskId?: string;
  filters?: unknown;
  after: unknown;
};
export function encodeCursor(value: CursorPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export function decodeCursor(value: string): CursorPayload | null {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    const result = CursorPayloadSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
