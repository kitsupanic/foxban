import { removeAttachmentReferences, rewriteAttachmentUrls } from "@foxban/shared";
import { describe, expect, it } from "vitest";
import {
  attachmentObjectKey,
  attachmentTransferObjectKey,
  parseAttachmentObjectKey,
} from "../src/attachment-lifecycle";

const BOARD_ID = "board-a";
const ATTACHMENT_ID = "attachment-1";
const URL = `/boards/${BOARD_ID}/attachments/${ATTACHMENT_ID}`;
const OTHER_URL = `/boards/${BOARD_ID}/attachments/attachment-2`;

function expectCleanup(markdown: string, expected: string): void {
  const cleaned = removeAttachmentReferences(markdown, BOARD_ID, ATTACHMENT_ID);
  expect(cleaned).toBe(expected);
  expect(removeAttachmentReferences(cleaned, BOARD_ID, ATTACHMENT_ID)).toBe(expected);
}

describe("removeAttachmentReferences", () => {
  it("removes repeated embeds without trimming prose, blank lines or another attachment", () => {
    expectCleanup(
      `  Before **keep**  \n\n![remove](${URL})\n\nMiddle ![again](${URL} "title") end\n\n![keep](${OTHER_URL})\n\nAfter\n`,
      `  Before **keep**  \n\n\n\nMiddle  end\n\n![keep](${OTHER_URL})\n\nAfter\n`,
    );
  });

  it("unwraps links while preserving the exact formatted and escaped label source", () => {
    expectCleanup(
      `Before [ **bold** _italic_ ~~gone~~ \`code\` \\[literal\\] &amp; ](<${URL}> "download") after\n[empty](${URL}) [](${URL})`,
      "Before  **bold** _italic_ ~~gone~~ `code` \\[literal\\] &amp;  after\nempty ",
    );
  });

  it("resolves full, collapsed and shortcut references and removes their shared definition", () => {
    expectCleanup(
      `![one][ ASSET ] [**download**][asset] ![asset][] [asset][] ![asset] [asset]\n\n[asset]: <${URL}> "shared title"\n[other]: ${OTHER_URL}\n\n![keep][other]\n`,
      ` **download**  asset  asset\n\n\n[other]: ${OTHER_URL}\n\n![keep][other]\n`,
    );
  });

  it("uses the first definition after identifier case and whitespace normalization", () => {
    expectCleanup(
      `![remove][mixed label] [*label*][MIXED\tLABEL]\n\n[MiXeD   LaBeL]: ${URL}\n[mixed label]: ${OTHER_URL}\n`,
      ` *label*\n\n\n[mixed label]: ${OTHER_URL}\n`,
    );
  });

  it("preserves references resolved by an earlier unrelated definition while deleting a later matching definition", () => {
    expectCleanup(
      `![keep][ASSET] [download][asset]\n\n[asset]: ${OTHER_URL} "first wins"\n[ASSET]: ${URL}\n`,
      `![keep][ASSET] [download][asset]\n\n[asset]: ${OTHER_URL} "first wins"\n\n`,
    );
  });

  it("removes a nested image without rewriting its unrelated surrounding link", () => {
    expectCleanup(
      `[before ![remove](${URL}) **after**](https://example.test "keep title")\n[![remove][asset]][outside]\n\n[asset]: ${URL}\n[outside]: ${OTHER_URL}\n`,
      `[before  **after**](https://example.test "keep title")\n[][outside]\n\n\n[outside]: ${OTHER_URL}\n`,
    );
  });

  it("cleans a matching link's label recursively before unwrapping it", () => {
    expectCleanup(
      `[**before** ![remove](${URL}) ![keep](${OTHER_URL}) _after_](${URL})\n[before ![remove][asset] after][asset]\n\n[asset]: ${URL}\n`,
      `**before**  ![keep](${OTHER_URL}) _after_\nbefore  after\n\n\n`,
    );
  });

  it("matches parsed destinations rather than their raw Markdown spelling", () => {
    expectCleanup(
      `[download](/boards/board-a/attachments/attachment&#45;1) ![remove](<${URL}>)`,
      "download ",
    );
  });

  it("does not match foreign boards, id prefixes, absolute URLs, queries or fragments", () => {
    const retained = [
      "/boards/board-b/attachments/attachment-1",
      `${URL}0`,
      "/boards/board-a/attachments/attachment",
      `${URL}/preview`,
      `https://foxban.test${URL}`,
      `//foxban.test${URL}`,
      `${URL}?download=1`,
      `${URL}#preview`,
    ]
      .map((destination) => `![keep](${destination}) [keep](${destination})`)
      .join("\n");
    expectCleanup(`![remove](${URL})\n${retained}`, `\n${retained}`);
  });

  it("preserves inline, fenced and indented code alongside a real embed", () => {
    const literal = [
      `\`![inline](${URL})\``,
      "",
      "```markdown",
      `![fenced](${URL})`,
      `[asset]: ${URL}`,
      "```",
      "",
      `    ![indented](${URL})`,
      "",
    ].join("\n");
    expectCleanup(`${literal}\n![remove](${URL})`, `${literal}\n`);
  });

  it("preserves escaped syntax, literal HTML, unresolved references and malformed markup", () => {
    const literal = [
      `\\!\\[escaped](${URL})`,
      `\\[escaped link](${URL})`,
      `![unresolved][missing] [unresolved][missing]`,
      `![unfinished](${URL}`,
      `<img src="${URL}" alt="literal">`,
      `<a href="${URL}">literal link</a>`,
      "",
      "<div>",
      `![HTML block contents](${URL})`,
      "</div>",
      "",
    ].join("\n");
    expectCleanup(`${literal}\n![remove](${URL})`, `${literal}\n`);
  });

  it("preserves Unicode, CRLF, tabs and trailing spaces outside removed spans", () => {
    expectCleanup(
      `漢字 café 𐐀\t![remove](${URL})  \r\n\r\n[**保留 é**](${URL})\r\n![keep](${OTHER_URL})\t\r\n`,
      `漢字 café 𐐀\t  \r\n\r\n**保留 é**\r\n![keep](${OTHER_URL})\t\r\n`,
    );
  });

  it("cleans GFM table and task-list content without reformatting their surrounding source", () => {
    expectCleanup(
      `| Attachment | Note |\n| --- | --- |\n| ![remove](${URL}) | ~~[download](${URL})~~ |\n\n- [x] ![remove](${URL}) keep\n`,
      "| Attachment | Note |\n| --- | --- |\n|  | ~~download~~ |\n\n- [x]  keep\n",
    );
  });

  it("returns empty and no-match descriptions unchanged", () => {
    expectCleanup("", "");
    const markdown = `  Plain ${URL}\n\n![keep](${OTHER_URL})\n`;
    expectCleanup(markdown, markdown);
  });

  it("preserves originally literal bytes when deletion joins delimiters into new syntax", () => {
    // One source-AST pass is intentional: newly exposed syntax is not an original reference.
    const markdown = `![literal]![remove](${URL})(${URL})`;
    expect(removeAttachmentReferences(markdown, BOARD_ID, ATTACHMENT_ID)).toBe(
      `![literal](${URL})`,
    );
  });
});

