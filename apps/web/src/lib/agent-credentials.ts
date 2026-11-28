import { infiniteQueryOptions } from "@tanstack/react-query";
import { api } from "./api";

export type AgentScope = "boards:read" | "tasks:write" | "comments:write";

export type CredentialMetadata = {
  id: string;
  name: string;
  boardIds: string[];
  scopes: AgentScope[];
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
};
export type CredentialPage = { credentials: CredentialMetadata[]; nextCursor: string | null };
export type IssueCredentialInput = {
  name: string;
  boardIds: string[];
  scopes: AgentScope[];
  expiresInDays: number;
  /** Required for an account that has a password (ADR 0090). */
  currentPassword?: string;
};
export type IssuedCredential = { credential: CredentialMetadata; token: string };
export async function fetchAgentCredentialsPage(cursor: string | null): Promise<CredentialPage> {
  const response = await api.me["agent-credentials"].$get({
    query: { limit: "20", ...(cursor ? { cursor } : {}) },
  });
  if (!response.ok) throw new Error(`Could not load tokens (${response.status}).`);
  return await response.json();
}


export const agentCredentialsKey = (userId: string) => ["agent-credentials", userId] as const;
export const agentCredentialsMutationKey = (userId: string) => ["agent-credentials", userId, "mutation"] as const;

export function agentCredentialsQuery(userId: string) {
  return infiniteQueryOptions({
    queryKey: agentCredentialsKey(userId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchAgentCredentialsPage(pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
