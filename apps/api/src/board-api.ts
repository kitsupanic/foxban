import {
  ATTACHMENT_POLICY,
  ActivitySchema,
  CardPullRequestAssociationSchema,
  CardSchema,
  ChecklistItemSchema,
  CommentSchema,
  DevelopmentPullRequestSchema,
  Identifier,
  LabelColorSchema,
  Title,
} from "@foxban/shared";
import { z } from "zod";
import { ATTACHMENT_ID } from "./attachment-lifecycle";
import {
  BranchUnlinkSchema,
  BranchWriteSchema,
  DevelopmentBranchTransferSchema,
  DevelopmentUnlinkSchema,
  PullRequestLinkSchema,
  PullRequestUnlinkSchema,
  PullRequestWriteSchema,
} from "./development-info";
import {
  McpBoardReadRequestSchema,
  McpCommandRequestSchema,
  McpTaskListRequestSchema,
  McpTaskReadRequestSchema,
} from "./mcp-contract";

/**
 * The Worker's internal API to a board's Durable Object: every route the DO answers
 * besides the realtime socket, in one table both sides read. The DO dispatches from it
 * (`BoardDO.fetch`); the Worker's `BoardClient` builds its requests from it. The wire
 * is plain `fetch` to the board's stub, the board named in `INTERNAL_BOARD_ID_HEADER`.
 *
 * A route's `gate` says what the DO checks before it runs the handler:
 *
 *   fence       access prepare/release and board delete. A board id; dispatched ahead of
 *               the deletion and freeze gates, because it is how a board enters and leaves them.
 *   settlement  settling a transfer that already exists. A board id; bypasses deletion and freeze,
 *               so a frozen or deleted board still drains its in-flight transfers.
 *   cleanup     attachment reconcile. A board id; bypasses deletion (a deleted board still
 *               collects its objects) but not freeze on a board that is not deleted.
 *   open        a board id, behind deletion and freeze. No actor: webhooks, reads, the Worker's own bookkeeping.
 *   protected   a board id and an actor, behind deletion and freeze, then the actor is admitted
 *               on the board's current access (`admitProtectedPath`) before the handler runs.
 *
 * `stamp` says whether the DO first records the board's identity (see `stampIdentity`).
 */

// Paths that name no card or attachment.
export const ACCESS_PREPARE_PATH = "/internal/access/prepare";
export const ACCESS_RELEASE_PATH = "/internal/access/release";
export const DELETE_BOARD_PATH = "/internal/board/delete";
export const MCP_BOARD_READ_PATH = "/internal/mcp/board";
export const MCP_TASK_LIST_PATH = "/internal/mcp/tasks";
export const MCP_TASK_READ_PATH = "/internal/mcp/task";
export const MCP_COMMAND_PATH = "/internal/mcp/command";
/** The Worker's webhook handler writes a pull request to a board here. */
export const PULL_REQUEST_WRITE_PATH = "/internal/github/pull-request";
/** The Worker's webhook handler writes a branch's re-read state to a board here. */
export const BRANCH_WRITE_PATH = "/internal/github/branch";
/** The board's pull requests for all its cards, for the card fronts. */
export const BOARD_DEVELOPMENT_PATH = "/internal/development";
export const STAGE_ATTACHMENT_PATH = "/internal/attachments/stage";
export const RECONCILE_ATTACHMENTS_PATH = "/internal/attachments/reconcile";
export const CARD_TRANSFER_OPTIONS_PATH = "/internal/card-transfer/options";
export const CARD_TRANSFER_PREPARE_PATH = "/internal/card-transfer/prepare";
export const CARD_TRANSFER_IMPORT_PATH = "/internal/card-transfer/import";
export const CARD_TRANSFER_FINALIZE_PATH = "/internal/card-transfer/finalize";
export const CARD_TRANSFER_RELEASE_PATH = "/internal/card-transfer/release";
export const CARD_TRANSFER_RECEIPT_PATH = "/internal/card-transfer/receipt";
export const CARD_TRANSFER_ABORT_PATH = "/internal/card-transfer/abort";
// Patterns: `:cardId` is a URL-encoded segment, `:attachmentId` is taken as written.
const CARD_PATH = "/internal/cards/:cardId";
const WRITE_BACK_PATH = `${CARD_PATH}/write-back`;
const CARD_DEVELOPMENT_PATH = `${CARD_PATH}/development`;
const CARD_ACTIVITY_PATH = `${CARD_PATH}/activity`;
const CARD_COMMENTS_PATH = `${CARD_PATH}/comments`;
const CARD_PULL_REQUESTS_PATH = `${CARD_DEVELOPMENT_PATH}/pull-requests`;
const CARD_BRANCHES_PATH = `${CARD_DEVELOPMENT_PATH}/branches`;
const ATTACHMENT_KEY_PATH = "/internal/attachments/key/:attachmentId";

