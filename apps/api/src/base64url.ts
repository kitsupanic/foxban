/** Unpadded base64url (RFC 4648 §5). A leaf module so auth, github and mcp-contract can share it without an import cycle. */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
