import {
  ATTACHMENT_POLICY,
  isPreviewableImageContentType,
  normalizeAttachmentContentType,
} from "@foxban/shared";
/**
 * Shrinks an image before it is uploaded: bandwidth on the way up, and R2 space
 * (and every later download) forever after.
 *
 * Raster compression is best-effort by design — anything that goes wrong returns
 * the original bytes and lets the server's declared-type size cap be the authority.
 * In contrast, SVG rasterization (rasterizeSvg === true) is strict: it always
 * produces WebP and never falls back to original SVG, PNG, or raw-vector bytes.
 */

/** Longest side of the re-encoded image. Plenty for a card description at 2x. */
const MAX_EDGE = 2048;
const WEBP_QUALITY = 0.8;

export async function compressImage(
  file: File,
  options?: {
    maxEdge?: number;
    quality?: number;
    forceWebp?: boolean;
    rasterizeSvg?: boolean;
  },
): Promise<{ blob: Blob; fileName: string; contentType: string }> {
  const maxEdge = options?.maxEdge ?? MAX_EDGE;
  const quality = options?.quality ?? WEBP_QUALITY;
  const contentType = normalizeAttachmentContentType(file.type);
  const original = { blob: file, fileName: file.name, contentType };

  if (options?.rasterizeSvg && contentType === "image/svg+xml") {
    return rasterizeSvgToWebp(file, options);
  }

  // Non-images are not decoded; re-encoding a GIF would drop every frame but the first.
  if (!isPreviewableImageContentType(contentType) || contentType === "image/gif") return original;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (context === null) return original;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const encoded = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/webp", quality);
    });
    // A tiny or already-optimal image can encode larger than it started; keep
    // whichever is smaller so compression never costs bytes, unless forceWebp is set.
    if (encoded === null) return original;
    if (!options?.forceWebp && encoded.size >= file.size) return original;
    return {
      blob: encoded,
      fileName: file.name.replace(/\.[^.]+$/, "") + ".webp",
      contentType: "image/webp",
    };
  } catch {
    // Corrupt or undecodable input: hand the original over untouched.
    return original;
  }
}

const SVG_MAX_BYTES = ATTACHMENT_POLICY.imageMaxBytes; // 10 MiB
const SVG_DECODE_TIMEOUT_MS = 10_000;

/**
 * Strict conversion of SVG images to WebP.
 * Does not fall back to original SVG, PNG, or vector bytes on error.
 */