/** The identity the write-back routes (create a branch or pull request from a card) read before and after talking to GitHub. */
export const WriteBackCardSchema = z.strictObject({
  id: Identifier,
  title: Title,
  taskNumber: z.number().int().min(1),
});
export type WriteBackCard = z.infer<typeof WriteBackCardSchema>;

export const PreparedCardTransferBundleSchema = z.strictObject({
  card: CardSchema,
  checklistItems: z.array(ChecklistItemSchema),
  attachments: z
    .array(
      z.strictObject({
        id: Identifier,
        cardId: Identifier,
        fileName: Title,
        contentType: z.string().max(ATTACHMENT_POLICY.contentTypeMaxLength),
        size: z.number().int().min(0).max(ATTACHMENT_POLICY.fileMaxBytes),
        objectKey: z.string().min(1).max(200),
      }),
    ),
  comments: z.array(CommentSchema),
  activities: z.array(ActivitySchema),
  labels: z
    .array(
      z.strictObject({
        id: Identifier,
        name: Title,
        color: LabelColorSchema,
        joinId: Identifier,
      }),
    ),
  /**
   * The card's explicit pull request link travels with it. Its repository id may
   * name a different board's repository, in which case it stays dormant — the
   * destination never resolves its number against its own repository.
   */
  pullRequestAssociation: CardPullRequestAssociationSchema.nullable(),
  /** The pull requests webhooks linked to the card (ADR 0064): the link follows the card to its new board. */
  developmentPullRequests: z.array(DevelopmentPullRequestSchema),
  /** The branches linked to the card (ADR 0064), which follow it like the pull requests. */
  developmentBranches: z.array(DevelopmentBranchTransferSchema),
  /** The card's unlink tombstones (ADR 0064), so an unlink still holds after the move. */
  developmentUnlinks: z.array(DevelopmentUnlinkSchema),
}).superRefine((data, ctx) => {
  const cardId = data.card.id;
  for (let i = 0; i < data.checklistItems.length; i++) {
    if (data.checklistItems[i].cardId !== cardId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `checklistItem[${i}] cardId does not match bundle card id`,
        path: ["checklistItems", i, "cardId"],
      });
    }
  }
  for (let i = 0; i < data.attachments.length; i++) {
    if (data.attachments[i].cardId !== cardId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `attachment[${i}] cardId does not match bundle card id`,
        path: ["attachments", i, "cardId"],
      });
    }
  }
  for (let i = 0; i < data.comments.length; i++) {
    if (data.comments[i].cardId !== cardId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `comment[${i}] cardId does not match bundle card id`,
        path: ["comments", i, "cardId"],
      });
    }
  }
  for (let i = 0; i < data.activities.length; i++) {
    if (data.activities[i].cardId !== cardId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `activity[${i}] cardId does not match bundle card id`,
        path: ["activities", i, "cardId"],
      });
    }
  }
});

export type PreparedCardTransferBundle = z.infer<typeof PreparedCardTransferBundleSchema>;

export const CardTransferImportPayloadSchema = z.strictObject({
  transferId: Identifier,
  sourceBoardId: Identifier,
  destinationColumnId: Identifier,
  assigneeId: Identifier.nullable().optional(),
  bundle: PreparedCardTransferBundleSchema,
});

