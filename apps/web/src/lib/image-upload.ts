import { isPreviewableImageContentType, normalizeAttachmentContentType } from "@foxban/shared";

/** The shared attachment upload: the file goes up, and the markdown embed's `url` and `alt` come back. */
export type UploadImage = (file: File, options?: { rasterizeSvg?: boolean }) => Promise<{ url: string; alt: string }>;

/** A section's "an image is being prepared" flag. `begin` is false while one already is. */
export type ImageUploadFlag = { begin: () => boolean; end: () => void };

/** The image checks every editor's paste/drop shares, then the upload with the section's flag held around it. */
export const uploadImageFor = (upload: UploadImage, uploading: ImageUploadFlag, allowSvg: boolean = false) => async (file: File): Promise<{ url: string; alt: string }> => {
  const contentType = normalizeAttachmentContentType(file.type);
  const isSvg = contentType === "image/svg+xml";
  if (isSvg) {
    if (!allowSvg) {
      throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
    }
  } else if (!isPreviewableImageContentType(contentType)) {
    throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
  }

  if (!uploading.begin()) {
    throw new Error("An image is still uploading. Paste again when it finishes.");
  }
  try {
    return await upload(file, { rasterizeSvg: allowSvg && isSvg });
  } finally {
    uploading.end();
  }
};
