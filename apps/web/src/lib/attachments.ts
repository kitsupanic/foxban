import { useMemo, useSyncExternalStore } from "react";
import {
  attachmentMaxBytes,
  isPreviewableImageContentType,
  removeAttachmentReferences,
} from "@foxban/shared";
import type { BoardState } from "./apply-mutation";
import type { AuthoredScope } from "./authored-operation";
import { compressImage } from "./compress-image";
import type { BoardEventObserver } from "./socket";

/**
 * The attachment lifecycle on one board (ADRs 0027, 0028, 0035, 0069): owner tracking,
 * stripping deleted embeds from open drafts, and upload with settlement. The core is
 * React-free and fed board events by `useBoardSocket` through `events`; the hooks at
 * the bottom are thin adapters.
 */

export type AttachmentView = {
  /** The draft with every embed of a server-confirmed deletion on this card removed. */
  descriptionFor(cardId: string, draft: string): string;
  /** An own deletion on this card whose outcome is still unknown; Save waits for it. */
  isDeletePending(cardId: string): boolean;
};

export type UploadedAttachment = { url: string; alt: string };

export type BoardAttachments = {
  events: BoardEventObserver;
  /** Mount seed: reverses the optimistic cleanup of deletions still unresolved. */
  seedDescription(cardId: string, description: string): string;
  /**
   * Resolves only once the server has accepted the metadata, so no draft gets a URL that never lands.
   * `scope` should outlive the card: a disposed scope cannot publish a finished upload.
   */
  upload(input: { file: File; cardId: string; scope: AuthoredScope; rasterizeSvg?: boolean }): Promise<UploadedAttachment>;
  getView(): AttachmentView;
  subscribe(listener: () => void): () => void;
};

type UnresolvedDelete = {
  attachmentId: string;
  ownerId: string;
  descriptionBefore: string | undefined;
  descriptionAfter: string | undefined;
};

