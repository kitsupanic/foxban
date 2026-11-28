import { expect, test } from "@playwright/test";
import { isAttachmentImageSrc } from "../src/lib/markdown-image";

// The page a card's Markdown renders on; a relative `src` resolves against it, as the browser does.
const page = "https://app.foxban.test/board/ABC?attachment=x";

test("a card attachment on this origin loads as an image, however its src is written", () => {
  for (const src of [
    "/boards/b1/attachments/a1",
    "https://app.foxban.test/boards/b1/attachments/a1",
    "../boards/b1/attachments/a1",
    "/boards/b1/attachments/a1?v=2",
  ]) {
    expect(isAttachmentImageSrc(src, page), src).toBe(true);
  }
});

test("any other path on this origin stays a link: every viewer's browser would request it", () => {
  for (const src of [
    "/auth/github/login/start?1",
    "/users/u1/avatar/v1",
    "/boards/b1/attachments",
    "/boards/b1/attachments/a1/more",
    "/boards//attachments/a1",
    "/boards/b1/attachments/../../../auth/login",
    // Relative to the board page, not the origin root: /board/boards/…
    "boards/b1/attachments/a1",
  ]) {
    expect(isAttachmentImageSrc(src, page), src).toBe(false);
  }
});

test("another origin, a protocol-relative URL, data: and an unparseable src stay links", () => {
  for (const src of [
    "https://example.com/boards/b1/attachments/a1",
    "http://app.foxban.test/boards/b1/attachments/a1",
    "//example.com/boards/b1/attachments/a1",
    "data:image/png;base64,AAAA",
    "http://[::1",
  ]) {
    expect(isAttachmentImageSrc(src, page), src).toBe(false);
  }
});
