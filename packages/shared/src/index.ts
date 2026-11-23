export const APP_NAME = "foxban";

export { removeAttachmentReferences, rewriteAttachmentUrls } from "./attachment-description";

export {
  ATTACHMENT_POLICY,
  attachmentMaxBytes,
  isPreviewableImageContentType,
  normalizeAttachmentContentType,
} from "./attachment-policy";

export {
  ActivitySchema,
  CARD_ARCHIVE_RETENTION_MS,
  BoardColorSchema,
  BoardIconSchema,
  BoardDevelopmentSchema,
  CardDevelopmentSchema,
  DEVELOPMENT_TEXT_MAX,
  CardPullRequestAssociationSchema,
  CardSchema,
  DevelopmentBranchSchema,
  DevelopmentPullRequestSchema,
  ChecklistItemSchema,
  ClientMessageSchema,
  CommentSchema,
  DESCRIPTION_MAX_BYTES,
  descriptionByteLength,
  Identifier,
  LabelColorSchema,
  LabelSchema,
  PrioritySchema,
  REALTIME_PROTOCOL_VERSION,
  SESSION_REVOKED_CLOSE,
  TRANSFER_TERMINAL_CODE,
  type TransferTerminalCode,
  ServerMessageSchema,
  TaskTypeSchema,
  Title,
  type Activity,
  type ActivityDetail,
  type BoardColor,
  type BoardIcon,
  type ArchivedCard,
  type Attachment,
  type Card,
  type PositionsRebalanced,
  type CardLabel,
  type BoardDevelopment,
  type CardDevelopment,
  type CardRelation,
  type DevelopmentBranch,
  type DevelopmentPullRequest,
  type ChecklistItem,
  type ClientMessage,
  type Column,
  type Comment,
  type Label,
  type LabelColor,
  type Priority,
  type RelationKind,
  type ServerMessage,
  type TaskType,
} from "./protocol";

export {
  PresenceServerMessageSchema,
  type PresenceServerMessage,
  type PresenceSnapshotMessage,
  type PresenceState,
  type PresenceUpdatedMessage,
  type WorkspaceInvalidated,
} from "./presence";

export {
  BoardAccessModeSchema,
  WorkspaceRoleSchema,
  type BoardAccessMode,
  type BoardCapabilities,
  type WorkspaceAccess,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "./workspaces";

export {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  newPasswordProblem,
} from "./password-policy";

export {
  familyCompletionRows,
  buildSubtaskHierarchy,
  type SubtaskHierarchy,
} from "./subtasks";