describe("rewriteAttachmentUrls", () => {
  const SOURCE_BOARD = "source-board-uuid";
  const DEST_BOARD = "dest-board-uuid";
  const ATT_1 = "att-uuid-1";
  const ATT_2 = "att-uuid-2";
  const OWNED = [ATT_1, ATT_2];

  const SRC_URL_1 = `/boards/${SOURCE_BOARD}/attachments/${ATT_1}`;
  const SRC_URL_2 = `/boards/${SOURCE_BOARD}/attachments/${ATT_2}`;
  const DST_URL_1 = `/boards/${DEST_BOARD}/attachments/${ATT_1}`;
  const DST_URL_2 = `/boards/${DEST_BOARD}/attachments/${ATT_2}`;

  it("rewrites inline image and link URLs to destination board while keeping labels intact", () => {
    const input = `Here is ![photo 1](${SRC_URL_1}) and a link to [file 2](${SRC_URL_2} "download").`;
    const expected = `Here is ![photo 1](${DST_URL_1}) and a link to [file 2](${DST_URL_2} "download").`;
    expect(rewriteAttachmentUrls(input, SOURCE_BOARD, DEST_BOARD, OWNED)).toBe(expected);
  });

  it("rewrites reference-style link and image definition URLs", () => {
    const input = [
      `See ![diagram][fig1] and download [notes][doc].`,
      ``,
      `[fig1]: ${SRC_URL_1} "Architecture"`,
      `[doc]: <${SRC_URL_2}>`,
      `[unrelated]: https://example.com`,
    ].join("\n");

    const expected = [
      `See ![diagram][fig1] and download [notes][doc].`,
      ``,
      `[fig1]: ${DST_URL_1} "Architecture"`,
      `[doc]: <${DST_URL_2}>`,
      `[unrelated]: https://example.com`,
    ].join("\n");

    expect(rewriteAttachmentUrls(input, SOURCE_BOARD, DEST_BOARD, OWNED)).toBe(expected);
  });

  it("preserves foreign board URLs, unowned attachment IDs, and external links byte-identically", () => {
    const foreignBoardUrl = `/boards/other-board-uuid/attachments/${ATT_1}`;
    const unownedUrl = `/boards/${SOURCE_BOARD}/attachments/unowned-att-3`;
    const externalUrl = "https://cdn.example.com/images/cat.png";

    const input = [
      `![foreign](${foreignBoardUrl})`,
      `![unowned](${unownedUrl})`,
      `[external](${externalUrl})`,
      `![owned](${SRC_URL_1})`,
    ].join("\n");

    const expected = [
      `![foreign](${foreignBoardUrl})`,
      `![unowned](${unownedUrl})`,
      `[external](${externalUrl})`,
      `![owned](${DST_URL_1})`,
    ].join("\n");

    expect(rewriteAttachmentUrls(input, SOURCE_BOARD, DEST_BOARD, OWNED)).toBe(expected);
  });

  it("preserves code blocks (inline, fenced, and indented) containing owned attachment URLs byte-identically", () => {
    const input = [
      `Use \`![literal](${SRC_URL_1})\` in Markdown.`,
      ``,
      `\`\`\`markdown`,
      `![code block embed](${SRC_URL_1})`,
      `[doc]: ${SRC_URL_2}`,
      `\`\`\``,
      ``,
      `    const url = "${SRC_URL_1}";`,
      ``,
      `Real embed: ![real](${SRC_URL_1})`,
    ].join("\n");

    const expected = [
      `Use \`![literal](${SRC_URL_1})\` in Markdown.`,
      ``,
      `\`\`\`markdown`,
      `![code block embed](${SRC_URL_1})`,
      `[doc]: ${SRC_URL_2}`,
      `\`\`\``,
      ``,
      `    const url = "${SRC_URL_1}";`,
      ``,
      `Real embed: ![real](${DST_URL_1})`,
    ].join("\n");

    expect(rewriteAttachmentUrls(input, SOURCE_BOARD, DEST_BOARD, OWNED)).toBe(expected);
  });

  it("preserves surrounding GFM tables, task lists, emojis, and formatting unchanged", () => {
    const input = [
      `| File | Preview | Status |`,
      `| --- | --- | --- |`,
      `| photo.png | ![img](${SRC_URL_1}) | Done ✅ |`,
      ``,
      `- [x] Reviewed **bold** _italic_ [spec](${SRC_URL_2}) 🚀`,
      `- [ ] Unrelated item`,
    ].join("\n");

    const expected = [
      `| File | Preview | Status |`,
      `| --- | --- | --- |`,
      `| photo.png | ![img](${DST_URL_1}) | Done ✅ |`,
      ``,
      `- [x] Reviewed **bold** _italic_ [spec](${DST_URL_2}) 🚀`,
      `- [ ] Unrelated item`,
    ].join("\n");

    expect(rewriteAttachmentUrls(input, SOURCE_BOARD, DEST_BOARD, OWNED)).toBe(expected);
  });

  it("handles no-op conditions: empty markdown, empty attachmentIds, or identical boards", () => {
    expect(rewriteAttachmentUrls("", SOURCE_BOARD, DEST_BOARD, OWNED)).toBe("");
    const text = `![img](${SRC_URL_1})`;
    expect(rewriteAttachmentUrls(text, SOURCE_BOARD, DEST_BOARD, [])).toBe(text);
    expect(rewriteAttachmentUrls(text, SOURCE_BOARD, SOURCE_BOARD, OWNED)).toBe(text);
  });
});