export function createBoardAttachments(boardId: string, deps: { fetch?: typeof fetch } = {}): BoardAttachments {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  let owners = new Map<string, string>();
  // In send order; unlike rollback timers these survive a transport close.
  const unresolved = new Map<string, UnresolvedDelete>();
  // attachmentId → ownerId, and mutationId → ownerId.
  let confirmed: ReadonlyMap<string, string> = new Map();
  let pending: ReadonlyMap<string, string> = new Map();
  const listeners = new Set<() => void>();

  const makeView = (): AttachmentView => {
    const confirmedNow = confirmed;
    const pendingNow = pending;
    return {
      descriptionFor(cardId, draft) {
        let next = draft;
        for (const [attachmentId, ownerId] of confirmedNow) {
          if (ownerId === cardId) next = removeAttachmentReferences(next, boardId, attachmentId);
        }
        return next;
      },
      isDeletePending: (cardId) => [...pendingNow.values()].includes(cardId),
    };
  };
  let view = makeView();
  const publish = (nextConfirmed: ReadonlyMap<string, string>, nextPending: ReadonlyMap<string, string>) => {
    if (nextConfirmed === confirmed && nextPending === pending) return;
    confirmed = nextConfirmed;
    pending = nextPending;
    view = makeView();
    for (const listener of Array.from(listeners)) listener();
  };
  const withEntry = (map: ReadonlyMap<string, string>, key: string, value: string) => {
    if (map.get(key) === value) return map;
    const next = new Map(map);
    next.set(key, value);
    return next;
  };
  const withoutEntry = (map: ReadonlyMap<string, string>, key: string) => {
    if (!map.has(key)) return map;
    const next = new Map(map);
    next.delete(key);
    return next;
  };
  const clearPending = (mutationId: string) => {
    unresolved.delete(mutationId);
    publish(confirmed, withoutEntry(pending, mutationId));
  };

  const events: BoardEventObserver = {
    snapshot(msg) {
      const snapshotOwners = new Map(msg.attachments.map((attachment) => [attachment.id, attachment.cardId]));
      let next = confirmed;
      for (const id of snapshotOwners.keys()) next = withoutEntry(next, id);
      // A snapshot proves deletion of every known attachment it no longer lists.
      for (const [id, ownerId] of owners) {
        if (!snapshotOwners.has(id)) next = withEntry(next, id, ownerId);
      }
      owners = snapshotOwners;
      unresolved.clear();
      publish(next, pending.size ? new Map() : pending);
    },
    // Lifecycle frames must settle drafts even for an own echo.
    message(msg, own) {
      if (msg.type === "attachment.create") {
        owners.set(msg.id, msg.cardId);
        publish(withoutEntry(confirmed, msg.id), pending);
      } else if (msg.type === "attachment.delete") {
        const ownerId = owners.get(msg.id);
        if (ownerId !== undefined) {
          publish(withEntry(confirmed, msg.id, ownerId), pending);
          owners.delete(msg.id);
        }
        if (own) clearPending(msg.mutationId);
        else {
          // A peer's accepted deletion permanently retires any own pending deletion of it.
          for (const [mutationId, deletion] of Array.from(unresolved)) {
            if (deletion.attachmentId === msg.id) clearPending(mutationId);
          }
        }
      }
    },
    sent(msg, before, after) {
      if (msg.type !== "attachment.delete") return;
      const ownerId = before.attachments.find((attachment) => attachment.id === msg.id)?.cardId ?? owners.get(msg.id);
      if (ownerId === undefined) return;
      const description = (state: BoardState) => state.cards.find((card) => card.id === ownerId)?.description;
      owners.set(msg.id, ownerId);
      unresolved.set(msg.mutationId, {
        attachmentId: msg.id,
        ownerId,
        descriptionBefore: description(before),
        descriptionAfter: description(after),
      });
      publish(confirmed, withEntry(pending, msg.mutationId, ownerId));
    },
    resolved: clearPending,
  };

  /**
   * Raw `fetch` rather than `hc`: the body is binary, which the RPC client cannot type.
   * Same-origin, so the session cookie rides along.
   */
  const upload: BoardAttachments["upload"] = async ({ file, cardId, scope, rasterizeSvg }) => {
    const prepared = await compressImage(file, { rasterizeSvg });
    // Same bound as the shared `Title` the server applies to `fileName`:
    // refuse before the bytes are spent rather than after they are stored.
    if (prepared.fileName.trim() === "" || prepared.fileName.length > 200) {
      throw new Error("File name must be 200 characters or fewer.");
    }
    if (prepared.blob.size > attachmentMaxBytes(prepared.contentType)) {
      throw new Error(
        isPreviewableImageContentType(prepared.contentType) ? "Image is too large (max 10 MB)." : "File is too large (max 50 MB).",
      );
    }
    const response = await fetchImpl(`/boards/${boardId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": prepared.contentType },
      body: prepared.blob,
    });
    if (!response.ok) throw new Error("Could not upload the attachment.");
    const uploaded = (await response.json()) as { id: string; contentType: string; size: number };
    const result: UploadedAttachment = {
      url: `/boards/${boardId}/attachments/${uploaded.id}`,
      // Brackets and parens would break out of the `![alt](url)` markup.
      alt: prepared.fileName.replace(/[[\]()]/g, ""),
    };
    // If the socket is closed or the server refuses, the upload's provisional lease
    // remains in the BoardDO and its alarm removes the unclaimed R2 object after one hour.
    // A timeout only makes the attempt uncertain: a late acceptance still resolves it.
    return new Promise<UploadedAttachment>((resolve, reject) => {
      const op = scope.operation<null>({
        build: (mutationId) => ({
          type: "attachment.create",
          mutationId,
          id: uploaded.id,
          cardId,
          fileName: prepared.fileName,
          contentType: uploaded.contentType,
          size: uploaded.size,
        }),
        onAccepted: () => {
          unsubscribe();
          resolve(result);
        },
        copy: {
          rejected: "Could not attach the upload.",
          unverified: "Could not confirm the upload — try again.",
          "not-connected": "Not connected — try again.",
          "accepted-gone": "Could not attach the upload.",
        },
      });
      const unsubscribe = op.subscribe(() => {
        const state = op.getState();
        if (state.status !== "failed") return;
        unsubscribe();
        op.discard();
        reject(new Error(state.error ?? "Could not attach the upload."));
      });
      op.start(null);
    });
  };

  return {
    events,
    seedDescription(cardId, description) {
      let seed = description;
      const deletes = [...unresolved.values()];
      for (let index = deletes.length - 1; index >= 0; index -= 1) {
        const deletion = deletes[index];
        if (deletion.ownerId === cardId && deletion.descriptionBefore !== undefined && seed === deletion.descriptionAfter) {
          seed = deletion.descriptionBefore;
        }
      }
      return seed;
    },
    upload,
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** One lifecycle per board: a board change starts from no evidence, a socket retry does not. */
export function useBoardAttachments(boardId: string): BoardAttachments {
  return useMemo(() => createBoardAttachments(boardId), [boardId]);
}

export function useAttachmentView(attachments: BoardAttachments): AttachmentView {
  return useSyncExternalStore(attachments.subscribe, attachments.getView, attachments.getView);
}