export const CardTransferPreparePayloadSchema = z.strictObject({
  transferId: Identifier,
  cardId: Identifier,
  destinationBoardId: Identifier,
});

export const CardTransferFinalizePayloadSchema = z.strictObject({
  transferId: Identifier,
  cardId: Identifier,
  destinationBoardId: Identifier.optional(),
});

export const CardTransferReleasePayloadSchema = z.strictObject({
  transferId: Identifier,
  cardId: Identifier,
  destinationBoardId: Identifier.optional(),
});
export const CardTransferAbortPayloadSchema = z.strictObject({
  transferId: Identifier,
  sourceBoardId: Identifier,
  cardId: Identifier,
});
export const CardTransferReceiptQuerySchema = z.strictObject({
  transferId: Identifier,
  sourceBoardId: Identifier,
  cardId: Identifier,
});

export type CardTransferReceipt = {
  sourceBoardId: string;
  cardId: string;
  transferId: string;
  taskNumber: number;
};

const AccessOperationSchema = z.looseObject({ operationId: z.string(), generation: z.number() });
/** Any JSON object: the reconcile body is read leniently, entry by entry. */
const ReconcileBodySchema = z.custom<Record<string, unknown>>((value) => typeof value === "object" && value !== null);
const StageAttachmentSchema = z.looseObject({ id: z.string().regex(ATTACHMENT_ID), objectKey: z.unknown().optional() });

type Method = "GET" | "POST" | "DELETE";
export type Gate = "fence" | "settlement" | "cleanup" | "open" | "protected";

type Base<G extends Gate> = {
  path: string;
  methods: readonly Method[];
  gate: G;
  /** Whether the DO records the board's identity before anything else; see `BoardDO.stampIdentity`. */
  stamp: boolean;
  /** A bad board id and a bad actor id answer the same "invalid identity" (the MCP routes). */
  joinedIdentity?: true;
};
type Body<S extends z.ZodType> = {
  input: S;
  /** The 400 a body the schema rejects gets. A function, because a Response is read once. */
  invalid: () => Response;
  /** The board the body says it is for; the dispatcher refuses a body for another board before admission. */
  boardOf?: (input: z.output<S>) => string;
  /** The user the body assigns work to, if any: admission also reads whether that user may be assigned. */
  assignee?: (input: z.output<S>) => string | null;
};

/** A route with no body. */
function route<const G extends Gate>(spec: Base<G>): Base<G> & { input?: undefined } {
  return spec;
}
/** A route whose body its schema parses, and whose rejection answers `invalid`. */
function bodyRoute<const G extends Gate, S extends z.ZodType>(spec: Base<G> & Body<S>): Base<G> & Body<S> {
  return spec;
}

const invalidText = (text: string) => () => new Response(text, { status: 400 });
const invalidJson = (code: string, error: string) => () => Response.json({ code, error }, { status: 400 });

