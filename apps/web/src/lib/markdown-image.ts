const ATTACHMENT_PATH = /^\/boards\/[^/]+\/attachments\/[^/]+$/;

/**
 * Whether a Markdown image may load as an `<img>`: only a card attachment on this
 * origin. Every viewer's browser fetches an image, so any other path here (an auth
 * route with a rate limit or a cookie) renders as a link, like another origin's image.
 * `base` is the page URL, which the browser resolves a relative `src` against.
 */
export function isAttachmentImageSrc(src: string, base: string): boolean {
  try {
    const url = new URL(src, base);
    return url.origin === new URL(base).origin && ATTACHMENT_PATH.test(url.pathname);
  } catch {
    return false;
  }
}
