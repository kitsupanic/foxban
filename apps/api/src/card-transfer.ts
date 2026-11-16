import { TRANSFER_TERMINAL_CODE, rewriteAttachmentUrls } from "@foxban/shared";
import { STAGE_ATTACHMENT_PATH, attachmentTransferObjectKey } from "./attachment-lifecycle";
import type { CardTransferReceipt, PreparedCardTransferBundle } from "./board-do";
import { INTERNAL_USER_ID_HEADER, boardFetch } from "./internal-headers";

/**
 * The card transfer coordinator (ADRs 0038, 0048, 0061): the one place that knows
 * the saga's step order, its compensation, the destination receipt lookup and how
 * each participant's status maps to an outcome. `run` drives a transfer from the
 * Worker route; `settle` resolves a source lock against its destination, for the
 * alarm, the access fence, a stale-lock takeover and the release endpoint.
 *
 * It talks to the boards only through `SourceParticipant` / `DestinationParticipant`.
 * The real adapters below call the BoardDOs; tests pass fakes.
 */

export const CARD_TRANSFER_OPTIONS_PATH = "/internal/card-transfer/options";
export const CARD_TRANSFER_PREPARE_PATH = "/internal/card-transfer/prepare";
export const CARD_TRANSFER_IMPORT_PATH = "/internal/card-transfer/import";
export const CARD_TRANSFER_FINALIZE_PATH = "/internal/card-transfer/finalize";
export const CARD_TRANSFER_RELEASE_PATH = "/internal/card-transfer/release";
export const CARD_TRANSFER_RECEIPT_PATH = "/internal/card-transfer/receipt";
export const CARD_TRANSFER_ABORT_PATH = "/internal/card-transfer/abort";

export type TransferIds = { transferId: string; sourceBoardId: string; cardId: string; destinationBoardId: string };
type ErrorBody = { error?: string; code?: string };
/** A participant's answer: its HTTP status and parsed body (`{}` when there is none). */
export type Reply<T = ErrorBody> = { status: number; body: T };
const ok = (r: Reply<unknown>) => r.status >= 200 && r.status < 300;

export interface SourceParticipant {
  prepare(): Promise<Reply<ErrorBody & { bundle?: PreparedCardTransferBundle }>>;
  /** 2xx: the source card is gone. 409 from a local adapter: the lock moved on, nothing was done. */
  finalize(): Promise<Reply>;
  /** 2xx: the lock was cleared. 409 from a local adapter: the lock moved on. */
  release(): Promise<Reply>;
}

export interface DestinationParticipant {
  receipt(): Promise<Reply<ErrorBody & { receipt?: CardTransferReceipt }>>;
  /** Fence the operation: answers the committed receipt, or records an abort tombstone. */
  abort(): Promise<Reply<{ committed?: boolean; aborted?: boolean; receipt?: CardTransferReceipt }>>;
  stageAttachment(attachment: { id: string; contentType: string; size: number; objectKey: string }): Promise<Reply>;
  /** Copy one blob into the destination's transfer-scoped key; false when it could not. */
  copyAttachment(sourceKey: string, destinationKey: string): Promise<boolean>;
  import(input: {
    destinationColumnId: string;
    assigneeId: string | null;
    bundle: PreparedCardTransferBundle;
  }): Promise<Reply<ErrorBody & { receipt?: CardTransferReceipt }>>;
}

export type RunOutcome =
  | { kind: "moved"; receipt: CardTransferReceipt }
  | {
      kind: "refused";
      status: 400 | 403 | 404 | 409 | 410 | 500 | 503;
      error: string;
      code?: typeof TRANSFER_TERMINAL_CODE | "access_change_pending";
    };

export type SettleOutcome =
  | { kind: "finalized" }
  | { kind: "released"; cleared: boolean }
  | { kind: "retry"; why: "unreachable" | "refused" | "mismatch" };

type Fence = { kind: "committed"; receipt: CardTransferReceipt } | { kind: "aborted" } | { kind: "retry"; why: "unreachable" | "refused" | "mismatch" };

const sameOperation = (receipt: CardTransferReceipt | undefined, ids: Omit<TransferIds, "destinationBoardId">): receipt is CardTransferReceipt =>
  !!receipt && receipt.transferId === ids.transferId && receipt.sourceBoardId === ids.sourceBoardId && receipt.cardId === ids.cardId;

