import { hc } from "hono/client";
import type { AppType } from "@foxban/api";

/**
 * Typed client for the Worker, bound to the current origin: the Vite dev proxy
 * forwards `/auth`, `/me` and `/boards`, so the session cookie is sent by default.
 */
export const api = hc<AppType>("/");

/** One row of `GET /boards/:id/members`; the response is already ordered by name. */
export type Member = {
  id: string;
  email: string;
  name: string;
  githubLogin: string | null;
  avatarVersion: string | null;
  isAdmin: boolean;
  explicitRole: "member" | "manager" | null;
  workspaceRole: "admin" | "member" | null;
};

/** One row of `GET /boards/:id/membership-candidates`. */
export type MemberCandidate = {
  id: string;
  email: string;
  name: string;
  githubLogin: string | null;
  avatarVersion: string | null;
};
