import { SELF, env } from "cloudflare:test";

/**
 * The workspace a new account owns from signup. `POST /boards` has no default
 * workspace, so a test that just needs "a board for this account" names this one.
 */
export async function firstWorkspaceId(session: string): Promise<string> {
  const me = await SELF.fetch("https://foxban.test/me", { headers: { cookie: session } });
  const { id } = await me.json<{ id: string }>();
  const row = await env.DB.prepare(
    "SELECT id FROM workspaces WHERE owner_id=? ORDER BY created_at,id LIMIT 1",
  ).bind(id).first<{ id: string }>();
  if (!row) throw new Error(`account ${id} has no first workspace`);
  return row.id;
}