/** Ask the destination to commit-or-abort this operation (ADR 0048 §3) and read its answer. */
async function fence(destination: DestinationParticipant, ids: Omit<TransferIds, "destinationBoardId">): Promise<Fence> {
  let reply;
  try {
    reply = await destination.abort();
  } catch {
    return { kind: "retry", why: "unreachable" };
  }
  if (!ok(reply)) return { kind: "retry", why: "refused" };
  if (!sameOperation(reply.body.receipt, ids)) return { kind: "retry", why: "mismatch" };
  if (reply.body.committed) return { kind: "committed", receipt: reply.body.receipt };
  if (reply.body.aborted) return { kind: "aborted" };
  return { kind: "retry", why: "refused" };
}

const terminal = (status: 409 | 410, error: string): RunOutcome => ({ kind: "refused", status, error, code: TRANSFER_TERMINAL_CODE });
const failed = (error: string): RunOutcome => ({ kind: "refused", status: 500, error });
const ACCESS_CHANGING: RunOutcome = { kind: "refused", status: 503, error: "Board access is changing. Please retry.", code: "access_change_pending" };

function prepareRefusal({ status, body }: Reply): RunOutcome {
  if (status === 404) return { kind: "refused", status: 404, error: "not found" };
  if (status === 403) return { kind: "refused", status: 403, error: "forbidden" };
  if (status === 503 && body.code === "access_change_pending") return ACCESS_CHANGING;
  if (status === 409) {
    if (body.code === TRANSFER_TERMINAL_CODE) return terminal(409, body.error ?? "transfer operation is no longer usable");
    if (body.error === "remove card links before transferring") return { kind: "refused", status: 409, error: body.error };
    return { kind: "refused", status: 409, error: "card transfer already in progress" };
  }
  return failed("could not prepare card transfer");
}

function importRefusal({ status, body }: Reply): RunOutcome {
  if (status === 403) return { kind: "refused", status: 403, error: "forbidden" };
  if (status === 503 && body.code === "access_change_pending") return ACCESS_CHANGING;
  if (status === 400) return { kind: "refused", status: 400, error: body.error ?? "destination column not found" };
  if (status === 409) {
    if (body.code === TRANSFER_TERMINAL_CODE) return terminal(409, body.error ?? "transfer operation is no longer usable");
    return { kind: "refused", status: 409, error: body.error ?? "card transfer conflict" };
  }
  return failed("could not import card");
}

/**
 * Run one transfer: receipt lookup → prepare → stage and copy attachments →
 * import → finalize. A failure after prepare compensates: fence the destination,
 * then finalize the source if the destination had committed after all, or release
 * the source lock if it is now aborted. `destinationMembers` decides whether the
 * assignee survives the move.
 */
export async function run(
  ids: TransferIds,
  source: SourceParticipant,
  destination: DestinationParticipant,
  destinationColumnId: string,
  destinationMembers: ReadonlySet<string>,
): Promise<RunOutcome> {
  const finish = async (receipt: CardTransferReceipt): Promise<RunOutcome> =>
    ok(await source.finalize()) ? { kind: "moved", receipt } : failed("transfer needs retry");

  const compensate = async (refusal: RunOutcome): Promise<RunOutcome> => {
    const answer = await fence(destination, ids);
    if (answer.kind === "committed") return finish(answer.receipt);
    if (answer.kind !== "aborted" || !ok(await source.release())) return failed("transfer compensation failed; retry required");
    return refusal;
  };

  // A retry of an operation the destination already committed only finishes the source.
  const existing = await destination.receipt();
  if (existing.status === 409) return terminal(409, "transfer id already used for another transfer");
  // Fenced as aborted: it can never commit, so the client must rotate the id.
  if (existing.status === 410) return terminal(410, "transfer operation was aborted");
  if (ok(existing)) {
    if (!sameOperation(existing.body.receipt, ids)) return terminal(409, "transfer operation identity mismatch");
    return finish(existing.body.receipt);
  }

  const prepared = await source.prepare();
  if (!ok(prepared) || !prepared.body.bundle) return prepareRefusal(prepared);
  const bundle = prepared.body.bundle;

  const attachmentIds = bundle.attachments.map((a) => a.id);
  if (attachmentIds.length > 0) {
    const rewrite = (text: string) => rewriteAttachmentUrls(text, ids.sourceBoardId, ids.destinationBoardId, attachmentIds);
    bundle.card.description = rewrite(bundle.card.description);
    for (const comment of bundle.comments) comment.body = rewrite(comment.body);
  }
  const assigneeId = bundle.card.assigneeId !== null && destinationMembers.has(bundle.card.assigneeId) ? bundle.card.assigneeId : null;

  // Stage every lease before any blob lands, so a copied blob is never unowned.
  const destinationKey = (id: string) => attachmentTransferObjectKey(ids.destinationBoardId, ids.transferId, id);
  for (const a of bundle.attachments) {
    const staged = await destination.stageAttachment({ id: a.id, contentType: a.contentType, size: a.size, objectKey: destinationKey(a.id) });
    if (!ok(staged)) return compensate(failed("could not transfer attachments"));
  }
  for (const a of bundle.attachments) {
    if (!(await destination.copyAttachment(a.objectKey, destinationKey(a.id)))) return compensate(failed("could not transfer attachments"));
  }

  const imported = await destination.import({ destinationColumnId, assigneeId, bundle });
  if (!ok(imported) || !imported.body.receipt) return compensate(importRefusal(imported));
  return finish(imported.body.receipt);
}