export const boardRoutes = {
  accessPrepare: bodyRoute({
    path: ACCESS_PREPARE_PATH, methods: ["POST"], gate: "fence", stamp: false,
    input: AccessOperationSchema, invalid: invalidText("invalid access operation"),
  }),
  accessRelease: bodyRoute({
    path: ACCESS_RELEASE_PATH, methods: ["POST"], gate: "fence", stamp: false,
    input: AccessOperationSchema, invalid: invalidText("invalid access operation"),
  }),
  boardDelete: route({ path: DELETE_BOARD_PATH, methods: ["POST"], gate: "fence", stamp: false }),

  transferReceipt: bodyRoute({
    path: CARD_TRANSFER_RECEIPT_PATH, methods: ["POST"], gate: "settlement", stamp: true,
    input: CardTransferReceiptQuerySchema, invalid: invalidText("invalid receipt query payload"),
  }),
  transferAbort: bodyRoute({
    path: CARD_TRANSFER_ABORT_PATH, methods: ["POST"], gate: "settlement", stamp: true,
    input: CardTransferAbortPayloadSchema, invalid: invalidText("invalid abort payload"),
  }),
  transferFinalize: bodyRoute({
    path: CARD_TRANSFER_FINALIZE_PATH, methods: ["POST"], gate: "settlement", stamp: true,
    input: CardTransferFinalizePayloadSchema, invalid: invalidText("invalid finalize payload"),
  }),
  transferRelease: bodyRoute({
    path: CARD_TRANSFER_RELEASE_PATH, methods: ["POST"], gate: "settlement", stamp: true,
    input: CardTransferReleasePayloadSchema, invalid: invalidText("invalid release payload"),
  }),

  attachmentsReconcile: bodyRoute({
    path: RECONCILE_ATTACHMENTS_PATH, methods: ["POST"], gate: "cleanup", stamp: true,
    input: ReconcileBodySchema, invalid: invalidText("invalid request body"),
  }),

  writeBack: route({ path: WRITE_BACK_PATH, methods: ["GET"], gate: "open", stamp: false }),
  boardDevelopment: route({ path: BOARD_DEVELOPMENT_PATH, methods: ["GET"], gate: "open", stamp: false }),
  cardDevelopment: route({ path: CARD_DEVELOPMENT_PATH, methods: ["GET"], gate: "open", stamp: false }),
  cardActivity: route({ path: CARD_ACTIVITY_PATH, methods: ["GET"], gate: "open", stamp: false }),
  cardComments: route({ path: CARD_COMMENTS_PATH, methods: ["GET"], gate: "open", stamp: false }),
  pullRequestWrite: bodyRoute({
    path: PULL_REQUEST_WRITE_PATH, methods: ["POST"], gate: "open", stamp: false,
    input: PullRequestWriteSchema, invalid: invalidText("invalid pull request write"),
  }),
  branchWrite: bodyRoute({
    path: BRANCH_WRITE_PATH, methods: ["POST"], gate: "open", stamp: false,
    input: BranchWriteSchema, invalid: invalidText("invalid branch write"),
  }),
  attachmentKey: route({ path: ATTACHMENT_KEY_PATH, methods: ["GET"], gate: "open", stamp: true }),
  transferOptions: route({ path: CARD_TRANSFER_OPTIONS_PATH, methods: ["POST"], gate: "open", stamp: true }),

  mcpBoard: bodyRoute({
    path: MCP_BOARD_READ_PATH, methods: ["POST"], gate: "protected", stamp: false, joinedIdentity: true,
    input: McpBoardReadRequestSchema, invalid: invalidText("invalid request"), boardOf: (input) => input.board.id,
  }),
  mcpTasks: bodyRoute({
    path: MCP_TASK_LIST_PATH, methods: ["POST"], gate: "protected", stamp: false, joinedIdentity: true,
    input: McpTaskListRequestSchema, invalid: invalidText("invalid request"), boardOf: (input) => input.board.id,
  }),
  mcpTask: bodyRoute({
    path: MCP_TASK_READ_PATH, methods: ["POST"], gate: "protected", stamp: false, joinedIdentity: true,
    input: McpTaskReadRequestSchema, invalid: invalidText("invalid request"), boardOf: (input) => input.board.id,
  }),
  mcpCommand: bodyRoute({
    path: MCP_COMMAND_PATH, methods: ["POST"], gate: "protected", stamp: false, joinedIdentity: true,
    input: McpCommandRequestSchema, invalid: invalidText("invalid request"), boardOf: (input) => input.board.id,
    assignee: (input) => (input.command.operation === "create_task" ? input.command.assigneeId : null),
  }),
  pullRequestLink: bodyRoute({
    path: CARD_PULL_REQUESTS_PATH, methods: ["POST"], gate: "protected", stamp: false,
    input: PullRequestLinkSchema, invalid: invalidJson("invalid_pr_reference", "invalid pull request"),
  }),
  pullRequestUnlink: bodyRoute({
    path: CARD_PULL_REQUESTS_PATH, methods: ["DELETE"], gate: "protected", stamp: false,
    input: PullRequestUnlinkSchema, invalid: invalidJson("invalid_pr_reference", "invalid pull request"),
  }),
  branchUnlink: bodyRoute({
    path: CARD_BRANCHES_PATH, methods: ["DELETE"], gate: "protected", stamp: false,
    input: BranchUnlinkSchema, invalid: invalidJson("invalid_branch_reference", "invalid branch"),
  }),
  attachmentStage: bodyRoute({
    path: STAGE_ATTACHMENT_PATH, methods: ["POST"], gate: "protected", stamp: true,
    input: StageAttachmentSchema, invalid: invalidText("invalid attachment id"),
  }),
  transferPrepare: bodyRoute({
    path: CARD_TRANSFER_PREPARE_PATH, methods: ["POST"], gate: "protected", stamp: true,
    input: CardTransferPreparePayloadSchema, invalid: invalidText("invalid transfer payload"),
  }),
  transferImport: bodyRoute({
    path: CARD_TRANSFER_IMPORT_PATH, methods: ["POST"], gate: "protected", stamp: true,
    input: CardTransferImportPayloadSchema, invalid: invalidText("invalid import payload"),
  }),
};