describe("parseAttachmentObjectKey and attachmentTransferObjectKey grammar", () => {
  const BOARD_ID = "board-1";
  const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
  const UUID_TRANSFER_ID = "00000000-0000-4000-8000-000000000002";

  it("round-trips UUID transfer IDs produced by attachmentTransferObjectKey", () => {
    const key = attachmentTransferObjectKey(BOARD_ID, UUID_TRANSFER_ID, ATTACHMENT_ID);
    expect(key).toBe(`${BOARD_ID}/${UUID_TRANSFER_ID}/${ATTACHMENT_ID}`);
    expect(parseAttachmentObjectKey(key)).toEqual({
      boardId: BOARD_ID,
      attachmentId: ATTACHMENT_ID,
      objectKey: key,
      transferId: UUID_TRANSFER_ID,
    });
  });

  it("round-trips valid non-UUID safe transfer IDs produced by attachmentTransferObjectKey", () => {
    const validTransferIds = [
      "transfer-1",
      "xfer-expired-lease-1",
      "a",
      "A_1-b",
      "x".repeat(64),
    ];

    for (const transferId of validTransferIds) {
      const key = attachmentTransferObjectKey(BOARD_ID, transferId, ATTACHMENT_ID);
      expect(key).toBe(`${BOARD_ID}/${transferId}/${ATTACHMENT_ID}`);
      expect(parseAttachmentObjectKey(key)).toEqual({
        boardId: BOARD_ID,
        attachmentId: ATTACHMENT_ID,
        objectKey: key,
        transferId,
      });
    }
  });

  it("round-trips and parses legacy two-segment keys without transferId", () => {
    const producedKey = attachmentObjectKey(BOARD_ID, ATTACHMENT_ID);
    expect(producedKey).toBe(`${BOARD_ID}/${ATTACHMENT_ID}`);
    expect(parseAttachmentObjectKey(producedKey)).toEqual({
      boardId: BOARD_ID,
      attachmentId: ATTACHMENT_ID,
      objectKey: producedKey,
    });

    const literalKey = "board-alpha/11111111-2222-4333-8444-555555555555";
    expect(parseAttachmentObjectKey(literalKey)).toEqual({
      boardId: "board-alpha",
      attachmentId: "11111111-2222-4333-8444-555555555555",
      objectKey: literalKey,
    });
  });

  it("rejects empty, overlong, extra-slash, traversal, and unsafe transfer segments", () => {
    const invalidKeys = [
      // Empty transfer segment
      `${BOARD_ID}//${ATTACHMENT_ID}`,
      // Overlong transfer segment (> 64 characters)
      `${BOARD_ID}/${"x".repeat(65)}/${ATTACHMENT_ID}`,
      // Extra slash / segment count mismatches
      `${BOARD_ID}/xfer/1/${ATTACHMENT_ID}`,
      `${BOARD_ID}/xfer/1/extra/${ATTACHMENT_ID}`,
      `${BOARD_ID}`,
      "",
      // Path traversal segments
      `${BOARD_ID}/../${ATTACHMENT_ID}`,
      `${BOARD_ID}/./${ATTACHMENT_ID}`,
      `../transfer-1/${ATTACHMENT_ID}`,
      `${BOARD_ID}/transfer-1/..`,
      // Unsafe characters in transfer segment
      `${BOARD_ID}/transfer 1/${ATTACHMENT_ID}`,
      `${BOARD_ID}/transfer!/${ATTACHMENT_ID}`,
      `${BOARD_ID}/transfer@dest/${ATTACHMENT_ID}`,
      `${BOARD_ID}/transfer:1/${ATTACHMENT_ID}`,
      `${BOARD_ID}/transfer?foo/${ATTACHMENT_ID}`,
      `${BOARD_ID}/transfer#1/${ATTACHMENT_ID}`,
      `${BOARD_ID}/..%2F/${ATTACHMENT_ID}`,
    ];

    for (const key of invalidKeys) {
      expect(parseAttachmentObjectKey(key)).toBeNull();
    }
  });

  it("rejects non-UUID attachment IDs and non-conforming board IDs", () => {
    const invalidAttachmentKeys = [
      // 3-segment with non-UUID attachmentId
      `${BOARD_ID}/transfer-1/not-a-uuid`,
      `${BOARD_ID}/transfer-1/00000000-0000-0000-0000-00000000000g`,
      `${BOARD_ID}/transfer-1/`,
      `${BOARD_ID}/${UUID_TRANSFER_ID}/not-a-uuid`,
      `${BOARD_ID}/${UUID_TRANSFER_ID}/12345`,
      // 2-segment with non-UUID attachmentId
      `${BOARD_ID}/not-a-uuid`,
      `${BOARD_ID}/00000000-0000-0000-0000-00000000000g`,
      `${BOARD_ID}/`,
      // Invalid boardId
      `bad_board!/transfer-1/${ATTACHMENT_ID}`,
      `-invalid/transfer-1/${ATTACHMENT_ID}`,
      `_invalid/transfer-1/${ATTACHMENT_ID}`,
      `bad_board!/${ATTACHMENT_ID}`,
    ];

    for (const key of invalidAttachmentKeys) {
      expect(parseAttachmentObjectKey(key)).toBeNull();
    }
  });
});