/**
 * Settle one source lock: finalize if a destination committed, release once every
 * destination is fenced as aborted, otherwise `retry` and the lock stays.
 * A lock that names its destination has one; a legacy lock without one passes every
 * candidate board with `lookupFirst`, so committed receipts are read before any board
 * is fenced. Errors thrown by the source propagate to the caller.
 */
export async function settle(
  ids: Omit<TransferIds, "destinationBoardId">,
  source: Pick<SourceParticipant, "finalize" | "release">,
  destinations: DestinationParticipant[],
  lookupFirst = false,
): Promise<SettleOutcome> {
  const finalize = async (): Promise<SettleOutcome> => {
    await source.finalize();
    return { kind: "finalized" };
  };
  if (lookupFirst) {
    for (const destination of destinations) {
      let reply;
      try {
        reply = await destination.receipt();
      } catch {
        return { kind: "retry", why: "unreachable" };
      }
      if (ok(reply)) {
        const receipt = reply.body.receipt;
        if (sameOperation(receipt, ids) && receipt.taskNumber >= 0) return finalize();
      } else if (reply.status !== 404 && reply.status !== 410) {
        return { kind: "retry", why: "refused" };
      }
    }
  }
  for (const destination of destinations) {
    const answer = await fence(destination, ids);
    if (answer.kind === "committed") return finalize();
    if (answer.kind === "retry") return answer;
  }
  return { kind: "released", cleared: ok(await source.release()) };
}

async function reply<T>(response: Promise<Response>): Promise<Reply<T>> {
  const res = await response;
  return { status: res.status, body: ((await res.json().catch(() => null)) ?? {}) as T };
}

const post = (body: unknown, userId?: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...(userId ? { [INTERNAL_USER_ID_HEADER]: userId } : {}) },
  body: JSON.stringify(body),
});

/** The source board over its internal endpoints. `userId` is the actor prepare admits. */
export function boardSource(env: Env, ids: TransferIds, userId: string): SourceParticipant {
  const body = { transferId: ids.transferId, cardId: ids.cardId, destinationBoardId: ids.destinationBoardId };
  return {
    prepare: () => reply(boardFetch(env, ids.sourceBoardId, CARD_TRANSFER_PREPARE_PATH, post(body, userId))),
    finalize: () => reply(boardFetch(env, ids.sourceBoardId, CARD_TRANSFER_FINALIZE_PATH, post(body))),
    release: () => reply(boardFetch(env, ids.sourceBoardId, CARD_TRANSFER_RELEASE_PATH, post(body))),
  };
}

/** The destination board over its internal endpoints, plus the R2 copy into it. `userId` is needed only to stage and import. */
export function boardDestination(env: Env, ids: TransferIds, userId?: string): DestinationParticipant {
  const operation = { transferId: ids.transferId, sourceBoardId: ids.sourceBoardId, cardId: ids.cardId };
  const call = <T>(path: string, body: unknown, user?: string) => reply<T>(boardFetch(env, ids.destinationBoardId, path, post(body, user)));
  return {
    receipt: () => call(CARD_TRANSFER_RECEIPT_PATH, operation),
    abort: () => call(CARD_TRANSFER_ABORT_PATH, operation),
    stageAttachment: (attachment) => call(STAGE_ATTACHMENT_PATH, attachment, userId),
    import: ({ destinationColumnId, assigneeId, bundle }) =>
      call(CARD_TRANSFER_IMPORT_PATH, { transferId: ids.transferId, sourceBoardId: ids.sourceBoardId, destinationColumnId, assigneeId, bundle }, userId),
    async copyAttachment(sourceKey, destinationKey) {
      try {
        const object = await env.ATTACHMENTS.get(sourceKey);
        if (object === null) return false;
        const meta = object.httpMetadata;
        await env.ATTACHMENTS.put(destinationKey, object.body, {
          httpMetadata: meta
            ? {
                contentType: meta.contentType,
                contentLanguage: meta.contentLanguage,
                contentDisposition: meta.contentDisposition,
                contentEncoding: meta.contentEncoding,
                cacheControl: meta.cacheControl,
                cacheExpiry: meta.cacheExpiry,
              }
            : undefined,
          customMetadata: object.customMetadata,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
