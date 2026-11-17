import { Identifier } from "@foxban/shared";

export const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ATTACHMENT_BOARD_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;
export const ATTACHMENT_TRANSFER_ID = /^[0-9A-Za-z_-]{1,64}$/;
export const STAGED_ATTACHMENT_TTL_MS = 60 * 60 * 1000;

export function attachmentObjectKey(boardId: string, attachmentId: string): string {
  return `${boardId}/${attachmentId}`;
}

export function attachmentTransferObjectKey(
  boardId: string,
  transferId: string,
  attachmentId: string,
): string {
  return `${boardId}/${transferId}/${attachmentId}`;
}

export function parseAttachmentObjectKey(
  objectKey: string,
): { boardId: string; attachmentId: string; objectKey: string; transferId?: string } | null {
  const parts = objectKey.split("/");
  if (parts.length === 2) {
    const [boardId, attachmentId] = parts;
    if (!boardId || !attachmentId) return null;
    if (!ATTACHMENT_BOARD_ID.test(boardId) || !ATTACHMENT_ID.test(attachmentId)) return null;
    return { boardId, attachmentId, objectKey };
  }
  if (parts.length === 3) {
    const [boardId, transferId, attachmentId] = parts;
    if (!boardId || !transferId || !attachmentId) return null;
    if (
      !ATTACHMENT_BOARD_ID.test(boardId) ||
      !Identifier.safeParse(transferId).success ||
      !ATTACHMENT_TRANSFER_ID.test(transferId) ||
      !ATTACHMENT_ID.test(attachmentId)
    ) {
      return null;
    }
    return { boardId, attachmentId, objectKey, transferId };
  }
  return null;
}
export function userAvatarObjectKey(userId: string, avatarVersion: string): string {
  return `avatars/${userId}/${avatarVersion}`;
}

export function parseAvatarObjectKey(
  objectKey: string,
): { userId: string; avatarVersion: string } | null {
  const parts = objectKey.split("/");
  if (parts.length !== 3 || parts[0] !== "avatars") return null;
  const userId = parts[1];
  const avatarVersion = parts[2];
  if (!userId || !avatarVersion) return null;
  return { userId, avatarVersion };
}
