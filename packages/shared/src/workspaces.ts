import { z } from "zod";

import { Identifier } from "./protocol";

export const WorkspaceRoleSchema = z.enum(["admin", "member"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const BoardAccessModeSchema = z.enum(["workspace", "restricted"]);
export type BoardAccessMode = z.infer<typeof BoardAccessModeSchema>;

export const WorkspaceAccessSchema = z.enum(["member", "guest", "operator"]);
export type WorkspaceAccess = z.infer<typeof WorkspaceAccessSchema>;

export const BoardCapabilitiesSchema = z.strictObject({
  canManageBoard: z.boolean(),
});
export type BoardCapabilities = z.infer<typeof BoardCapabilitiesSchema>;

export const WorkspaceSummarySchema = z.strictObject({
  id: Identifier,
  name: z.string().min(1).max(40),
  defaultBoardAccess: BoardAccessModeSchema,
  role: WorkspaceRoleSchema.nullable(),
  access: WorkspaceAccessSchema,
  boardCount: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const AccessChangeStateSchema = z.enum(["preparing", "committed", "aborted", "completed"]);
export const AccessChangeOutcomeSchema = z.enum(["committed", "aborted"]);
export const AccessChangePendingSchema = z.strictObject({
  operationId: Identifier,
  state: z.enum(["preparing", "committed", "aborted"]),
  recoveryPending: z.literal(true),
});
export const AccessChangeCompletedSchema = z.strictObject({
  operationId: Identifier,
  state: z.literal("completed"),
  outcome: AccessChangeOutcomeSchema,
  result: z.unknown().nullable(),
});
