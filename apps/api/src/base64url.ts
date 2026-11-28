/** Standard padded base64 (RFC 4648 §4). A leaf module so auth, github and mcp-contract can share it without an import cycle. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Unpadded base64url (RFC 4648 §5). */
export function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Decodes standard base64; throws on malformed input. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** Decodes base64url, padded or not; throws on malformed input. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  return fromBase64(text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
}
