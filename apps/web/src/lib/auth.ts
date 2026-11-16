import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

export type User = {
  id: string;
  email: string;
  name: string;
  githubLogin: string | null;
  avatarVersion: string | null;
  timezone: string | null;
  /** False for an account made with GitHub that has not set a password yet. */
  hasPassword: boolean;
  isAdmin: boolean;
};

/**
 * The signed-in user, or `null` when the session cookie is missing or expired.
 * A 401 is an answer, not a failure, so it must not be retried as an error.
 */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<User | null> => {
    const response = await api.me.$get();
    if (response.status === 401) return null;
    if (!response.ok) throw new Error(`GET /me failed with ${response.status}`);
    return await response.json();
  },
  // Fetched once and then only after an explicit invalidation (login/logout).
  staleTime: "static",
});
