import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AlignLeft,
  ArrowUpRight,
  CalendarArrowDown,
  CalendarArrowUp,
  Check,
  ChevronDown,
  File,
  GitBranch,
  Network,
  MessageSquare,
  Link,
  Paperclip,
  Plus,
  SquareCheck,
  Search,
  Tag,
  Users,
  Maximize2,
  Minimize2,
  Pencil,
  Reply,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { boardQueryKey } from "../lib/board-cache";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DESCRIPTION_MAX_BYTES,
  Title,
  type ClientMessage,
  descriptionByteLength,
  isPreviewableImageContentType,
  normalizeAttachmentContentType,
  type Activity,
  type Attachment,
  type Card,
  type CardRelation,
  type ChecklistItem,
  type Column,
  type Comment,
  type Label,
  type LabelColor,
  type Priority,
  type SubtaskHierarchy,
  type TaskType,
} from "@foxban/shared";
import type { Member } from "../lib/api";
import {
  activitySentence,
  activityTimeline,
  cardAssigneeHistory,
  cardCreatorId,
  type ActivityTimelineItem,
} from "../lib/activity";
import type { SendMutation, MutationSettledCallback } from "../lib/socket";
import { useAttachmentView, type BoardAttachments } from "../lib/attachments";
import { LABEL_COLORS, LABEL_COLOR_META } from "../lib/labels";
import { type BoardState, type CardLabelView } from "../lib/apply-mutation";
import { useBoardCommands } from "../lib/board-commands";
import {
  RELATION_OPTIONS,
  relationViews,
  cardTitle,
  type RelationOptionValue,
} from "../lib/relations";
import { relationCardMatches, taskKey } from "../lib/task-key";
import { meQuery } from "../lib/auth";
import { Avatar } from "./Avatar";
import { AssigneePicker } from "./AssigneePicker";
import { PriorityPicker } from "./PriorityPicker";
import { TaskTypePicker } from "./TaskTypePicker";
import { StatusPicker } from "./StatusPicker";
import { CardActionsMenu } from "./CardActionsMenu";
import { TransferCardDialog } from "./TransferCardDialog";
import { DescriptionEditor } from "./DescriptionEditor";
import { MarkdownContent, MarkdownEditor } from "./MarkdownEditor";
import { CardDevelopment } from "./CardDevelopment";
import { cardDevelopmentQueryOptions, connectedReposQueryOptions, usePullRequestLink } from "../lib/card-development";
import { SubtaskList } from "./SubtaskList";
import { buildSubtaskNodes, directSubtaskCounts } from "../lib/subtask-nodes";
import { TASK_TYPE_META } from "../lib/task-type";
import { restoreFocusSoon } from "../lib/focus";
import { composerLane, useAuthoredOperation, useAuthoredScope, type AuthoredScope } from "../lib/authored-operation";
import { usePickerMenuStyle } from "../lib/picker-menu";
import "./card-detail.css";
/** Which shell the card details render in: the overlay modal or full screen. */
export type CardViewMode = "modal" | "full";

type ActivityView = "all" | "comments" | "history";
type ActivitySortOrder = "asc" | "desc";

const ACTIVITY_TABS: readonly { view: ActivityView; label: string }[] = [
  { view: "all", label: "All" },
  { view: "comments", label: "Comments" },
  { view: "history", label: "History" },
];
/**
 * Card details. The title/description draft is seeded once on mount and never
 * re-seeded from the card: whoever saves last wins (ADR 0007/0010), so a
 * broadcast arriving while the modal is open must not overwrite what the user is
 * typing. The mount seed reverses unresolved optimistic attachment cleanup only;
 * confirmed deletions strip their references from the effective description,
 * leaving the raw draft and other prose intact.
 *
 * Assignee, priority, due date, checklist, and relations are the other half of
 * the split: they are discrete idempotent sets, so they apply instantly through
 * the normal optimistic mutation path (Trello-style) and render straight from
 * the live props — a draft would only buy a merge problem. Subtask conversion
 * and unlinking send instantly too, for the same reason.
 *
 * The split is only honest if the draft cannot vanish behind the user's back:
 * every exit — Escape, the backdrop, the header close button, a row that navigates to
 * another card — goes through `requestClose`, which parks the exit behind the
 * discard strip while the draft differs from the card (ADR 0020).
 *
 * The card itself is derived from the board cache by the caller, which unmounts
 * the modal when the card is deleted underneath it.
 *
 * Two shells render the same header, two-pane body (a main column plus a
 * metadata/links sidebar) and footer; they differ only in the surface — an
 * overlay panel or the full viewport — picked by `view`. Which one is up lives
 * in the board URL, not here — this component only asks for a change through
 * `onViewChange`.
 *
 * One rung sits above both shells: an attachment thumbnail opens a fullscreen
 * image viewer over the card. Which attachment is up is the board URL's to
 * decide as well — this component only asks through `onOpenAttachment` /
 * `onCloseAttachment` — and Escape peels the viewer off before the card.
 */
