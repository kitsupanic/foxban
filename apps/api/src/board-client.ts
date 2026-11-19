import { ActivitySchema, BoardDevelopmentSchema, CardDevelopmentSchema, CommentSchema, type Activity, type Comment, type BoardDevelopment, type CardDevelopment, type Column, type DevelopmentPullRequest } from "@foxban/shared";
import { z } from "zod";
import {
  WriteBackCardSchema,
  boardRoutes,
  routePath,
  type CardTransferReceipt,
  type PreparedCardTransferBundle,
  type RouteInput,
  type RouteName,
  type WriteBackCard,
} from "./board-api";
import type { BranchWrite, PullRequestWrite } from "./development-info";
import {
  INTERNAL_BOARD_ID_HEADER,
  INTERNAL_CAN_MANAGE_COLUMNS_HEADER,
  INTERNAL_SESSION_HASH_HEADER,
  INTERNAL_USER_ID_HEADER,
  upgradeHeaders,
} from "./internal-headers";
import { McpToolResultSchema, type McpToolResult } from "./mcp-contract";

/**
 * The Worker's side of the internal API (`board-api.ts`): every request a Worker makes to
 * a board's Durable Object is built here, and this is the only module that spells the
 * internal origin. Each method is one route; it decodes the answer the way its caller
 * always did, so the caller sees a typed result and not an HTTP response. The routes'
 * checks and their error bodies belong to `BoardDO.fetch`, not to this file.
 */

type ErrorBody = { error?: string; code?: string };
/** A participant's answer: its HTTP status and parsed body (`{}` when there is none). */
export type Reply<T = ErrorBody> = { status: number; body: T };

/** What a board answers for a card's development info: the public part, and old manual links for the Worker to adopt. */
const CardDevelopmentReadSchema = CardDevelopmentSchema.extend({
  legacy: z.array(z.strictObject({ repositoryId: z.number().int(), number: z.number().int(), taskNumber: z.number().int() })),
});

export type McpRoute = "mcpBoard" | "mcpTasks" | "mcpTask" | "mcpCommand";

type Call = {
  params?: Record<string, string>;
  userId?: string;
  canManageColumns?: boolean;
  body?: unknown;
  timeoutMs?: number;
};

