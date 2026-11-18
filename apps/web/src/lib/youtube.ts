import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export type YouTubeVideo = {
  videoId: string;
  startSeconds: number;
};

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS: Record<string, true> = {
  "youtube.com": true,
  "www.youtube.com": true,
  "m.youtube.com": true,
};
const SHORT_HOSTS: Record<string, true> = {
  "youtu.be": true,
  "www.youtu.be": true,
};

export function parseYouTubeUrl(value: string): YouTubeVideo | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return null;
  }

  let videoId: string | null = null;

  if (YOUTUBE_HOSTS[url.hostname]) {
    if (url.pathname === "/watch") {
      const videoIds = url.searchParams.getAll("v");
      if (videoIds.length === 1) videoId = videoIds[0] ?? null;
    } else {
      const pathMatch = /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname);
      videoId = pathMatch?.[1] ?? null;
    }
  } else if (SHORT_HOSTS[url.hostname]) {
    const pathMatch = /^\/([^/]+)\/?$/.exec(url.pathname);
    videoId = pathMatch?.[1] ?? null;
  }

  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) return null;

  return {
    videoId,
    startSeconds: parseStartSeconds(url),
  };
}
const YOUTUBE_HINT = /youtu/i;
const GFM_EXTENSIONS = [gfm()];
const GFM_MDAST_EXTENSIONS = [gfmFromMarkdown()];

type MdNode = ReturnType<typeof fromMarkdown>["children"][number];

/** Mirrors MarkdownEditor's `p` renderer: a paragraph holding only a bare YouTube link. */
function isBareYouTubeParagraph(node: Extract<MdNode, { type: "paragraph" }>): boolean {
  const contentNodes = node.children.filter(
    (child) => child.type !== "text" || child.value.trim() !== "",
  );
  if (contentNodes.length !== 1) return false;
  const linkNode = contentNodes[0];
  if (
    linkNode?.type !== "link" ||
    typeof linkNode.url !== "string" ||
    linkNode.children.length !== 1 ||
    linkNode.children[0]?.type !== "text"
  ) {
    return false;
  }
  const href = linkNode.url;
  const label = linkNode.children[0].value.trim();
  return (
    (label === href || label === href.replace(/^https?:\/\//i, "")) &&
    parseYouTubeUrl(href) !== null
  );
}

// Paragraphs embed at any depth (quotes, list items), so the walk does too, except where the renderer
// never sees a `<p>`: mdast-util-to-hast unwraps the paragraphs directly inside a tight list's items.
function containsYouTubeParagraph(nodes: readonly MdNode[], tight = false): boolean {
  return nodes.some((node) => {
    if (node.type === "paragraph") return !tight && isBareYouTubeParagraph(node);
    if (node.type === "list") {
      const loose = node.spread || node.children.some((item) => item.spread);
      return node.children.some((item) => containsYouTubeParagraph(item.children, !loose));
    }
    return "children" in node && containsYouTubeParagraph(node.children as MdNode[]);
  });
}

const YOUTUBE_CACHE_LIMIT = 500;
const youTubeCache = new Map<string, boolean>();

/** Cached by description: card faces ask on every render and parsing markdown is the cost. */
export function hasYouTubeVideo(description: string): boolean {
  if (!description || !YOUTUBE_HINT.test(description)) return false;
  const cached = youTubeCache.get(description);
  if (cached !== undefined) return cached;
  let found = false;
  try {
    found = containsYouTubeParagraph(
      fromMarkdown(description, {
        extensions: GFM_EXTENSIONS,
        mdastExtensions: GFM_MDAST_EXTENSIONS,
      }).children,
    );
  } catch {
    // Unparseable text embeds nothing.
  }
  if (youTubeCache.size >= YOUTUBE_CACHE_LIMIT) youTubeCache.clear();
  youTubeCache.set(description, found);
  return found;
}

function parseStartSeconds(url: URL): number {
  let value: string | null = null;

  if (url.searchParams.has("start")) {
    value = url.searchParams.get("start");
  } else if (url.searchParams.has("t")) {
    value = url.searchParams.get("t");
  } else if (url.hash.startsWith("#t=")) {
    value = url.hash.slice(3);
  }

  if (value === null || value === "") return 0;

  let seconds: number;
  if (/^\d+s?$/.test(value)) {
    seconds = Number.parseInt(value, 10);
  } else {
    const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
    if (!match || match[0] === "") return 0;
    seconds =
      Number.parseInt(match[1] ?? "0", 10) * 3600 +
      Number.parseInt(match[2] ?? "0", 10) * 60 +
      Number.parseInt(match[3] ?? "0", 10);
  }

  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : 0;
}