export function CardModal({
  boardId,
  boardKey,
  card,
  items,
  attachments,
  comments,
  boardAttachments,
  uploadScope,
  activities,
  relations,
  hierarchy,
  labels,
  cardLabels,
  cards,
  columns,
  onOpenCard,
  onRequestMove,
  members,
  membersLoading,
  membersError,
  onRetryMembers,
  send,
  subscribeMutation,
  retireTrackedMutation,
  connected,
  handshakeFailed,
  onRetryConnection,
  onClose,
  onDirtyChange,
  onRegisterDiscardPrompt,
  onConfirmBlockedNavigation,
  onCancelBlockedNavigation,
  view,
  onViewChange,
  openAttachmentId,
  onOpenAttachment,
  onCloseAttachment,
  onTransferSuccess,
}: {
  boardId: string;
  boardKey?: string;
  card: Card;
  items: ChecklistItem[];
  /** This card's attachments in display order; the live cache, not a draft. */
  attachments: Attachment[];
  /** The board's attachment lifecycle: mount seed, deleted-embed cleanup, delete gate, upload. */
  boardAttachments: BoardAttachments;
  /** Board-lived, not this modal's scope: a card closed mid-upload still publishes the finished attachment. */
  uploadScope: AuthoredScope;
  /** This card's comments, oldest first; the live cache, not a draft. */
  comments: Comment[];
  /** This card's immutable history in server sequence order. */
  activities: Activity[];
  /** Every relation naming this card on either side; the live cache, not a draft. */
  relations: CardRelation[];
  /**
   * The board's shared subtask forest: the detail view reads each child's
   * parent and order from the same answer the board does.
   */
  hierarchy: SubtaskHierarchy;
  /** Every label definition on the board — the picker lists them all. */
  labels: Label[];
  /** This card's labels, name-sorted, with their join-row ids; the live cache. */
  cardLabels: CardLabelView[];
  /** All board cards — the link picker searches them by title. */
  cards: Card[];
  /** The board's live columns in display order. */
  columns: Column[];
  /** Every status change goes through the board, which owns placement and the family-finish gate. */
  onRequestMove: (id: string, columnId: string, trigger?: HTMLElement | null) => void;
  onOpenCard: (cardId: string) => void;
  members: Member[];
  membersLoading: boolean;
  membersError: boolean;
  onRetryMembers: () => void;
  send: SendMutation;
  subscribeMutation: (mutationId: string, callback: MutationSettledCallback) => () => void;
  retireTrackedMutation: (mutationId: string) => void;
  connected: boolean;
  handshakeFailed?: boolean;
  onRetryConnection?: () => void;
  onClose: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  onRegisterDiscardPrompt?: (trigger: () => void) => void;
  onConfirmBlockedNavigation?: () => void;
  onCancelBlockedNavigation?: () => void;
  view: CardViewMode;
  onViewChange: (view: CardViewMode) => void;
  /** The attachment shown in the fullscreen viewer, from the URL; none when unset. */
  openAttachmentId?: string;
  onOpenAttachment: (attachmentId: string, trigger?: HTMLElement | null) => void;
  onCloseAttachment: () => void;
  onTransferSuccess?: (
    destinationBoardId: string,
    destinationBoardKey: string,
    cardId: string,
    taskNumber: number,
  ) => void;
}) {
  const queryClient = useQueryClient();
  // Settlement scope for the modal's authored operations (ADR 0069).
  const authoredScope = useAuthoredScope({
    send,
    subscribe: subscribeMutation,
    retire: retireTrackedMutation,
    readBoard: () => queryClient.getQueryData<BoardState>(boardQueryKey(boardId)),
  });
  const commands = useBoardCommands(boardId, send);
  const [title, setTitle] = useState(card.title);
  const [editingTitle, setEditingTitle] = useState(false);
  const editTitleButtonRef = useRef<HTMLButtonElement | null>(null);
  // Mount-only seed; never replaces an already-open draft on live updates.
  const [descriptionDraft, setDescriptionDraft] = useState(() =>
    boardAttachments.seedDescription(card.id, card.description),
  );
  const attachmentView = useAttachmentView(boardAttachments);
  // Only the "Description must be…" refusal; a failed send is the save operation's own error.
  const [saveValidationError, setSaveValidationError] = useState<string | null>(null);
  const [descriptionUploading, setDescriptionUploading] = useState(false);
  const descriptionUploadingRef = useRef(descriptionUploading);
  descriptionUploadingRef.current = descriptionUploading;
  const [commentUploading, setCommentUploading] = useState(false);
  const commentUploadingRef = useRef(commentUploading);
  commentUploadingRef.current = commentUploading;
  const [replyUploading, setReplyUploading] = useState(false);
  const replyUploadingRef = useRef(replyUploading);
  replyUploadingRef.current = replyUploading;
  // Comment and reply creation are authored operations (ADR 0069), one lineage each: the entity
  // id is chosen at submit and survives retries. `sent` is what a retry re-sends and what the draft
  // must still equal when the attempt is accepted.
  type CommentSent = { entityId: string; authorId: string; parentCommentId: string | null; rawDraft: string; body: string };
  const commentCopy = (noun: "comment" | "reply") => ({
    rejected: `Server rejected ${noun}.`,
    unverified: `Sync could not verify ${noun}. You can retry sending.`,
    "not-connected": "Not connected — try again.",
    "accepted-gone": `Server rejected ${noun}.`, // unreachable: no `confirm`
  });
  const createCommentMessage = (mutationId: string, { entityId, authorId, parentCommentId, body }: CommentSent): ClientMessage => ({
    type: "comment.create",
    mutationId,
    id: entityId,
    cardId: cardRef.current.id,
    authorId,
    parentCommentId,
    body,
    createdAt: Date.now(),
  });
  // The composer generation the running attempt is compared against: the one the submit bumped to,
  // or the live one when a retry starts.
  const commentAcceptGenRef = useRef(0);
  const replyAcceptGenRef = useRef(0);
  const commentRetriedRef = useRef(false);
  const replyRetriedRef = useRef(false);
  const commentRecoveryErrorRef = useRef("");
  const replyRecoveryErrorRef = useRef("");
  const commentOp = useAuthoredOperation<CommentSent>(authoredScope, {
    build: createCommentMessage,
    onAccepted: ({ rawDraft }) => {
      if (commentGenerationRef.current === commentAcceptGenRef.current && commentDraftRef.current === rawDraft && !commentUploadingRef.current) {
        cancelComposer(true);
      }
    },
    copy: commentCopy("comment"),
  });
  const replyOp = useAuthoredOperation<CommentSent>(authoredScope, {
    build: createCommentMessage,
    onAccepted: ({ rawDraft, parentCommentId }) => {
      if (
        replyGenerationRef.current === replyAcceptGenRef.current &&
        replyingRootIdRef.current === parentCommentId &&
        replyDraftRef.current === rawDraft &&
        !replyUploadingRef.current
      ) {
        cancelReplyComposer(true);
      }
    },
    copy: commentCopy("reply"),
  });
  const commentLane = composerLane(commentOp, commentRetriedRef.current, commentRecoveryErrorRef);
  const replyLane = composerLane(replyOp, replyRetriedRef.current, replyRecoveryErrorRef);
  const { pendingId: pendingCommentId, uncertain: commentUncertain, error: commentError, recovery: commentRecovery } = commentLane;
  const { pendingId: pendingReplyId, uncertain: replyUncertain, error: replyError, recovery: replyRecovery } = replyLane;
  // Typing dismisses an inline error; a retained recovery stays until retried or discarded.
  const clearCommentError = () => { if (commentError !== null) commentOp.discard(); };
  const clearReplyError = () => { if (replyError !== null) replyOp.discard(); };
  // Save is one authored operation (ADR 0069): `card.update` with the fields Save diffed. `sent` is
  // that diff plus the draft it was taken from (to tell later edits apart on acceptance). `entityId`
  // is the card, only so the lane helper has a marker for "in flight".
  type SaveSent = { entityId: string; submittedTitle?: string; submittedDescription?: string; draftTitle: string; draftDescription: string };
  const saveRetriedRef = useRef(false);
  const saveRecoveryErrorRef = useRef("");
  // What each attempt of the lineage actually carried, by mutationId: a retry re-diffs against the
  // live card, so it can drop a field a peer already saved, and an earlier attempt may still be
  // accepted late. Acceptance updates baselines for exactly what the accepted attempt carried.
  const saveAttemptDiffsRef = useRef(new Map<string, { title?: string; description?: string }>());
  const saveOp = useAuthoredOperation<SaveSent>(authoredScope, {
    build: (mutationId, { submittedTitle, submittedDescription }): ClientMessage | null => {
      const retried = saveRetriedRef.current;
      const diff: { title?: string; description?: string } = {};
      if (submittedTitle !== undefined && (!retried || submittedTitle !== cardRef.current.title)) diff.title = submittedTitle;
      if (submittedDescription !== undefined && (!retried || submittedDescription !== cardRef.current.description)) diff.description = submittedDescription;
      saveAttemptDiffsRef.current.set(mutationId, diff);
      // Nothing left to send: the lineage settles and its recovery goes with it.
      if (diff.title === undefined && diff.description === undefined) return null;
      return { type: "card.update", mutationId, id: cardRef.current.id, ...diff };
    },
    onAccepted: ({ draftTitle, draftDescription }, mutationId) => {
      const { title: sentTitle, description: sentDescription } = saveAttemptDiffsRef.current.get(mutationId) ?? {};
      saveAttemptDiffsRef.current.clear();
      const currentTitle = titleRef.current.trim();
      const currentDescription = descriptionRef.current;
      if (sentTitle !== undefined) {
        titleBaselineRef.current = sentTitle;
        if (currentTitle === sentTitle) titleDirtyRef.current = false;
      }
      if (sentDescription !== undefined) {
        descriptionBaselineRef.current = sentDescription;
        if (currentDescription === sentDescription) descriptionDirtyRef.current = false;
      }
      // Only a first attempt closes the card, and only if nothing else needs it open. `saveUncertain`
      // is as of the last render, so a save that went uncertain on the way never closes the card.
      if (!saveRetriedRef.current && !saveUncertain && !workKeepsCardOpen() && currentTitle === draftTitle && currentDescription === draftDescription) {
        onCloseRef.current();
      }
    },
    copy: {
      rejected: "Server rejected save.",
      unverified: "Sync could not verify save. You can retry sending.",
      "not-connected": "Not connected — changes won't send.",
      "accepted-gone": "Server rejected save.", // unreachable: no `confirm`
    },
  });
  const saveLane = composerLane(saveOp, saveRetriedRef.current, saveRecoveryErrorRef);
  const { pendingId: pendingSaveId, uncertain: saveUncertain, recovery: saveRecovery } = saveLane;
  const saveError = saveValidationError ?? saveLane.error;
  // Typing dismisses an inline error; a retained recovery stays until retried or discarded.
  const clearSaveError = () => {
    setSaveValidationError(null);
    if (saveLane.error !== null) saveOp.discard();
  };
  // The subtask composer and the checklist conversion are authored operations (ADR 0069), one
  // lineage each: the entity and relation ids are chosen at submit and survive retries, so a retry
  // is the same creation rather than a second child. One `subtask.create` frame is the whole
  // creation (child, parent link and, for conversion, the source item's removal), so settling one
  // lane never speaks for the other. The conversion lane is single-slot: while it is pending or
  // holds a recovery it is the whole lane's state, not just the source item's.
  const [composingSubtask, setComposingSubtask] = useState(false);
  const [subtaskDraft, setSubtaskDraft] = useState("");
  // Only the "Checklist item is empty." refusal; a failed send is the operation's own error.
  const [convertEmptyError, setConvertEmptyError] = useState<string | null>(null);
  type SubtaskSent = { entityId: string; relationId: string; position: string; rawDraft: string };
  type ConvertSent = SubtaskSent & { checklistItemId: string };
  const subtaskCopy = (rejected: string, unverified: string) => ({
    rejected,
    unverified,
    "not-connected": "Not connected — try again.",
    "accepted-gone": rejected, // unreachable: no `confirm`
  });
  // The composer generation the running attempt is compared against, bumped by every submit and retry.
  const subtaskAcceptGenRef = useRef(0);
  const subtaskRetriedRef = useRef(false);
  const convertRetriedRef = useRef(false);
  const subtaskRecoveryErrorRef = useRef("");
  const convertRecoveryErrorRef = useRef("");
  const subtaskOp = useAuthoredOperation<SubtaskSent>(authoredScope, {
    // The composer trims its draft; conversion sends the stored item text as is.
    build: (mutationId, { entityId, relationId, position, rawDraft }): ClientMessage => ({
      type: "subtask.create",
      mutationId,
      id: entityId,
      parentCardId: cardRef.current.id,
      relationId,
      title: rawDraft.trim(),
      position,
    }),
    // Acceptance is the only thing that clears the draft, and only while this lane's own
    // submission is still what the field holds.
    onAccepted: ({ rawDraft }) => {
      if (subtaskGenerationRef.current === subtaskAcceptGenRef.current && subtaskDraftRef.current === rawDraft) {
        setSubtaskDraft("");
        setComposingSubtask(false);
      }
    },
    copy: subtaskCopy("Server rejected the subtask.", "Sync could not verify the subtask. You can retry sending."),
  });
  // Conversion carries the item's EXACT stored text (a stored " Write docs " is legal, and the
  // server compares it byte for byte) plus its id: the BoardDO re-reads the item inside the
  // transaction and refuses only a real change.
  const convertOp = useAuthoredOperation<ConvertSent>(authoredScope, {
    build: (mutationId, { entityId, relationId, position, rawDraft, checklistItemId }): ClientMessage => ({
      type: "subtask.create",
      mutationId,
      id: entityId,
      parentCardId: cardRef.current.id,
      relationId,
      title: rawDraft,
      position,
      checklistItemId,
    }),
    copy: subtaskCopy("Server rejected the conversion.", "Sync could not verify the conversion. You can retry the same item."),
  });
  const subtaskLane = composerLane(subtaskOp, subtaskRetriedRef.current, subtaskRecoveryErrorRef);
  const convertLane = composerLane(convertOp, convertRetriedRef.current, convertRecoveryErrorRef);
  const { pendingId: pendingSubtaskId, uncertain: subtaskUncertain, error: subtaskError, recovery: subtaskRecovery } = subtaskLane;
  const { uncertain: convertUncertain, error: convertOpError, recovery: convertRecovery } = convertLane;
  const pendingConvertItemId = convertLane.pendingId === null ? null : convertOp.sent?.checklistItemId ?? null;
  const convertError = convertEmptyError ?? convertOpError;
  // Typing dismisses an inline error; a retained recovery stays until retried or discarded.
  const clearSubtaskError = () => { if (subtaskError !== null) subtaskOp.discard(); };
  const description = useMemo(
    () => attachmentView.descriptionFor(card.id, descriptionDraft),
    [attachmentView, card.id, descriptionDraft],
  );
  const attachmentDeletePending = attachmentView.isDeletePending(card.id);
  // Inline item editor: the id being edited plus its own draft text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [newItem, setNewItem] = useState("");
  // Validation errors are local; everything else comes from the add / edit operations.
  const [checklistInvalid, setChecklistInvalid] = useState<Record<"add" | "edit", string | null>>({ add: null, edit: null });
  type ChecklistSent = { id: string; text: string; position?: string };
  const checklistOptions = (onAccepted: (sent: ChecklistSent) => void) => ({
    build: (mutationId: string, { id, text, position }: ChecklistSent): ClientMessage =>
      position === undefined
        ? { type: "checklist.update", mutationId, id, text }
        : { type: "checklist.create", mutationId, id, cardId: card.id, text, position },
    confirm: (board: BoardState | undefined, { id }: ChecklistSent) => !!board?.checklistItems.some((item) => item.id === id),
    onAccepted,
    copy: {
      rejected: "Server rejected checklist save.",
      unverified: "Sync could not verify checklist save. You can retry saving.",
      "not-connected": "Not connected — try again.",
      "accepted-gone": "This item was deleted. Your draft is preserved below.",
    },
  });
  const addOp = useAuthoredOperation<ChecklistSent>(authoredScope, checklistOptions(() => setNewItem("")));
  const editOp = useAuthoredOperation<ChecklistSent>(authoredScope, checklistOptions(({ id }) => {
    // The user already left this edit (Escape/Discard): a late acceptance must not steal focus. "Save as
    // new item" sends a fresh id while the edited item is deleted, so that case still belongs to the edit.
    if (editingId !== id && !editedItemDeleted) return;
    setEditingId(null);
    restoreFocusSoon(() => document.querySelector<HTMLElement>(`[data-checklist-item-edit="${id}"]`));
  }));
  const checklistLane = (op: typeof addOp, lane: "add" | "edit") => ({
    pending: op.status === "pending" || op.status === "uncertain",
    uncertain: op.status === "uncertain",
    error: checklistInvalid[lane] ?? op.error,
  });
  const checklistAttempts = { add: checklistLane(addOp, "add"), edit: checklistLane(editOp, "edit") };
  // A failed lineage is only kept for its error; the draft lives in component state.
  const clearChecklistError = (lane: "add" | "edit") => {
    setChecklistInvalid((current) => ({ ...current, [lane]: null }));
    const op = lane === "add" ? addOp : editOp;
    if (op.status === "failed") op.discard();
  };
  const editedItemDeleted = editingId !== null && !items.some((item) => item.id === editingId);
  const checklistHasWork = newItem !== "" || (editingId !== null && (editedItemDeleted || editText !== items.find((item) => item.id === editingId)?.text)) || checklistAttempts.add.pending || checklistAttempts.edit.pending;
  const checklistHasWorkRef = useRef(checklistHasWork);
  checklistHasWorkRef.current = checklistHasWork;
  const [addingChecklistItem, setAddingChecklistItem] = useState(false);
  const checklistInputRef = useRef<HTMLInputElement | null>(null);
  const checklistAddButtonRef = useRef<HTMLButtonElement | null>(null);
  const attachInput = useRef<HTMLInputElement | null>(null);
  const [confirmingAttachmentId, setConfirmingAttachmentId] = useState<string | null>(null);
  const doneCount = items.filter((item) => item.done).length;
  const checklistPercent = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;
  const [composingComment, setComposingComment] = useState(false);
  const [commentFeedbackResetToken, setCommentFeedbackResetToken] = useState(0);
  const [commentDraft, setCommentDraft] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentDraft, setEditCommentDraft] = useState("");
  const [editCommentBaseline, setEditCommentBaseline] = useState("");
  const commentEditOp = useAuthoredOperation<{ id: string; body: string }>(authoredScope, {
    build: (mutationId, { id, body }): ClientMessage => ({ type: "comment.update", mutationId, id, body, updatedAt: Date.now() }),
    // Socket settlement can precede React rendering the peer's deletion.
    confirm: (board, { id }) => !!board?.comments.some((comment) => comment.id === id && !comment.deleted),
    // A late acceptance of an earlier attempt must not close an editor the user has kept typing in.
    onAccepted: ({ id, body }) => {
      if (editingCommentId === id && editCommentDraft.trim() === body && !commentUploading) setEditingCommentId(null);
    },
    copy: {
      rejected: "Server rejected comment edit.",
      unverified: "Sync could not verify comment edit. You can retry saving.",
      "not-connected": "Not connected — try again.",
      "accepted-gone": "",
    },
  });
  const commentEditActive = commentEditOp.status === "pending" || commentEditOp.status === "uncertain";
  const pendingCommentEditId = commentEditActive ? commentEditOp.sent?.id ?? null : null;
  const pendingCommentEditIdRef = useRef(pendingCommentEditId);
  pendingCommentEditIdRef.current = pendingCommentEditId;
  const commentEditUncertain = commentEditOp.status === "uncertain";
  // A deleted comment shows its own banner, so an accepted-but-gone edit has no error line.
  const commentEditError = commentEditOp.failure === "accepted-gone" ? null : commentEditOp.error;
  const clearCommentEditError = () => { if (pendingCommentEditIdRef.current === null) commentEditOp.discard(); };
  const editingCommentIdRef = useRef(editingCommentId);
  editingCommentIdRef.current = editingCommentId;
  const editedCommentDeleted = editingCommentId !== null && !comments.some((comment) => comment.id === editingCommentId && !comment.deleted);
  const commentEditHasWork = editingCommentId !== null && (editCommentDraft !== editCommentBaseline || pendingCommentEditId !== null);
  const commentEditHasWorkRef = useRef(commentEditHasWork);
  commentEditHasWorkRef.current = commentEditHasWork;
  const [replyingCommentId, setReplyingCommentId] = useState<string | null>(null);
  const [replyingRootId, setReplyingRootId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const pendingReplyUploadTargetRef = useRef<{ targetId: string; initialDraft: string } | null>(null);
  const [orphanedReply, setOrphanedReply] = useState<{ text: string } | null>(null);
  const orphanedReplyRef = useRef(orphanedReply);
  orphanedReplyRef.current = orphanedReply;
  const composingCommentRef = useRef(composingComment);
  composingCommentRef.current = composingComment;
  const commentDraftRef = useRef(commentDraft);
  commentDraftRef.current = commentDraft;
  const commentGenerationRef = useRef(0);
  const replyingCommentIdRef = useRef(replyingCommentId);
  replyingCommentIdRef.current = replyingCommentId;
  const replyingRootIdRef = useRef(replyingRootId);
  replyingRootIdRef.current = replyingRootId;
  const replyDraftRef = useRef(replyDraft);
  replyDraftRef.current = replyDraft;
  const replyGenerationRef = useRef(0);
  const titleRef = useRef(title);
  titleRef.current = title;
  const descriptionRef = useRef(description);
  descriptionRef.current = description;
  // Each field is sent only when the user edited it and it differs from the
  // value that edit started from, so an untouched field never overwrites a peer.
  const titleBaselineRef = useRef(card.title);
  const descriptionBaselineRef = useRef(card.description);
  const titleDirtyRef = useRef(false);
  const descriptionDirtyRef = useRef(description !== card.description);
  useEffect(() => {
    if (!titleDirtyRef.current && card.title !== titleRef.current) {
      titleRef.current = card.title;
      setTitle(card.title);
    }
    if (!titleDirtyRef.current) titleBaselineRef.current = card.title;
    if (!descriptionDirtyRef.current && card.description !== descriptionRef.current) {
      descriptionRef.current = card.description;
      setDescriptionDraft(card.description);
    }
    if (!descriptionDirtyRef.current) descriptionBaselineRef.current = card.description;
  }, [card.title, card.description]);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const cardRef = useRef(card);
  cardRef.current = card;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const commentRecoveryRef = useRef(commentRecovery);
  commentRecoveryRef.current = commentRecovery;
  const replyRecoveryRef = useRef(replyRecovery);
  replyRecoveryRef.current = replyRecovery;
  const saveRecoveryRef = useRef(saveRecovery);
  saveRecoveryRef.current = saveRecovery;
  const pendingCommentIdRef = useRef(pendingCommentId);
  pendingCommentIdRef.current = pendingCommentId;
  const pendingReplyIdRef = useRef(pendingReplyId);
  pendingReplyIdRef.current = pendingReplyId;
  const attachmentDeletePendingRef = useRef(attachmentDeletePending);
  attachmentDeletePendingRef.current = attachmentDeletePending;
  const commentUncertainRef = useRef(commentUncertain);
  commentUncertainRef.current = commentUncertain;
  const replyUncertainRef = useRef(replyUncertain);
  replyUncertainRef.current = replyUncertain;
  const composingSubtaskRef = useRef(composingSubtask);
  composingSubtaskRef.current = composingSubtask;
  const subtaskDraftRef = useRef(subtaskDraft);
  subtaskDraftRef.current = subtaskDraft;
  const pendingSubtaskIdRef = useRef(pendingSubtaskId);
  pendingSubtaskIdRef.current = pendingSubtaskId;
  const subtaskUncertainRef = useRef(subtaskUncertain);
  subtaskUncertainRef.current = subtaskUncertain;
  const subtaskRecoveryRef = useRef(subtaskRecovery);
  subtaskRecoveryRef.current = subtaskRecovery;
  const subtaskGenerationRef = useRef(0);
  const convertRecoveryRef = useRef(convertRecovery);
  convertRecoveryRef.current = convertRecovery;
  // Below `md` the card is a full-viewport surface over a board page that scrolls
  // the document. Fixing the body removes that overflow for as long as the card is
  // open — `overflow: hidden` alone still lets the page be scrolled
  // programmatically — and the recorded offset puts the page back, unmoved, when
  // the card closes.
  useEffect(() => {
    const body = document.body;
    const offset = window.scrollY;
    const previous = { position: body.style.position, top: body.style.top, width: body.style.width, overflow: body.style.overflow };
    body.style.position = "fixed";
    body.style.top = `-${offset}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    return () => {
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;
      window.scrollTo(0, offset);
    };
  }, []);
  const replyButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [activityView, setActivityView] = useState<ActivityView>("comments");
  const [activitySortOrder, setActivitySortOrder] = useState<ActivitySortOrder>("asc");
  const activityTabRefs = useRef<Record<ActivityView, HTMLButtonElement | null>>({
    all: null,
    comments: null,
    history: null,
  });
  // Link composer: collapsed like the comment one until asked for, then the
  // direction to store plus the picker's search text.
  const [composingRelation, setComposingRelation] = useState(false);
  const [relationKind, setRelationKind] = useState<RelationOptionValue>("relates");
  const [relationQuery, setRelationQuery] = useState("");
  // Label picker: collapsed like the link one. Open, it can be editing one
  // definition (its own name/colour draft) and confirming that one's delete.
  const [composingLabel, setComposingLabel] = useState(false);
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [labelQuery, setLabelQuery] = useState("");
  const labelRootRef = useRef<HTMLDivElement>(null);
  const labelTriggerRef = useRef<HTMLButtonElement>(null);
  const labelSearchRef = useRef<HTMLInputElement>(null);
  const labelMenuStyle = usePickerMenuStyle(composingLabel, labelRootRef);
  useEffect(() => {
    if (!composingLabel) return;
    const onOutsideClick = (event: MouseEvent) => {
      if (labelRootRef.current?.contains(event.target as Node)) return;
      // Consume the card backdrop click while leaving higher dialogs interactive.
      if (view === "modal" && event.target === modalRef.current?.parentElement) {
        event.stopPropagation();
      }
      setComposingLabel(false);
      restoreFocusSoon(labelTriggerRef.current);
    };
    document.addEventListener("click", onOutsideClick, true);
    return () => document.removeEventListener("click", onOutsideClick, true);
  }, [composingLabel, view]);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editLabelName, setEditLabelName] = useState("");
  const [editLabelColor, setEditLabelColor] = useState<LabelColor>("red");
  const [confirmingLabelDelete, setConfirmingLabelDelete] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  // `null` means "follow the first unused colour", which moves as labels are made.
  const [newLabelColor, setNewLabelColor] = useState<LabelColor | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const viewerCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastAttachmentTriggerRef = useRef<HTMLElement | null>(null);
  const previousOpenAttachmentIdRef = useRef<string | undefined>(openAttachmentId);
  const actionsMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [pendingClose, setPendingClose] = useState<(() => void) | null>(null);
  const pendingCloseTriggerRef = useRef<HTMLElement | null>(null);
  const keepEditingButtonRef = useRef<HTMLButtonElement | null>(null);
  const footerCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeCardButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (pendingClose !== null) keepEditingButtonRef.current?.focus();
  }, [pendingClose]);
  // The delete the user asked for, awaiting the inline Delete/Cancel confirm.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const previousTransferDialogOpenRef = useRef(false);
  useEffect(() => {
    if (previousTransferDialogOpenRef.current && !transferDialogOpen) {
      actionsMenuTriggerRef.current?.focus();
    }
    previousTransferDialogOpenRef.current = transferDialogOpen;
  }, [transferDialogOpen]);
  // Already cached by the router guard, so this is a read, not a fetch.
  const me = useQuery(meQuery).data ?? null;

  const development = useQuery(cardDevelopmentQueryOptions(boardId, card.id)).data;
  const developmentPullRequests = development?.pullRequests ?? [];
  const developmentBranches = development?.branches ?? [];
  // With connected repositories the section opens even on a card with nothing yet: that is where Create branch lives.
  const hasConnectedRepos = (useQuery(connectedReposQueryOptions(boardId)).data?.length ?? 0) > 0;
  // The link draft lives with the card, not in the section: the modal's dirty
  // guard and its Escape ladder both have to see it.
  const pullRequestLink = usePullRequestLink(boardId, card.id);
  const pullRequestWorkRef = useRef(pullRequestLink.hasWork);
  pullRequestWorkRef.current = pullRequestLink.hasWork;
  const onActivityTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: ActivityView,
  ) => {
    const currentIndex = ACTIVITY_TABS.findIndex((tab) => tab.view === current);
    let nextIndex: number;
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = (currentIndex + ACTIVITY_TABS.length - 1) % ACTIVITY_TABS.length;
        break;
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % ACTIVITY_TABS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = ACTIVITY_TABS.length - 1;
        break;
      default:
        return;
    }
    const next = ACTIVITY_TABS[nextIndex]?.view;
    if (next === undefined) return;
    event.preventDefault();
    setActivityView(next);
    requestAnimationFrame(() => activityTabRefs.current[next]?.focus());
  };

  // Assignment is its own mutation, not a `card.update` field: `null` has to
  // mean "unassign", which a partial update could not express.
  const assign = (value: string) => {
    commands.assign(card.id, value === "" ? null : value);
  };

  // Priority follows assignment rather than the draft: an instant-send field,
  // never unset (every card has one, new cards default to Medium).
  const prioritize = (value: string) => {
    commands.prioritize(card.id, value as Priority);
  };
  const retype = (taskType: Exclude<TaskType, "subtask">) => {
    commands.retype(card.id, taskType);
  };
  // Without a starting and a completed column (fewer than two columns) there is
  // no completion to change.
  const hasWorkflowRoles = columns.some(column => column.starting) && columns.some(column => column.completed);
  const changeColumn = (targetColumnId: string) => {
    if (targetColumnId === card.columnId) return;
    const trigger = document.activeElement?.closest('[role="dialog"]')?.querySelector<HTMLElement>('[aria-label="Status"]') ?? null;
    onRequestMove(card.id, targetColumnId, trigger);
  };

  /** Completion is an ordinary instant mutation: optimistic, with board-reported errors. */
  const completeSubtask = (cardId: string, done: boolean) => {
    const target = columns.find(c => done ? c.completed : c.starting);
    if (target) onRequestMove(cardId, target.id);
  };


  // A cleared date input yields "", which maps to null — "no deadline".
  const schedule = (value: string) => {
    commands.schedule(card.id, value === "" ? null : value);
  };

  const sendChecklistText = (lane: "add" | "edit", itemId?: string) => {
    if (checklistAttempts[lane].pending) return;
    const text = (lane === "add" ? newItem : editText).trim();
    if (!text || !Title.safeParse(text).success) {
      setChecklistInvalid((current) => ({ ...current, [lane]: "Checklist text must contain 1–200 characters." }));
      return;
    }
    setChecklistInvalid((current) => ({ ...current, [lane]: null }));
    (lane === "add" ? addOp : editOp).start({
      id: itemId ?? crypto.randomUUID(),
      text,
      position: itemId ? undefined : commands.placeNewChecklistItem(card.id),
    });
  };

  const commitEdit = (item: ChecklistItem) => {
    if (checklistAttempts.edit.pending) return;
    if (editText.trim() === item.text) {
      setEditingId(null);
      return;
    }
    sendChecklistText("edit", item.id);
  };

  const addItem = () => sendChecklistText("add");

  /** A new subtask's key in the column it lands in: the starting column, or this card's own on a board without roles. */
  const subtaskTailPosition = (): string => commands.placeNewCard(columns.find(c => c.starting)?.id ?? card.columnId);

  const addSubtask = () => {
    const rawDraft = subtaskDraftRef.current;
    if (rawDraft.trim() === "" || pendingSubtaskId !== null || subtaskUncertain || subtaskRecovery !== null) return;
    subtaskRetriedRef.current = false;
    subtaskAcceptGenRef.current = ++subtaskGenerationRef.current;
    // Stable per submitted draft: this click's ids are the creation's identity.
    subtaskOp.start({ entityId: crypto.randomUUID(), relationId: crypto.randomUUID(), position: subtaskTailPosition(), rawDraft });
  };

  const retrySubtask = () => {
    if (!subtaskRecovery || pendingSubtaskId !== null || subtaskUncertain) return;
    subtaskRetriedRef.current = true;
    subtaskAcceptGenRef.current = ++subtaskGenerationRef.current;
    subtaskOp.retry();
  };

  const cancelSubtaskComposer = (force = false) => {
    if (
      !force &&
      (pendingSubtaskIdRef.current !== null ||
        subtaskUncertainRef.current ||
        subtaskRecoveryRef.current !== null)
    ) {
      return;
    }
    ++subtaskGenerationRef.current;
    setSubtaskDraft("");
    subtaskOp.discard();
    setComposingSubtask(false);
  };

  // The conversion lane is single-slot: one pending write or one retained
  // recovery owns every Convert action until it settles or is discarded, so no
  // second conversion can start beside it and mint fresh ids behind its back.
  const convertLaneBusy =
    pendingConvertItemId !== null || convertUncertain || convertRecovery !== null;

  const convertItem = (item: ChecklistItem) => {
    if (cardRef.current.taskType === "subtask" || convertLaneBusy) return;
    if (item.text.trim() === "") {
      setConvertEmptyError("Checklist item is empty.");
      return;
    }
    setConvertEmptyError(null);
    convertRetriedRef.current = false;
    convertOp.start({
      entityId: crypto.randomUUID(),
      relationId: crypto.randomUUID(),
      position: subtaskTailPosition(),
      rawDraft: item.text,
      checklistItemId: item.id,
    });
  };

  /** Retries the same conversion with its retained ids, so it cannot duplicate. */
  const retryConvert = () => {
    if (cardRef.current.taskType === "subtask" || !convertRecovery || pendingConvertItemId !== null || convertUncertain) return;
    convertRetriedRef.current = true;
    convertOp.retry();
  };

  // The picked card arrives straight from the autocomplete — no confirm button.
  // A duplicate pair is dropped silently; the DO does no referential checks.
  const addRelation = (otherCardId: string) => {
    if (commands.createRelation(relationKind, card.id, otherCardId) !== "not-sent") setRelationQuery("");
  };

  const toggleLabel = (labelId: string) => commands.toggleLabel(card.id, labelId);

  // Two ordinary mutations from one submit — define it, then hang it on this
  // card. A drop after the first leaves an unassigned definition in the picker:
  // visible and one click from fixed (ADR 0019).
  const createLabel = () => {
    const name = newLabelName.trim();
    if (!name) return;
    if (commands.createAndAssignLabel(card.id, name, createColor) === "not-sent") return;
    setNewLabelName("");
    setNewLabelColor(null);
    setCreatingLabel(false);
    setLabelQuery("");
    requestAnimationFrame(() => labelSearchRef.current?.focus());
  };

  const labelBaselineRef = useRef<{ id: string; name: string; color: LabelColor } | null>(null);
  const labelNameDirtyRef = useRef(false);
  const labelColorDirtyRef = useRef(false);
  const startLabelEdit = (label: Label) => {
    setCreatingLabel(false);
    labelBaselineRef.current = { id: label.id, name: label.name, color: label.color };
    labelNameDirtyRef.current = false;
    labelColorDirtyRef.current = false;
    setEditingLabelId(label.id);
    setEditLabelName(label.name);
    setEditLabelColor(label.color);
    setConfirmingLabelDelete(false);
  };

  const exitLabelEdit = () => {
    setEditingLabelId(null);
    setConfirmingLabelDelete(false);
    requestAnimationFrame(() => labelSearchRef.current?.focus());
  };

  // Partial by construction: only a field the user touched, and changed from
  // where the edit started, is sent, so a peer's concurrent rename or recolour
  // of the other one survives.
  const saveLabelEdit = (label: Label) => {
    const baseline = labelBaselineRef.current?.id === label.id ? labelBaselineRef.current : label;
    const typed = editLabelName.trim();
    // An emptied name is a slip, not an edit — same rule as the card title.
    const name = labelNameDirtyRef.current && typed !== "" && typed !== baseline.name ? typed : undefined;
    const color =
      labelColorDirtyRef.current && editLabelColor !== baseline.color ? editLabelColor : undefined;
    commands.updateLabel(label.id, { name, color });
    exitLabelEdit();
  };

  const deleteLabel = (labelId: string) => {
    commands.deleteLabel(labelId);
    exitLabelEdit();
  };

  const collapseLabelComposer = () => {
    setComposingLabel(false);
    restoreFocusSoon(labelTriggerRef.current);
  };

  // One Escape peels one stage; creation text survives a return to selection.
  const onLabelPaneEscape = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
    if (confirmingLabelDelete) setConfirmingLabelDelete(false);
    else if (editingLabelId !== null) exitLabelEdit();
    else if (creatingLabel) {
      setCreatingLabel(false);
      requestAnimationFrame(() => labelSearchRef.current?.focus());
    } else if (labelQuery !== "") setLabelQuery("");
    else collapseLabelComposer();
  };

  const cancelComposer = (force = false) => {
    if (!force && (commentUploadingRef.current || pendingCommentIdRef.current !== null || commentUncertainRef.current)) return;
    ++commentGenerationRef.current;
    setCommentFeedbackResetToken((token) => token + 1);
    setCommentDraft("");
    setComposingComment(false);
  };

  const cancelReplyComposer = (force = false) => {
    if (!force && (replyUploadingRef.current || pendingReplyIdRef.current !== null || replyUncertainRef.current)) return;
    ++replyGenerationRef.current;
    const targetId = replyingCommentId;
    setReplyDraft("");
    setReplyingCommentId(null);
    setReplyingRootId(null);
    if (targetId && replyButtonRefs.current[targetId]) {
      replyButtonRefs.current[targetId]?.focus();
    }
  };
  const startReply = (targetComment: Comment) => {
    if (replyUploadingRef.current || pendingReplyIdRef.current !== null || replyUncertainRef.current || orphanedReplyRef.current !== null) return;
    if (replyingCommentId === targetComment.id) return;
    const rootId = targetComment.parentCommentId ?? targetComment.id;
    const activate = () => {
      ++replyGenerationRef.current;
      setReplyingCommentId(targetComment.id);
      setReplyingRootId(rootId);
      setReplyDraft("");
    };
    if (replyingCommentId !== null && (replyDraft.trim() !== "" || replyUploadingRef.current)) {
      requestClose(activate);
      return;
    }
    activate();
  };
  // `authorId` and the timestamps ride the wire: the DO is identity-blind and
  // rebroadcasts frames verbatim, so a server stamp would not reach peers until
  // their next snapshot (ADR 0015).
  const submitComment = () => {
    const rawDraft = commentDraftRef.current;
    const body = rawDraft.trim();
    if (!body || !me || commentUploadingRef.current || pendingCommentId !== null || commentUncertain || commentRecovery !== null) return;
    commentRetriedRef.current = false;
    commentAcceptGenRef.current = ++commentGenerationRef.current;
    commentOp.start({ entityId: crypto.randomUUID(), authorId: me.id, parentCommentId: null, rawDraft, body });
  };

  const submitReply = (rootCommentId: string) => {
    const rawDraft = replyDraftRef.current;
    const body = rawDraft.trim();
    if (!body || !me || replyUploadingRef.current || pendingReplyId !== null || replyUncertain || replyRecovery !== null) return;
    replyRetriedRef.current = false;
    replyAcceptGenRef.current = ++replyGenerationRef.current;
    replyOp.start({ entityId: crypto.randomUUID(), authorId: me.id, parentCommentId: rootCommentId, rawDraft, body });
  };
  const retryCommentRecovery = () => {
    if (!commentRecovery || !me || commentUploadingRef.current || pendingCommentId !== null || commentUncertain) return;
    commentRetriedRef.current = true;
    commentAcceptGenRef.current = commentGenerationRef.current;
    commentOp.retry();
  };

  const retryReplyRecovery = () => {
    if (!replyRecovery || !me || replyUploadingRef.current || pendingReplyId !== null || replyUncertain) return;
    replyRetriedRef.current = true;
    replyAcceptGenRef.current = replyGenerationRef.current;
    replyOp.retry();
  };

  const retrySaveRecovery = () => {
    if (!saveRecovery || descriptionUploadingRef.current || pendingSaveId !== null || saveUncertain) return;
    saveRetriedRef.current = true;
    saveOp.retry();
  };

  const saveCommentEdit = () => {
    const body = editCommentDraft.trim();
    if (!body || !editingCommentId || commentUploadingRef.current || pendingCommentEditIdRef.current !== null) return;
    commentEditOp.start({ id: editingCommentId, body });
  };

  const cancelCommentEdit = () => {
    if (pendingCommentEditIdRef.current !== null || commentUploadingRef.current) return;
    setEditingCommentId(null);
    clearCommentEditError();
  };

  /**
   * What Save would send: the draft diffed against the card. Shared with the
   * dirty check below, so "unsaved changes" means exactly "Save has work".
   */
  const changes = (): { title?: string; description?: string } => {
    const nextTitle = title.trim();
    const diff: { title?: string; description?: string } = {};
    // An emptied title is a slip, not an edit — the card keeps the old one.
    if (titleDirtyRef.current && nextTitle && nextTitle !== titleBaselineRef.current) diff.title = nextTitle;
    if (descriptionDirtyRef.current && description !== descriptionBaselineRef.current) {
      diff.description = description;
    }
    return diff;
  };

  const liveChanges = (): { title?: string; description?: string } => {
    const nextTitle = titleRef.current.trim();
    const diff: { title?: string; description?: string } = {};
    if (titleDirtyRef.current && nextTitle && nextTitle !== titleBaselineRef.current) diff.title = nextTitle;
    if (descriptionDirtyRef.current && descriptionRef.current !== descriptionBaselineRef.current) {
      diff.description = descriptionRef.current;
    }
    return diff;
  };
  /**
   * What keeps the card open after an accepted save instead of throwing it away: a submitted write
   * of another lane still in flight, a draft, or a recovery still on screen (Save's own included,
   * so the late acceptance of an earlier attempt does not close the card).
   */
  const workKeepsCardOpen = () =>
    authoredScope.hasActiveWork() ||
    checklistHasWorkRef.current ||
    commentEditHasWorkRef.current ||
    (composingCommentRef.current && (commentDraftRef.current.trim() !== "" || commentUploadingRef.current)) ||
    (replyingCommentIdRef.current !== null && (replyDraftRef.current.trim() !== "" || replyUploadingRef.current)) ||
    orphanedReplyRef.current !== null ||
    descriptionUploadingRef.current ||
    commentRecoveryRef.current !== null ||
    replyRecoveryRef.current !== null ||
    saveRecoveryRef.current !== null ||
    // A pull request draft, or a link request still in flight, is work Save does
    // not own: the card stays open so it is not thrown away by closing.
    pullRequestWorkRef.current ||
    // Save never commits an open subtask composer, so an unaccepted child
    // being written (or a conversion landing) must not close the card either.
    (composingSubtaskRef.current && subtaskDraftRef.current.trim() !== "") ||
    subtaskRecoveryRef.current !== null ||
    convertRecoveryRef.current !== null;
  const save = () => {
    if (attachmentDeletePendingRef.current || descriptionUploadingRef.current || pendingSaveId !== null || saveUncertain || saveRecoveryRef.current !== null) return;
    if (descriptionByteLength(description) > DESCRIPTION_MAX_BYTES) {
      setSaveValidationError("Description must be 100,000 bytes or fewer.");
      return;
    }
    clearSaveError();
    const diff = liveChanges();
    if (diff.title === undefined && diff.description === undefined) {
      return;
    }
    saveRetriedRef.current = false;
    saveAttemptDiffsRef.current.clear();
    saveOp.start({
      entityId: cardRef.current.id,
      submittedTitle: diff.title,
      submittedDescription: diff.description,
      draftTitle: titleRef.current.trim(),
      draftDescription: descriptionRef.current,
    });
  };
  /** The one upload path, shared by the panel and the image-only Markdown entry points. */
  const upload = useMutation({
    mutationFn: ({ file, rasterizeSvg }: { file: File; rasterizeSvg?: boolean }) =>
      boardAttachments.upload({ file, cardId: card.id, scope: uploadScope, rasterizeSvg }),
  });

  const uploadImageFor = (
    setUploading: React.Dispatch<React.SetStateAction<boolean>>,
    allowSvg: boolean = false,
    uploadingRef?: React.RefObject<boolean>,
  ) => async (file: File): Promise<{ url: string; alt: string }> => {
    const contentType = normalizeAttachmentContentType(file.type);
    const isSvg = contentType === "image/svg+xml";
    if (isSvg) {
      if (!allowSvg) {
        throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
      }
    } else if (!isPreviewableImageContentType(contentType)) {
      throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
    }

    if (uploadingRef) {
      if (uploadingRef.current) {
        throw new Error("An image is still uploading. Paste again when it finishes.");
      }
      uploadingRef.current = true;
    }
    setUploading(true);
    try {
      return await upload.mutateAsync({ file, rasterizeSvg: allowSvg && isSvg });
    } finally {
      if (uploadingRef) {
        uploadingRef.current = false;
      }
      setUploading(false);
    }
  };

  const uploadDescriptionImage = useMemo(
    () => uploadImageFor(setDescriptionUploading, true, descriptionUploadingRef),
    [],
  );
  const uploadCommentImage = useMemo(
    () => uploadImageFor(setCommentUploading, false, commentUploadingRef),
    [],
  );
  const uploadEditedCommentImage = useMemo(
    () => async (file: File) => {
      const targetId = editingCommentIdRef.current;
      const result = await uploadCommentImage(file);
      if (targetId && !commentsRef.current.some((comment) => comment.id === targetId && !comment.deleted)) {
        // The deleted row unmounted its editor, so preserve its pending image here.
        setEditCommentDraft((draft) => `${draft}\n\n![${result.alt}](${result.url})`);
      }
      return result;
    },
    [],
  );
  const uploadReplyImage = useMemo(() => {
    return async (file: File): Promise<{ url: string; alt: string }> => {
      const capturedGeneration = replyGenerationRef.current;
      const capturedTargetId = replyingCommentIdRef.current;
      const capturedInitialDraft = replyDraftRef.current;
      if (capturedTargetId) {
        pendingReplyUploadTargetRef.current = { targetId: capturedTargetId, initialDraft: capturedInitialDraft };
      }
      const contentType = normalizeAttachmentContentType(file.type);
      if (!isPreviewableImageContentType(contentType)) {
        throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
      }
      setReplyUploading(true);
      try {
        const result = await upload.mutateAsync({ file });
        // Tie async completion to reply owner generation + target.
        // It may never overwrite another target's or newer reply draft.
        if (replyGenerationRef.current !== capturedGeneration || replyingCommentIdRef.current !== capturedTargetId) {
          throw new Error("Reply composer target changed or closed before upload completed.");
        }
        const targetStillExists = capturedTargetId ? commentsRef.current.some((c) => c.id === capturedTargetId && !c.deleted) : false;
        if (!targetStillExists && capturedTargetId !== null) {
          // Target was deleted by peer while upload was in flight.
          // Form exact markdown embed using the current live reply draft.
          const currentDraft = replyDraftRef.current;
          const markup = `![${result.alt}](${result.url})`;
          const finalOrphanText = currentDraft.trim() !== "" ? `${currentDraft}\n\n${markup}` : markup;
          setOrphanedReply((prev) => (prev !== null ? prev : { text: finalOrphanText }));
          setReplyingCommentId(null);
          setReplyingRootId(null);
          setReplyDraft("");
          return result;
        }
        return result;
      } catch (err) {
        const targetId = replyingCommentIdRef.current ?? capturedTargetId;
        const targetStillExists = targetId ? commentsRef.current.some((c) => c.id === targetId && !c.deleted) : true;
        if (!targetStillExists && capturedTargetId !== null) {
          const currentDraft = replyDraftRef.current;
          if (currentDraft.trim() !== "") {
            setOrphanedReply((prev) => (prev !== null ? prev : { text: currentDraft }));
            setReplyingCommentId(null);
            setReplyingRootId(null);
            setReplyDraft("");
          }
        }
        throw err;
      } finally {
        setReplyUploading(false);
      }
    };
  }, [upload]);
  // Every authored draft is guarded independently of the title/description Save.
  const diff = changes();
  const titleHasChanges = diff.title !== undefined;
  const descriptionHasChanges = diff.description !== undefined;
  const hasTextChanges = titleHasChanges || descriptionHasChanges;
  const textSaveStatusId = `card-text-save-status-${card.id}`;
  const unsavedTextMessage = titleHasChanges && descriptionHasChanges
    ? "Unsaved title and description"
    : titleHasChanges
      ? "Unsaved title"
      : "Unsaved description";
  // Closing guards every authored lane; the footer Save owns only card text.
  const draftingDirty =
    checklistHasWork ||
    commentEditHasWork ||
    diff.title !== undefined ||
    diff.description !== undefined ||
    descriptionUploading ||
    commentUploading ||
    replyUploading ||
    orphanedReply !== null ||
    pendingSaveId !== null ||
    pendingCommentId !== null ||
    pendingReplyId !== null ||
    saveUncertain ||
    commentUncertain ||
    replyUncertain ||
    commentRecovery !== null ||
    replyRecovery !== null ||
    saveRecovery !== null ||
    (composingComment && (commentDraft.trim() !== "" || commentUploading)) ||
    (replyingCommentId !== null && (replyDraft.trim() !== "" || replyUploading)) ||
    // The subtask composer is authored work too: a typed title is a draft, and a
    // submitted one is a write still to be verified.
    (composingSubtask && subtaskDraft.trim() !== "") ||
    pendingSubtaskId !== null ||
    subtaskUncertain ||
    subtaskRecovery !== null ||
    // A conversion in flight is authored work too: closing before it settles
    // would drop its recovery and retire its ownership behind the user's back.
    pendingConvertItemId !== null ||
    convertUncertain ||
    convertRecovery !== null;
  // The pull request link is unsaved work too — it just belongs to Link pull
  // request, not Save — so closing is guarded the same way.
  const dirty = draftingDirty || pullRequestLink.hasWork;
  const submittedWorkPending = authoredScope.hasActiveWork();
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (onRegisterDiscardPrompt) {
      onRegisterDiscardPrompt(() => {
        pendingCloseTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPendingClose(() => () => onConfirmBlockedNavigation?.());
      });
    }
  }, [onRegisterDiscardPrompt, onConfirmBlockedNavigation]);

  /**
   * Every way out of the modal goes through here: a clean panel closes (or
   * navigates) at once, a dirty one parks the action behind the discard strip
   * instead of throwing the draft away.
   */
  const requestClose = (action: () => void) => {
    if (!dirty) {
      action();
      return;
    }
    pendingCloseTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingClose(() => action);
  };

  // Relation, parent and subtask rows remount the modal on the other card, so
  // they are a close as far as the draft is concerned.
  const navigate = (cardId: string) => requestClose(() => onOpenCard(cardId));

  const executePendingClose = () => {
    if (!pendingClose) return;
    const action = pendingClose;
    pendingCloseTriggerRef.current = null;
    setPendingClose(null);
    onDirtyChange?.(false);
    action();
  };
  const cancelPendingClose = () => {
    if (pendingClose !== null) {
      const trigger = pendingCloseTriggerRef.current;
      restoreFocusSoon(() => trigger?.isConnected ? trigger : footerCloseButtonRef.current ?? closeCardButtonRef.current);
      pendingCloseTriggerRef.current = null;
    }
    setPendingClose(null);
    onCancelBlockedNavigation?.();
  };

  // Reconcile active reply composer when comments change:
  // - If replying to a reply, check if that reply still exists. If the reply was deleted
  //   by a peer, fall back to its thread root if that root is still live (not deleted).
  // - If replying to a root, check if the root still exists and is not deleted.
  // - If no valid live anchor remains:
  //     - If the draft has text, prompt the user via requestClose / discard strip rather
  //       than silently dropping the text or stranding invisible dirty state.
  //     - If the draft is empty, simply close the composer.
  useEffect(() => {
    if (replyingCommentId === null) return;
    const target = comments.find((c) => c.id === replyingCommentId);
    if (target) {
      // The target still exists. Ensure root comment tracking is synced.
      const rootId = target.parentCommentId ?? target.id;
      if (replyingRootId !== rootId) {
        setReplyingRootId(rootId);
      }
      return;
    }

    // If reply is currently uploading, keep ownership; the upload completion
    // will detect the missing target and create an orphan recovery.
    // The uploading guard now precedes child-to-root reanchor.
    if (replyUploadingRef.current) {
      return;
    }

    // The target comment was deleted or pruned by a peer.
    // Check if the thread's root comment still survives (either active or tombstoned with remaining replies).
    const root = replyingRootId ? comments.find((c) => c.id === replyingRootId) : null;
    if (root) {
      // Re-anchor the active composer visibly directly beneath the surviving root.
      // If the root is tombstoned, renderReplyComposer will appear under the root row,
      // keeping the draft visible and editable!
      setReplyingCommentId(root.id);
      return;
    }

    // Neither the target comment nor any thread root survives.
    // If reply is currently uploading, keep ownership; the upload completion
    // will detect the missing target and create an orphan recovery.
    if (replyUploadingRef.current) {
      // Don't discard or clear target while uploading: keep active composer visible
      // until upload completes or fails, so user can edit and see progress.
      return;
    }
    // Prompt the user via the discard guard if dirty, or close if empty.
    if (replyDraft.trim() !== "") {
      requestClose(() => {
        setReplyingCommentId(null);
        setReplyingRootId(null);
        setReplyDraft("");
      });
    } else {
      setReplyingCommentId(null);
      setReplyingRootId(null);
      setReplyDraft("");
    }
  }, [comments, replyingCommentId, replyingRootId, replyDraft]);
  // A peer can delete the row while its confirmation is open. Do not leave an
  // invisible Escape rung behind after the live attachment disappears.
  useEffect(() => {
    if (
      confirmingAttachmentId !== null &&
      !attachments.some((attachment) => attachment.id === confirmingAttachmentId)
    ) {
      setConfirmingAttachmentId(null);
    }
  }, [attachments, confirmingAttachmentId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (transferDialogOpen) return;
        if (openAttachmentId !== undefined) {
          onCloseAttachment();
          return;
        }
        if (confirmingAttachmentId !== null) {
          setConfirmingAttachmentId(null);
          return;
        }
        if (confirmingDelete) {
          setConfirmingDelete(false);
          return;
        }
        if (pendingClose) {
          executePendingClose();
          return;
        }
        // One rung per Escape: clear the typed link or its error first, then
        // collapse an empty composer. Pending or uncertain work is never erased
        // here — it falls through to the guarded close below.
        if (pullRequestLink.handleEscape()) return;
        if (
          composingSubtaskRef.current &&
          pendingSubtaskIdRef.current === null &&
          !subtaskUncertainRef.current
        ) {
          // An idle empty composer just collapses; a typed title goes through the
          // same discard strip as every other draft, and a submitted one is left
          // strictly alone until it settles.
          if (subtaskDraftRef.current.trim() === "") {
            cancelSubtaskComposer();
            return;
          }
          requestClose(() => cancelSubtaskComposer(true));
          return;
        }
        requestClose(onClose);
        return;
      }

      if (event.key === "Tab") {
        if (transferDialogOpen) return;
        const activeContainer = openAttachmentId !== undefined ? viewerRef.current : modalRef.current;
        if (!activeContainer || activeContainer.hasAttribute("inert")) return;
        const focusableSelector =
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const focusableElements = Array.from(
          activeContainer.querySelectorAll<HTMLElement>(focusableSelector),
        ).filter(
          (element) =>
            !element.hasAttribute("disabled") &&
            element.getAttribute("aria-hidden") !== "true" &&
            element.offsetParent !== null,
        );
        if (focusableElements.length === 0) {
          event.preventDefault();
          return;
        }
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        if (event.shiftKey) {
          if (
            document.activeElement === firstElement ||
            !activeContainer.contains(document.activeElement)
          ) {
            event.preventDefault();
            lastElement.focus();
          }
        } else {
          if (
            document.activeElement === lastElement ||
            !activeContainer.contains(document.activeElement)
          ) {
            event.preventDefault();
            firstElement.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    transferDialogOpen,
    openAttachmentId,
    onCloseAttachment,
    confirmingAttachmentId,
    confirmingDelete,
    pendingClose,
    dirty,
    pullRequestLink.handleEscape,
    onClose,
  ]);

  useEffect(() => {
    if (openAttachmentId !== undefined) {
      const active = document.activeElement;
      if (
        !lastAttachmentTriggerRef.current &&
        active instanceof HTMLElement &&
        active !== document.body &&
        modalRef.current?.contains(active) &&
        !active.closest("[inert]")
      ) {
        lastAttachmentTriggerRef.current = active;
      }
      requestAnimationFrame(() => {
        viewerCloseButtonRef.current?.focus();
      });
    } else if (previousOpenAttachmentIdRef.current !== undefined) {
      // Viewer was closed: restore focus to trigger or fallback within non-inert modal
      requestAnimationFrame(() => {
        const target = lastAttachmentTriggerRef.current;
        let focused = false;
        if (
          target &&
          target !== document.body &&
          target.isConnected &&
          modalRef.current?.contains(target) &&
          !target.closest("[inert]")
        ) {
          target.focus();
          focused = document.activeElement === target;
        }
        if (!focused) {
          const fallback = modalRef.current?.querySelector<HTMLElement>(
            'button:not([disabled]):not([aria-hidden="true"]), [tabindex]:not([tabindex="-1"]):not([disabled])',
          );
          fallback?.focus();
        }
        lastAttachmentTriggerRef.current = null;
      });
    }
    previousOpenAttachmentIdRef.current = openAttachmentId;
  }, [openAttachmentId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Backspace") return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        if (target instanceof HTMLTextAreaElement) return;
        if (target instanceof HTMLInputElement) {
          const type = target.type.toLowerCase();
          const isNonTextInput: Record<string, true | undefined> = {
            checkbox: true,
            color: true,
            file: true,
            hidden: true,
            image: true,
            radio: true,
            range: true,
            reset: true,
            submit: true,
          };
          if (!isNonTextInput[type]) return;
        }
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // A click event fires on the nearest common ancestor of press and release, so
  // a selection drag that starts in the textarea and ends over the backdrop
  // targets the overlay. Only a gesture that *began* on the backdrop discards.
  const pressedBackdrop = useRef(false);

  const views = relationViews(relations, card.id);
  // The guarded forest decides whether this card is a subtask at all: a stored
  // child with two parents (or inside a cycle) is a root here, exactly as the
  // board and the server read it.
  const effectiveParentId = hierarchy.parentByChild.get(card.id);
  const parentLink =
    effectiveParentId === undefined
      ? undefined
      : relations.find(
          (relation) =>
            relation.kind === "subtask" &&
            relation.targetCardId === card.id &&
            relation.sourceCardId === effectiveParentId,
        );
  /** The card's direct children, with the link each row can unlink. */
  const childNodes = buildSubtaskNodes({ cards, relations }, hierarchy, card.id, {
    directOnly: true,
  });
  const subtaskCounts = directSubtaskCounts(cards, hierarchy, card.id);
  const subtaskPercent =
    subtaskCounts.total > 0
      ? Math.round((subtaskCounts.done / subtaskCounts.total) * 100)
      : 0;
  const matches = relationCardMatches(cards, card.id, boardKey ?? "", relationQuery);
  // The picker lists the whole board, name-sorted; the pills above it are
  // already sorted the same way by `cardLabelViews`.
  const pickerLabels = [...labels].sort((a, b) =>
    a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()),
  );
  // The create form starts on a colour no label uses yet, so a board of eight
  // labels reads as eight colours without anyone picking.
  const nextColor =
    LABEL_COLORS.find((color) => !labels.some((label) => label.color === color)) ??
    LABEL_COLORS[0];
  const createColor = newLabelColor ?? nextColor;

  // Essential instant-save fields lead the mobile reading and keyboard order.
  // CSS places this same mounted block beside the main content on desktop.
  const metadataSection = (
    <div className="card-detail-fields">
      {/* `div`s, not `label`s: a `<label>` cannot name a button, so the
          trigger's own `aria-label` carries the accessible name while the
          visible caption stays put. */}
      <div className="card-property-row">
        <span className="card-property-label">Status</span>
        <div className="card-property-control">
        <StatusPicker columnId={card.columnId} columns={columns} onChange={changeColumn} />
        </div>
      </div>
      <div className="card-property-row">
        <span className="card-property-label">Type</span>
        <div className="card-property-control">
        {card.taskType === "subtask" ? (
          <div
            aria-label="Type"
            className="card-property-readonly flex min-h-11 items-center gap-2 px-2"
          >
            <span aria-hidden="true" className="size-3.5 shrink-0 rounded-full bg-teal-500" />
            <span>Subtask</span>
          </div>
        ) : (
          <TaskTypePicker value={card.taskType} onChange={retype} />
        )}
        </div>
      </div>
      <div className="card-property-row">
        <span className="card-property-label">Assignee</span>
        <div className="card-property-control">
        {membersLoading ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading board members…
          </p>
        ) : membersError ? (
          <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
            <span>Could not load board members.</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onRetryMembers}
              className="border-border text-foreground hover:bg-accent"
            >
              Retry
            </Button>
          </div>
        ) : (
          <AssigneePicker assigneeId={card.assigneeId} members={members} onChange={assign} />
        )}
        </div>
      </div>
      <div className="card-property-row">
        <span className="card-property-label">Priority</span>
        <div className="card-property-control"><PriorityPicker value={card.priority} onChange={prioritize} /></div>
      </div>
      {/* The clear button sits OUTSIDE the label: inside, its accessible name
          would fold into the date input's own, which the e2e locates by. */}
      <div className="card-property-row">
        <label htmlFor={`card-due-date-${card.id}`} className="card-property-label">Due date</label>
        <div className="card-property-control card-property-date" data-empty={card.dueDate === null}>
          {card.dueDate === null && <span aria-hidden="true" className="card-date-empty">No due date</span>}
          <Input
            id={`card-due-date-${card.id}`}
            type="date"
            value={card.dueDate ?? ""}
            onChange={(event) => schedule(event.target.value)}
            className="h-8 w-full min-w-0 bg-background text-base sm:text-sm text-foreground"
          />
        {card.dueDate !== null && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Clear due date"
            onClick={() => schedule("")}
            className="mb-0.5 text-muted-foreground hover:text-destructive pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            <X aria-hidden className="size-4" />
          </Button>
        )}
        </div>
      </div>
    </div>
  );
  const creatorId = cardCreatorId(card.id, activities);
  const creator = creatorId ? members.find((m) => m.id === creatorId) : undefined;
  const historicalAssigneeIds = cardAssigneeHistory(card.id, activities, card.assigneeId);

  const contributorsSection = (
    <details className="card-details-disclosure">
      <summary tabIndex={0}><h3><Users aria-hidden="true" className="card-section-icon" />Contributors</h3><ChevronDown aria-hidden="true" /></summary>
      <div className="card-disclosure-content flex flex-col gap-2 text-sm">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-foreground">
          <span className="text-xs text-muted-foreground">Created by:</span>
          {creatorId ? (
            creator ? (
              <span
                role="img"
                aria-label={`Created by ${creator.name}`}
                title={creator.name}
                className="flex items-center gap-1.5"
              >
                <Avatar
                  name={creator.name}
                  githubLogin={creator.githubLogin}
                  avatarVersion={creator.avatarVersion}
                  userId={creator.id}
                />
                <span className="truncate">{creator.name}</span>
              </span>
            ) : (
              <span
                role="img"
                aria-label="Created by Former member"
                title="Former member"
                className="flex items-center gap-1.5 text-muted-foreground"
              >
                <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-secondary-foreground">
                  ?
                </span>
                <span>Former member</span>
              </span>
            )
          ) : (
            <span className="text-xs text-muted-foreground">Creator unavailable</span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Assigned during this task:</span>
          {historicalAssigneeIds.length === 0 ? (
            <span className="text-xs text-muted-foreground">No assignees yet</span>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {historicalAssigneeIds.map((userId) => {
                const member = members.find((m) => m.id === userId);
                if (member) {
                  return (
                    <span
                      key={userId}
                      role="img"
                      aria-label={`Assigned: ${member.name}`}
                      title={member.name}
                      className="flex shrink-0"
                    >
                      <Avatar
                        name={member.name}
                        githubLogin={member.githubLogin}
                        avatarVersion={member.avatarVersion}
                        userId={member.id}
                      />
                    </span>
                  );
                }
                return (
                  <span
                    key={userId}
                    role="img"
                    aria-label="Assigned: Former member"
                    title="Former member"
                    className="flex shrink-0"
                  >
                    <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-secondary-foreground">
                      ?
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
      </div>
    </details>
  );
  // A `div`, for the same reason as the checklist above. Labels are instant-send
  // like the metadata block: the picker never joins the Save draft.
  const editingLabel = labels.find((label) => label.id === editingLabelId);
  const filteredLabels = pickerLabels.filter((label) =>
    label.name.toLocaleLowerCase().includes(labelQuery.trim().toLocaleLowerCase()),
  );
  const labelPalette = (selected: LabelColor, onSelect: (color: LabelColor) => void) => (
    <div className="label-palette" role="group" aria-label="Label color">
      {LABEL_COLORS.map((color) => (
        <button key={color} type="button" aria-label={LABEL_COLOR_META[color].label}
          aria-pressed={color === selected} onClick={() => onSelect(color)}
          className={`label-swatch ${LABEL_COLOR_META[color].pill}`}>
          {color === selected && <Check aria-hidden="true" className="size-3.5" />}
        </button>
      ))}
    </div>
  );
  const labelPreview = (name: string, color: LabelColor) => (
    <span className={`label-chip ${LABEL_COLOR_META[color].pill}`}>
      <span aria-hidden="true" className={`label-dot ${LABEL_COLOR_META[color].swatch}`} />
      <span className="label-name">{name.trim() || "Label preview"}</span>
    </span>
  );
  const labelsSection = (
    <div className="card-sidebar-section flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <h3 className="card-section-title text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Tag aria-hidden="true" className="card-section-icon" />Labels{cardLabels.length > 0 && ` ${cardLabels.length}`}
      </h3>
      {cardLabels.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-1.5">
          {cardLabels.map((view) => (
            <li key={view.id} className="min-w-0 max-w-full">
              <span className={`label-chip ${LABEL_COLOR_META[view.label.color].pill}`}>
                <span aria-hidden="true" className={`label-dot ${LABEL_COLOR_META[view.label.color].swatch}`} />
                <span className="label-name">{view.label.name}</span>
                <button type="button" aria-label={`Remove label ${view.label.name}`}
                  onClick={() => toggleLabel(view.label.id)} className="label-remove">
                  <X aria-hidden="true" className="size-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div ref={labelRootRef} className="relative" onKeyDown={(event) => {
        if (!composingLabel) return;
        if (event.key === "Escape") { onLabelPaneEscape(event); return; }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        if (creatingLabel || editingLabel) return;
        event.preventDefault();
        const items = Array.from(labelRootRef.current?.querySelectorAll<HTMLElement>(
          '[aria-label="Search labels"], [aria-label^="Toggle label "]',
        ) ?? []);
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[Math.min(Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0), items.length - 1)]?.focus();
      }}>
        <Button ref={labelTriggerRef} type="button" aria-label="+ Add label…"
          aria-expanded={composingLabel} aria-controls={`label-picker-${card.id}`}
          variant="outline" size="sm" onClick={() => composingLabel ? collapseLabelComposer() : setComposingLabel(true)}
          className="label-add text-muted-foreground hover:text-foreground">
          <Plus aria-hidden="true" className="size-3.5" />Add labels
        </Button>
        {composingLabel && (
          <div id={`label-picker-${card.id}`} style={labelMenuStyle}
            className="label-picker rounded-lg border border-border bg-popover text-popover-foreground shadow-popover"
            aria-label="Label picker">
            <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
              <span className="text-xs font-medium">{editingLabel ? "Edit label" : creatingLabel ? "Create label" : "Labels"}</span>
              <Button type="button" variant="ghost" size="xs"
                onClick={() => {
                  if (editingLabel) exitLabelEdit();
                  else if (creatingLabel) { setCreatingLabel(false); requestAnimationFrame(() => labelSearchRef.current?.focus()); }
                  else collapseLabelComposer();
                }} className="text-muted-foreground pointer-coarse:min-h-11">
                {editingLabel || creatingLabel ? "Back" : "Done"}
              </Button>
            </div>
            {editingLabel || creatingLabel ? (
              <div className="flex flex-col gap-3 px-3 pb-3">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">Name
                  <Input autoFocus maxLength={200} aria-label={editingLabel ? `Label name ${editingLabel.name}` : "New label name"}
                    value={editingLabel ? editLabelName : newLabelName}
                    onChange={(event) => {
                      if (editingLabel) { labelNameDirtyRef.current = true; setEditLabelName(event.target.value); }
                      else setNewLabelName(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); editingLabel ? saveLabelEdit(editingLabel) : createLabel(); }
                    }} className="h-8 text-base sm:text-sm text-foreground" />
                </label>
                <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Color</span>
                  {labelPalette(editingLabel ? editLabelColor : createColor, (color) => {
                    if (editingLabel) { labelColorDirtyRef.current = true; setEditLabelColor(color); }
                    else setNewLabelColor(color);
                  })}
                </div>
                <div className="min-w-0 py-1">{labelPreview(editingLabel ? editLabelName : newLabelName, editingLabel ? editLabelColor : createColor)}</div>
                {editingLabel && confirmingLabelDelete ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="w-full">Remove this label from every card?</span>
                    <Button type="button" variant="destructive" size="xs" aria-label={`Confirm delete label ${editingLabel.name}`}
                      onClick={() => deleteLabel(editingLabel.id)}>Delete</Button>
                    <Button type="button" variant="ghost" size="xs" aria-label="Cancel label delete"
                      onClick={() => setConfirmingLabelDelete(false)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {editingLabel && <Button type="button" variant="ghost" size="xs"
                      aria-label={`Delete label ${editingLabel.name}`} onClick={() => setConfirmingLabelDelete(true)}
                      className="mr-auto text-destructive hover:text-destructive">Delete</Button>}
                    <Button type="button" variant="ghost" size="xs"
                      aria-label={editingLabel ? "Cancel label edit" : "Cancel label creation"}
                      onClick={() => {
                        if (editingLabel) exitLabelEdit();
                        else { setNewLabelName(""); setNewLabelColor(null); setCreatingLabel(false); requestAnimationFrame(() => labelSearchRef.current?.focus()); }
                      }}>Cancel</Button>
                    <Button type="button" size="xs" aria-label={editingLabel ? `Save label ${editingLabel.name}` : undefined}
                      onClick={() => editingLabel ? saveLabelEdit(editingLabel) : createLabel()}
                      disabled={!editingLabel && !newLabelName.trim()}>{editingLabel ? "Save label" : "Create and add"}</Button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="relative mx-3 my-2">
                  <Search aria-hidden="true" className="pointer-events-none absolute top-2.5 left-2 size-3.5 text-muted-foreground" />
                  <Input ref={labelSearchRef} autoFocus type="search" aria-label="Search labels" placeholder="Search labels…"
                    value={labelQuery} onChange={(event) => setLabelQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && filteredLabels[0]) { event.preventDefault(); toggleLabel(filteredLabels[0].id); }
                    }} className="h-8 pl-7 text-base sm:text-sm" />
                </div>
                <div className="px-1 pb-1">
                  {filteredLabels.map((label) => {
                    const selected = cardLabels.some((view) => view.label.id === label.id);
                    return <div key={label.id} className={`label-picker-row ${selected ? "bg-accent/50" : ""}`}>
                      <button type="button" aria-label={`Toggle label ${label.name}`} aria-pressed={selected}
                        onClick={() => toggleLabel(label.id)} className="label-picker-toggle">
                        <span aria-hidden="true" className={`label-checkbox ${selected ? "bg-primary text-primary-foreground border-primary" : "border-input"}`}>
                          {selected && <Check className="size-3" />}
                        </span>
                        <span aria-hidden="true" className={`label-dot ${LABEL_COLOR_META[label.color].swatch}`} />
                        <span className="label-name flex-1">{label.name}</span>
                      </button>
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Edit label ${label.name}`}
                        onClick={() => startLabelEdit(label)} className="size-7 shrink-0 text-muted-foreground pointer-coarse:size-11">
                        <Pencil aria-hidden="true" className="size-3" />
                      </Button>
                    </div>;
                  })}
                  {filteredLabels.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">{labels.length ? "No matching labels" : "No labels yet"}</p>}
                </div>
                <button type="button" onClick={() => setCreatingLabel(true)} className="label-create">
                  <Plus aria-hidden="true" className="size-3.5" />Create label
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Label changes apply immediately.</p>
    </div>
  );
  const previewImagesKey = attachments
    .map((a) => `${a.id}:${a.contentType}:${a.fileName}`)
    .join(";");
  const previewImages = useMemo(() => {
    const map = new Map<string, { id: string; fileName: string }>();
    for (const attachment of attachments) {
      if (isPreviewableImageContentType(attachment.contentType)) {
        map.set(`/boards/${boardId}/attachments/${attachment.id}`, {
          id: attachment.id,
          fileName: attachment.fileName,
        });
      }
    }
    return map;
  }, [previewImagesKey, boardId]);

  const handleOpenAttachmentFromMarkdown = useCallback(
    (attId: string, trigger?: HTMLElement | null) => {
      const el =
        trigger ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      if (el) {
        lastAttachmentTriggerRef.current = el;
      }
      onOpenAttachment(attId, el);
    },
    [onOpenAttachment],
  );

  const descriptionSection = (
    <div className="card-description-section flex flex-col gap-1 py-4 first:pt-0 last:pb-0">
      <DescriptionEditor
        heading={<div className="flex items-center gap-2">
        <h3 className="card-section-title text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <AlignLeft aria-hidden="true" className="card-section-icon" />Description
        </h3>
        {descriptionHasChanges && pendingSaveId === null && !saveUncertain && (
          <span className="card-text-draft-badge">Unsaved</span>
        )}
      </div>}
        notice={saveRecovery && (
        <div
          role="alert"
          className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
        >
          <div className="flex items-center justify-between gap-2 font-medium">
            <span>{saveRecovery.error}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={retrySaveRecovery}
                disabled={descriptionUploading || pendingSaveId !== null || saveUncertain}
                className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                {pendingSaveId !== null ? "Retrying…" : "Retry unsent save"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={pendingSaveId !== null || saveUncertain}
                onClick={() => {
                  if (pendingSaveId !== null || saveUncertain) return;
                  saveOp.discard();
                }}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                Discard unsent save
              </Button>
            </div>
          </div>
          <div className="rounded border border-border/50 bg-background/50 p-2 text-foreground font-mono text-[11px] whitespace-pre-wrap break-words">
            {saveRecovery.submittedTitle !== undefined && (
              <div><span className="font-semibold text-muted-foreground">Title: </span>{saveRecovery.submittedTitle}</div>
            )}
            {saveRecovery.submittedDescription !== undefined && (
              <div><span className="font-semibold text-muted-foreground">Description: </span>{saveRecovery.submittedDescription}</div>
            )}
          </div>
        </div>
      )}
        value={description}
        readOnly={pendingSaveId !== null || saveUncertain}
        onChange={(next) => {
          if (next !== descriptionRef.current) descriptionDirtyRef.current = true;
          setDescriptionDraft(next);
          clearSaveError();
          cancelPendingClose();
        }}
        onSave={save}
        onUploadImage={uploadDescriptionImage}
        previewImages={previewImages}
        onOpenImage={handleOpenAttachmentFromMarkdown}
        onPendingClose={pendingClose ? executePendingClose : undefined}
      />
    </div>
  );
  // A `div`, not a `section`: the e2e helpers locate board columns by
  // `section`, and the modal must not add one.
  const checklistSection = (
    <div data-testid="card-checklist-section" data-empty={items.length === 0} className="card-checklist-section flex flex-col gap-1 py-4 first:pt-0 last:pb-0">
      <div className="card-checklist-heading">
      <h3 className="card-section-title text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <SquareCheck aria-hidden="true" className="card-section-icon" />Checklist{items.length > 0 && ` ${doneCount}/${items.length}`}
      </h3>
      {items.length === 0 && !addingChecklistItem && newItem === "" && (
        <Button
          ref={checklistAddButtonRef}
          type="button"
          variant="outline"
          size="sm"
          className="card-checklist-reveal"
          onClick={() => {
            setAddingChecklistItem(true);
            requestAnimationFrame(() => checklistInputRef.current?.focus());
          }}
        >
          <Plus aria-hidden="true" className="size-4" />Add item
        </Button>
      )}
      </div>
      {items.length > 0 && (
        <div className="flex items-center gap-2 py-1">
          <span className="text-xs font-medium text-muted-foreground w-8 text-right">
            {checklistPercent}%
          </span>
          <div
            role="progressbar"
            aria-label="Checklist progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={checklistPercent}
            className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${checklistPercent}%` }}
            />
          </div>
        </div>
      )}
      <ul className="card-checklist-items flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id} className="group flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              aria-label={item.text}
              checked={item.done}
              disabled={editingId === item.id && checklistAttempts.edit.pending}
              onChange={() => commands.setChecklistDone(item.id, !item.done)}
              className="size-4 rounded border-input text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
            {editingId === item.id ? (
              <Input
                autoFocus
                // The modal's Escape listener sits on `window`; React dispatches
                // from the root container, so stopping propagation here keeps a
                // cancelled item edit from also closing the modal.
                data-checklist-edit
                aria-label="Edit checklist item text"
                readOnly={checklistAttempts.edit.pending}
                value={editText}
                onChange={(event) => {
                  setEditText(event.target.value);
                  clearChecklistError("edit");
                }}
                onBlur={() => { if (!checklistAttempts.edit.error) commitEdit(item); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitEdit(item);
                  }
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    if (checklistAttempts.edit.pending) return;
                    setEditingId(null);
                    restoreFocusSoon(() => document.querySelector<HTMLElement>(`[data-checklist-item-edit="${item.id}"]`));
                  }
                }}
                className="h-7 flex-1 bg-background px-2 py-0.5 text-base sm:text-sm"
              />
            ) : (
              <button
                type="button"
                data-checklist-item-edit={item.id}
                disabled={checklistAttempts.edit.pending || editingId !== null}
                aria-label={`Edit checklist item ${item.text}`}
                className={`flex-1 cursor-text break-words text-left ${
                  item.done ? "text-muted-foreground line-through" : "text-foreground"
                }`}
                onClick={() => {
                  setEditingId(item.id);
                  setEditText(item.text);
                  clearChecklistError("edit");
                }}
              >
                {item.text}
              </button>
            )}
            {card.taskType !== "subtask" && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Convert to card ${item.text}`}
                title="Convert to card"
                // The conversion lane is single-slot: while a conversion is pending
                // or a recovery is unresolved, its retry/discard pair is the only
                // conversion action any checklist item offers.
                disabled={convertLaneBusy || (editingId === item.id && checklistAttempts.edit.pending)}
                onClick={() => convertItem(item)}
                className="opacity-0 pointer-coarse:opacity-100 size-7 pointer-coarse:size-11 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-foreground"
              >
                <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete item ${item.text}`}
              disabled={editingId === item.id && checklistAttempts.edit.pending}
              onClick={() => commands.deleteChecklistItem(item.id)}
              className="opacity-0 pointer-coarse:opacity-100 size-7 pointer-coarse:size-11 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-destructive"
            >
              <X aria-hidden className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      {editedItemDeleted && <div className="flex flex-col gap-2">
        <p role="alert" className="text-xs text-destructive">This item was deleted. Your draft is preserved.</p>
        <Input aria-label="Preserved checklist edit" value={editText} readOnly={checklistAttempts.edit.pending} onChange={(event) => setEditText(event.target.value)} />
        <Button type="button" size="xs" disabled={checklistAttempts.edit.pending} onClick={() => sendChecklistText("edit")}>Save as new item</Button>
        <Button type="button" size="xs" variant="ghost" disabled={checklistAttempts.edit.pending} onClick={() => setEditingId(null)}>Discard checklist edit</Button>
      </div>}
      {checklistAttempts.edit.pending && <p role="status" className="text-xs text-muted-foreground">{checklistAttempts.edit.uncertain ? "Checking whether checklist edit completed…" : "Saving checklist edit…"}</p>}
      {editingId !== null && checklistAttempts.edit.error && <p role="alert" className="text-xs text-destructive">{checklistAttempts.edit.error}</p>}
      {(items.length > 0 || addingChecklistItem || newItem !== "") && <form className="card-checklist-add"
        onSubmit={(event) => {
          event.preventDefault();
          addItem();
        }}
      >
        <Input
          ref={checklistInputRef}
          value={newItem}
          readOnly={checklistAttempts.add.pending}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (items.length > 0 || newItem !== "") return;
            event.preventDefault();
            setAddingChecklistItem(false);
            restoreFocusSoon(() => checklistAddButtonRef.current);
          }}
          onChange={(event) => {
            setNewItem(event.target.value);
            clearChecklistError("add");
          }}
          aria-label="Add checklist item"
          placeholder="Add an item…"
          className="h-8 bg-card text-base sm:text-sm"
        />
        <Button type="submit" size="sm" aria-label="Add checklist item" disabled={checklistAttempts.add.pending || newItem.trim() === ""}>
          <Plus aria-hidden="true" className="size-4" />Add item
        </Button>
      </form>}
      {checklistAttempts.add.pending && <p role="status" className="text-xs text-muted-foreground">{checklistAttempts.add.uncertain ? "Checking whether checklist item was added…" : "Adding checklist item…"}</p>}
      {checklistAttempts.add.error && <p role="alert" className="text-xs text-destructive">{checklistAttempts.add.error}</p>}
      {convertError !== null && convertRecovery === null && (
        // The item is still here (the refused conversion never removed it), so
        // the error sits with the checklist it belongs to.
        <p role="alert" className="text-xs text-destructive">
          {convertError}
        </p>
      )}
      {convertRecovery !== null && (
        <div
          role="alert"
          className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
        >
          <div className="flex items-center justify-between gap-2 font-medium">
            <span>{convertRecovery.error}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={retryConvert}
                disabled={pendingConvertItemId !== null || convertUncertain}
                className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                {pendingConvertItemId !== null ? "Retrying…" : "Retry conversion"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={pendingConvertItemId !== null || convertUncertain}
                onClick={() => {
                  if (pendingConvertItemId !== null || convertUncertain) return;
                  convertOp.discard();
                }}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                Discard conversion attempt
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
  const subtasksSection = (
    // Also a `div`, for the same reason as the checklist above. The section is
    // always present: `Add subtask` is the only place a child can be created
    // directly, so it cannot be hidden behind already having one.
    <div data-testid="card-subtasks-section" data-empty={subtaskCounts.total === 0 && parentLink === undefined && !composingSubtask} className="card-subtasks-section flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="card-section-title text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Network aria-hidden="true" className="card-section-icon" />Subtasks
        </h3>
        {subtaskCounts.total > 0 && (
          <span className="text-xs text-muted-foreground">
            {subtaskCounts.done} of {subtaskCounts.total} done
          </span>
        )}
      </div>
      {parentLink !== undefined && (
        <div className="group flex items-center gap-2 text-sm text-foreground">
          <button
            type="button"
            aria-label={`Open parent ${cardTitle(cards, parentLink.sourceCardId)}`}
            onClick={() => navigate(parentLink.sourceCardId)}
            className="min-w-0 flex-1 truncate text-left hover:underline"
          >
            <span className="text-muted-foreground">Subtask of</span>{" "}
            <span className="font-medium text-foreground">{cardTitle(cards, parentLink.sourceCardId)}</span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove parent link ${cardTitle(cards, parentLink.sourceCardId)}`}
            onClick={() => commands.deleteRelation(parentLink.id)}
            className="opacity-0 pointer-coarse:opacity-100 size-7 pointer-coarse:size-11 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-destructive"
          >
            <X aria-hidden className="size-3.5" />
          </Button>
        </div>
      )}
      {subtaskCounts.total > 0 && (
        <div
          role="progressbar"
          aria-label="Subtask progress"
          aria-valuemin={0}
          aria-valuemax={subtaskCounts.total}
          aria-valuenow={subtaskCounts.done}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-success transition-[width] duration-200"
            style={{ width: `${subtaskPercent}%` }}
          />
        </div>
      )}
      {childNodes.length > 0 && (
        <SubtaskList
          nodes={childNodes}
          boardKey={boardKey}
          actions={{
            onOpen: navigate,
            onComplete: hasWorkflowRoles ? completeSubtask : undefined,
            onUnlink: (relationId: string) => commands.deleteRelation(relationId),
          }}
          // The child's own status, as plain text.
          statusLabel={(child: Card) =>
            columns.find((column) => column.id === child.columnId)?.title
          }
        />
      )}
      {card.taskType !== "subtask" && (
        composingSubtask ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            addSubtask();
          }}
        >
          <Input
            autoFocus
            aria-label="Subtask title"
            maxLength={200}
            placeholder="Subtask title…"
            value={subtaskDraft}
            readOnly={pendingSubtaskId !== null || subtaskUncertain}
            onChange={(event) => {
              // A submitted draft is held read-only until it settles; the title
              // the server received must not drift while it is in flight.
              if (pendingSubtaskId !== null || subtaskUncertain) return;
              setSubtaskDraft(event.target.value);
              clearSubtaskError();
              cancelPendingClose();
            }}
            onKeyDown={(event) => {
              // The modal's Escape listener sits on `window`; stopping here keeps
              // a cancelled composer from also closing the card.
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (subtaskDraft.trim() === "" && pendingSubtaskId === null && !subtaskUncertain) {
                  cancelSubtaskComposer();
                } else if (pendingSubtaskId === null && !subtaskUncertain) {
                  requestClose(() => cancelSubtaskComposer(true));
                }
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                addSubtask();
              }
            }}
            className="h-8 bg-background text-base sm:text-sm"
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={
                subtaskDraft.trim() === "" ||
                pendingSubtaskId !== null ||
                subtaskUncertain ||
                subtaskRecovery !== null
              }
              className="pointer-coarse:min-h-11 pointer-coarse:px-4"
            >
              {pendingSubtaskId !== null ? "Adding…" : "Add"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pendingSubtaskId !== null}
              onClick={() => cancelSubtaskComposer()}
              className="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-4"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={subtaskRecovery !== null}
          onClick={() => setComposingSubtask(true)}
          className="card-subtask-add self-start border-border text-foreground hover:bg-accent pointer-coarse:min-h-11 pointer-coarse:px-4"
        >
          <Plus aria-hidden="true" className="size-4" />Add subtask
        </Button>
        )
      )}
      {subtaskRecovery !== null && (
        <div
          role="alert"
          className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
        >
          <div className="flex items-center justify-between gap-2 font-medium">
            <span>{subtaskRecovery.error}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={retrySubtask}
                disabled={pendingSubtaskId !== null || subtaskUncertain}
                className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                {pendingSubtaskId !== null ? "Retrying…" : "Retry unsent subtask"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={pendingSubtaskId !== null || subtaskUncertain}
                onClick={() => {
                  if (pendingSubtaskId !== null || subtaskUncertain) return;
                  subtaskOp.discard();
                }}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                Discard unsent subtask
              </Button>
            </div>
          </div>
          <div className="rounded border border-border/50 bg-background/50 p-2 font-mono text-[11px] whitespace-pre-wrap break-words text-foreground">
            <span className="font-semibold text-muted-foreground">Unsent subtask: </span>
            {subtaskRecovery.rawDraft}
          </div>
        </div>
      )}
      {subtaskError !== null && (
        <div role="alert" className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>{subtaskError}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={addSubtask}
            className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
  // Keep secondary forms mounted so collapsing never drops their drafts.
  const relationsSection = (
    <details data-testid="card-relations-section" className="card-details-disclosure">
      <summary><h3><Link aria-hidden="true" className="card-section-icon" />Relations{views.length > 0 && ` ${views.length}`}</h3><ChevronDown aria-hidden="true" /></summary>
      <div className="card-sidebar-section card-disclosure-content flex flex-col gap-2">
      {views.length > 0 && (
        <ul className="flex flex-col gap-1">
          {views.map((view) => (
            <li
              key={view.relation.id}
              className="group flex items-center gap-2 text-sm text-foreground"
            >
              <button
                type="button"
                aria-label={`Open ${cardTitle(cards, view.otherCardId)}`}
                onClick={() => navigate(view.otherCardId)}
                className="min-w-0 flex-1 truncate text-left hover:underline"
              >
                <span className="text-muted-foreground">{view.label}</span>{" "}
                <span className="font-medium text-foreground">{cardTitle(cards, view.otherCardId)}</span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete relation ${view.label} ${cardTitle(cards, view.otherCardId)}`}
                onClick={() => commands.deleteRelation(view.relation.id)}
                className="opacity-0 pointer-coarse:opacity-100 size-7 pointer-coarse:size-11 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-destructive"
              >
                <X aria-hidden className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {composingRelation ? (
        <>
          <div className="flex items-center gap-2">
            <select
              aria-label="Relation kind"
              value={relationKind}
              onChange={(event) => setRelationKind(event.target.value as RelationOptionValue)}
              className="h-8 flex-1 rounded-md border border-input bg-card px-2 py-1 text-base sm:text-sm text-card-foreground shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {RELATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Input
              autoFocus
              aria-label="Link a card"
              value={relationQuery}
              onChange={(event) => setRelationQuery(event.target.value)}
              // Same reason as the checklist editor: the modal's Escape listener
              // sits on `window`, so both inner stages must stop here. Only once
              // the composer is gone does an Escape reach the modal.
              onKeyDown={(event) => {
                if (event.key === "Enter" && matches.length > 0) addRelation(matches[0].id);
                if (event.key === "Escape") {
                  event.stopPropagation();
                  if (relationQuery !== "") setRelationQuery("");
                  else setComposingRelation(false);
                }
              }}
              placeholder="Search by title or task ID…"
              className="h-8 flex-1 bg-background text-base sm:text-sm text-foreground"
            />
          </div>
          {relationQuery.trim() !== "" &&
            (matches.length === 0 ? (
              <div className="text-sm text-muted-foreground">No matching cards</div>
            ) : (
              <ul data-testid="relation-results" className="flex flex-col gap-1">
                {matches.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => addRelation(c.id)}
                      className="flex w-full items-center gap-2 truncate rounded-md px-2 py-1 text-left text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
                    >
                      {boardKey && c.taskNumber > 0 && (
                        <span className="shrink-0 text-xs font-medium text-muted-foreground select-none">
                          {boardKey}-{c.taskNumber}
                        </span>
                      )}
                      <span className="truncate">{c.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </>
      ) : (
        // Collapsed like the comment composer: linking is the rare act on
        // a card, and the picker is two controls wide.
        <Button
          type="button"
          aria-label="+ Link a card…"
          variant="secondary"
          size="sm"
          onClick={() => setComposingRelation(true)}
          className="w-full justify-start text-muted-foreground hover:text-foreground"
        >
          <Plus aria-hidden="true" className="size-4" />Link a card
        </Button>
      )}
      </div>
    </details>
  );
  const attachmentsSection = (
    <details data-testid="card-attachments-section" className="card-details-disclosure">
      <summary><h3><Paperclip aria-hidden="true" className="card-section-icon" />Attachments{attachments.length > 0 && ` ${attachments.length}`}</h3><ChevronDown aria-hidden="true" /></summary>
      <div className="card-sidebar-section card-disclosure-content flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {attachments.map((attachment) => {
          const url = `/boards/${boardId}/attachments/${attachment.id}`;
          const previewable = isPreviewableImageContentType(attachment.contentType);
          return (
            <li
              key={attachment.id}
              className="group flex items-center gap-2 text-sm text-foreground"
            >
              {previewable ? (
                // A button, not a link out: the image opens in the viewer below,
                // which keeps the card (and its drafts) on screen.
                <button
                  type="button"
                  aria-label={`Preview attachment ${attachment.fileName}`}
                  onClick={(event) => {
                    lastAttachmentTriggerRef.current = event.currentTarget;
                    onOpenAttachment(attachment.id, event.currentTarget);
                  }}
                  className="shrink-0"
                >
                  <img
                    src={url}
                    alt={attachment.fileName}
                    className="h-10 w-10 rounded-md border border-border object-cover"
                  />
                </button>
              ) : (
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50"
                >
                  <File aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                </span>
              )}
              {previewable ? (
                <span className="min-w-0 flex-1 truncate">{attachment.fileName}</span>
              ) : (
                <a
                  href={url}
                  download={attachment.fileName}
                  aria-label={`Download attachment ${attachment.fileName}`}
                  className="min-w-0 flex-1 truncate underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
                >
                  {attachment.fileName}
                </a>
              )}
              <span className="text-xs text-muted-foreground">
                {Math.max(1, Math.round(attachment.size / 1024))} KB
              </span>
              {confirmingAttachmentId === attachment.id ? (
                <span
                  role="group"
                  aria-label={`Confirm delete attachment ${attachment.fileName}`}
                  className="flex shrink-0 items-center gap-1"
                >
                  <span className="text-xs text-destructive">Delete?</span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="xs"
                    onClick={() => {
                      if (commands.deleteAttachment(attachment.id) === "sent") setConfirmingAttachmentId(null);
                    }}
                    className="h-6 px-1.5 py-0 text-xs"
                  >
                    Delete
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setConfirmingAttachmentId(null)}
                    className="h-6 px-1.5 py-0 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete attachment ${attachment.fileName}`}
                  onClick={() => setConfirmingAttachmentId(attachment.id)}
                  className="opacity-0 pointer-coarse:opacity-100 size-7 pointer-coarse:size-11 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 text-muted-foreground hover:text-destructive"
                >
                  <X aria-hidden className="size-3.5" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label="+ Attach file"
        disabled={upload.isPending}
        onClick={() => attachInput.current?.click()}
        className="w-full justify-start text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <Plus aria-hidden="true" className="size-4" />Attach file
      </Button>
      <input
        ref={attachInput}
        data-testid="attach-input"
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so picking the same file again still fires a change event.
          event.target.value = "";
          // Attach-only: nothing is spliced into the description here.
          if (file) upload.mutate({ file });
        }}
      />
      {upload.error && <p className="mt-1 text-xs text-destructive">{upload.error.message}</p>}
      </div>
    </details>
  );
  const membersById = useMemo(
    () => new Map(members.map((member) => [member.id, member])),
    [members],
  );
  const activityRows = useMemo((): ActivityTimelineItem[] => {
    const oldestFirst =
      activityView === "all"
        ? activityTimeline(comments, activities)
        : activityView === "comments"
          ? activityTimeline(comments, [])
          : activityTimeline([], activities);
    if (activitySortOrder === "desc") {
      return [...oldestFirst].reverse();
    }
    return oldestFirst;
  }, [activityView, comments, activities, activitySortOrder]);
  const activeCommentCount = useMemo(
    () => comments.filter((comment) => !comment.deleted).length,
    [comments],
  );
  const activityCounts: Record<ActivityView, number> = {
    all: activeCommentCount + activities.length,
    comments: activeCommentCount,
    history: activities.length,
  };
  const emptyActivityCopy =
    activityView === "all"
      ? "No activity yet."
      : activityView === "comments"
        ? "No comments yet."
        : "No history yet.";
  const renderReplyComposer = (rootId: string) => (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-xs">
      {replyError && (
        <div role="alert" className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>{replyError}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => submitReply(rootId)}
            className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
          >
            Retry
          </Button>
        </div>
      )}
      <MarkdownEditor
        value={replyDraft}
        readOnly={pendingReplyId !== null || replyUncertain}
        onChange={(val) => {
          setReplyDraft(val);
          replyDraftRef.current = val;
          clearReplyError();
        }}
        onSubmit={() => submitReply(rootId)}
        onEscape={cancelReplyComposer}
        onUploadImage={uploadReplyImage}
        ariaLabel="Comment"
        rows={4}
        imageInputTestId="comment-image-input"
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => submitReply(rootId)}
          disabled={replyDraft.trim() === "" || replyUploading || pendingReplyId !== null || replyUncertain || replyRecovery !== null}
          className="pointer-coarse:min-h-11 pointer-coarse:px-4"
        >
          {pendingReplyId !== null ? "Sending…" : "Reply"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={replyUploading}
          onClick={() => cancelReplyComposer()}
          className="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-4"
        >
          Cancel
        </Button>
      </div>
    </div>
  );

  const activitySection = (
    <div className="flex min-w-0 flex-col gap-3">
      <h3 className="card-section-title text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <MessageSquare aria-hidden="true" className="card-section-icon" />Activity
      </h3>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Activity view" className="flex flex-wrap gap-1">
          {ACTIVITY_TABS.map((tab) => {
            const selected = activityView === tab.view;
            return (
              <button
                key={tab.view}
                id={`card-activity-${tab.view}-tab`}
                ref={(element) => {
                  activityTabRefs.current[tab.view] = element;
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="card-activity-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => setActivityView(tab.view)}
                onKeyDown={(event) => onActivityTabKeyDown(event, tab.view)}
                className={cn(
                  "whitespace-nowrap rounded-md border px-2 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  selected
                    ? "border-input bg-card font-medium text-foreground shadow-xs"
                    : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {tab.label} · {activityCounts[tab.view]}
              </button>
            );
          })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={
            activitySortOrder === "asc"
              ? "Sort activity by date: Oldest first"
              : "Sort activity by date: Newest first"
          }
          onClick={() =>
            setActivitySortOrder((current) =>
              current === "asc" ? "desc" : "asc",
            )
          }
        >
          {activitySortOrder === "asc" ? (
            <CalendarArrowUp aria-hidden className="size-4" />
          ) : (
            <CalendarArrowDown aria-hidden className="size-4" />
          )}
          {activitySortOrder === "asc" ? "Oldest first" : "Newest first"}
        </Button>
      </div>
      <div
        id="card-activity-panel"
        role="tabpanel"
        aria-labelledby={`card-activity-${activityView}-tab`}
        className="flex min-w-0 flex-col gap-2"
      >
        {activityRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyActivityCopy}</p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            <ul className="flex min-w-0 flex-col gap-2">
            {activityRows.map((item) => {
              if (item.kind === "history") {
                const actor = membersById.get(item.activity.actorId) ?? null;
                const createdAtDate = new Date(item.createdAt);
                const isCreatedAtValid = !Number.isNaN(createdAtDate.getTime());
                return (
                  <li
                    key={item.key}
                    className="flex min-w-0 items-start gap-2 text-sm text-foreground"
                  >
                    {actor ? (
                      <Avatar name={actor.name} githubLogin={actor.githubLogin} />
                    ) : (
                      <span aria-hidden="true" className="size-5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <span className="sr-only">History entry: </span>
                      <p className="min-w-0 [overflow-wrap:anywhere] text-foreground">
                        <span className="min-w-0 [overflow-wrap:anywhere] font-medium">{actor?.name ?? "former member"}</span>{" "}
                        {activitySentence(item.activity.detail, members)}
                      </p>
                      <time
                        {...(isCreatedAtValid ? { dateTime: createdAtDate.toISOString() } : {})}
                        className="text-xs text-muted-foreground"
                      >
                        {isCreatedAtValid ? createdAtDate.toLocaleString() : "Invalid date"}
                      </time>
                    </div>
                  </li>
                );
              }

              const { comment, replies } = item;

              const renderCommentRow = (c: Comment) => {
                const cAuthor = membersById.get(c.authorId) ?? null;
                const cCreatedAtDate = new Date(c.createdAt);
                const cIsCreatedAtValid = !Number.isNaN(cCreatedAtDate.getTime());

                if (c.deleted) {
                  return (
                    <div
                      key={c.id}
                      data-comment-id={c.id}
                      className="group flex min-w-0 items-start gap-2 text-sm text-foreground"
                    >
                      <span aria-hidden="true" className="size-5 shrink-0" />
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-xs italic text-muted-foreground">
                        Comment deleted
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={c.id}
                    data-comment-id={c.id}
                    className="group flex min-w-0 items-start gap-2 text-sm text-foreground"
                  >
                    {cAuthor ? (
                      <Avatar name={cAuthor.name} githubLogin={cAuthor.githubLogin} />
                    ) : (
                      <span aria-hidden="true" className="size-5 shrink-0" />
                    )}
                    <div className="card-comment-content flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border border-border bg-card p-3 shadow-xs">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="sr-only">Comment by </span>
                        <span className="min-w-0 [overflow-wrap:anywhere] font-medium">
                          {cAuthor?.name ?? "former member"}
                        </span>
                        <time
                          {...(cIsCreatedAtValid ? { dateTime: cCreatedAtDate.toISOString() } : {})}
                          className="text-xs text-muted-foreground"
                          title={cIsCreatedAtValid ? cCreatedAtDate.toLocaleString() : "Invalid date"}
                          aria-label={cIsCreatedAtValid ? cCreatedAtDate.toLocaleString() : "Invalid date"}
                        >
                          {cIsCreatedAtValid ? cCreatedAtDate.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            ...(cCreatedAtDate.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
                          }) : "Invalid date"}
                        </time>
                        {c.updatedAt > c.createdAt && (
                          <span className="text-xs text-muted-foreground">(edited)</span>
                        )}
                        <span className="flex-1" />
                        {me !== null && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Reply to comment"
                            ref={(el) => {
                              replyButtonRefs.current[c.id] = el;
                            }}
                            disabled={replyUploading || orphanedReply !== null}
                            onClick={() => startReply(c)}
                            className="size-7 pointer-coarse:size-11 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                          >
                            <Reply aria-hidden className="size-3.5" />
                          </Button>
                        )}
                        {/* Legacy comment permissions remain UI-only (ADR 0029). */}
                        {me?.id === c.authorId && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Edit comment"
                            disabled={pendingCommentEditId !== null || commentUploading}
                            onClick={() => {
                              if (pendingCommentEditIdRef.current !== null || commentUploadingRef.current) return;
                              if (editingCommentIdRef.current === c.id) return;
                              if (commentEditHasWorkRef.current) {
                                requestClose(() => { setEditingCommentId(c.id); setEditCommentDraft(c.body); setEditCommentBaseline(c.body); clearCommentEditError(); });
                                return;
                              }
                              setEditingCommentId(c.id);
                              setEditCommentDraft(c.body);
                              setEditCommentBaseline(c.body);
                              clearCommentEditError();
                            }}
                            className="size-7 pointer-coarse:size-11 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                          >
                            <Pencil aria-hidden className="size-3.5" />
                          </Button>
                        )}
                        {me !== null && (me.id === c.authorId || me.isAdmin) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Delete comment"
                            disabled={editingCommentId === c.id}
                            onClick={() => commands.deleteComment(c.id)}
                            className="size-7 pointer-coarse:size-11 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
                          >
                            <X aria-hidden className="size-3.5" />
                          </Button>
                        )}
                      </div>
                      {editingCommentId === c.id ? (
                        <div className="flex min-w-0 flex-col gap-2">
                          <MarkdownEditor
                            value={editCommentDraft}
                            onChange={setEditCommentDraft}
                            onSubmit={saveCommentEdit}
                            onEscape={cancelCommentEdit}
                            readOnly={pendingCommentEditId !== null}
                            onUploadImage={uploadEditedCommentImage}
                            ariaLabel="Comment"
                            rows={4}
                            imageInputTestId="comment-image-input"
                          />
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="default"
                              size="sm"
                              onClick={saveCommentEdit}
                              disabled={editCommentDraft.trim() === "" || commentUploading || pendingCommentEditId !== null}
                              className="pointer-coarse:min-h-11 pointer-coarse:px-4"
                            >
                              Save comment
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={cancelCommentEdit}
                              disabled={commentUploading || pendingCommentEditId !== null}
                              className="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-4"
                            >
                              Cancel
                            </Button>
                          </div>
                          {commentEditError && <p role="alert" className="text-xs text-destructive">{commentEditError}</p>}
                          {pendingCommentEditId !== null && <p role="status" className="text-xs text-muted-foreground">{commentEditUncertain ? "Checking whether comment edit completed…" : "Saving comment…"}</p>}
                          {commentUploading && (
                            <p role="status" className="text-xs text-muted-foreground">
                              Converting and uploading image…
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="prose prose-sm min-w-0 max-w-none break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
                          <MarkdownContent
                            value={c.body}
                            previewImages={previewImages}
                            onOpenImage={handleOpenAttachmentFromMarkdown}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              };

              return (
                <li key={item.key} className="flex min-w-0 flex-col gap-2">
                  {renderCommentRow(comment)}
                  {replyRecovery && replyRecovery.parentCommentId === comment.id && (
                    <div className="pl-7">
                      <div
                        role="alert"
                        className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
                      >
                        <div className="flex items-center justify-between gap-2 font-medium">
                          <span>{replyRecovery.error}</span>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={retryReplyRecovery}
                              disabled={replyUploading || pendingReplyId !== null || replyUncertain}
                              className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
                            >
                              {pendingReplyId !== null ? "Retrying…" : "Retry unsent reply"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              disabled={pendingReplyId !== null || replyUncertain}
                              onClick={() => {
                                if (pendingReplyId !== null || replyUncertain) return;
                                replyOp.discard();
                              }}
                              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
                            >
                              Discard unsent reply
                            </Button>
                          </div>
                        </div>
                        <div className="rounded border border-border/50 bg-background/50 p-2 text-foreground font-mono text-[11px] whitespace-pre-wrap break-words">
                          <span className="font-semibold text-muted-foreground">Unsent reply: </span>
                          {replyRecovery.rawDraft}
                        </div>
                      </div>
                    </div>
                  )}
                  {replyingCommentId === comment.id && (
                    <div className="pl-7">
                      {renderReplyComposer(comment.id)}
                    </div>
                  )}
                  {replies.length > 0 && (
                    <div className="flex min-w-0 flex-col gap-2 pl-7">
                      {replies.map((reply) => (
                        <div key={reply.id} className="flex min-w-0 flex-col gap-2">
                          {renderCommentRow(reply)}
                          {replyingCommentId === reply.id && (
                            <div className="pl-7">
                              {renderReplyComposer(comment.id)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
            </ul>
          </div>
        )}
        {replyingCommentId !== null && !comments.some((c) => c.id === replyingCommentId && !c.deleted) && replyUploading && (
          <div className="pl-7">
            {renderReplyComposer(replyingCommentId)}
          </div>
        )}
        {editedCommentDeleted && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
            <span>Edited comment was deleted. Your draft is preserved.</span>
            <Textarea aria-label="Preserved comment edit" readOnly value={editCommentDraft} rows={4} className="w-full rounded border border-border bg-background p-2 font-mono text-foreground" />
            <div className="flex gap-2">
              <Button
                type="button" variant="outline" size="xs"
                disabled={commentUploading || pendingCommentEditId !== null || pendingCommentId !== null || commentUncertain || commentRecovery !== null}
                onClick={() => {
                  setCommentDraft((draft) => draft !== "" ? `${draft}\n\n${editCommentDraft}` : editCommentDraft);
                  setComposingComment(true);
                  cancelCommentEdit();
                }}
              >Move to comment</Button>
              <Button type="button" variant="ghost" size="xs" disabled={commentUploading || pendingCommentEditId !== null} onClick={cancelCommentEdit}>Discard edit</Button>
            </div>
            {commentUploading && <p role="status">Uploading image into preserved draft…</p>}
            {pendingCommentEditId !== null && <p role="status">{commentEditUncertain ? "Checking whether comment edit completed…" : "Saving comment…"}</p>}
            {commentEditError && <p>{commentEditError}</p>}
          </div>
        )}
        {orphanedReply && (
          <div
            role="alert"
            className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
          >
            <div className="flex items-center justify-between gap-2 font-medium">
              <span>Target comment was deleted by a peer. Reply draft preserved (image placed at end):</span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={
                    pendingCommentId !== null ||
                    commentUncertain ||
                    commentUploading ||
                    commentRecovery !== null
                  }
                  onClick={() => {
                    if (
                      pendingCommentId !== null ||
                      commentUncertain ||
                      commentUploading ||
                      commentRecovery !== null
                    ) return;
                    setCommentDraft((prev) => (prev.trim() !== "" ? `${prev}\n\n${orphanedReply.text}` : orphanedReply.text));
                    setComposingComment(true);
                    setOrphanedReply(null);
                  }}
                  className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
                >
                  Move to comment
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setOrphanedReply(null);
                  }}
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-3"
                >
                  Discard
                </Button>
              </div>
            </div>
            <div className="rounded border border-border/50 bg-background/50 p-2 text-foreground font-mono text-[11px] whitespace-pre-wrap break-words">
              {orphanedReply.text}
            </div>
          </div>
        )}
        {activityView !== "history" &&
          me !== null && (
            <div className="card-comment-composer-row flex min-w-0 items-start gap-2" data-expanded={composingComment || commentRecovery !== null || commentError !== null || commentUploading || pendingCommentId !== null || commentUncertain}>
              <Avatar name={me.name} githubLogin={me.githubLogin} userId={me.id} avatarVersion={me.avatarVersion} />
              <div className="min-w-0 flex-1">
                  <div className="card-comment-composer flex min-w-0 flex-col gap-2">
                    {commentRecovery && (
                      <div
                        role="alert"
                        className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
                      >
                        <div className="flex items-center justify-between gap-2 font-medium">
                          <span>{commentRecovery.error}</span>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={retryCommentRecovery}
                              disabled={commentUploading || pendingCommentId !== null || commentUncertain}
                              className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
                            >
                              {pendingCommentId !== null ? "Retrying…" : "Retry unsent comment"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              disabled={pendingCommentId !== null || commentUncertain}
                              onClick={() => {
                                if (pendingCommentId !== null || commentUncertain) return;
                                commentOp.discard();
                              }}
                              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3"
                            >
                              Discard unsent comment
                            </Button>
                          </div>
                        </div>
                        <div className="rounded border border-border/50 bg-background/50 p-2 text-foreground font-mono text-[11px] whitespace-pre-wrap break-words">
                          <span className="font-semibold text-muted-foreground">Unsent comment: </span>
                          {commentRecovery.rawDraft}
                        </div>
                      </div>
                    )}
                    {commentError && (
                      <div role="alert" className="flex items-center justify-between gap-2 text-xs text-destructive">
                        <span>{commentError}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={submitComment}
                          className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
                        >
                          Retry
                        </Button>
                      </div>
                    )}
                    <MarkdownEditor
                      autoFocus={false}
                      feedbackResetToken={commentFeedbackResetToken}
                      compact={!composingComment && !commentRecovery && !commentError && !commentUploading && pendingCommentId === null && !commentUncertain}
                      placeholder="Add a comment…"
                      onFocus={() => setComposingComment(true)}
                      onClick={() => setComposingComment(true)}
                      value={commentDraft}
                      readOnly={pendingCommentId !== null || commentUncertain}
                      onChange={(val) => {
                        setComposingComment(true);
                        setCommentDraft(val);
                        commentDraftRef.current = val;
                        clearCommentError();
                      }}
                      onSubmit={submitComment}
                      onEscape={composingComment || commentUploading ? cancelComposer : undefined}
                      onUploadImage={uploadCommentImage}
                      ariaLabel={composingComment ? "Comment" : "Add a comment"}
                      rows={4}
                      imageInputTestId="comment-image-input"
                    />
                    <div className="card-comment-actions flex gap-2">
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={submitComment}
                        disabled={commentDraft.trim() === "" || commentUploading || pendingCommentId !== null || commentUncertain || commentRecovery !== null}
                        className="pointer-coarse:min-h-11 pointer-coarse:px-4"
                      >
                        {pendingCommentId !== null ? "Sending…" : "Comment"}
                      </Button>
                      {composingComment && <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={commentUploading || pendingCommentId !== null || commentUncertain}
                        onClick={() => cancelComposer()}
                        className="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-4"
                      >
                        Cancel
                      </Button>}
                    </div>
                  </div>
              </div>
            </div>
          )}
      </div>
    </div>
  );
  // Header and footer sit outside the scroll region: the title and Save must
  // stay reachable however long the comment thread grows. Their borders always
  // span the shell; in full view an inner wrapper caps their content on the
  // same centred column the body uses.
  const rowClass =
    view === "full"
      ? "mx-auto flex w-full max-w-6xl items-center gap-2"
      : "flex w-full items-center gap-2";
  const header = (
    <div className="card-detail-header shrink-0 border-b border-border bg-card p-3 md:p-4 md:pb-3 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] md:pt-4">
      <div className={cn(rowClass, "items-start gap-2")}>
        {/* Keep actions beside the title, with the task key above it on phones. */}
        <div className="card-title-group flex min-w-0 flex-1 flex-col items-start gap-1">
            <div className="card-detail-eyebrow flex shrink-0 flex-wrap items-center gap-2">
              {boardKey && card.taskNumber > 0 && <span className="font-mono select-none">
                {taskKey(boardKey, card.taskNumber)}
              </span>}
              <span className="card-detail-type"><span aria-hidden="true" className={`size-2 shrink-0 rounded-sm ${TASK_TYPE_META[card.taskType].swatch}`} />{TASK_TYPE_META[card.taskType].label}</span>
              {titleHasChanges && pendingSaveId === null && !saveUncertain && <span className="card-text-draft-badge">Unsaved</span>}
            </div>
          {editingTitle ? (
            <Input
              autoFocus
              aria-label="Card title"
              value={title}
              readOnly={pendingSaveId !== null || saveUncertain}
              aria-disabled={pendingSaveId !== null || saveUncertain}
              onChange={(event) => {
                if (pendingSaveId !== null || saveUncertain) return;
                titleDirtyRef.current = true;
                setTitle(event.target.value);
                cancelPendingClose();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  save();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditingTitle(false);
                  requestAnimationFrame(() => editTitleButtonRef.current?.focus());
                }
              }}
              className="card-detail-title-input h-10 w-full min-w-0 flex-1 bg-transparent text-xl sm:text-xl font-semibold text-foreground"
            />
          ) : (
            <div className="flex w-full min-w-0 flex-1 items-start gap-1">
              <h2 className="card-detail-title min-w-0 flex-1 break-words text-xl font-semibold leading-snug text-foreground">
                {title.trim() || card.title}
              </h2>

            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-1 md:gap-2">
          {!editingTitle && (
              <Button
                ref={editTitleButtonRef}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Edit title"
                title="Edit title"
                disabled={pendingSaveId !== null || saveUncertain}
                aria-disabled={pendingSaveId !== null || saveUncertain}
                onClick={() => setEditingTitle(true)}
                className="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                <Pencil aria-hidden className="size-3.5" />
              </Button>
          )}
          <CardActionsMenu
            triggerRef={actionsMenuTriggerRef}
            onTransfer={() => setTransferDialogOpen(true)}
          />
          {/* Fullscreen toggle is hidden below md because both modal and full view are full viewport on phone */}
          {view === "modal" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Open full screen"
              title="Open full screen"
              onClick={() => onViewChange("full")}
              className="hidden md:inline-flex text-muted-foreground hover:text-foreground pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              <Maximize2 aria-hidden className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Exit full screen"
              title="Exit full screen"
              onClick={() => onViewChange("modal")}
              className="hidden md:inline-flex text-muted-foreground hover:text-foreground pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              <Minimize2 aria-hidden className="size-4" />
            </Button>
          )}
        <Button
          ref={closeCardButtonRef}
          type="button"
          variant="ghost"
          size="icon"
          autoFocus={!editingTitle}
          aria-label="Close card"
          onClick={() => requestClose(onClose)}
          className="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          <X aria-hidden className="size-4" />
        </Button>
      </div>
    </div>
  </div>
  );
  const footer = (
    <div className="shrink-0 border-t border-border bg-card p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] md:pb-3">
      <div className={cn(rowClass, "flex-col md:flex-row gap-2")}>
        {pendingClose !== null ? (
          <div className="flex w-full flex-col md:flex-row md:items-center gap-2">
            {/* Inline, not `window.confirm`: the prompt belongs to the panel,
                and a native dialog would steal the Escape ladder. */}
            <div className="min-w-0 text-sm text-foreground">
              <p>{pullRequestLink.phase === "idle"
                ? "Discard unsaved changes?"
                : "A pull request link is still being saved. Leaving will not cancel it."}</p>
              <p className="mt-1 text-xs text-muted-foreground">Changes already saved will stay.</p>
              {submittedWorkPending && <p className="mt-1 text-xs text-muted-foreground">Leaving won’t cancel changes already submitted.</p>}
            </div>
            <div className="flex w-full md:w-auto md:ml-auto items-center gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => executePendingClose()}
                className="flex-1 md:flex-initial min-h-11 md:min-h-8 pointer-coarse:min-h-11 md:pointer-coarse:min-h-11"
              >
                Discard
              </Button>
              <Button
                ref={keepEditingButtonRef}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => cancelPendingClose()}
                className="flex-1 md:flex-initial min-h-11 md:min-h-8 pointer-coarse:min-h-11 md:pointer-coarse:min-h-11"
              >
                Keep editing
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex w-full flex-col md:flex-row md:items-center gap-2">
            {saveError && connected && !attachmentDeletePending ? (
              <span id={textSaveStatusId} role="alert" className="text-sm font-medium text-destructive">
                {saveError}
              </span>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span
                  id={textSaveStatusId}
                  role="status"
                  className={
                    !connected
                      ? "font-medium text-destructive"
                      : (saveUncertain || commentUncertain || replyUncertain)
                        ? "font-medium text-destructive"
                        : dirty
                          ? "font-medium text-warning"
                          : "text-muted-foreground"
                  }
                >
                  {connected && !dirty && !attachmentDeletePending && !descriptionUploading && pendingSaveId === null && !saveUncertain && !commentUncertain && !replyUncertain && (
                    <Check aria-hidden="true" className="card-text-clean-icon" />
                  )}
                  {!connected
                    ? handshakeFailed
                      ? "Could not connect."
                      : "Not connected — changes won't send."
                    : (saveUncertain || commentUncertain || replyUncertain)
                      ? "Sync uncertain — reconnecting to verify."
                      : attachmentDeletePending
                        ? "Deleting attachment…"
                        : pendingSaveId !== null
                          ? "Saving…"
                          : descriptionUploading
                            ? "Preparing description image…"
                            : hasTextChanges
                              ? unsavedTextMessage
                            : pullRequestLink.hasWork
                              ? "Pull request link saves with Link pull request."
                              : draftingDirty
                                ? "Other drafts have their own save actions."
                                : "Title and description are up to date."}
                </span>
                {!connected && handshakeFailed && onRetryConnection && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={onRetryConnection}
                    className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
                  >
                    Retry
                  </Button>
                )}
              </div>
            )}
            <span className="hidden md:block md:flex-1" />
            <div className="card-text-save-actions">
              <Button
                ref={footerCloseButtonRef}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => requestClose(onClose)}
                className="min-h-11 md:min-h-8 pointer-coarse:min-h-11"
              >Close</Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                aria-describedby={textSaveStatusId}
                onClick={save}
                disabled={!hasTextChanges || attachmentDeletePending || descriptionUploading || pendingSaveId !== null || saveUncertain || saveRecovery !== null}
                className="min-h-11 md:min-h-8 pointer-coarse:min-h-11"
              >
                {pendingSaveId !== null ? "Saving…" : "Save title & description"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
  // A shared phone scroll keeps essentials first; desktop panes scroll
  // independently. Keeping the main pane in reading order retains editors and
  // keyboard navigation when the viewport changes.
  const bodyClass = cn("card-detail-body", view === "full" && "mx-auto max-w-6xl");
  const body = (
    <div className={bodyClass}>
      <div className="card-detail-details-pane">
        <div data-testid="card-essentials" className="card-detail-essentials">
          <h3 className="card-details-heading">Details</h3>
          <p className="card-details-save-hint">{connected ? "Changes here save automatically." : "Automatic saving is unavailable offline."}</p>
          {metadataSection}
        </div>
        <div className="card-detail-main flex min-w-0 flex-col">
          <div className="card-detail-sections flex flex-col divide-y divide-border p-4">
            {descriptionSection}
            {checklistSection}
            {subtasksSection}
          </div>
          <div className="card-detail-activity min-w-0 flex-1 border-t border-border p-4">
            {activitySection}
          </div>
        </div>
        <div
          data-testid="card-sidebar"
          className="card-detail-sidebar flex min-w-0 flex-col"
        >
          {labelsSection}
          {contributorsSection}
          <details className="card-details-disclosure" open={hasConnectedRepos || developmentPullRequests.length > 0 || developmentBranches.length > 0}>
            <summary tabIndex={0}><h3><GitBranch aria-hidden="true" className="card-section-icon" />Development</h3><ChevronDown aria-hidden="true" /></summary>
            <div className="card-disclosure-content">
          <CardDevelopment
            boardId={boardId}
            cardId={card.id}
            pullRequests={developmentPullRequests}
            branches={developmentBranches}
            link={pullRequestLink}
            onEdit={() => setPendingClose(null)}
          />
            </div>
          </details>
          {relationsSection}
          {attachmentsSection}
          {/* Deletion lives here, not on the card front: one confirm step, inline
              for the same reason the discard prompt is (the Escape ladder). */}
          <div className="py-4 first:pt-0 last:pb-0">
            {confirmingDelete ? (
              <div className="flex flex-col gap-2 text-sm">
                <span className="text-destructive">
                  Delete this card? It, its subtasks, and everything on them will be kept in Archived
                  cards for 90 days, then permanently deleted.
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      // Not sent when disconnected: nothing happened, so the dialog
                      // stays open. On success the optimistic removal unmounts it.
                      if (commands.deleteCard(card.id) === "sent") onClose();
                    }}
                  >
                    Delete
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmingDelete(true)}
                className="w-full justify-start border-transparent bg-muted/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                Delete card
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  // The image viewer: a dialog of its own above either shell (`z-20` over their
  // `z-10`), so the card stays mounted underneath with its drafts intact. A
  // missing or non-image attachment renders nothing while the caller scrubs it
  // out of the URL.
  const previewed = attachments.find(
    (candidate) =>
      candidate.id === openAttachmentId &&
      isPreviewableImageContentType(candidate.contentType),
  );
  const previewUrl = previewed && `/boards/${boardId}/attachments/${previewed.id}`;
  const viewer = previewed && (
    <div
      ref={viewerRef}
      role="dialog"
      aria-modal="true"
      aria-label={previewed.fileName}
      className="fixed inset-0 z-20 flex h-dvh flex-col bg-foreground/95 text-background backdrop-blur-sm pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]"
    >
      <div className="mx-auto flex w-full max-w-5xl items-center gap-2 border-b border-background/20 p-3 text-background">
        <span className="min-w-0 flex-1 truncate text-sm">{previewed.fileName}</span>
        <span className="text-xs text-background/70">
          {Math.max(1, Math.round(previewed.size / 1024))} KB
        </span>
        {/* Raw access is still one click away, for saving or zooming natively. */}
        <a
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-md px-2 py-1 text-sm text-background/70 underline hover:text-background pointer-coarse:min-h-11 pointer-coarse:inline-flex pointer-coarse:items-center"
        >
          Open original
        </a>
        <Button
          ref={viewerCloseButtonRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close preview"
          onClick={onCloseAttachment}
          className="text-background/70 hover:bg-background/10 hover:text-background pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      {/* The dark surround closes; nothing here is selectable, so unlike the
          modal backdrop this needs no press-origin guard. */}
      <div
        className="flex flex-1 items-center justify-center overflow-hidden p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onCloseAttachment();
        }}
      >
        <img
          src={previewUrl}
          alt={previewed.fileName}
          className="max-h-full max-w-full rounded-md object-contain shadow-dialog"
        />
      </div>
    </div>
  );

  // Full screen: no backdrop to dismiss — the surface IS the viewport — but
  // still the same dialog, over the same `inert` board, so the role stays.
  const transferDialog = transferDialogOpen ? (
    <TransferCardDialog
      boardId={boardId}
      cardId={card.id}
      hasLinksOrSubtasks={relations.length > 0}
      isDirty={dirty}
      isAttachmentPending={attachmentDeletePending}
      onCancel={() => {
        setTransferDialogOpen(false);
      }}
      onSuccess={(destBoardId, destBoardKey, destCardId, destTaskNumber) => {
        setTransferDialogOpen(false);
        onTransferSuccess?.(destBoardId, destBoardKey, destCardId, destTaskNumber);
      }}
    />
  ) : null;
  if (view === "full") {
    return (
      <>
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label={card.title}
          inert={transferDialogOpen || openAttachmentId !== undefined}
          className="card-detail-shell fixed inset-0 z-10 flex h-dvh flex-col bg-card text-card-foreground"
        >
          {header}
          {body}
          {footer}
        </div>
        {viewer}
        {transferDialog}
      </>
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 z-10 flex items-start justify-center bg-overlay md:p-8"
        onMouseDown={(event) => {
          pressedBackdrop.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          if (!pressedBackdrop.current) return;
          // The second click of a double-click on the card lands here, because the
          // overlay went up under the pointer after the first one.
          if (event.detail > 1) return;
          requestClose(onClose);
        }}
      >
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label={card.title}
          inert={transferDialogOpen || openAttachmentId !== undefined}
          className="card-detail-shell flex h-dvh w-full max-w-6xl flex-col bg-card text-card-foreground shadow-dialog md:h-auto md:max-h-[calc(100dvh-4rem)] md:rounded-lg md:border md:border-border"
        >
          {header}
          {body}
          {footer}
        </div>
      </div>
      {viewer}
      {transferDialog}
    </>
  );
}