export function boardClient(env: Env, boardId: string) {
  const stub = () => env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));

  /** One request to the board: the method comes from the route, the board is named in the header the DO insists on. */
  function call(name: RouteName, { params, userId, canManageColumns, body, timeoutMs }: Call = {}): Promise<Response> {
    const headers = new Headers({ [INTERNAL_BOARD_ID_HEADER]: boardId });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (userId) headers.set(INTERNAL_USER_ID_HEADER, userId);
    if (canManageColumns !== undefined) headers.set(INTERNAL_CAN_MANAGE_COLUMNS_HEADER, String(canManageColumns));
    return stub().fetch(`https://board.internal${routePath(name, params)}`, {
      method: boardRoutes[name].methods[0],
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
    });
  }

  /** A fence call: true when the board answered 2xx, false when it refused or did not answer in time. */
  async function fence(name: RouteName, options: Call): Promise<boolean> {
    try {
      return (await call(name, options)).ok;
    } catch {
      return false;
    }
  }

  /** Posts one development-info write to a board; true when it changed any card. */
  async function developmentWrite(name: "pullRequestWrite" | "branchWrite", write: unknown): Promise<boolean> {
    const response = await call(name, { body: write });
    // A board deleted since its pointer was written has nothing to update.
    if (response.status === 410) return false;
    if (!response.ok) throw new Error(`board ${boardId} refused a development write to ${routePath(name)}: ${response.status}`);
    return (await response.json<{ changed: boolean }>()).changed;
  }

  async function reply<T>(response: Promise<Response>): Promise<Reply<T>> {
    const res = await response;
    return { status: res.status, body: ((await res.json().catch(() => null)) ?? {}) as T };
  }

  return {
    /** Freezes the board for an access operation. The timeout bounds the participant, not the operation. */
    prepareAccess: (op: RouteInput<"accessPrepare">, timeoutMs: number) => fence("accessPrepare", { body: op, timeoutMs }),
    releaseAccess: (op: RouteInput<"accessRelease">, timeoutMs: number) => fence("accessRelease", { body: op, timeoutMs }),
    /** The terminal deletion of the board's content; retried after a lost response. */
    deleteBoard: (timeoutMs: number) => fence("boardDelete", { timeoutMs }),
    /** Closes the open sockets a session revocation names (ADR 0082); true when the board answered 2xx. */
    revokeSessions: (revocation: RouteInput<"sessionRevoke">, timeoutMs: number) => fence("sessionRevoke", { body: revocation, timeoutMs }),

    /** One MCP tool call, answered in the contract's shape whatever the board did. */
    async mcp(route: McpRoute, actor: { userId: string; canManageColumns: boolean }, body: unknown): Promise<McpToolResult> {
      const response = await call(route, { ...actor, body });
      if (response.status === 410) return { ok: false, error: { code: "board_deleted", message: "Board was deleted.", retryable: false } };
      if (!response.ok) return { ok: false, error: { code: "internal_error", message: "Board service failed; retry with the same operationKey.", retryable: true } };
      return McpToolResultSchema.parse(await response.json());
    },

    /**
     * The active card a write-back route acts on (its id, title and task number), parsed at
     * the boundary. `null` means the card is missing or archived; `"unreadable"` means the
     * board could not answer.
     */
    async writeBackCard(cardId: string): Promise<WriteBackCard | null | "unreadable"> {
      const response = await call("writeBack", { params: { cardId } });
      if (response.status === 404) return null;
      if (!response.ok) return "unreadable";
      const parsed = WriteBackCardSchema.safeParse(await response.json().catch(() => null));
      return parsed.success ? parsed.data : "unreadable";
    },

    writePullRequest: (write: PullRequestWrite) => developmentWrite("pullRequestWrite", write),
    writeBranch: (write: BranchWrite) => developmentWrite("branchWrite", write),

    /** A card's development info with the old manual links to adopt, or null when the card is missing or archived. */
    async cardDevelopment(cardId: string) {
      const response = await call("cardDevelopment", { params: { cardId } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`board ${boardId} could not read development info: ${response.status}`);
      return CardDevelopmentReadSchema.parse(await response.json());
    },

    /** A card's immutable activity in sequence order (empty for an unknown card). Throws when the board cannot answer. */
    async cardActivity(cardId: string): Promise<Activity[]> {
      const response = await call("cardActivity", { params: { cardId } });
      if (!response.ok) throw new Error(`board ${boardId} could not read card activity: ${response.status}`);
      return z.object({ activities: z.array(ActivitySchema) }).parse(await response.json()).activities;
    },

    /** A card's comments, tombstones included (empty for an unknown card). Throws when the board cannot answer. */
    async cardComments(cardId: string): Promise<Comment[]> {
      const response = await call("cardComments", { params: { cardId } });
      if (!response.ok) throw new Error(`board ${boardId} could not read card comments: ${response.status}`);
      return z.object({ comments: z.array(CommentSchema) }).parse(await response.json()).comments;
    },

    async boardDevelopment(): Promise<BoardDevelopment> {
      const response = await call("boardDevelopment");
      if (!response.ok) throw new Error(`board ${boardId} could not read development info: ${response.status}`);
      return BoardDevelopmentSchema.parse(await response.json());
    },

    /**
     * A member's manual link or unlink of a pull request, or unlink of a branch, committed by
     * the board under the actor's own access. The answer is the card's development info
     * afterwards, or the board's refusal.
     */
    async changeCardLink(
      userId: string,
      cardId: string,
      change: { link: DevelopmentPullRequest } | { unlink: { repositoryId: number; number: number } } | { unlinkBranch: { repositoryId: number; name: string } },
    ): Promise<{ ok: true; development: CardDevelopment } | { ok: false; status: number; code: string; error: string }> {
      const [route, sent] =
        "link" in change
          ? (["pullRequestLink", { pullRequest: change.link }] as const)
          : "unlink" in change
            ? (["pullRequestUnlink", change.unlink] as const)
            : (["branchUnlink", change.unlinkBranch] as const);
      const response = await call(route, { params: { cardId }, userId, body: sent });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const development = CardDevelopmentSchema.safeParse(body);
        if (development.success) return { ok: true, development: development.data };
      }
      const failure = z.object({ code: z.string(), error: z.string() }).safeParse(body);
      return {
        ok: false,
        status: response.ok || response.status >= 500 ? 502 : response.status,
        code: failure.success ? failure.data.code : "github_error",
        error: failure.success ? failure.data.error : "Could not save the change.",
      };
    },

    /** The R2 key of an attachment the board knows (or has staged), or null when it has no such row. Throws when the board cannot answer. */
    async attachmentKey(attachmentId: string): Promise<string | null> {
      const response = await call("attachmentKey", { params: { attachmentId } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`board ${boardId} could not read an attachment key: ${response.status}`);
      const data = (await response.json()) as { objectKey?: string };
      return data.objectKey || null;
    },

    /** Leases the object key an upload is about to write, as `userId`; true when the board admitted it. */
    async stageAttachment(userId: string, attachment: { id: string }): Promise<boolean> {
      return (await call("attachmentStage", { userId, body: attachment })).ok;
    },

    /** Queues the objects R2 holds for this board that its rows no longer own; true when the board accepted them. */
    async reconcileAttachments(objects: Array<{ key: string; attachmentId: string }>): Promise<boolean> {
      return (await call("attachmentsReconcile", { body: { objects } })).ok;
    },

    /** The columns a card could be transferred into. Throws when the board refuses. */
    async transferOptions(): Promise<Array<Pick<Column, "id" | "title" | "position">>> {
      const response = await call("transferOptions");
      if (!response.ok) throw new Error(`Failed to fetch options for board ${boardId}`);
      return ((await response.json()) as { columns: Array<Pick<Column, "id" | "title" | "position">> }).columns;
    },

    /** The card transfer saga's calls (`card-transfer.ts` drives them). Each answers with the board's status and body. */
    transfer: {
      prepare: (userId: string, body: RouteInput<"transferPrepare">) =>
        reply<ErrorBody & { bundle?: PreparedCardTransferBundle }>(call("transferPrepare", { userId, body })),
      finalize: (body: RouteInput<"transferFinalize">) => reply<ErrorBody>(call("transferFinalize", { body })),
      release: (body: RouteInput<"transferRelease">) => reply<ErrorBody>(call("transferRelease", { body })),
      receipt: (body: RouteInput<"transferReceipt">) =>
        reply<ErrorBody & { receipt?: CardTransferReceipt }>(call("transferReceipt", { body })),
      abort: (body: RouteInput<"transferAbort">) =>
        reply<{ committed?: boolean; aborted?: boolean; receipt?: CardTransferReceipt }>(call("transferAbort", { body })),
      /** `userId` is the actor the board admits; the transfer's coordinator passes it for stage and import. */
      stage: (userId: string | undefined, attachment: { id: string; contentType: string; size: number; objectKey: string }) =>
        reply<ErrorBody>(call("attachmentStage", { userId, body: attachment })),
      import: (userId: string | undefined, body: RouteInput<"transferImport">) =>
        reply<ErrorBody & { receipt?: CardTransferReceipt }>(call("transferImport", { userId, body })),
    },

    /** The realtime socket: the browser's own upgrade request, passed through with the identity the Worker decided on. `sessionHash` is the SHA-256 of the session id it was authenticated with (ADR 0082). */
    connect(request: Request, userId: string, canManageColumns: boolean, sessionHash: string): Promise<Response> {
      // No `x-foxban-*` of the browser's and no cookie: the Worker's own headers are the only identity the board gets.
      const headers = upgradeHeaders(request);
      headers.set(INTERNAL_BOARD_ID_HEADER, boardId);
      headers.set(INTERNAL_USER_ID_HEADER, userId);
      headers.set(INTERNAL_CAN_MANAGE_COLUMNS_HEADER, canManageColumns ? "true" : "false");
      headers.set(INTERNAL_SESSION_HASH_HEADER, sessionHash);
      return stub().fetch(new Request(request, { headers }));
    },
  };
}

export type BoardClient = ReturnType<typeof boardClient>;