async function rasterizeSvgToWebp(
  file: File,
  options?: { maxEdge?: number; quality?: number },
): Promise<{ blob: Blob; fileName: string; contentType: string }> {
  if (file.size > SVG_MAX_BYTES) {
    throw new Error("SVG is too large (max 10 MB).");
  }

  try {
    const text = await file.text();
    // Re-verify byte length after reading text as utf-8 blob
    const byteLength = new TextEncoder().encode(text).length;
    if (byteLength > SVG_MAX_BYTES) {
      throw new Error("SVG is too large (max 10 MB).");
    }

    // Reject actual DOCTYPE and entity declarations before parsing.
    // Do not treat comments or CDATA sections as declarations.
    // (allow predefined XML escapes &amp;, &lt;, &gt;, &quot;, &apos; and numeric references &#...;)
    if (hasXmlDeclarationOrEntity(text)) {
      throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
    }

    const parser = new DOMParser();
    let xmlDoc = parser.parseFromString(text, "image/svg+xml");

    let parserError = xmlDoc.querySelector("parsererror");
    if (parserError) {
      throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
    }

    let root = xmlDoc.documentElement;
    if (!root || root.localName !== "svg") {
      throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
    }

    // Check explicit namespace. If omitted, insert standard namespace into opening tag and reparse.
    if (root.namespaceURI !== "http://www.w3.org/2000/svg") {
      // If an explicit namespace is present and not SVG, reject.
      if (root.getAttribute("xmlns") && root.getAttribute("xmlns") !== "http://www.w3.org/2000/svg") {
        throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
      }
      // Insert standard xmlns in the actual root opening tag and reparse so all descendants acquire SVG namespace
      const inserted = insertSvgNamespaceIntoRootTag(text);
      xmlDoc = parser.parseFromString(inserted, "image/svg+xml");
      parserError = xmlDoc.querySelector("parsererror");
      if (parserError) {
        throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
      }
      root = xmlDoc.documentElement;
      if (!root || root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg") {
        throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
      }
    }

    // Sizing and dimensions
    const widthAttr = root.getAttribute("width");
    const heightAttr = root.getAttribute("height");
    const viewBoxAttr = root.getAttribute("viewBox");

    const parsedWidth = parseSvgDimension(widthAttr);
    const parsedHeight = parseSvgDimension(heightAttr);

    let parsedViewBox: { minX: number; minY: number; width: number; height: number } | null = null;
    if (viewBoxAttr !== null) {
      parsedViewBox = parseSvgViewBox(viewBoxAttr);
      if (!parsedViewBox) {
        throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
      }
    }

    let naturalWidth: number;
    let naturalHeight: number;

    if (parsedViewBox) {
      if (parsedWidth !== null && parsedHeight !== null) {
        naturalWidth = parsedWidth;
        naturalHeight = parsedHeight;
      } else if (parsedWidth !== null && parsedHeight === null) {
        naturalWidth = parsedWidth;
        naturalHeight = parsedWidth * (parsedViewBox.height / parsedViewBox.width);
      } else if (parsedWidth === null && parsedHeight !== null) {
        naturalWidth = parsedHeight * (parsedViewBox.width / parsedViewBox.height);
        naturalHeight = parsedHeight;
      } else {
        naturalWidth = parsedViewBox.width;
        naturalHeight = parsedViewBox.height;
      }
    } else {
      naturalWidth = parsedWidth ?? 300;
      naturalHeight = parsedHeight ?? 150;
    }

    if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) {
      throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
    }

    // Before scaling an SVG without viewBox, synthesize viewBox="0 0 W H" from original viewport
    // so downscaling does not clip geometry.
    if (!parsedViewBox) {
      root.setAttribute("viewBox", `0 0 ${naturalWidth} ${naturalHeight}`);
    }

    // Scale proportionally to maxEdge (2048) without upscaling; clamp rounded to at least 1px.
    const maxEdge = options?.maxEdge ?? MAX_EDGE;
    const quality = options?.quality ?? WEBP_QUALITY;
    const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
    const targetWidth = Math.max(1, Math.round(naturalWidth * scale));
    const targetHeight = Math.max(1, Math.round(naturalHeight * scale));

    // Set root width/height attributes and inline CSS width/height with !important
    root.setAttribute("width", `${targetWidth}px`);
    root.setAttribute("height", `${targetHeight}px`);
    root.style.setProperty("width", `${targetWidth}px`, "important");
    root.style.setProperty("height", `${targetHeight}px`, "important");

    const serializedSvg = new XMLSerializer().serializeToString(xmlDoc);
    const svgBlob = new Blob([serializedSvg], { type: "image/svg+xml" });
    const objectUrl = URL.createObjectURL(svgBlob);
    let img: HTMLImageElement | null = new Image();
    let timer: NodeJS.Timeout | number | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        if (!img) return reject(new Error("Image creation failed"));
        timer = setTimeout(() => {
          reject(new Error("SVG decode timed out."));
        }, SVG_DECODE_TIMEOUT_MS);

        img.onload = () => {
          resolve();
        };
        img.onerror = () => {
          reject(new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again."));
        };
        img.src = objectUrl;
      });

      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
      }

      context.drawImage(img, 0, 0, targetWidth, targetHeight);

      const encoded = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/webp", quality);
      });

      if (!encoded || encoded.type !== "image/webp") {
        throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
      }

      const baseName = file.name && file.name.trim() !== "" ? file.name : "pasted.svg";
      const fileName = baseName.replace(/\.[^.]+$/, "") + ".webp";

      return {
        blob: encoded,
        fileName,
        contentType: "image/webp",
      };
    } finally {
      clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
      if (img) {
        img.onload = null;
        img.onerror = null;
        img.src = "";
        img = null;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "SVG is too large (max 10 MB).") {
      throw error;
    }
    throw new Error("Could not convert SVG to WebP. Try copying a self-contained SVG again.");
  }
}

