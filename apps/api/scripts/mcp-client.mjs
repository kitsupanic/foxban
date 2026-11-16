import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

function origin() {
  const value = process.env.FOXBAN_ORIGIN;
  if (!value) throw new Error("FOXBAN_ORIGIN is required");
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("FOXBAN_ORIGIN must use HTTPS, except for loopback HTTP");
  }
  return url;
}

async function credentialRequest(method, path, body) {
  const cookie = process.env.FOXBAN_SESSION_COOKIE;
  if (!cookie) throw new Error("FOXBAN_SESSION_COOKIE is required for credential commands");
  const response = await fetch(new URL(path, origin()), {
    method,
    headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Foxban returned HTTP ${response.status}`);
  if (response.status === 204) return { ok: true };
  return await response.json();
}

async function withClient(action) {
  const token = process.env.FOXBAN_MCP_TOKEN;
  if (!token) throw new Error("FOXBAN_MCP_TOKEN is required for MCP commands");
  const client = new Client({ name: "foxban-local-helper", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", origin()), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}

function parseObject(raw, label) {
  if (!raw) throw new Error(`${label} JSON is required`);
  const value = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

const [group, command, argument] = process.argv.slice(2);
try {
  let output;
  if (group === "credentials" && command === "issue") {
    output = await credentialRequest("POST", "/me/agent-credentials", parseObject(argument, "credential"));
  } else if (group === "credentials" && command === "list") {
    output = await credentialRequest("GET", "/me/agent-credentials");
  } else if (group === "credentials" && command === "revoke") {
    if (!argument || argument.includes("/")) throw new Error("credential id is required");
    output = await credentialRequest("DELETE", `/me/agent-credentials/${encodeURIComponent(argument)}`);
  } else if (group === "tools" && command === undefined) {
    output = await withClient((client) => client.listTools());
  } else if (group === "call") {
    if (!command) throw new Error("tool name is required");
    output = await withClient((client) => client.callTool({ name: command, arguments: parseObject(argument, "tool arguments") }));
  } else {
    throw new Error("Usage: credentials issue|list|revoke, tools, or call <tool> <json>");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (typeof output === "object" && output !== null && "isError" in output && output.isError === true) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "command failed";
  process.stderr.write(`foxban MCP helper: ${message.replace(/foxban_mcp_[A-Za-z0-9_-]+/g, "[redacted]")}\n`);
  process.exitCode = 1;
}
