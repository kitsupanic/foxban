import type { Nodes } from "mdast";
import { fromMarkdown, type Extension } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
type Edit = { start: number; end: number; replacement: string };

function offset(node: Nodes, edge: "start" | "end"): number {
  const value = node.position?.[edge].offset;
  if (value === undefined) throw new Error("Markdown node is missing its source offset.");
  return value;
}

export function removeAttachmentReferences(
  markdown: string,
  boardId: string,
  attachmentId: string,
): string {
  if (!markdown) return markdown;

  const target = `/boards/${boardId}/attachments/${attachmentId}`;
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const definitions = new Map<string, string>();

  function collectDefinitions(node: Nodes): void {
    // The parser normalizes identifiers; Markdown resolves the first definition.
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if ("children" in node) {
      for (const child of node.children) collectDefinitions(child);
    }
  }
  collectDefinitions(tree);

  function splice(start: number, end: number, edits: Edit[]): string {
    let result = "";
    let cursor = start;
    for (const edit of edits) {
      result += markdown.slice(cursor, edit.start) + edit.replacement;
      cursor = edit.end;
    }
    return result + markdown.slice(cursor, end);
  }

  function collectEdits(node: Nodes, edits: Edit[]): void {
    const url =
      node.type === "imageReference" || node.type === "linkReference"
        ? definitions.get(node.identifier)
        : "url" in node
          ? node.url
          : undefined;

    if (url === target) {
      const start = offset(node, "start");
      const end = offset(node, "end");
      if (node.type === "image" || node.type === "imageReference" || node.type === "definition") {
        edits.push({ start, end, replacement: "" });
        return;
      }
      if (node.type === "link" || node.type === "linkReference") {
        const labelEdits: Edit[] = [];
        for (const child of node.children) collectEdits(child, labelEdits);
        const first = node.children[0];
        const last = node.children[node.children.length - 1];
        // Child spans cover the original label, not a reference's identifier.
        // Autolink children likewise exclude angle brackets. Never use decoded text.
        const replacement =
          first && last ? splice(offset(first, "start"), offset(last, "end"), labelEdits) : "";
        edits.push({ start, end, replacement });
        return;
      }
    }

    if ("children" in node) {
      for (const child of node.children) collectEdits(child, edits);
    }
  }

  // Compose edits inside removed link wrappers before splicing their parents,
  // leaving only ordered, non-overlapping ranges in the original source.
  const edits: Edit[] = [];
  collectEdits(tree, edits);
  return edits.length ? splice(0, markdown.length, edits) : markdown;
}

function getDestinationRange(
  node: Nodes,
  destinationOffsets: Map<Nodes, { start: number; end: number }>,
  markdown: string,
): { start: number; end: number } | null {
  const fromParser = destinationOffsets.get(node);
  if (fromParser) return fromParser;

  // Fallback for autolinks enclosed in angle brackets (<url>)
  const start = offset(node, "start");
  const end = offset(node, "end");
  if (markdown[start] === "<" && markdown[end - 1] === ">") {
    return { start: start + 1, end: end - 1 };
  }
  return null;
}

export function rewriteAttachmentUrls(
  markdown: string,
  sourceBoardId: string,
  destinationBoardId: string,
  attachmentIds: readonly string[],
): string {
  if (!markdown || attachmentIds.length === 0 || sourceBoardId === destinationBoardId) {
    return markdown;
  }

  const idSet = new Set(attachmentIds);
  const prefix = `/boards/${sourceBoardId}/attachments/`;
  const destPrefix = `/boards/${destinationBoardId}/attachments/`;

  const destinationOffsets = new Map<Nodes, { start: number; end: number }>();

  const trackDestinations: Extension = {
    exit: {
      resourceDestinationString(token) {
        const data = this.resume();
        const node = this.stack[this.stack.length - 1];
        if (node && (node.type === "link" || node.type === "image")) {
          node.url = data;
          if (token.start.offset !== undefined && token.end.offset !== undefined) {
            destinationOffsets.set(node, { start: token.start.offset, end: token.end.offset });
          }
        }
      },
      definitionDestinationString(token) {
        const data = this.resume();
        const node = this.stack[this.stack.length - 1];
        if (node && node.type === "definition") {
          node.url = data;
          if (token.start.offset !== undefined && token.end.offset !== undefined) {
            destinationOffsets.set(node, { start: token.start.offset, end: token.end.offset });
          }
        }
      },
    },
  };

  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown(), trackDestinations],
  });

  function splice(start: number, end: number, edits: Edit[]): string {
    let result = "";
    let cursor = start;
    for (const edit of edits) {
      result += markdown.slice(cursor, edit.start) + edit.replacement;
      cursor = edit.end;
    }
    return result + markdown.slice(cursor, end);
  }

  const edits: Edit[] = [];

  function collectEdits(node: Nodes): void {
    if (node.type === "definition" || node.type === "image" || node.type === "link") {
      const url = node.url;
      if (url && url.startsWith(prefix)) {
        const attId = url.slice(prefix.length);
        if (idSet.has(attId)) {
          const targetUrl = `${destPrefix}${attId}`;
          const destRange = getDestinationRange(node, destinationOffsets, markdown);
          if (destRange && destRange.start < destRange.end) {
            edits.push({ start: destRange.start, end: destRange.end, replacement: targetUrl });
          }
        }
      }
    }

    if ("children" in node) {
      for (const child of node.children) collectEdits(child);
    }
  }

  collectEdits(tree);

  if (edits.length === 0) return markdown;

  edits.sort((a, b) => a.start - b.start);

  return splice(0, markdown.length, edits);
}