function hasXmlDeclarationOrEntity(source: string): boolean {
  let i = 0;
  const len = source.length;
  while (i < len) {
    const nextLt = source.indexOf("<", i);
    if (nextLt === -1) break;
    if (source.startsWith("<!--", nextLt)) {
      const commentEnd = source.indexOf("-->", nextLt + 4);
      i = commentEnd === -1 ? len : commentEnd + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", nextLt)) {
      const cdataEnd = source.indexOf("]]>", nextLt + 9);
      i = cdataEnd === -1 ? len : cdataEnd + 3;
      continue;
    }
    if (/^<!DOCTYPE[\s>]/i.test(source.slice(nextLt, nextLt + 11))) {
      return true;
    }
    if (/^<!ENTITY[\s>]/i.test(source.slice(nextLt, nextLt + 10))) {
      return true;
    }
    i = nextLt + 1;
  }
  return false;
}

function insertSvgNamespaceIntoRootTag(source: string): string {
  let i = 0;
  const len = source.length;
  while (i < len) {
    const nextLt = source.indexOf("<", i);
    if (nextLt === -1) break;
    if (source.startsWith("<!--", nextLt)) {
      const commentEnd = source.indexOf("-->", nextLt + 4);
      i = commentEnd === -1 ? len : commentEnd + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", nextLt)) {
      const cdataEnd = source.indexOf("]]>", nextLt + 9);
      i = cdataEnd === -1 ? len : cdataEnd + 3;
      continue;
    }
    if (source.startsWith("<?", nextLt)) {
      const piEnd = source.indexOf("?>", nextLt + 2);
      i = piEnd === -1 ? len : piEnd + 2;
      continue;
    }
    if (source.startsWith("<!", nextLt)) {
      const declEnd = source.indexOf(">", nextLt + 2);
      i = declEnd === -1 ? len : declEnd + 1;
      continue;
    }

    // Check if this tag is the <svg root
    const match = /^<svg(\s|>|\/)/i.exec(source.slice(nextLt));
    if (match) {
      const insertPos = nextLt + 4; // right after '<svg'
      return source.slice(0, insertPos) + ' xmlns="http://www.w3.org/2000/svg"' + source.slice(insertPos);
    }
    i = nextLt + 1;
  }
  return source;
}

const SVG_NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseSvgDimension(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "auto") {
    return null;
  }
  if (trimmed.endsWith("%")) {
    const percentNum = trimmed.slice(0, -1).trim();
    if (!SVG_NUMBER_PATTERN.test(percentNum)) {
      throw new Error("Invalid SVG percentage dimension");
    }
    const num = Number(percentNum);
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error("Invalid SVG percentage dimension value");
    }
    return null; // Valid percentage is treated as unresolved
  }
  // Check for px or unitless
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(px)?$/i.exec(trimmed);
  if (!match) {
    // Unsupported units or malformed numeric syntax -> reject
    throw new Error("Invalid SVG dimension unit or syntax");
  }
  const numStr = match[1];
  if (!SVG_NUMBER_PATTERN.test(numStr)) {
    throw new Error("Invalid SVG dimension number format");
  }
  const num = Number(numStr);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error("Invalid SVG dimension value");
  }
  return num;
}

function parseSvgViewBox(
  value: string,
): { minX: number; minY: number; width: number; height: number } | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // SVG2 viewBox grammar:
  // viewBox ::= ws* [number] (ws+ [number] | ws* ',' ws* [number]){3} ws*
  // Cannot have leading comma, trailing comma, or repeated commas.
  // Between each pair of numbers, there must be either one comma (with optional whitespace)
  // or one or more whitespace characters (without comma).
  const pattern = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:\s*,\s*|\s+)([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:\s*,\s*|\s+)([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:\s*,\s*|\s+)([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*$/;
  const match = pattern.exec(trimmed);
  if (!match) return null;

  const minX = Number(match[1]);
  const minY = Number(match[2]);
  const width = Number(match[3]);
  const height = Number(match[4]);
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return { minX, minY, width, height };
}
