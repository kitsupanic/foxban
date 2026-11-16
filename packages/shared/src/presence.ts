import { z } from "zod";

import { Identifier } from "./protocol";

/**
 * Member presence wire protocol.
 * Server frames:
 * - presence.snapshot: initial full list of known members
 * - presence.updated: single member presence change
 *
 * Client sends no application messages.
 */

export const PresenceTimezoneSchema = z.string().min(1).max(100).nullable();
export const PresenceTimestampSchema = z.number().int().nonnegative().nullable();

export const PresenceStateSchema = z.strictObject({
  userId: Identifier,
  online: z.boolean(),
  lastSeenAt: PresenceTimestampSchema,
  timezone: PresenceTimezoneSchema,
});

export type PresenceState = z.infer<typeof PresenceStateSchema>;

export const PresenceSnapshotMessageSchema = z.strictObject({
  type: z.literal("presence.snapshot"),
  members: z.array(PresenceStateSchema),
});

export type PresenceSnapshotMessage = z.infer<typeof PresenceSnapshotMessageSchema>;

export const PresenceUpdatedMessageSchema = z.strictObject({
  type: z.literal("presence.updated"),
  member: PresenceStateSchema,
});

export type PresenceUpdatedMessage = z.infer<typeof PresenceUpdatedMessageSchema>;

export const WorkspaceInvalidatedSchema = z.strictObject({
  type: z.literal("workspace.invalidated"),
  workspaceIds: z.array(Identifier),
  boardIds: z.array(Identifier),
});

export type WorkspaceInvalidated = z.infer<typeof WorkspaceInvalidatedSchema>;

export const PresenceServerMessageSchema = z.discriminatedUnion("type", [
  PresenceSnapshotMessageSchema,
  PresenceUpdatedMessageSchema,
  WorkspaceInvalidatedSchema,
]);

export type PresenceServerMessage = z.infer<typeof PresenceServerMessageSchema>;
