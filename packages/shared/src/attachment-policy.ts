export const ATTACHMENT_POLICY = {
  previewableImageContentTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  imageMaxBytes: 10_485_760,
  fileMaxBytes: 52_428_800,
  contentTypeMaxLength: 100,
  fallbackContentType: "application/octet-stream",
} as const;

export function normalizeAttachmentContentType(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length > ATTACHMENT_POLICY.contentTypeMaxLength) {
    return ATTACHMENT_POLICY.fallbackContentType;
  }
  return normalized;
}

export function isPreviewableImageContentType(contentType: string): boolean {
  switch (contentType) {
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
      return true;
    default:
      return false;
  }
}

export function attachmentMaxBytes(contentType: string): number {
  return isPreviewableImageContentType(contentType)
    ? ATTACHMENT_POLICY.imageMaxBytes
    : ATTACHMENT_POLICY.fileMaxBytes;
}
