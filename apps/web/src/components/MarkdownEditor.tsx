import {
  ATTACHMENT_POLICY,
  isPreviewableImageContentType,
  normalizeAttachmentContentType,
} from "@foxban/shared";
import { Image, Link } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { parseYouTubeUrl, type YouTubeVideo } from "../lib/youtube";
import { YouTubeEmbed } from "./YouTubeEmbed";

const IMAGE_ACCEPT = ATTACHMENT_POLICY.previewableImageContentTypes.join(",");

/**
 * The Markdown composing surface shared by the card description and card
 * comments (ADR 0013, ADR 0015): a textarea plus formatting toolbar, with
 * paste-to-upload for images. The draft lives in the caller — this component
 * owns only the editing affordances.
 */
export function MarkdownEditor({
  value,
  onChange,
  onSubmit,
  onEscape,
  onUploadImage,
  ariaLabel,
  rows,
  imageInputTestId,
  trailing,
  readOnly,
  allowSvgPaste = false,
  active = true,
  compact = false,
  autoFocus = true,
  placeholder,
  onFocus,
  onClick,
  feedbackResetToken = 0,

}: {
  value: string;
  readOnly?: boolean;
  onChange: (next: string) => void;
  /** Ctrl/Cmd+Enter. */
  onSubmit: () => void;
  /**
   * When set, Escape stops propagation and calls this (e.g. comment cancel or
   * description preview switch); when absent, Escape bubbles untouched.
   */
  onEscape?: () => void;
  /**
   * Uploads one image and resolves with what to embed. The editor stays
   * board-agnostic: the caller owns the request and the attachment metadata.
   */
  onUploadImage: (file: File) => Promise<{ url: string; alt: string }>;
  ariaLabel: string;
  rows: number;
  imageInputTestId: string;
  /** Rendered after the toolbar spacer (the description's Done button). */
  trailing?: ReactNode;
  allowSvgPaste?: boolean;
  active?: boolean;
  /** Compact presentation keeps the same textarea while hiding formatting controls. */
  compact?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  onFocus?: () => void;
  onClick?: () => void;
  /** Intentional draft disposal clears transient feedback without replacing the editor. */
  feedbackResetToken?: number;

}) {
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadingRef = useRef(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const prevActiveRef = useRef(active);
  const latestValueRef = useRef(value);
  latestValueRef.current = value;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const pendingUploadSelectionRef = useRef<{
    element: HTMLTextAreaElement;
    value: string;
    start: number;
    end: number;
  } | null>(null);

  useLayoutEffect(() => {
    setStatusMessage(null);
    setUploadError(null);
    pendingUploadSelectionRef.current = null;
  }, [feedbackResetToken]);

  // An async update's animation frame can run before React commits its value.
  // Apply the selection only to that committed text, without moving focus.
  useLayoutEffect(() => {
    const pending = pendingUploadSelectionRef.current;
    if (!pending) return;
    if (!active || readOnly) {
      pendingUploadSelectionRef.current = null;
      return;
    }
    const element = textarea.current;
    if (value !== pending.value || element?.value !== pending.value) return;
    pendingUploadSelectionRef.current = null;
    if (element !== pending.element || !element.isConnected) return;
    element.setSelectionRange(pending.start, pending.end);
  }, [value, active, readOnly]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!prevActiveRef.current && active) {
      textarea.current?.focus();
    }
    prevActiveRef.current = active;
  }, [active]);
  type PendingUploadAnchor = {
    start: number;
    end: number;
    lastText: string;
    hasSelection: boolean;
    originalSelectedText: string;
    rangeEdited: boolean;
  };

  const pendingUploadAnchorRef = useRef<PendingUploadAnchor | null>(null);

  const updatePendingUploadAnchor = useCallback((newText: string) => {
    if (!pendingUploadAnchorRef.current) return;
    const anchor = pendingUploadAnchorRef.current;
    if (newText === anchor.lastText) return;
    const { editStart, oldEditEnd, delta } = computeEditRange(anchor.lastText, newText);
    const rangeEdited =
      anchor.rangeEdited ||
      (anchor.hasSelection && oldEditEnd > anchor.start && editStart < anchor.end);
    const bias = anchor.hasSelection ? "left" : "right";
    const newStart = adjustAnchorOffset(anchor.start, editStart, oldEditEnd, delta, bias);
    const newEnd = adjustAnchorOffset(anchor.end, editStart, oldEditEnd, delta, bias);
    pendingUploadAnchorRef.current = {
      ...anchor,
      start: newStart,
      end: Math.max(newStart, newEnd),
      lastText: newText,
      rangeEdited,
    };
  }, []);

  /**
   * Applies a toolbar action: splice the draft, then restore focus and the
   * requested selection. The selection has to be set *after* React re-renders
   * the controlled value, hence the frame delay.
   */
  const splice = (compute: (text: string, start: number, end: number) => Splice) => {
    const el = textarea.current;
    if (!el) return;
    pendingUploadSelectionRef.current = null;
    const currentText = latestValueRef.current;
    const { next, select } = compute(currentText, el.selectionStart, el.selectionEnd);
    updatePendingUploadAnchor(next);
    latestValueRef.current = next;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(select[0], select[1]);
    });
  };

  const bold = () => splice((text, start, end) => wrap(text, start, end, "**"));
  const italic = () => splice((text, start, end) => wrap(text, start, end, "_"));

  /** Shared by the toolbar button and the clipboard: upload, then embed at the caret. */
  const uploadAndInsert = async (file: File, isSvgCandidate = false) => {
    const contentType = normalizeAttachmentContentType(file.type);
    const isSvg = contentType === "image/svg+xml";
    if (isSvg) {
      if (!allowSvgPaste || !isSvgCandidate) {
        setUploadError("Choose a PNG, JPEG, GIF, or WebP image.");
        setStatusMessage(null);
        return;
      }
    } else if (!isPreviewableImageContentType(contentType)) {
      setUploadError("Choose a PNG, JPEG, GIF, or WebP image.");
      setStatusMessage(null);
      return;
    }
    if (uploadingRef.current) {
      setUploadError("An image is still uploading. Paste again when it finishes.");
      setStatusMessage(null);
      return;
    }
    uploadingRef.current = true;
    const el = textarea.current;
    const startText = latestValueRef.current;
    const startSelectionStart = el ? el.selectionStart : startText.length;
    const startSelectionEnd = el ? el.selectionEnd : startText.length;
    const hasSelection = startSelectionStart < startSelectionEnd;
    pendingUploadAnchorRef.current = {
      start: startSelectionStart,
      end: startSelectionEnd,
      lastText: startText,
      hasSelection,
      originalSelectedText: hasSelection
        ? startText.slice(startSelectionStart, startSelectionEnd)
        : "",
      rangeEdited: false,
    };

    setUploadError(null);
    const status = isSvg ? "Converting and uploading image…" : null;
    setStatusMessage(status);
    setUploading(true);
    try {
      const { url, alt } = await onUploadImage(file);
      if (!mountedRef.current) return;
      if (readOnlyRef.current) {
        pendingUploadAnchorRef.current = null;
        return;
      }
      const currentEl = textarea.current;
      const currentText = latestValueRef.current;
      const currentSelStart = currentEl ? currentEl.selectionStart : currentText.length;
      const currentSelEnd = currentEl ? currentEl.selectionEnd : currentText.length;

      const anchor = pendingUploadAnchorRef.current ?? {
        start: startSelectionStart,
        end: startSelectionEnd,
        lastText: startText,
        hasSelection: startSelectionStart < startSelectionEnd,
        originalSelectedText:
          startSelectionStart < startSelectionEnd
            ? startText.slice(startSelectionStart, startSelectionEnd)
            : "",
        rangeEdited: false,
      };
      pendingUploadAnchorRef.current = null;

      if (anchor.lastText !== currentText) {
        const { editStart, oldEditEnd, delta } = computeEditRange(anchor.lastText, currentText);
        if (anchor.hasSelection && oldEditEnd > anchor.start && editStart < anchor.end) {
          anchor.rangeEdited = true;
        }
        const bias = anchor.hasSelection ? "left" : "right";
        anchor.start = adjustAnchorOffset(anchor.start, editStart, oldEditEnd, delta, bias);
        anchor.end = adjustAnchorOffset(anchor.end, editStart, oldEditEnd, delta, bias);
        anchor.lastText = currentText;
      }

      const boundedStart = Math.max(0, Math.min(anchor.start, currentText.length));
      const boundedEnd = Math.max(boundedStart, Math.min(anchor.end, currentText.length));

      const selectionUnchanged =
        anchor.hasSelection &&
        !anchor.rangeEdited &&
        currentText.slice(boundedStart, boundedEnd) === anchor.originalSelectedText;

      const insertStart = selectionUnchanged ? boundedStart : boundedEnd;
      const insertEnd = selectionUnchanged ? boundedEnd : boundedEnd;

      const { next, select } = image(currentText, insertStart, insertEnd, alt, url);
      const insertedLen = select[0] - insertStart;
      const replacedLen = insertEnd - insertStart;
      const delta = insertedLen - replacedLen;

      let newSelStart: number;
      let newSelEnd: number;

      if (
        currentText !== startText ||
        currentSelStart !== startSelectionStart ||
        currentSelEnd !== startSelectionEnd
      ) {
        if (currentSelStart >= insertEnd) {
          newSelStart = currentSelStart + delta;
          newSelEnd = currentSelEnd + delta;
        } else if (currentSelEnd <= insertStart) {
          newSelStart = currentSelStart;
          newSelEnd = currentSelEnd;
        } else {
          newSelStart = select[0];
          newSelEnd = select[1];
        }
      } else {
        newSelStart = select[0];
        newSelEnd = select[1];
      }

      pendingUploadSelectionRef.current = currentEl
        ? { element: currentEl, value: next, start: newSelStart, end: newSelEnd }
        : null;
      latestValueRef.current = next;
      onChange(next);
      setStatusMessage(null);
    } catch (error) {
      if (!mountedRef.current) return;
      pendingUploadAnchorRef.current = null;
      setStatusMessage(null);
      const err = error instanceof Error ? error.message : "Upload failed.";
      setUploadError(err);
    } finally {
      if (mountedRef.current) {
        uploadingRef.current = false;
        setUploading(false);
      }
    }
  };

  return (
    <div className="markdown-editor flex flex-col gap-2" data-compact={compact}>
      {statusMessage && (
        <p role="status" className="text-xs text-muted-foreground">
          {statusMessage}
        </p>
      )}
      {uploadError && (
        <p role="alert" className="text-xs text-destructive">
          {uploadError}
        </p>
      )}
      <div className={`flex flex-col gap-2 ${active ? "" : "hidden"}`} inert={!active}>
        <div className={`markdown-editor-toolbar flex flex-wrap gap-1 ${compact ? "hidden" : ""}`} inert={compact}>
          <ToolbarButton label="Bold" disabled={readOnly} onClick={bold}>
            B
          </ToolbarButton>
        <ToolbarButton label="Italic" disabled={readOnly} onClick={italic}>
          I
        </ToolbarButton>
        <ToolbarButton label="Heading" disabled={readOnly} onClick={() => splice(heading)}>
          H
        </ToolbarButton>
        <ToolbarButton
          label="Bulleted list"
          disabled={readOnly}
          onClick={() => splice((text, start, end) => prefixLines(text, start, end, () => "- "))}
        >
          •
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          disabled={readOnly}
          onClick={() =>
            // Numbering restarts at 1 for every application.
            splice((text, start, end) => prefixLines(text, start, end, (i) => `${i + 1}. `))
          }
        >
          1.
        </ToolbarButton>
        <ToolbarButton label="Link" disabled={readOnly} onClick={() => splice(link)}>
          <Link aria-hidden="true" className="size-3.5 shrink-0" />
        </ToolbarButton>
        <ToolbarButton
          label="Code"
          disabled={readOnly}
          onClick={() => splice((text, start, end) => wrap(text, start, end, "`"))}
        >
          {"</>"}
        </ToolbarButton>
        <ToolbarButton
          label="Image"
          disabled={uploading || readOnly}
          onClick={() => imageInput.current?.click()}
        >
          <Image aria-hidden="true" className="size-3.5 shrink-0" />
        </ToolbarButton>
        <input
          ref={imageInput}
          data-testid={imageInputTestId}
          type="file"
          accept={IMAGE_ACCEPT}
          disabled={readOnly}
          className="hidden"
          onChange={(event) => {
            if (readOnlyRef.current) return;
            const file = event.target.files?.[0];
            // Cleared so picking the same file again still fires a change event.
            event.target.value = "";
            if (file) void uploadAndInsert(file);
          }}
        />
        <span className="flex-1" />
          {trailing}
        </div>
        <Textarea
        ref={textarea}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onFocus={onFocus}
        onClick={onClick}
        aria-label={ariaLabel}
        rows={compact ? 1 : rows}
        value={value}
        readOnly={readOnly}
        disabled={!active}
        tabIndex={active ? 0 : -1}
        aria-hidden={!active}
        aria-disabled={readOnly || !active}
        onChange={(event) => {
          if (!activeRef.current || readOnly) return;
          pendingUploadSelectionRef.current = null;
          const next = event.target.value;
          updatePendingUploadAnchor(next);
          latestValueRef.current = next;
          onChange(next);
        }}
        onKeyDown={(event) => {
          if (!activeRef.current) return;
          if (event.key === "Escape") {
            if (readOnlyRef.current) {
              event.stopPropagation();
              event.preventDefault();
              return;
            }
            if (onEscape) {
              event.stopPropagation();
              onEscape();
              return;
            }
            return;
          }
          if (readOnlyRef.current) return;
          if (!event.ctrlKey && !event.metaKey) return;
          if (event.key === "Enter") {
            onSubmit();
            return;
          }
          if (event.key === "b" || event.key === "B") {
            event.preventDefault();
            bold();
            return;
          }
          if (event.key === "i" || event.key === "I") {
            event.preventDefault();
            italic();
          }
        }}
        // A pasted supported image uploads and embeds itself; every other paste
        // is left entirely alone.
        onPaste={(event) => {
          if (!activeRef.current || readOnlyRef.current) return;
          const candidate = extractClipboardImageCandidate(event.clipboardData, allowSvgPaste);
          if (!candidate) return;

          event.preventDefault();
          if (uploadingRef.current) {
            const msg = "An image is still uploading. Paste again when it finishes.";
            setUploadError(msg);

            return;
          }
          void uploadAndInsert(candidate.file, candidate.isSvg);
        }}
        className="resize-none"
      />
      </div>
    </div>
  );
}
const MarkdownInLinkContext = createContext(false);