export type BoardRoutes = typeof boardRoutes;
export type RouteName = keyof BoardRoutes;
export type RouteGate<K extends RouteName> = BoardRoutes[K]["gate"];
/** What a route's handler receives as its parsed body; `undefined` for a route with none. */
export type RouteInput<K extends RouteName> = BoardRoutes[K] extends { input: infer S extends z.ZodType } ? z.output<S> : undefined;

/** A route as the dispatcher reads it, without the per-route body types. */
export type RouteSpec = Base<Gate> & {
  input?: z.ZodType;
  invalid?: () => Response;
  // `any`: the dispatcher only ever passes a body its own schema parsed.
  boardOf?: (input: any) => string;
  assignee?: (input: any) => string | null;
};

type Compiled = { name: RouteName; spec: RouteSpec; exact: string | null; prefix: string; suffix: string; param: string };
const PARAM = /:(\w+)/;
const compiled: Compiled[] = (Object.keys(boardRoutes) as RouteName[]).map((name) => {
  const spec: RouteSpec = boardRoutes[name];
  const found = PARAM.exec(spec.path);
  if (!found) return { name, spec, exact: spec.path, prefix: "", suffix: "", param: "" };
  return {
    name,
    spec,
    exact: null,
    prefix: spec.path.slice(0, found.index),
    suffix: spec.path.slice(found.index + found[0].length),
    param: found[1]!,
  };
});

export type RouteMatch = { name: RouteName; spec: RouteSpec; params: Record<string, string> };

/**
 * The route a request is for: the one that answers its method, else one that answers its
 * path (the dispatcher refuses the method), else null. A pattern matches the way the DO
 * always read card paths: by its prefix and suffix, whatever lies between is the parameter.
 * Parameters come back as written; `decodeParams` undoes the encoding of the ones that have it.
 */
export function matchRoute(pathname: string, method: string): RouteMatch | null {
  let wrongMethod: RouteMatch | null = null;
  for (const { name, spec, exact, prefix, suffix, param } of compiled) {
    let params: Record<string, string>;
    if (exact !== null) {
      if (pathname !== exact) continue;
      params = {};
    } else {
      if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) continue;
      params = { [param]: pathname.slice(prefix.length, pathname.length - suffix.length) };
    }
    const match = { name, spec, params };
    if ((spec.methods as readonly string[]).includes(method)) return match;
    wrongMethod ??= match;
  }
  return wrongMethod;
}

/** Card ids travel URL-encoded; the attachment id is a uuid and is read as written. */
export function decodeParams(params: Record<string, string>): Record<string, string> {
  return "cardId" in params ? { ...params, cardId: decodeURIComponent(params.cardId) } : params;
}

/** The path a route is called on, parameters filled in. */
export function routePath(name: RouteName, params: Record<string, string> = {}): string {
  return boardRoutes[name].path.replace(PARAM, (_, key: string) => (key === "cardId" ? encodeURIComponent(params[key]) : params[key]));
}
