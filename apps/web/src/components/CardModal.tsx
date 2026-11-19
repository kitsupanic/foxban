import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AlignLeft,
  Check,
  ChevronDown,
  File,
  GitBranch,
  Paperclip,
  Plus,
  Users,
  Maximize2,
  Minimize2,
  Pencil,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { boardQueryKey } from "../lib/board-cache";
import { Input } from "./ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isPreviewableImageContentType,
  type Activity,
  type Attachment,
  type Card,
  type CardRelation,
  type ChecklistItem,
  type Column,
  type Comment,
  type Label,
  type Priority,
  type SubtaskHierarchy,
  type TaskType,
} from "@foxban/shared";
import type { Member } from "../lib/api";
import { cardActivityQueryOptions, cardAssigneeHistory, cardCreatorId } from "../lib/activity";
import type { SendMutation, MutationSettledCallback } from "../lib/socket";
import { useAttachmentView, type BoardAttachments } from "../lib/attachments";
import { type BoardState, type CardLabelView } from "../lib/apply-mutation";
import { useBoardCommands } from "../lib/board-commands";
import { taskKey } from "../lib/task-key";
import { meQuery } from "../lib/auth";
import { Avatar } from "./Avatar";
import { AssigneePicker } from "./AssigneePicker";
import { PriorityPicker } from "./PriorityPicker";
import { TaskTypePicker } from "./TaskTypePicker";
import { StatusPicker } from "./StatusPicker";
import { CardActionsMenu } from "./CardActionsMenu";
import { TransferCardDialog } from "./TransferCardDialog";
import { DescriptionEditor } from "./DescriptionEditor";
import { CardDevelopment } from "./CardDevelopment";
import { CardChecklist } from "./CardChecklist";
import { CardSubtasks } from "./CardSubtasks";
import { CardRelations, useCardRelations } from "./CardRelations";
import { CardLabels, useCardLabels } from "./CardLabels";
import { CardActivity, ACTIVITY_TABS, type ActivitySortOrder, type ActivityView, type CommentsRead } from "./CardActivity";
import { cardDevelopmentQueryOptions, connectedReposQueryOptions, usePullRequestLink } from "../lib/card-development";
import { TASK_TYPE_META } from "../lib/task-type";
import { restoreFocusSoon } from "../lib/focus";
import { useCardDraft } from "../lib/card-draft";
import { useCommentThread } from "../lib/comment-thread";
import { uploadImageFor, type UploadImage } from "../lib/image-upload";
import { useChecklist } from "../lib/checklist";
import { useSubtaskComposer } from "../lib/subtask-composer";
import { useAuthoredScope, type AuthoredScope } from "../lib/authored-operation";
import "./card-detail.css";

/** A stable empty history while a card's own read is loading, so the memos downstream hold still. */
const NO_ACTIVITIES: Activity[] = [];

/** Which shell the card details render in: the overlay modal or full screen. */
export type CardViewMode = "modal" | "full";

