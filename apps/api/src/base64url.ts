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