interface MarkdownPreviewContextValue {
  previewImages?: ReadonlyMap<string, { id: string; fileName: string }>;
  onOpenImage?: (attachmentId: string, trigger?: HTMLElement | null) => void;
}

const MarkdownPreviewContext = createContext<MarkdownPreviewContextValue>({});

const inLinkLinkRenderer: Components["a"] = ({ node: _node, children, ...props }) => (
  <MarkdownInLinkContext.Provider value={true}>
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  </MarkdownInLinkContext.Provider>
);

function isSameOrigin(src: string): boolean {
  try {
    return new URL(src, location.origin).origin === location.origin;
  } catch {
    return false;
  }
}

const StableMarkdownImage: Components["img"] = ({ node: _node, src, alt, ...props }) => {
  const inLink = useContext(MarkdownInLinkContext);
  const { previewImages, onOpenImage } = useContext(MarkdownPreviewContext);
  const preview =
    !inLink && typeof src === "string" ? previewImages?.get(src) : undefined;
  if (typeof src === "string" && !isSameOrigin(src)) {
    // The CSP (public/_headers) would block it anyway; keep it reachable as a link.
    const label = alt || src;
    return inLink ? (
      <span>{label}</span>
    ) : (
      <a href={src} target="_blank" rel="noreferrer">
        {label}
      </a>
    );
  }
  if (!preview || !onOpenImage) {
    return <img src={src} alt={alt} {...props} />;
  }

  return (
    <button
      type="button"
      aria-label={`Preview attachment ${preview.fileName}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpenImage(preview.id, event.currentTarget);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
      className="cursor-zoom-in text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <img src={src} alt={alt} {...props} />
    </button>
  );
};

const standardMarkdownComponents: Components = {
  a: inLinkLinkRenderer,
  img: StableMarkdownImage,
};

const youtubeParagraphRenderer: Components["p"] = ({ node, children, ...props }) => {
  const contentNodes = node?.children.filter(
    (child) => child.type !== "text" || child.value.trim() !== "",
  );
  const linkNode = contentNodes?.length === 1 ? contentNodes[0] : undefined;
  let video: YouTubeVideo | null = null;
  if (
    linkNode?.type === "element" &&
    linkNode.tagName === "a" &&
    typeof linkNode.properties.href === "string" &&
    linkNode.children.length === 1 &&
    linkNode.children[0]?.type === "text"
  ) {
    const href = linkNode.properties.href;
    const label = linkNode.children[0].value.trim();
    if (label === href || label === href.replace(/^https?:\/\//i, "")) {
      video = parseYouTubeUrl(href);
    }
  }

  if (video) {
    return (
      <YouTubeEmbed
        key={`${video.videoId}:${video.startSeconds}`}
        videoId={video.videoId}
        startSeconds={video.startSeconds}
      />
    );
  }

  return <p {...props}>{children}</p>;
};
const youtubeMarkdownComponents: Components = {
  a: inLinkLinkRenderer,
  p: youtubeParagraphRenderer,
  img: StableMarkdownImage,
};

/**
 * The render half: rendered Markdown, no wrapper. Callers own the `prose` div.
 *
 * Two deliberate omissions keep untrusted text inert: no `rehype-raw`, so raw
 * HTML renders as literal text rather than elements; and react-markdown's
 * default `urlTransform` is left in place, so `javascript:` and other unsafe
 * hrefs are stripped.
 */
export function MarkdownContent({
  value,
  embedYouTube = false,
  previewImages,
  onOpenImage,
}: {
  value: string;
  embedYouTube?: boolean;
  /**
   * Previewable images currently attached to the card, keyed by canonical URL.
   */
  previewImages?: ReadonlyMap<string, { id: string; fileName: string }>;
  /** Opens the card's fullscreen attachment viewer for an embedded image. */
  onOpenImage?: (attachmentId: string, trigger?: HTMLElement | null) => void;
}) {
  const previewContextValue = useMemo<MarkdownPreviewContextValue>(
    () => ({ previewImages, onOpenImage }),
    [previewImages, onOpenImage],
  );

  const components = embedYouTube ? youtubeMarkdownComponents : standardMarkdownComponents;

  return (
    <MarkdownPreviewContext.Provider value={previewContextValue}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {value}
      </Markdown>
    </MarkdownPreviewContext.Provider>
  );
}

export function ToolbarButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:text-sm [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]"
    >
      {children}
    </Button>
  );
}


/** A rewritten draft plus the selection to restore, as `[start, end]`. */
type Splice = { next: string; select: [number, number] };

/**
 * Wraps the selection in `marker`; an empty selection inserts the pair with the
 * caret between. No toggle-off — a second click nests, which is what a plain
 * insert does and is easy to undo.
 */
function wrap(text: string, start: number, end: number, marker: string): Splice {
  const next = `${text.slice(0, start)}${marker}${text.slice(start, end)}${marker}${text.slice(end)}`;
  return { next, select: [start + marker.length, end + marker.length] };
}

/** Prefixes `## ` to the line holding the caret. */
function heading(text: string, start: number, end: number): Splice {
  const from = lineStart(text, start);
  const prefix = "## ";
  const next = `${text.slice(0, from)}${prefix}${text.slice(from)}`;
  return { next, select: [start + prefix.length, end + prefix.length] };
}

/** Prefixes every line touched by the selection, keeping the lines selected. */
function prefixLines(
  text: string,
  start: number,
  end: number,
  prefix: (index: number) => string,
): Splice {
  const from = lineStart(text, start);
  const toNewline = text.indexOf("\n", end);
  const to = toNewline === -1 ? text.length : toNewline;
  const prefixed = text
    .slice(from, to)
    .split("\n")
    .map((line, index) => `${prefix(index)}${line}`)
    .join("\n");
  const next = `${text.slice(0, from)}${prefixed}${text.slice(to)}`;
  return { next, select: [from, from + prefixed.length] };
}

/**
 * Start of the line holding `at`. `lastIndexOf` from a negative index would
 * search position 0 instead of finding nothing, so offset 0 is its own case.
 */
function lineStart(text: string, at: number): number {
  return at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
}

/** `[selection](url)` with `url` selected, or `[text](url)` with `text` selected. */
function link(text: string, start: number, end: number): Splice {
  const label = start === end ? "text" : text.slice(start, end);
  const next = `${text.slice(0, start)}[${label}](url)${text.slice(end)}`;
  const labelStart = start + 1;
  if (start === end) return { next, select: [labelStart, labelStart + label.length] };
  const urlStart = labelStart + label.length + 2;
  return { next, select: [urlStart, urlStart + 3] };
}

/**
 * Replaces the selection with `![alt](url)` for a freshly uploaded image. The
 * caret lands after the insertion — unlike `link`, there is nothing left to fill in.
 */
function image(text: string, start: number, end: number, alt: string, url: string): Splice {
  const markup = `![${alt}](${url})`;
  const next = `${text.slice(0, start)}${markup}${text.slice(end)}`;
  const caret = start + markup.length;
  return { next, select: [caret, caret] };
}

/**
 * Calculates the range replaced between two text revisions:
 * editStart: index of first differing character
 * oldEditEnd: end of replaced range in prev
 * delta: net difference in character count (next.length - prev.length)
 */
export function computeEditRange(
  prev: string,
  next: string,
): { editStart: number; oldEditEnd: number; delta: number } {
  let pre = 0;
  const minLen = Math.min(prev.length, next.length);
  while (pre < minLen && prev.charCodeAt(pre) === next.charCodeAt(pre)) {
    pre += 1;
  }
  let suf = 0;
  while (
    suf < minLen - pre &&
    prev.charCodeAt(prev.length - 1 - suf) === next.charCodeAt(next.length - 1 - suf)
  ) {
    suf += 1;
  }
  const editStart = pre;
  const oldEditEnd = prev.length - suf;
  const delta = next.length - prev.length;
  return { editStart, oldEditEnd, delta };
}

/**
 * Adjusts an offset across an edit in the text:
 * - If edit is a pure insertion at offset: shifts by delta if bias is "right", else stays.
 * - If offset <= editStart: edit happened after/at offset; offset does not move.
 * - If offset >= oldEditEnd: edit happened before offset; offset shifts by delta.
 * - If offset is within replaced range: collapses to editStart.
 */
export function adjustAnchorOffset(
  offset: number,
  editStart: number,
  oldEditEnd: number,
  delta: number,
  bias: "left" | "right" = "left",
): number {
  if (editStart === oldEditEnd && offset === editStart) {
    return bias === "right" ? offset + delta : offset;
  }
  if (offset <= editStart) {
    return offset;
  }
  if (offset >= oldEditEnd) {
    return Math.max(editStart, offset + delta);
  }
  return editStart;
}

function extractClipboardImageCandidate(
  clipboardData: DataTransfer,
  allowSvgPaste: boolean,
): { file: File; isSvg: boolean } | null {
  if (allowSvgPaste) {
    // Priority 1: First SVG file
    // Matches image/svg+xml or empty-MIME .svg file (does NOT match explicit non-SVG types
    // like application/octet-stream).
    // Check both clipboardData.files and clipboardData.items (where synthetic DataTransfer files may live).
    const files = getClipboardFiles(clipboardData);
    const svgFile = files.find((f) => {
      const normalizedType = normalizeAttachmentContentType(f.type);
      return (
        normalizedType === "image/svg+xml" ||
        (f.name.toLowerCase().endsWith(".svg") && f.type === "")
      );
    });
    if (svgFile) {
      const normalizedFile =
        svgFile.type === "image/svg+xml"
          ? svgFile
          : new File([svgFile], svgFile.name || "pasted.svg", { type: "image/svg+xml" });
      return { file: normalizedFile, isSvg: true };
    }
    // Priority 2: SVG MIME string item
    // Explicit SVG MIME payloads are always conversion candidates (even if empty or whitespace-only)
    // and never fall back to lower-priority raster.
    const hasSvgMime = Array.from(clipboardData.types).includes("image/svg+xml");
    if (hasSvgMime) {
      const svgString = clipboardData.getData("image/svg+xml");
      const file = new File([svgString], "pasted.svg", { type: "image/svg+xml" });
      return { file, isSvg: true };
    }

    // Priority 3: Whole plain-text SVG document
    const plainText = clipboardData.getData("text/plain");
    if (plainText && isWholeSvgDocument(plainText)) {
      const file = new File([plainText], "pasted.svg", { type: "image/svg+xml" });
      return { file, isSvg: true };
    }
  }

  // Priority 4 (or standard paste): first supported raster file
  const files = getClipboardFiles(clipboardData);
  const rasterFile = files.find((candidate) =>
    isPreviewableImageContentType(normalizeAttachmentContentType(candidate.type)),
  );
  if (rasterFile) {
    return { file: rasterFile, isSvg: false };
  }
  return null;
}
function getClipboardFiles(clipboardData: DataTransfer): File[] {
  const fileList: File[] = [];
  if (clipboardData.files && clipboardData.files.length > 0) {
    for (let i = 0; i < clipboardData.files.length; i++) {
      const file = clipboardData.files[i];
      if (file) fileList.push(file);
    }
  }
  if (clipboardData.items && clipboardData.items.length > 0) {
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item && item.kind === "file") {
        const file = item.getAsFile();
        if (file && !fileList.some((existing) => existing.name === file.name && existing.size === file.size)) {
          fileList.push(file);
        }
      }
    }
  }
  return fileList;
}

function isWholeSvgDocument(text: string): boolean {
  // Trim BOM and whitespace
  let trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") return false;

  // Skip optional XML declaration <?xml ... ?>
  if (trimmed.startsWith("<?xml")) {
    const xmlEnd = trimmed.indexOf("?>");
    if (xmlEnd === -1) return false;
    trimmed = trimmed.slice(xmlEnd + 2).trim();
  }

  // Skip leading XML comments <!-- ... -->
  while (trimmed.startsWith("<!--")) {
    const commentEnd = trimmed.indexOf("-->");
    if (commentEnd === -1) return false;
    trimmed = trimmed.slice(commentEnd + 3).trim();
  }

  // Require <svg followed by whitespace, > or /
  if (!/^<svg(\s|>|\/)/i.test(trimmed)) {
    return false;
  }

  // Use DOMParser to parse as XML
  const parser = new DOMParser();
  const doc = parser.parseFromString(trimmed, "image/svg+xml");
  const parserError = doc.querySelector("parsererror");

  if (!parserError && doc.documentElement && doc.documentElement.localName === "svg") {
    // Document is well-formed XML with an SVG root element.
    // Verify that everything outside the root element in the source text is only
    // XML whitespace and comments.
    const rootEndIndex = findRootElementEnd(trimmed);
    if (rootEndIndex === -1) {
      // Should not happen for well-formed document, but treat as candidate
      return true;
    }
    const afterRoot = trimmed.slice(rootEndIndex).trim();
    if (afterRoot === "") return true;

    // Check if afterRoot is only XML comments
    let rest = afterRoot;
    let onlyComments = true;
    while (rest.startsWith("<!--")) {
      const cEnd = rest.indexOf("-->");
      if (cEnd === -1) {
        onlyComments = false;
        break;
      }
      rest = rest.slice(cEnd + 3).trim();
    }
    if (onlyComments && rest === "") {
      return true;
    }
    // There is non-comment trailing content (prose). Retain native paste!
    return false;
  }

  // If parser failed:
  // Check if there is a completed root followed by prose.
  // "If an SVG-root-prefixed input is malformed with no completed root followed by prose,
  // intercept it and let conversion report the error."
  // "A complete SVG followed by prose, a prose prefix, and fenced code retain native paste byte-for-byte."
  const rootEndIndex = findRootElementEnd(trimmed);
  if (rootEndIndex !== -1) {
    const afterRoot = trimmed.slice(rootEndIndex).trim();
    if (afterRoot !== "") {
      let rest = afterRoot;
      let onlyComments = true;
      while (rest.startsWith("<!--")) {
        const cEnd = rest.indexOf("-->");
        if (cEnd === -1) {
          onlyComments = false;
          break;
        }
        rest = rest.slice(cEnd + 3).trim();
      }
      if (!onlyComments || rest !== "") {
        // Completed root followed by trailing prose -> retain native paste!
        return false;
      }
    }
  }

  // Root-prefixed input without completed root followed by prose: intercept and report error
  return true;
}

/**
 * Lexically scans XML to find the end position of the outer <svg>...</svg> or <svg.../> element.
 * Correctly handles quoted attribute strings (so '>' inside quotes doesn't end a tag),
 * XML comments (so tags inside comments are ignored), and whitespace in closing tags like </svg >.
 */
function findRootElementEnd(source: string): number {
  let i = 0;
  const len = source.length;

  // Skip any leading <?...?> or <!--...--> before the root
  while (i < len) {
    const nextLt = source.indexOf("<", i);
    if (nextLt === -1) return -1;
    if (source.startsWith("<!--", nextLt)) {
      const cEnd = source.indexOf("-->", nextLt + 4);
      i = cEnd === -1 ? len : cEnd + 3;
      continue;
    }
    if (source.startsWith("<?", nextLt)) {
      const piEnd = source.indexOf("?>", nextLt + 2);
      i = piEnd === -1 ? len : piEnd + 2;
      continue;
    }
    if (/^<svg(\s|>|\/)/i.test(source.slice(nextLt))) {
      i = nextLt;
      break;
    }
    return -1;
  }

  if (i >= len) return -1;

  // Now scan the root element
  let depth = 0;
  while (i < len) {
    const nextLt = source.indexOf("<", i);
    if (nextLt === -1) return -1;

    // Comment inside SVG
    if (source.startsWith("<!--", nextLt)) {
      const cEnd = source.indexOf("-->", nextLt + 4);
      i = cEnd === -1 ? len : cEnd + 3;
      continue;
    }
    // CDATA inside SVG
    if (source.startsWith("<![CDATA[", nextLt)) {
      const cdEnd = source.indexOf("]]>", nextLt + 9);
      i = cdEnd === -1 ? len : cdEnd + 3;
      continue;
    }
    // Processing instruction inside SVG
    if (source.startsWith("<?", nextLt)) {
      const piEnd = source.indexOf("?>", nextLt + 2);
      i = piEnd === -1 ? len : piEnd + 2;
      continue;
    }
    // Tag scanning: could be opening, self-closing, or closing tag
    let tagIdx = nextLt + 1;
    const isClosing = tagIdx < len && source[tagIdx] === "/";
    if (isClosing) tagIdx++;

    // Parse tag name
    const nameStart = tagIdx;
    while (tagIdx < len && !/[\s>\/]/.test(source[tagIdx])) {
      tagIdx++;
    }
    const tagName = source.slice(nameStart, tagIdx).toLowerCase();

    // Scan attributes until '>'
    let selfClosing = false;
    let inQuote: string | null = null;
    while (tagIdx < len) {
      const ch = source[tagIdx];
      if (inQuote !== null) {
        if (ch === inQuote) {
          inQuote = null;
        }
      } else {
        if (ch === '"' || ch === "'") {
          inQuote = ch;
        } else if (ch === "/" && tagIdx + 1 < len && source[tagIdx + 1] === ">") {
          selfClosing = true;
        } else if (ch === ">") {
          tagIdx++;
          break;
        }
      }
      tagIdx++;
    }

    if (isClosing) {
      depth--;
      if (depth === 0 && tagName === "svg") {
        return tagIdx;
      }
    } else if (selfClosing) {
      if (depth === 0 && tagName === "svg") {
        return tagIdx;
      }
    } else {
      depth++;
    }

    i = tagIdx;
  }

  return -1;
}