/**
 * Card details. The title/description draft is seeded once on mount; after that
 * an untouched field follows the live card and an edited one is left alone
 * (`lib/card-draft.ts`): whoever saves last wins (ADR 0007/0010), so a
 * broadcast arriving while the modal is open must not overwrite what the user is
 * typing. The mount seed reverses unresolved optimistic attachment cleanup only;
 * confirmed deletions strip their references from the effective description,
 * leaving the raw draft and other prose intact. The other authored drafts
 * (checklist, subtask composer, comments and replies) are owned by their section
 * modules in `lib/`; the modal only combines their `hasWork` for the discard strip.
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
  commentsRead,
  boardAttachments,
  uploadScope,
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
  commentsRead: CommentsRead;
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
  const editTitleButtonRef = useRef<HTMLButtonElement | null>(null);
  const attachmentView = useAttachmentView(boardAttachments);
  // Save is one authored operation (ADR 0069): `card.update` with the fields Save diffed.
  const cardDraft = useCardDraft(authoredScope, {
    card,
    boardAttachments,
    attachmentView,
    keepsOpen: () => workKeepsCardOpen(),
    close: onClose,
  });
  const { title, editingTitle, description, uploading: descriptionUploading, titleHasChanges, descriptionHasChanges, unsavedTextMessage } = cardDraft;
  const { pending: savePending, uncertain: saveUncertain, error: saveError, recovery: saveRecovery } = cardDraft.saveLane;
  const subtasks = useSubtaskComposer(authoredScope, {
    cardId: card.id,
    isSubtask: card.taskType === "subtask",
    placeTail: () => commands.placeNewCard(columns.find(c => c.starting)?.id ?? card.columnId),
  });
  const attachmentDeletePending = attachmentView.isDeletePending(card.id);
  const checklist = useChecklist(authoredScope, {
    cardId: card.id,
    items,
    placeNew: () => commands.placeNewChecklistItem(card.id),
  });
  const attachInput = useRef<HTMLInputElement | null>(null);
  const [confirmingAttachmentId, setConfirmingAttachmentId] = useState<string | null>(null);
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
  const [activityView, setActivityView] = useState<ActivityView>("comments");
  const [activitySortOrder, setActivitySortOrder] = useState<ActivitySortOrder>("asc");
  const activityTabRefs = useRef<Record<ActivityView, HTMLButtonElement | null>>({
    all: null,
    comments: null,
    history: null,
  });
  const modalRef = useRef<HTMLDivElement | null>(null);
  // Both live here, not in their sections: the two shells wrap the body differently, so a view
  // switch is not guaranteed to keep a section's own state.
  const relationLink = useCardRelations(commands, { cardId: card.id, relations, cards, boardKey });
  const labelPicker = useCardLabels(commands, { cardId: card.id, labels, view, modalRef });
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

  // This card's immutable history in server sequence order, read on demand (ADR 0073); empty until it loads.
  const activities = useQuery(cardActivityQueryOptions(boardId, card.id)).data ?? NO_ACTIVITIES;
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
  const changeColumn = (targetColumnId: string) => {
    if (targetColumnId === card.columnId) return;
    const trigger = document.activeElement?.closest('[role="dialog"]')?.querySelector<HTMLElement>('[aria-label="Status"]') ?? null;
    onRequestMove(card.id, targetColumnId, trigger);
  };

  // A cleared date input yields "", which maps to null — "no deadline".
  const schedule = (value: string) => {
    commands.schedule(card.id, value === "" ? null : value);
  };

  const toggleLabel = (labelId: string) => commands.toggleLabel(card.id, labelId);

  /**
   * What keeps the card open after an accepted save instead of throwing it away: a submitted write
   * of another lane still in flight, or a draft or recovery of another section. Save's own recovery
   * is not counted: the card draft remembers an interrupted first attempt itself, so the late
   * acceptance of an earlier attempt does not close the card.
   */
  const workKeepsCardOpen = () =>
    authoredScope.hasActiveWork() ||
    checklist.current().hasWork ||
    commentThread.current().keepsCardOpen ||
    cardDraft.current().uploading ||
    // A pull request draft, or a link request still in flight, is work Save does
    // not own: the card stays open so it is not thrown away by closing.
    pullRequestWorkRef.current ||
    subtasks.current().keepsCardOpen;
  /** The one upload path, shared by the panel and the image-only Markdown entry points. */
  const upload = useMutation({
    mutationFn: ({ file, rasterizeSvg }: { file: File; rasterizeSvg?: boolean }) =>
      boardAttachments.upload({ file, cardId: card.id, scope: uploadScope, rasterizeSvg }),
  });

  const uploadFile: UploadImage = (file, options) => upload.mutateAsync({ file, ...options });
  const uploadDescriptionImage = useMemo(
    () => uploadImageFor(uploadFile, { begin: cardDraft.beginUpload, end: cardDraft.endUpload }, true),
    [cardDraft.beginUpload, cardDraft.endUpload],
  );
  const commentThread = useCommentThread(authoredScope, {
    cardId: card.id,
    me,
    comments,
    requestClose: (action) => requestClose(action),
    upload: uploadFile,
  });
  const { uncertain: commentUncertain } = commentThread.composer;
  const { uncertain: replyUncertain } = commentThread.reply;
  // Every authored draft is guarded independently of the title/description Save.
  const hasTextChanges = titleHasChanges || descriptionHasChanges;
  const textSaveStatusId = `card-text-save-status-${card.id}`;
  // Closing guards every authored lane; the footer Save owns only card text.
  const draftingDirty =
    checklist.hasWork ||
    commentThread.hasWork ||
    titleHasChanges ||
    descriptionHasChanges ||
    descriptionUploading ||
    savePending ||
    saveUncertain ||
    saveRecovery !== null ||
    subtasks.hasWork;
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
        const { composing, draft, composer } = subtasks.current();
        if (composing && !composer.pending) {
          // An idle empty composer just collapses; a typed title goes through the
          // same discard strip as every other draft, and a submitted one is left
          // strictly alone until it settles.
          if (draft.trim() === "") {
            subtasks.cancel();
            return;
          }
          requestClose(() => subtasks.cancel(true));
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
    subtasks.current,
    subtasks.cancel,
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
        {descriptionHasChanges && !savePending && !saveUncertain && (
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
                onClick={cardDraft.retry}
                disabled={descriptionUploading || savePending || saveUncertain}
                className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10 pointer-coarse:min-h-11 pointer-coarse:px-3"
              >
                {savePending ? "Retrying…" : "Retry unsent save"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={savePending || saveUncertain}
                onClick={() => {
                  if (savePending || saveUncertain) return;
                  cardDraft.discardRecovery();
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
        readOnly={savePending || saveUncertain}
        onChange={(next) => {
          cardDraft.setDescription(next);
          cardDraft.clearError();
          cancelPendingClose();
        }}
        onSave={cardDraft.save}
        onUploadImage={uploadDescriptionImage}
        previewImages={previewImages}
        onOpenImage={handleOpenAttachmentFromMarkdown}
        onPendingClose={pendingClose ? executePendingClose : undefined}
      />
    </div>
  );
  const checklistSection = (
    <CardChecklist
      checklist={checklist}
      items={items}
      taskType={card.taskType}
      commands={commands}
      conversion={{
        ...subtasks.conversion,
        convert: subtasks.convert,
        retry: subtasks.retryConversion,
        discard: subtasks.discardConversion,
      }}
    />
  );
  const subtasksSection = (
    <CardSubtasks
      subtasks={subtasks}
      card={card}
      relations={relations}
      hierarchy={hierarchy}
      cards={cards}
      columns={columns}
      boardKey={boardKey}
      commands={commands}
      navigate={navigate}
      onRequestMove={onRequestMove}
      requestClose={requestClose}
      cancelPendingClose={cancelPendingClose}
    />
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
  const activitySection = (
    <CardActivity
      commentThread={commentThread}
      comments={comments}
      commentsRead={commentsRead}
      activities={activities}
      members={members}
      me={me}
      commands={commands}
      previewImages={previewImages}
      onOpenImage={handleOpenAttachmentFromMarkdown}
      activityView={activityView}
      setActivityView={setActivityView}
      activitySortOrder={activitySortOrder}
      setActivitySortOrder={setActivitySortOrder}
      activityTabRefs={activityTabRefs}
      onActivityTabKeyDown={onActivityTabKeyDown}
    />
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
              {titleHasChanges && !savePending && !saveUncertain && <span className="card-text-draft-badge">Unsaved</span>}
            </div>
          {editingTitle ? (
            <Input
              autoFocus
              aria-label="Card title"
              value={title}
              readOnly={savePending || saveUncertain}
              aria-disabled={savePending || saveUncertain}
              onChange={(event) => {
                if (savePending || saveUncertain) return;
                cardDraft.setTitle(event.target.value);
                cancelPendingClose();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  cardDraft.save();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cardDraft.setEditingTitle(false);
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
                disabled={savePending || saveUncertain}
                aria-disabled={savePending || saveUncertain}
                onClick={() => cardDraft.setEditingTitle(true)}
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
                  {connected && !dirty && !attachmentDeletePending && !descriptionUploading && !savePending && !saveUncertain && !commentUncertain && !replyUncertain && (
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
                        : savePending
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
                onClick={cardDraft.save}
                disabled={!hasTextChanges || attachmentDeletePending || descriptionUploading || savePending || saveUncertain || saveRecovery !== null}
                className="min-h-11 md:min-h-8 pointer-coarse:min-h-11"
              >
                {savePending ? "Saving…" : "Save title & description"}
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
          <CardLabels picker={labelPicker} cardId={card.id} labels={labels} cardLabels={cardLabels} toggleLabel={toggleLabel} />
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
          <CardRelations link={relationLink} cards={cards} boardKey={boardKey} commands={commands} navigate={navigate} />
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
