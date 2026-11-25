import { Archive, Check, CircleHelp, Plus, Search, Settings2, SlidersHorizontal, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isPreviewableImageContentType } from "@foxban/shared";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragOverEvent,
  type DragMoveEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useBoardCommands } from "../lib/board-commands";
import { cardDropPeers, resolveCardDrop, type CardDrop } from "../lib/card-drop";
import { Link, getRouteApi, useBlocker } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Member } from "../lib/api";
import { meQuery } from "../lib/auth";
import type { Board } from "../lib/boards";
import {
  UNLABELED_FILTER,
  UNASSIGNED_FILTER,
  cardAttachments,
  cardChecklist,
  cardComments,
  cardLabelViews,
  cardRelations,
  columnCards,
  columnRootCards,
  boardAncestors,
  buildBoardIndex,
  sortedColumns,
  visibleCardIds,
  type BoardState,
} from "../lib/apply-mutation";
import { buildSubtaskHierarchy, type Card, type ClientMessage } from "@foxban/shared";
import { WorkflowSettings } from "./WorkflowSettings";
import { CardSubtaskFamily } from "./SubtaskList";
import { LABEL_COLOR_META } from "../lib/labels";
import { useBoardSocket, useBoardState } from "../lib/socket";
import { useBoardAttachments } from "../lib/attachments";
import { useAuthoredOperation, useAuthoredScope } from "../lib/authored-operation";
import { boardQueryKey } from "../lib/board-cache";
import { cardForTaskKey, taskKey } from "../lib/task-key";
import { Avatar } from "./Avatar";
import { BoardAppearanceIcon } from "./BoardAppearanceFields";
import { MemberSidebar } from "./MemberSidebar";
import { CardArchiveDialog } from "./CardArchiveDialog";
import { FamilyCompletionDialog } from "./FamilyCompletionDialog";
import { completionFamily, finishMessage } from "../lib/family-completion";
import { CardModal, type CardViewMode } from "./CardModal";
import { CardCreateDialog, type CardCreateDraft } from "./CardCreateDialog";
import { ColumnCreateDialog } from "./ColumnCreateDialog";
import { ColumnDeleteDialog } from "./ColumnDeleteDialog";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { AppShell } from "./AppShell";
import { CardFace, getCardFaceProps } from "./CardView";
import { ColumnView } from "./ColumnView";
import { boardDevelopmentQueryOptions, cardPullRequestBadge, type CardPullRequestBadge } from "../lib/card-development";
import { cn } from "../lib/utils";
import { restoreFocusSoon } from "../lib/focus";
import { Button, buttonVariants } from "./ui/button";
import { Input } from "./ui/input";

// Read through the route api rather than importing `boardRoute`: router.tsx
// imports this file, and the reverse import would close the cycle.
const boardRouteApi = getRouteApi("/board/$boardKey");

const MEMBER_RAIL_STORAGE_KEY = "foxban-member-rail-visible";

function readStoredMemberRailVisible(): boolean {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const stored = window.localStorage.getItem(MEMBER_RAIL_STORAGE_KEY);
      if (stored !== null) {
        return stored === "true";
      }
    }
  } catch {
    // Storage access may be blocked or restricted
  }
  // The board opens without the rail: showing it is one click, and a fresh
  // page then matches the compact board the screenshots describe.
  return false;
}

function storeMemberRailVisible(visible: boolean): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(MEMBER_RAIL_STORAGE_KEY, String(visible));
    }
  } catch {
    // Ignore storage errors if localStorage is blocked or restricted
  }
}
type FinishIntent = { id: string; columnId: string; position: string; sourceColumnId: string; sourcePosition: string; trigger: HTMLElement | null };
type FinishSent = { intent: FinishIntent; message: Extract<ClientMessage, { type: "card.finish" }> };
type CreationFields<T extends "card.create" | "column.create"> = Omit<Extract<ClientMessage, { type: T }>, "type" | "mutationId">;
type CreationSent =
  | { kind: "column"; fields: CreationFields<"column.create"> }
  | { kind: "card"; fields: CreationFields<"card.create"> };

export function BoardView({
  boardId,
  boardMeta,
  accessChangePending,
  accessCheckedAt,
}: {
  boardId: string;
  /** The by-key lookup response: identity, appearance and the connected repository. */
  boardMeta: Board;
  /** The route's authoritative metadata read reports a pending access change. */
  accessChangePending: boolean;
  /** When that read last succeeded, so a stale success cannot claim the board is ready. */
  accessCheckedAt: number;
}) {
  const boardAttachments = useBoardAttachments(boardId);
  const {
    accessState,
    connected,
    handshakeFailed,
    signedOut,
    retry,
    sendMutation,
    subscribeMutation,
    retireTrackedMutation,
    cardCommentsQuery,
  } = useBoardSocket(boardId, {
    accessChangePending,
    accessCheckedAt,
    events: boardAttachments.events,
  });
  const state = useBoardState(boardId);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const queryClient = useQueryClient();
  const authored = useAuthoredScope({
    send: sendMutation,
    subscribe: subscribeMutation,
    retire: retireTrackedMutation,
    readBoard: () => queryClient.getQueryData<BoardState>(boardQueryKey(boardId)),
  });
  const commands = useBoardCommands(boardId, sendMutation);
  const me = useQuery(meQuery);
  // Board metadata is resolved by the route shell via GET /boards/by-key/:key and passed in.
  const meta = boardMeta;
  const canManageColumns = meta.capabilities.canManageBoard;
  // Board members feed the assignee picker and the card-front chips. The card
  // modal renders explicit loading and error/retry recovery rather than
  // degrading to an empty picker, while unresolved assignees render as `?`.
  const members = useQuery({
    queryKey: ["board-members", boardId],
    queryFn: async () => {
      const response = await api.boards[":id"].members.$get({ param: { id: boardId } });
      if (!response.ok)
        throw new Error(`GET /boards/${boardId}/members failed with ${response.status}`);
      return (await response.json()).members;
    },
    retry: false,
  });
  const memberList = members.data ?? [];
  // `| undefined`: a card can carry an assignee id the query has not resolved yet.
  const membersById: Record<string, Member | undefined> = Object.fromEntries(
    memberList.map((member) => [member.id, member]),
  );

  const sensors = useSensors(
    // Mouse sensor uses activation distance constraint
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // Touch sensor uses delay and tolerance so quick swipes scroll without lifting
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: (event, args) => {
        const activeId = args.active;
        const context = args.context;
        const activeData = context.active?.data.current;
        const currentState = stateRef.current;
        const isColumn =
          activeData?.type === "column" ||
          Boolean(currentState && currentState.columns.some((c) => c.id === activeId));
        if (isColumn && currentState) {
          const key = event.code;
          // Columns reorder along the axis they are laid out on, so a keyboard
          // lift on a stacked board steps with Up/Down like the eye expects.
          const forwardKey = stackedColumns ? "ArrowDown" : "ArrowRight";
          const backwardKey = stackedColumns ? "ArrowUp" : "ArrowLeft";
          if (key === forwardKey || key === backwardKey) {
            const ordered = sortedColumns(currentState);
            const currentIndex = ordered.findIndex((col) => col.id === (keyboardColumnTargetRef.current ?? activeId));
            if (currentIndex !== -1) {
              const targetIndex = key === forwardKey ? currentIndex + 1 : currentIndex - 1;
              if (targetIndex >= 0 && targetIndex < ordered.length) {
                const targetColumnId = ordered[targetIndex]!.id;
                const targetRect =
                  context.droppableRects.get(targetColumnId) ??
                  context.droppableContainers.get(targetColumnId)?.rect.current;
                const activeRect =
                  context.droppableRects.get(keyboardColumnTargetRef.current ?? activeId) ??
                  context.droppableContainers.get(keyboardColumnTargetRef.current ?? activeId)?.rect.current;

                if (targetRect && activeRect) {
                  const targetCenterX = targetRect.left + targetRect.width / 2;
                  const targetCenterY = targetRect.top + targetRect.height / 2;
                  const activeCenterX = activeRect.left + activeRect.width / 2;
                  const activeCenterY = activeRect.top + activeRect.height / 2;

                  keyboardColumnTargetRef.current = targetColumnId;
                  return {
                    x: args.currentCoordinates.x + targetCenterX - activeCenterX,
                    y: args.currentCoordinates.y + targetCenterY - activeCenterY,
                  };
                }
              }
            }
          }
          // The other axis is not this board's layout: swallowing it keeps a
          // keyboard lift from stepping out of the row (or down the stack).
          if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
            return args.currentCoordinates;
          }
        }
        if (currentState && activeData?.type === "card" && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
          const cardId = String(activeId);
          const currentHierarchy = buildSubtaskHierarchy(currentState.cards, currentState.relations);
          const currentTarget = keyboardCardTargetRef.current ?? cardId;
          const targetCard = currentState.cards.find(card => card.id === currentTarget);
          const currentColumn = targetCard?.columnId ?? currentTarget.replace("column-drop:", "");
          const ordered = sortedColumns(currentState);
          let destination = currentColumn;
          let nextId: string | undefined;
          if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
            const index = ordered.findIndex(column => column.id === currentColumn);
            const nextColumn = ordered[index + (event.code === "ArrowRight" ? 1 : -1)];
            if (!nextColumn) return args.currentCoordinates;
            destination = nextColumn.id;
            const peers = cardDropPeers(currentState, currentHierarchy, cardId, destination).filter(card => context.droppableContainers.has(card.id));
            nextId = peers[0]?.id ?? `column-drop:${destination}`;
          } else {
            const peers = cardDropPeers(currentState, currentHierarchy, cardId, destination).filter(card => context.droppableContainers.has(card.id));
            const atTail = currentTarget === `column-drop:${destination}`;
            const index = atTail ? peers.length : peers.findIndex(card => card.id === currentTarget);
            const nextIndex = index + (event.code === "ArrowDown" ? 1 : -1);
            nextId = peers[nextIndex]?.id ?? (nextIndex === peers.length && !atTail ? `column-drop:${destination}` : undefined);
          }
          if (!nextId) return args.currentCoordinates;
          const node = context.droppableContainers.get(nextId)?.node.current;
          // Long families can put the logical next peer beyond the viewport.
          // Bring only its body into view before translating the compact preview.
          node?.scrollIntoView({ block: "nearest", inline: "nearest" });
          const targetRect = node?.getBoundingClientRect() ?? context.droppableRects.get(nextId);
          const activeRect = context.collisionRect;
          if (targetRect && activeRect) {
            keyboardCardTargetRef.current = nextId;
            return { x: args.currentCoordinates.x + targetRect.left - activeRect.left, y: args.currentCoordinates.y + targetRect.top - activeRect.top };
          }
          return args.currentCoordinates;
        }
        return sortableKeyboardCoordinates(event, args);
      },
    }),
  );
  const {
    card: cardParam,
    view,
    attachment: attachmentParam,
    labels: labelsParam,
    assignees: assigneesParam,
    q: qParam,
  } = boardRouteApi.useSearch();
  const navigate = boardRouteApi.useNavigate();
  // The board's own dialogs. The create forms own their drafts internally, so
  // closing one discards it and reopening starts clean.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [workflowSettingsOpen, setWorkflowSettingsOpen] = useState(false);
  const workflowSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const closeWorkflowSettings = () => {
    setWorkflowSettingsOpen(false);
    restoreFocusSoon(workflowSettingsButtonRef.current);
  };
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const [columnCreateOpen, setColumnCreateOpen] = useState(false);
  const [cardCreateColumnId, setCardCreateColumnId] = useState<string | null>(null);
  const cardCreateColumnIdRef = useRef<string | null>(null);
  const cardCreateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const columnCreateTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Card and column creation share one operation: only one dialog is up at a time.
  const creation = useAuthoredOperation<CreationSent>(authored, {
    build: (mutationId, sent) =>
      sent.kind === "column"
        ? { type: "column.create", mutationId, ...sent.fields }
        : { type: "card.create", mutationId, ...sent.fields },
    onAccepted: (sent) => (sent.kind === "column" ? closeColumnCreate() : closeCardCreate()),
    copy: {
      rejected: "The board refused that change.",
      unverified: "Creation was not confirmed. You can try again.",
      "not-connected": "Not connected — changes won't send.",
      "accepted-gone": "The board refused that change.",
    },
  });
  // Uncertain: the request may still have landed, so the values stay locked until the reconnect snapshot settles it.
  const creationPending = creation.status === "pending" || creation.status === "uncertain";
  const creationError = creation.status === "uncertain" ? "Checking whether creation completed…" : creation.error;
  // Members opens the rail on a wide viewport and the drawer on a narrow one:
  // the control is one button, and this only decides which it drives.
  const [wideViewport, setWideViewport] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.matchMedia("(min-width: 768px)").matches,
  );
  // Columns stack below 600px, the axis their sorting and keyboard reordering follow.
  const [stackedColumns, setStackedColumns] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 600px)").matches,
  );
  const filterDialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const filterDialogCloseBtnRef = useRef<HTMLButtonElement | null>(null);
  const filterDialogRef = useRef<HTMLDivElement | null>(null);
  const [columnDeleteId, setColumnDeleteId] = useState<string | null>(null);
  const columnDeleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archiveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [memberDrawerOpen, setMemberDrawerOpen] = useState(false);
  const memberDrawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const memberDrawerCloseBtnRef = useRef<HTMLButtonElement | null>(null);
  const [desktopRailVisible, setDesktopRailVisible] = useState<boolean>(
    readStoredMemberRailVisible,
  );

  const toggleDesktopRail = () => {
    setDesktopRailVisible((prev) => {
      const next = !prev;
      storeMemberRailVisible(next);
      return next;
    });
  };
  const shortcutsButtonRef = useRef<HTMLButtonElement>(null);
  const newCardButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const onChange = (event: MediaQueryListEvent) => setWideViewport(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  // Columns stack below 600px, and that is the axis their sorting and keyboard
  // reordering follow. The member rail keeps its own 768px question.
  useEffect(() => {
    const query = window.matchMedia("(max-width: 600px)");
    const onChange = (event: MediaQueryListEvent) => setStackedColumns(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  // The URL holds the human task key: the card it names is derived from the
  // board cache and metadata key, so a broadcast that deletes it closes the
  // dialog instead of leaving one over a card that no longer exists.
  const openCard =
    cardParam !== undefined && state
      ? cardForTaskKey(state.cards, meta.key, cardParam)
      : undefined;
  // The open card's comments are read on open (ADR 0078); a reconnect snapshot invalidates and rereads them.
  const commentsQuery = useQuery({ ...cardCommentsQuery(openCard?.id ?? ""), enabled: openCard !== undefined });
  const columnToDelete =
    canManageColumns && columnDeleteId !== null && state
      ? state.columns.find((candidate) => candidate.id === columnDeleteId)
      : undefined;
  /**
   * The board's own overlays are one family: the create/help dialogs travel
   * through the shell's `overlays` slot (outside its inert subtree), and every
   * other dialog stays a sibling of the shell. Any of them suppresses the
   * keyboard shortcuts and the drag preview, and the shell turns inert.
   */
  const [finishIntent, setFinishIntent] = useState<FinishIntent | null>(null);
  const [finishPendingCount, setFinishPendingCount] = useState(0);
  // Failures of the checks made before the operation starts.
  const [finishLocalError, setFinishLocalError] = useState<string | null>(null);
  const finish = useAuthoredOperation<FinishSent>(authored, {
    build: (mutationId, sent) => ({ ...sent.message, mutationId }),
    onAccepted: ({ intent }) => {
      setFinishIntent(null); setFinishLocalError(null);
      restoreFocusSoon(() => intent.trigger?.isConnected ? intent.trigger : document.querySelector<HTMLElement>(`[data-card-body="${CSS.escape(intent.id)}"]`) ?? document.querySelector<HTMLElement>('[aria-label="Search cards"]'));
    },
    copy: {
      rejected: "Completion was not confirmed. Review the current subtasks and choose again.",
      unverified: "Completion was not confirmed. Review the current subtasks and choose again.",
      "not-connected": "Not connected — completion was not sent.",
      "accepted-gone": "Completion was not confirmed. Review the current subtasks and choose again.",
    },
  });
  const finishActive = finish.status === "pending" || finish.status === "uncertain";
  const finishError = finishLocalError ?? (finish.status === "uncertain" ? "Checking whether completion was accepted. Wait for reconnection before trying again." : finish.error);
  const workspaceOverlayOpen =
    openCard !== undefined ||
    columnToDelete !== undefined ||
    archiveOpen ||
    memberDrawerOpen ||
    filterDialogOpen ||
    columnCreateOpen ||
    cardCreateColumnId !== null ||
    (workflowSettingsOpen && canManageColumns) ||
    shortcutsOpen;
  const interactionBlocked = workspaceOverlayOpen || finishIntent !== null;
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // The column a keyboard lift has stepped to. The drop's collision reads the
  // overlay's small preview rect rather than the column's, so the deliberate
  // move is the authority for the axis it moved along.
  const keyboardColumnTargetRef = useRef<string | null>(null);
  const keyboardCardTargetRef = useRef<string | null>(null);
  const pointerDropSideRef = useRef<"before" | "after" | undefined>(undefined);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dropHint, setDropHint] = useState<CardDrop["hint"]>(null);
  const activeCardIds = useMemo(
    () => new Set(state ? state.cards.map((card) => card.id) : []),
    [state?.cards],
  );
  // Card lookup and per-card face aggregates, rebuilt once per board state so no
  // card or column render scans the board's flat arrays.
  const boardIndex = useMemo(() => (state ? buildBoardIndex(state) : undefined), [state]);
  // The board's subtask forest, rebuilt only when its inputs change: every family
  // rendered, every done/total count, the drag sibling lists and the close-focus
  // fallback read this one answer instead of walking ancestors per card.
  const hierarchy = useMemo(
    () => buildSubtaskHierarchy(state?.cards ?? [], state?.relations ?? []),
    [state?.cards, state?.relations],
  );
  // Collapsed families, by card id, for this board session only: a family nobody
  // has closed is open, which is how the board starts and how a peer's new
  // subtask appears. Nothing here is persisted or sent.
  const [collapsedSubtasks, setCollapsedSubtasks] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  useEffect(() => {
    setCollapsedSubtasks((current) => {
      if (current.size === 0) return current;
      const live = new Set([...current].filter((id) => activeCardIds.has(id)));
      return live.size === current.size ? current : live;
    });
  }, [activeCardIds]);
  const toggleSubtasks = useCallback((cardId: string) => {
    setCollapsedSubtasks((current) => {
      const next = new Set(current);
      if (!next.delete(cardId)) next.add(cardId);
      return next;
    });
  }, []);
  const closeFinish = () => {
    if (finishActive) return;
    const intent = finishIntent;
    setFinishIntent(null); setFinishLocalError(null); finish.discard();
    if (intent) restoreFocusSoon(() => intent.trigger?.isConnected ? intent.trigger : document.querySelector<HTMLElement>(`[data-card-body="${CSS.escape(intent.id)}"]`) ?? document.querySelector<HTMLElement>('[aria-label="Search cards"]'));
  };
  // Drag passes the drop's position; a status change lets the commands place the card among its peers.
  const requestCardMove = (id: string, to: { columnId: string; position?: string }, trigger?: HTMLElement | null) => {
    if (!state || finishActive || finishIntent) return;
    const card = state.cards.find(card => card.id === id);
    const result = commands.moveCard(id, to);
    if (card && typeof result === "object") {
      setFinishIntent({ id, ...result.needsFinish, sourceColumnId: card.columnId, sourcePosition: card.position, trigger: trigger ?? document.querySelector<HTMLElement>(`[data-card-body="${CSS.escape(id)}"]`) });
      setFinishLocalError(null);
    }
  };
  const chooseFinish = (scope: "parent" | "family") => {
    if (!state || !finishIntent || finishActive || !connected) return;
    const parent = state.cards.find(card => card.id === finishIntent.id);
    if (!parent || parent.columnId !== finishIntent.sourceColumnId || parent.position !== finishIntent.sourcePosition) { setFinishLocalError("Parent moved. Cancel and review the move again."); return; }
    let message: Extract<ClientMessage, { type: "card.finish" }>;
    try { message = finishMessage(state, finishIntent.id, finishIntent.columnId, finishIntent.position, scope); }
    catch (error) { setFinishLocalError(error instanceof Error ? error.message : "Could not prepare completion."); return; }
    setFinishPendingCount(completionFamily(state, finishIntent.id).open.length);
    setFinishLocalError(null);
    finish.start({ intent: finishIntent, message });
  };
  const activeDragData: "card" | "column" | null = activeDragId
    ? state?.cards.some((c) => c.id === activeDragId)
      ? "card"
      : state?.columns.some((col) => col.id === activeDragId)
        ? "column"
        : null
    : null;
  const [dirtyCardId, setDirtyCardId] = useState<string | null>(null);
  const activeDirtyCardId = dirtyCardId === openCard?.id ? dirtyCardId : null;
  const isDiscardingRef = useRef(false);
  const cardModalDiscardRef = useRef<(() => void) | null>(null);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (isDiscardingRef.current) return false;
      if (!activeDirtyCardId) return false;
      const currentSearch = (current.search as Record<string, unknown> | undefined) ?? {};
      const nextSearch = (next.search as Record<string, unknown> | undefined) ?? {};
      // If no card was open before, don't block opening a card
      if (!currentSearch.card) return false;
      const sameRoute = current.routeId === next.routeId;
      const samePathname = current.pathname === next.pathname;
      const sameCard = currentSearch.card === nextSearch.card && Boolean(currentSearch.card);
      if (sameRoute && samePathname && sameCard) {
        // Within the same board and card: view, attachment, search, filter transitions remain unblocked
        return false;
      }
      return true;
    },
    withResolver: true,
    enableBeforeUnload: false,
  });
  // In-app navigation keeps the custom discard strip; a real unload (refresh,
  // tab close, the update prompt's reload) gets the browser's own prompt.
  useEffect(() => {
    if (!activeDirtyCardId) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [activeDirtyCardId]);

  useEffect(() => {
    if (dirtyCardId && !activeDirtyCardId) {
      setDirtyCardId(null);
      cardModalDiscardRef.current = null;
    }
    if (blocker.status === "blocked") {
      if (!activeDirtyCardId) {
        blocker.proceed?.();
      } else if (cardModalDiscardRef.current) {
        cardModalDiscardRef.current();
      } else {
        blocker.reset?.();
      }
    }
  }, [blocker, dirtyCardId, activeDirtyCardId]);
  const previewCard =
    state && activeDragId !== null && activeDragData === "card"
      ? state.cards.find((candidate) => candidate.id === activeDragId)
      : undefined;
  const previewColumn =
    state && activeDragId !== null && activeDragData === "column"
      ? state.columns.find((candidate) => candidate.id === activeDragId)
      : undefined;
  // Also the deep-link guard: a link to a deleted, foreign, or invalid task key cleans
  // itself out of the URL and leaves the visitor on the board. A missing,
  // deleted, foreign-card, or non-image attachment id drops out the same way,
  // leaving the card open. Both state and board metadata must load before
  // semantic validation.
  useEffect(() => {
    if (state === undefined || cardParam === undefined) {
      return;
    }
    const matchedCard = cardForTaskKey(state.cards, meta.key, cardParam);
    if (!matchedCard) {
      void navigate({
        search: (prev) => ({
          labels: prev.labels,
          assignees: prev.assignees,
          q: prev.q,
        }),
        replace: true,
        resetScroll: false,
      });
      return;
    }
    if (
      attachmentParam !== undefined &&
      !cardAttachments(state, matchedCard.id).some(
        (candidate) =>
          candidate.id === attachmentParam &&
          isPreviewableImageContentType(candidate.contentType),
      )
    ) {
      void navigate({
        search: (prev) => ({ ...prev, attachment: undefined }),
        replace: true,
        resetScroll: false,
      });
    }
  }, [cardParam, attachmentParam, state, meta.key, navigate]);
  useEffect(() => {
    if (!canManageColumns && columnDeleteId !== null) {
      setColumnDeleteId(null);
      columnDeleteTriggerRef.current = null;
      restoreFocusSoon(searchInputRef.current);
      return;
    }
    if (state === undefined || columnDeleteId === null) return;
    if (
      cardParam !== undefined ||
      !state.columns.some((candidate) => candidate.id === columnDeleteId)
    ) {
      setColumnDeleteId(null);
      columnDeleteTriggerRef.current = null;
    }
  }, [state, columnDeleteId, cardParam, canManageColumns]);
  useEffect(() => {
    if (!archiveOpen) return;
    if (cardParam !== undefined) {
      setArchiveOpen(false);
      archiveTriggerRef.current = null;
    }
  }, [archiveOpen, cardParam]);

  // Card navigation is history: opening, closing and stepping card to card push
  // (Back walks them), while expand/collapse only replaces — a mode toggle has
  // no business in the history stack. `resetScroll: false` throughout keeps the
  // board's horizontal scroll where the user left it.
  const openFromBoard = (id: string) => {
    if (!state) return;
    const card = state.cards.find((candidate) => candidate.id === id);
    if (!card || card.taskNumber <= 0) return;
    // A click on the board always opens the modal, whatever the last mode was.
    void navigate({
      search: (prev) => ({
        card: taskKey(meta.key, card.taskNumber),
        labels: prev.labels,
        assignees: prev.assignees,
        q: prev.q,
      }),
      resetScroll: false,
    });
  };
  // Every card holds this handler as a prop, so its identity must not change with the board state.
  const openFromBoardRef = useRef(openFromBoard);
  useEffect(() => {
    openFromBoardRef.current = openFromBoard;
  });
  const openCardFromBoard = useCallback((id: string) => openFromBoardRef.current(id), []);
  const openFromCard = (id: string) => {
    if (!state) return;
    const card = state.cards.find((candidate) => candidate.id === id);
    if (!card || card.taskNumber <= 0) return;
    // A row inside the dialog keeps the current presentation, but not a viewer
    // opened over the card it is leaving.
    void navigate({
      search: (prev) => ({
        ...prev,
        card: taskKey(meta.key, card.taskNumber),
        attachment: undefined,
      }),
      resetScroll: false,
    });
  };
  // The image viewer is history too: opening and closing it both push, so Back
  // peels it off the card rather than closing both.
  const openAttachment = (id: string, _trigger?: HTMLElement | null) => {
    void navigate({ search: (prev) => ({ ...prev, attachment: id }), resetScroll: false });
  };
  const closeAttachment = () => {
    void navigate({ search: (prev) => ({ ...prev, attachment: undefined }), resetScroll: false });
  };
  const setCardView = (next: CardViewMode) => {
    void navigate({
      search: (prev) => ({ ...prev, view: next === "full" ? ("full" as const) : undefined }),
      replace: true,
      resetScroll: false,
    });
  };

  const filterTokens = labelsParam === undefined ? [] : labelsParam.split(",").filter(Boolean);
  const assigneeTokens =
    assigneesParam === undefined ? [] : assigneesParam.split(",").filter(Boolean);
  const selectedAssigneeTokens = new Set(assigneeTokens);
  const effectiveAssigneeTokens = [...selectedAssigneeTokens];
  const visible = useMemo(
    () =>
      state
        ? visibleCardIds(
            state,
            labelsParam === undefined ? [] : labelsParam.split(",").filter(Boolean),
            [...new Set(assigneesParam === undefined ? [] : assigneesParam.split(",").filter(Boolean))],
            qParam,
          )
        : null,
    [state, labelsParam, assigneesParam, qParam],
  );
  // The popover lists the board's labels name-sorted, like the card picker's.
  const filterLabels = state
    ? [...state.labels].sort((a, b) =>
        a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()),
      )
    : [];
  // Stale tokens (deleted labels) are ignored, not rewritten out of the URL: a
  // peer deleting a label must not trigger navigation under the user. Duplicate
  // valid tokens (e.g. from shared URLs) count once.
  const activeLabelFilterCount =
    state === undefined
      ? 0
      : [...new Set(filterTokens)].filter(
          (token) =>
            token === UNLABELED_FILTER || state.labels.some((label) => label.id === token),
        ).length;
  // Every non-empty assignee token is meaningful without member metadata:
  // stale ids can still match snapshot cards, and duplicates are effective once.
  const activeAssigneeFilterCount = selectedAssigneeTokens.size;
  const currentUser = me.data;
  const assignedToMeActive =
    currentUser !== undefined &&
    currentUser !== null &&
    effectiveAssigneeTokens.length === 1 &&
    effectiveAssigneeTokens[0] === currentUser.id;
  const toggleFilterToken = (token: string) => {
    const next = filterTokens.includes(token)
      ? filterTokens.filter((candidate) => candidate !== token)
      : [...filterTokens, token];
    void navigate({
      search: (prev) => ({ ...prev, labels: next.length > 0 ? next.join(",") : undefined }),
      replace: true,
      resetScroll: false,
    });
  };
  const toggleAssigneeFilterToken = (token: string) => {
    const next = selectedAssigneeTokens.has(token)
      ? effectiveAssigneeTokens.filter((candidate) => candidate !== token)
      : [...effectiveAssigneeTokens, token];
    void navigate({
      search: (prev) => ({
        ...prev,
        assignees: next.length > 0 ? next.join(",") : undefined,
      }),
      replace: true,
      resetScroll: false,
    });
  };
  const toggleAssignedToMe = () => {
    if (currentUser === undefined || currentUser === null) return;
    void navigate({
      search: (prev) => ({
        ...prev,
        assignees: assignedToMeActive ? undefined : currentUser.id,
      }),
      replace: true,
      resetScroll: false,
    });
  };

  const isFilterActive =
    (qParam?.trim() ?? "").length > 0 ||
    activeLabelFilterCount > 0 ||
    activeAssigneeFilterCount > 0;
  /** Every active filter dimension the one Filters control stands for. */
  const activeFilterCount = activeLabelFilterCount + activeAssigneeFilterCount;
  const totalCardCount = state ? state.cards.length : 0;
  const archivedCount = state ? state.archivedCards.length : 0;
  const matchingCardCount = visible !== null ? visible.size : totalCardCount;
  const clearAllFilters = () => {
    void navigate({
      search: (prev) => ({
        ...prev,
        labels: undefined,
        assignees: undefined,
        q: undefined,
      }),
      replace: true,
      resetScroll: false,
    });
  };

  const columns = state ? sortedColumns(state) : [];

  /**
   * Every active ancestor of a matched card: the path a filter must show so the
   * match is reachable, and not itself a match.
   */
  const filterContextIds = useMemo(() => {
    if (visible === null) return new Set<string>();
    const ids = new Set<string>();
    if (state) for (const cardId of visible) {
      for (const ancestor of boardAncestors(state, hierarchy, cardId, boardIndex?.cardsById)) ids.add(ancestor);
    }
    return ids;
  }, [visible, hierarchy, state, boardIndex]);

  /**
   * The families a filtered board must reveal. Saved expansion is never
   * overwritten: this is the render-time view, not the stored state.
   */
  const renderedCollapsed = useMemo(() => {
    if (filterContextIds.size === 0) return collapsedSubtasks;
    const next = new Set([...collapsedSubtasks].filter((id) => !filterContextIds.has(id)));
    return next.size === collapsedSubtasks.size ? collapsedSubtasks : next;
  }, [collapsedSubtasks, filterContextIds]);

  /** A root is shown when it matches or when a match lives anywhere beneath it. */
  const renderedRootsIn = useCallback(
    (columnId: string): Card[] => {
      const roots = columnRootCards(state as BoardState, columnId, hierarchy, boardIndex?.cardsById);
      if (visible === null) return roots;
      return roots.filter((card) => visible.has(card.id) || filterContextIds.has(card.id));
    },
    [state, boardIndex, hierarchy, visible, filterContextIds],
  );

  // Card fronts read every card's pull requests in one request; a hint from the
  // board's socket refreshes it, so nothing polls.
  const development = useQuery(boardDevelopmentQueryOptions(boardId)).data;
  const pullRequestBadges = useMemo(() => {
    const badges = new Map<string, CardPullRequestBadge>();
    for (const { cardId, pullRequests } of development?.cards ?? []) {
      const badge = cardPullRequestBadge(pullRequests);
      if (badge !== null) badges.set(cardId, badge);
    }
    return badges;
  }, [development]);

  // A lift moves one status row. Keep its summary, never clone a tall family.
  const previewFaceProps =
    !interactionBlocked && state && boardIndex && previewCard
      ? {
          ...getCardFaceProps(
            boardIndex,
            previewCard,
            membersById,
            meta.key,
            pullRequestBadges.get(previewCard.id) ?? null,
          ),
          subtaskContent: (
            <CardSubtaskFamily
              renderChild={(child) => <li key={child.id}><CardFace {...getCardFaceProps(boardIndex, child, membersById, meta.key, pullRequestBadges.get(child.id) ?? null)} /></li>}
              state={state}
              hierarchy={hierarchy}
              cardId={previewCard.id}
              visibleCardIds={visible}
              disclosure={{ collapsed: new Set([previewCard.id]) }}
            />
          ),
        }
      : null;

  /**
   * The trigger a closed creation dialog hands focus back to. A peer can remove
   * the control that opened it — or leave it disabled, as New card is on a board
   * that has no column — so every candidate is re-resolved and checked inside
   * the restore frame rather than trusted from capture time.
   */
  const creationFocusTarget = (
    trigger: HTMLButtonElement | null,
    columnId: string | null,
    kind: "card" | "column",
  ) => {
    const usable = (element: HTMLButtonElement | null): element is HTMLButtonElement =>
      element !== null &&
      element.isConnected &&
      element.offsetParent !== null &&
      !element.disabled &&
      element.closest("[inert]") === null;

    return () => {
      if (usable(trigger)) return trigger;
      if (columnId !== null) {
        const columnTrigger = document.querySelector<HTMLButtonElement>(
          `[data-column-id="${columnId.replace(/["\\]/g, "\\$&")}"] .board-column-add-card`,
        );
        if (usable(columnTrigger)) return columnTrigger;
      }
      const addColumnTrigger = document.querySelector<HTMLButtonElement>(".board-add-column");
      if (kind === "column" && usable(addColumnTrigger)) return addColumnTrigger;
      if (usable(newCardButtonRef.current)) return newCardButtonRef.current;
      return searchInputRef.current;
    };
  };

  const clearCreationDraft = creation.discard;

  /** Every create/help dialog closes the others: only one may be up at a time. */
  const openColumnCreate = (trigger: HTMLButtonElement | null) => {
    if (!canManageColumns) return;
    columnCreateTriggerRef.current = trigger;
    setShortcutsOpen(false);
    setFilterDialogOpen(false);
    setCardCreateColumnId(null);
    clearCreationDraft();
    setColumnCreateOpen(true);
  };

  const closeColumnCreate = useCallback(() => {
    const trigger = columnCreateTriggerRef.current;
    columnCreateTriggerRef.current = null;
    setColumnCreateOpen(false);
    clearCreationDraft();
    restoreFocusSoon(creationFocusTarget(trigger, null, "column"));
  }, [clearCreationDraft]);

  const openCardCreate = (columnId: string, trigger: HTMLButtonElement | null) => {
    cardCreateTriggerRef.current = trigger;
    cardCreateColumnIdRef.current = columnId;
    setShortcutsOpen(false);
    setFilterDialogOpen(false);
    setColumnCreateOpen(false);
    clearCreationDraft();
    setCardCreateColumnId(columnId);
  };

  const closeCardCreate = useCallback(() => {
    const trigger = cardCreateTriggerRef.current;
    const columnId = cardCreateColumnIdRef.current;
    cardCreateTriggerRef.current = null;
    cardCreateColumnIdRef.current = null;
    setCardCreateColumnId(null);
    clearCreationDraft();
    restoreFocusSoon(creationFocusTarget(trigger, columnId, "card"));
  }, [clearCreationDraft]);

  const createColumn = (title: string) => {
    if (!canManageColumns) return;
    const currentBoard = queryClient.getQueryData<BoardState>(boardQueryKey(boardId));
    if (!currentBoard) return;
    creation.start({
      kind: "column",
      fields: { id: crypto.randomUUID(), title, position: commands.placeNewColumn() },
    });
  };

  const createCard = (draft: CardCreateDraft) => {
    if (!queryClient.getQueryData<BoardState>(boardQueryKey(boardId))) return;
    creation.start({
      kind: "card",
      fields: {
        id: crypto.randomUUID(),
        columnId: draft.columnId,
        title: draft.title,
        position: commands.placeNewCard(draft.columnId),
        taskType: draft.taskType,
        priority: draft.priority,
        assigneeId: draft.assigneeId,
      },
    });
  };

  /**
   * Closing hands focus back to the card that opened the modal: the board is
   * `inert` while the dialog is up, so the browser has parked focus on <body>
   * and only the re-render that drops the attribute makes the card focusable
   * again — hence the frame's wait. A card deleted meanwhile simply misses.
   */
  const closeCard = useCallback(() => {
    const id = openCard?.id;
    isDiscardingRef.current = true;
    setDirtyCardId(null);
    memberDrawerTriggerRef.current = null;
    setMemberDrawerOpen(false);
    void navigate({
      search: (prev) => ({
        labels: prev.labels,
        assignees: prev.assignees,
        q: prev.q,
      }),
      resetScroll: false,
    }).finally(() => {
      isDiscardingRef.current = false;
    });
    if (id === undefined) return;
    // The card itself first (its body carries `data-card-id`); a nested child
    // whose family is collapsed, or whose own filter hid it, falls back to the
    // nearest visible ancestor's disclosure or body, and only then to search.
    // Resolved inside the frame, so a re-parented node is found as it is now.
    restoreFocusSoon(() => {
      const own = document.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
      if (own) return own;
      const currentBoard = queryClient.getQueryData<BoardState>(boardQueryKey(boardId));
      if (currentBoard) {
        const currentHierarchy = buildSubtaskHierarchy(currentBoard.cards, currentBoard.relations);
        let ancestor = currentHierarchy.parentByChild.get(id);
        while (ancestor !== undefined) {
          const disclosure = document.querySelector<HTMLElement>(
            `[data-subtask-disclosure="${ancestor}"]`,
          );
          if (disclosure) return disclosure;
          const body = document.querySelector<HTMLElement>(`[data-card-id="${ancestor}"]`);
          if (body) return body;
          ancestor = currentHierarchy.parentByChild.get(ancestor);
        }
      }
      return searchInputRef.current;
    });
  }, [openCard?.id, navigate, boardId, queryClient]);
  const openColumnDelete = (id: string, trigger: HTMLButtonElement) => {
    if (!canManageColumns) return;
    memberDrawerTriggerRef.current = null;
    setMemberDrawerOpen(false);
    columnDeleteTriggerRef.current = trigger;
    setColumnDeleteId(id);
  };

  const closeColumnDelete = useCallback(() => {
    const trigger = columnDeleteTriggerRef.current;
    columnDeleteTriggerRef.current = null;
    setColumnDeleteId(null);
    restoreFocusSoon(trigger);
  }, []);
  const closeArchive = useCallback(() => {
    const trigger = archiveTriggerRef.current;
    archiveTriggerRef.current = null;
    setArchiveOpen(false);
    restoreFocusSoon(trigger);
  }, []);

  const closeMemberDrawer = useCallback(() => {
    const trigger = memberDrawerTriggerRef.current;
    memberDrawerTriggerRef.current = null;
    setMemberDrawerOpen(false);
    restoreFocusSoon(trigger);
  }, []);

  const closeFilterDialog = useCallback(() => {
    const trigger = filterDialogTriggerRef.current;
    filterDialogTriggerRef.current = null;
    setFilterDialogOpen(false);
    restoreFocusSoon(trigger);
  }, []);

  useEffect(() => {
    if (filterDialogOpen) {
      requestAnimationFrame(() => {
        filterDialogCloseBtnRef.current?.focus();
      });
    }
  }, [filterDialogOpen]);

  useEffect(() => {
    if (!filterDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeFilterDialog();
        return;
      }

      if (event.key === "Tab") {
        const dialogNode = filterDialogRef.current;
        if (!dialogNode) return;

        const focusableSelector =
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const focusableElements = Array.from(
          dialogNode.querySelectorAll<HTMLElement>(focusableSelector),
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
            !dialogNode.contains(document.activeElement)
          ) {
            event.preventDefault();
            lastElement.focus();
          }
        } else {
          if (
            document.activeElement === lastElement ||
            !dialogNode.contains(document.activeElement)
          ) {
            event.preventDefault();
            firstElement.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filterDialogOpen, closeFilterDialog]);
  useEffect(() => {
    if (memberDrawerOpen) {
      requestAnimationFrame(() => {
        memberDrawerCloseBtnRef.current?.focus();
      });
    }
  }, [memberDrawerOpen]);

  useEffect(() => {
    if (!memberDrawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMemberDrawer();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [memberDrawerOpen, closeMemberDrawer]);

  useEffect(() => {
    if (!memberDrawerOpen) return;
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        // Breakpoint resized to desktop (md): close drawer cleanly without restoring focus to the mobile-only trigger
        memberDrawerTriggerRef.current = null;
        setMemberDrawerOpen(false);
      }
    };
    if (mediaQuery.matches) {
      onChange(mediaQuery);
      return;
    }
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, [memberDrawerOpen]);

  // If another modal surface becomes active (URL-backed card navigation/history,
  // column delete dialog, or archive dialog), ensure the member drawer is closed
  // and its trigger ref cleared so focus is never restored to a hidden or invalid trigger.
  useEffect(() => {
    if (openCard !== undefined || columnToDelete !== undefined || archiveOpen) {
      if (memberDrawerOpen || memberDrawerTriggerRef.current !== null) {
        memberDrawerTriggerRef.current = null;
        setMemberDrawerOpen(false);
      }
      if (filterDialogOpen || filterDialogTriggerRef.current !== null) {
        filterDialogTriggerRef.current = null;
        setFilterDialogOpen(false);
      }
    }
  }, [openCard, columnToDelete, archiveOpen, memberDrawerOpen, filterDialogOpen]);
  const restoreArchivedCard = useCallback(
    (cardId: string, columnId: string): boolean => commands.restoreCard(cardId, columnId) === "sent",
    [commands],
  );
  const purgeArchivedCard = useCallback(
    (cardId: string): boolean => commands.purgeCard(cardId) === "sent",
    [commands],
  );


  const confirmColumnDelete = () => {
    if (!canManageColumns || columnDeleteId === null) return;
    // Gone already (a peer deleted it) closes too; only an unsent delete keeps the dialog.
    if (commands.deleteColumn(columnDeleteId) !== "not-sent") closeColumnDelete();
  };

  // Everything the shortcut listener reads changes identity on every render, so
  // it travels through a ref: the window listener is then bound exactly once.
  const shortcuts = useRef({
    openColumnCreate,
    openCardCreate,
    canManageColumns,
    toggleAssignedToMe,
    leftColumnId: columns[0]?.id,
    hasColumns: columns.length > 0,
    interactionBlocked: false,
  });
  // Deliberately a ref of its own rather than a field on `shortcuts.current`:
  // the sync effect above reassigns that object on every render, and a lift
  // re-renders (isDragging) mid-drag, which would clobber the flag.
  const dragActive = useRef(false);
  useEffect(() => {
    shortcuts.current = {
      openColumnCreate,
      openCardCreate,
      canManageColumns,
      toggleAssignedToMe,
      leftColumnId: columns[0]?.id,
      hasColumns: columns.length > 0,
      interactionBlocked,
    };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A held-down key must open one dialog, not one per repeat.
      if (event.repeat) return;
      if (
        event.key !== "n" &&
        event.key !== "c" &&
        event.key !== "m" &&
        event.key !== "/"
      )
        return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "m" && event.shiftKey) return;
      // Typing must never trigger a shortcut, and any open dialog owns the keyboard.
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      }
      const {
        openColumnCreate: requestColumn,
        openCardCreate: requestCard,
        canManageColumns,
        toggleAssignedToMe: toggleAssigned,
        leftColumnId,
        hasColumns,
        interactionBlocked,
      } = shortcuts.current;
      if (interactionBlocked) return;
      // A keyboard drag owns the keyboard: board shortcuts must not fire mid-lift.
      if (dragActive.current) return;

      if (event.key === "m") {
        event.preventDefault();
        toggleAssigned();
        return;
      }

      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (event.key === "c") {
        if (!canManageColumns) return;
        event.preventDefault();
        requestColumn(null);
        return;
      }
      // "n" opens the first column's creation dialog — a plain no-op while the
      // board has no column to put a card in.
      if (leftColumnId === undefined || !hasColumns) return;
      event.preventDefault();
      requestCard(leftColumnId, null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const closeShortcuts = useCallback(() => {
    setShortcutsOpen(false);
    restoreFocusSoon(shortcutsButtonRef.current);
  }, []);

  const handleDragStart = ({ active }: DragStartEvent) => {
    const dragType =
      active.data.current?.type ??
      (state?.columns.some((column) => column.id === active.id) ? "column" : "card");
    if (dragType === "column" && !canManageColumns) return;
    keyboardColumnTargetRef.current = null;
    keyboardCardTargetRef.current = null;
    pointerDropSideRef.current = undefined;
    dragActive.current = true;
    setActiveDragId(String(active.id));
    setDropHint(null);
  };

  const handleDragOver = ({ active, over }: DragOverEvent | DragMoveEvent) => {
    const next = state && over && active.data.current?.type === "card"
      ? resolveCardDrop(state, hierarchy, String(active.id), String(over.id), pointerDropSideRef.current)?.hint ?? null
      : null;
    // Pointer moves fire constantly; an equal hint must not re-render the board.
    setDropHint(prev => (prev?.cardId === next?.cardId && prev?.placement === next?.placement ? prev : next));
  };

  const handleDragCancel = () => {
    dragActive.current = false;
    setActiveDragId(null);
    setDropHint(null);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    dragActive.current = false;
    setActiveDragId(null);
    setDropHint(null);
    if (!state || !over) return;

    const dragType =
      active.data.current?.type ??
      (state.columns.some((col) => col.id === active.id) ? "column" : "card");

    if (dragType === "column") {
      if (!canManageColumns) return;
      const columnId = String(active.id);
      const keyboardTarget = keyboardColumnTargetRef.current;
      keyboardColumnTargetRef.current = null;
      let overId = keyboardTarget ?? String(over.id);
      if (overId.startsWith("column-drop:")) {
        overId = overId.slice("column-drop:".length);
      }
      // If dropped over a card, find which column that card belongs to
      const overCard = state.cards.find((c) => c.id === overId);
      if (overCard) {
        overId = overCard.columnId;
      }

      if (columnId === overId) return;

      commands.moveColumn(columnId, overId);
      return;
    }
    const cardId = String(active.id);
    const drop = resolveCardDrop(state, hierarchy, cardId, keyboardCardTargetRef.current ?? String(over.id), pointerDropSideRef.current);
    keyboardCardTargetRef.current = null;
    if (!drop) return;
    requestCardMove(cardId, drop);
  };

  // Membership and accessibility are verified before BoardView mounts; WebSocket
  // connection failure offers retry. A pending access change keeps the board
  // mounted: an unsent card draft must survive until access is definitively gone.
  //
  // The route's authoritative read says the server has fenced this board, so the
  // mounted snapshot is stale: it is hidden until the change is released rather
  // than replaced, because replacing it is what discarded an unsent draft. The
  // socket's own transition means the same thing and keeps the board visible
  // under the same banner.
  const connectionLabel = signedOut
    ? "You were signed out."
    : accessState === "transitioning" ? "Updating access…" : connected ? "Live" : handshakeFailed ? "Could not connect." : "reconnecting…";
  const accessFenced = accessChangePending && state !== undefined;
  const accessChanging = accessFenced || (accessState === "transitioning" && state !== undefined);
  if (accessState === "denied") {
    return <div className="route-state"><p>You no longer have access to this board.</p><Link to="/" className={buttonVariants({ variant: "link" })}>Back to Home</Link></div>;
  }
  // The session ended (ADR 0082) and the redirect to /login may have been cancelled by an unsent draft's leave prompt: say so rather than reconnect.
  if (signedOut && !state) {
    return <div className="route-state"><p>You were signed out.</p><a href="/login" className={buttonVariants({ variant: "link" })}>Sign in</a></div>;
  }
  if (handshakeFailed && !state) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-background text-foreground">
        <p className="text-sm text-foreground">Could not connect.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            retry();
          }}
        >
          Retry
        </Button>
        <Link to="/" className={buttonVariants({ variant: "link", className: "text-sm" })}>
          Back to boards
        </Link>
      </div>
    );
  }
  return (
    <>
      {finishIntent && state && <FamilyCompletionDialog
        title={state.cards.find(card => card.id === finishIntent.id)?.title ?? "Unavailable parent"}
        count={finishActive ? finishPendingCount : completionFamily(state, finishIntent.id).open.length}
        pending={finishActive}
        error={finishError ?? (!state.cards.some(card => card.id === finishIntent.id && card.columnId === finishIntent.sourceColumnId && card.position === finishIntent.sourcePosition) ? "Parent moved or became unavailable. Cancel and review again." : !state.columns.some(column => column.id === finishIntent.columnId && column.completed) ? "Completed status changed. Cancel and review again." : !connected ? "Not connected — wait for reconnection." : null)}
        disabled={!connected || !state.cards.some(card => card.id === finishIntent.id && card.columnId === finishIntent.sourceColumnId && card.position === finishIntent.sourcePosition) || !state.columns.some(column => column.id === finishIntent.columnId && column.completed)}
        onChoose={chooseFinish} onCancel={closeFinish} onRetry={handshakeFailed ? retry : undefined}
      />}
      <AppShell
        breadcrumb="Boards"
        board={{ id: meta.id, name: meta.name, workspaceId: meta.workspaceId, workspaceName: meta.workspaceName }}
        overlayOpen={workspaceOverlayOpen}
        overlays={<>
          {columnCreateOpen && (
            <ColumnCreateDialog
              isPending={creationPending}
              error={creationError}
              connected={connected}
              handshakeFailed={handshakeFailed}
              onRetryConnection={retry}
              canManageColumns={canManageColumns}
              onCancel={closeColumnCreate}
              onCreate={createColumn}
            />
          )}
          {cardCreateColumnId !== null && (
            <CardCreateDialog
              boardName={meta.name}
              columns={columns}
              initialColumnId={cardCreateColumnId}
              members={memberList}
              membersLoading={members.isPending}
              membersError={members.isError}
              onRetryMembers={() => void members.refetch()}
              isPending={creationPending}
              error={creationError}
              connected={connected}
              handshakeFailed={handshakeFailed}
              onRetryConnection={retry}
              onCancel={closeCardCreate}
              onCreate={createCard}
            />
          )}
          {canManageColumns && state && workflowSettingsOpen && (
            <WorkflowSettings state={state} commands={commands} connected={connected} onClose={closeWorkflowSettings} />
          )}
          {shortcutsOpen && (
            <KeyboardShortcutsDialog canManageColumns={canManageColumns} onClose={closeShortcuts} />
          )}
        </>}
      >
      {accessChanging && (
        <p role="status" className="board-access-transition">Board access is changing… Your unsent drafts remain available while access is checked.</p>
      )}
      <div className="board-page-body" hidden={accessFenced}>
      {meta.viaWorkspaceAdmin && (
        <p role="note" className="board-admin-note">You are here as a workspace admin. You were not added to this Private board.</p>
      )}
      <header className="board-header">
        <div className="board-identity">
          <span className="board-identity-tile" data-board-color={meta.color}>
            <BoardAppearanceIcon icon={meta.icon} color={meta.color} />
          </span>
          <div className="board-identity-text">
            <h1 className="board-identity-name" title={meta.name}>{meta.name}</h1>
            <span className="board-identity-key">{meta.key}</span>
          </div>
          <div className="board-connection">
            <span className="board-connection-rule" aria-hidden="true" />
            <span
              className={cn(
                "board-connection-state",
                connected
                  ? "board-connection-live"
                  : handshakeFailed || signedOut
                    ? "board-connection-failed"
                    : "board-connection-pending",
              )}
              title={connectionLabel}
            >
              {connected && <span className="board-connection-dot" aria-hidden="true" />}
              {connectionLabel}
            </span>
            {signedOut && (
              <a href="/login" className={buttonVariants({ variant: "outline", size: "xs", className: "board-connection-retry" })}>
                Sign in
              </a>
            )}
            {handshakeFailed && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={retry}
                className="board-connection-retry"
              >
                Retry
              </Button>
            )}
          </div>
          <div className="board-identity-actions">
            {canManageColumns && state && (
              <Button
                ref={workflowSettingsButtonRef}
                type="button"
                variant="ghost"
                size="xs"
                aria-label="Workflow settings"
                aria-haspopup="dialog"
                onClick={() => setWorkflowSettingsOpen(true)}
                className="board-workflow-button"
              >
                <Settings2 aria-hidden="true" />
                <span className="board-label-desktop">Workflow settings</span>
                <span className="board-label-mobile">Workflow</span>
              </Button>
            )}
            {/* The rail toggle on a wide viewport, the drawer trigger below it:
                one control whose name and popup follow which one it drives. */}
            <Button
              type="button"
              variant={wideViewport && desktopRailVisible ? "secondary" : "ghost"}
              size="xs"
              aria-label={
                wideViewport
                  ? desktopRailVisible
                    ? "Hide board members"
                    : "Show board members"
                  : undefined
              }
              aria-haspopup={wideViewport ? undefined : "dialog"}
              aria-expanded={wideViewport ? desktopRailVisible : memberDrawerOpen}
              onClick={(event) => {
                if (wideViewport) {
                  toggleDesktopRail();
                  return;
                }
                setShortcutsOpen(false);
                setFilterDialogOpen(false);
                archiveTriggerRef.current = null;
                setArchiveOpen(false);
                memberDrawerTriggerRef.current = event.currentTarget;
                setMemberDrawerOpen(true);
              }}
              className="board-members-button"
            >
              {members.isSuccess && memberList.length > 0
                ? `Members · ${memberList.length}`
                : "Members"}
            </Button>
            <Button
              ref={newCardButtonRef}
              type="button"
              disabled={columns.length === 0}
              title={columns.length === 0 ? "Add a column before creating a card." : undefined}
              onClick={(event) => openCardCreate(columns[0]!.id, event.currentTarget)}
              className="board-new-card"
            >
              <Plus aria-hidden="true" />
              New card
            </Button>
          </div>
        </div>
        <div className="board-toolbar">
          <label className="board-search">
            <Search aria-hidden="true" className="board-search-icon" />
          <Input
            ref={searchInputRef}
            type="search"
            aria-label="Search cards"
            placeholder="Search cards…"
            value={qParam ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              void navigate({
                search: (prev) => ({ ...prev, q: value === "" ? undefined : value }),
                replace: true,
                resetScroll: false,
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (event.currentTarget.value !== "") {
                  void navigate({
                    search: (prev) => ({ ...prev, q: undefined }),
                    replace: true,
                    resetScroll: false,
                  });
                } else {
                  event.currentTarget.blur();
                }
              }
            }}
            className="board-search-input"
          />
            <kbd className="board-keycap" aria-hidden="true">/</kbd>
          </label>
          {currentUser !== undefined && currentUser !== null && (
            <Button
              type="button"
              variant={assignedToMeActive ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={assignedToMeActive}
              aria-label="Assigned to me"
              aria-keyshortcuts="m"
              onClick={toggleAssignedToMe}
              className={cn(
                "board-toolbar-button",
                assignedToMeActive ? "board-toolbar-button-on" : undefined,
              )}
            >
              <UserRound aria-hidden="true" />
              <span className="board-label-desktop">Assigned to me</span>
              <span className="board-label-mobile">Mine</span>
              <kbd className="board-keycap" aria-hidden="true">M</kbd>
            </Button>
          )}
          <Button
            type="button"
            variant={activeFilterCount > 0 ? "secondary" : "ghost"}
            size="sm"
            aria-label="Filter cards"
            aria-haspopup="dialog"
            aria-expanded={filterDialogOpen}
            onClick={(event) => {
              setShortcutsOpen(false);
              archiveTriggerRef.current = null;
              setArchiveOpen(false);
              filterDialogTriggerRef.current = event.currentTarget;
              setFilterDialogOpen(true);
            }}
            className={cn(
              "board-toolbar-button",
              activeFilterCount > 0 ? "board-toolbar-button-on" : undefined,
            )}
          >
            <SlidersHorizontal aria-hidden="true" />
            <span>{`Filters${activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}`}</span>
          </Button>
          {/* Real state only: a pending or failed snapshot reports no count at all
              rather than a fabricated zero. */}
          {state !== undefined && (
            <span
              className={cn(
                "board-toolbar-count",
                isFilterActive ? undefined : "board-toolbar-count-wide-only",
              )}
            >
              {`${matchingCardCount} of ${totalCardCount} cards`}
            </span>
          )}
          <div className="board-toolbar-actions">
            <Button
              ref={archiveTriggerRef}
              type="button"
              variant={archivedCount > 0 ? "secondary" : "ghost"}
              size="sm"
              aria-label="Archived cards"
              aria-haspopup="dialog"
              aria-expanded={archiveOpen}
              onClick={(event) => {
                setShortcutsOpen(false);
                setFilterDialogOpen(false);
                memberDrawerTriggerRef.current = null;
                setMemberDrawerOpen(false);
                archiveTriggerRef.current = event.currentTarget;
                setArchiveOpen(true);
              }}
              className={cn(
                "board-toolbar-button",
                archivedCount > 0 ? "board-toolbar-button-on" : undefined,
              )}
            >
              <Archive aria-hidden="true" />
              <span>Archive{archivedCount > 0 ? ` ${archivedCount}` : ""}</span>
            </Button>
            <Button
              ref={shortcutsButtonRef}
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Keyboard shortcuts"
              aria-haspopup="dialog"
              aria-expanded={shortcutsOpen}
              onClick={() => {
                setFilterDialogOpen(false);
                setShortcutsOpen(true);
              }}
              className="board-toolbar-button board-toolbar-help"
            >
              <CircleHelp aria-hidden="true" />
            </Button>
          </div>
        </div>
        {/* Active-filter status: the zero-result message and the one clear action.
            The match count itself lives in the toolbar, so it is never stated twice. */}
        {isFilterActive && state && (
          <div className="board-filter-status">
            <span role="status" className="board-filter-status-text">
              {matchingCardCount === 0 ? "No cards match the active filters." : ""}
            </span>
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={clearAllFilters}
              className="board-filter-clear"
            >
              Clear filters
            </Button>
          </div>
        )}
      </header>
      {/* Board canvas and the desktop presence rail */}
      <div className="board-page-canvas">
        {/* Kanban viewport */}
        <div ref={canvasRef} className="board-canvas">
          {state === undefined ? (
            <p className="text-sm text-muted-foreground">loading board…</p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={(args) => {
                const point = args.pointerCoordinates;
                const canvas = canvasRef.current?.getBoundingClientRect();
                if (point && canvas && (point.x < Math.max(0, canvas.left) || point.x > Math.min(window.innerWidth, canvas.right) || point.y < Math.max(0, canvas.top) || point.y > Math.min(window.innerHeight, canvas.bottom))) return [];
                const isColDrag =
                  args.active.data.current?.type === "column" ||
                  state.columns.some((c) => c.id === args.active.id);
                if (isColDrag) {
                  // For column drags, evaluate closestCenter against column sortable containers
                  const columnDroppables = args.droppableContainers.filter(
                    (d) =>
                      d.data.current?.type === "column" ||
                      state.columns.some((c) => c.id === d.id),
                  );
                  return closestCenter({
                    ...args,
                    droppableContainers: columnDroppables,
                  });
                }
                if (!args.pointerCoordinates && keyboardCardTargetRef.current) {
                  return [{ id: keyboardCardTargetRef.current }];
                }
                const cardTargets = args.droppableContainers.filter(container => container.data.current?.type === "card");
                const onCard = pointerWithin({ ...args, droppableContainers: cardTargets });
                const targetSide = (id: string | number) => {
                  const rect = args.droppableRects.get(id);
                  const distance = point && rect ? point.y - (rect.top + rect.height / 2) : 0;
                  // An exact centre retains the board's directional default;
                  // avoid pixel-rounding deciding before/after accidentally.
                  pointerDropSideRef.current = Math.abs(distance) <= 1 ? undefined : distance < 0 ? "before" : "after";
                };
                if (onCard.length) { targetSide(onCard[0]!.id); return onCard; }
                const columnTargets = args.droppableContainers.filter(container => String(container.id).startsWith("column-drop:"));
                if (point) {
                  const sections = args.droppableContainers.filter(container => container.data.current?.type === "column");
                  const inColumn = pointerWithin({ ...args, droppableContainers: columnTargets });
                  const hits = inColumn.length ? inColumn : pointerWithin({ ...args, droppableContainers: sections });
                  const hit = hits[0];
                  if (!hit) return [];
                  const columnId = String(hit.id).replace("column-drop:", "");
                  const candidates = cardTargets.filter(container => boardIndex?.cardsById.get(String(container.id))?.columnId === columnId);
                  const tail = Math.max(...candidates.map(container => args.droppableRects.get(container.id)?.bottom ?? -Infinity));
                  // Interior whitespace picks its nearest body boundary. Only the
                  // real tail/empty column appends, including hidden filtered tails.
                  if (candidates.length && inColumn.length && point.y < tail) {
                    const nearest = closestCenter({ ...args, collisionRect: { ...args.collisionRect, left: point.x, top: point.y, width: 0, height: 0 }, droppableContainers: candidates });
                    if (nearest[0]) { targetSide(nearest[0].id); return nearest; }
                  }
                  pointerDropSideRef.current = undefined;
                  return hits;
                }
                return closestCorners({ ...args, droppableContainers: [...cardTargets, ...columnTargets] });
              }}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragMove={handleDragOver}
              onDragCancel={handleDragCancel}
              onDragEnd={handleDragEnd}
            >
              {/* Columns reorder along their own axis: a row on desktop, a stack
                  below it, so a keyboard lift's arrows follow what is on screen. */}
              <SortableContext
                items={columns.map((c) => c.id)}
                strategy={stackedColumns ? verticalListSortingStrategy : horizontalListSortingStrategy}
              >
                <div className="board-columns">
                {columns.map((column) => {
                  return (
                    <ColumnView
                      key={column.id}
                      column={column}
                      dropHint={dropHint}
                      canManageColumns={canManageColumns}
                      cards={renderedRootsIn(column.id)}
                      totalCardCount={columnCards(state, column.id).length}
                      matchingCardCount={
                        visible === null
                          ? columnCards(state, column.id).length
                          : columnCards(state, column.id).filter((card) =>
                              visible.has(card.id),
                            ).length
                      }
                      isFilterActive={isFilterActive}
                      index={boardIndex!}
                      state={state}
                      hierarchy={hierarchy}
                      collapsedSubtasks={renderedCollapsed}
                      visibleCardIds={visible}
                      membersById={membersById}
                      boardKey={meta.key}
                      pullRequestBadges={pullRequestBadges}
                      commands={commands}
                      onOpenCard={openCardFromBoard}
                      onToggleSubtasks={toggleSubtasks}
                      onRequestDelete={(trigger) => openColumnDelete(column.id, trigger)}
                      onAddCard={(trigger) => openCardCreate(column.id, trigger)}
                    />
                  );
                })}
                {canManageColumns ? (
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Add column"
                  onClick={(event) => openColumnCreate(event.currentTarget)}
                  className="board-add-column"
                >
                  <Plus aria-hidden="true" />
                  <span>Add column</span>
                  <kbd className="board-keycap" aria-hidden="true">C</kbd>
                </Button>
                ) : columns.length === 0 ? (
                  <p className="board-columns-empty">
                    No columns yet. Ask a board owner or admin to add one.
                  </p>
                ) : null}
                </div>
              </SortableContext>
              {createPortal(
                <DragOverlay adjustScale={false} dropAnimation={null} zIndex={40}>
                  <div className="board-drag-overlay">
                  {previewFaceProps ? (
                    <div
                      aria-hidden="true"
                      data-testid="card-drag-preview"
                      className="board-card-drag-preview"
                    >
                      <CardFace {...previewFaceProps} className="cursor-grabbing" />
                    </div>
                  ) : previewColumn ? (
                    <div
                      aria-hidden="true"
                      data-testid="column-drag-preview"
                      className="board-column board-column-preview"
                    >
                      <div className="board-column-title">{previewColumn.title}</div>
                    </div>
                  ) : null}
                  </div>
                </DragOverlay>,
                document.body,
              )}
            </DndContext>
        )}
        </div>
        {/* Desktop member rail */}
        {desktopRailVisible && (
          <aside
            aria-label="Board members"
            className="board-member-rail"
          >
            <div className="board-member-rail-heading">
              Board members{memberList.length > 0 ? ` (${memberList.length})` : ""}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <MemberSidebar membersQuery={members} ownerId={meta.ownerId} />
            </div>
          </aside>
        )}
      </div>
      </div>
      </AppShell>

      {/* Mobile member drawer */}
      {memberDrawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end md:hidden">
          <div
            className="fixed inset-0 bg-background/80 backdrop-blur-xs"
            onClick={closeMemberDrawer}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Board members"
            className="relative z-50 flex h-full w-72 max-w-[80vw] flex-col border-l border-border bg-card text-card-foreground shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border p-3">
              <span className="text-xs font-semibold text-foreground">
                Board members{memberList.length > 0 ? ` (${memberList.length})` : ""}
              </span>
              <Button
                ref={memberDrawerCloseBtnRef}
                type="button"
                size="xs"
                onClick={closeMemberDrawer}
                aria-label="Close board members"
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                ✕
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <MemberSidebar membersQuery={members} ownerId={meta.ownerId} />
            </div>
          </div>
        </div>
      )}
      {/* One filter dialog for every width: a bottom sheet on a phone, a centered
          panel above it. Its contents are the same on both. */}
      {filterDialogOpen && (
        <div className="board-filter-overlay">
          <div
            className="board-filter-backdrop"
            onClick={closeFilterDialog}
            aria-hidden="true"
          />
          <div
            ref={filterDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Filter cards"
            className="board-filter-dialog"
          >
            <div className="board-filter-dialog-heading">
              <span>Filter cards</span>
              <Button
                ref={filterDialogCloseBtnRef}
                type="button"
                variant="ghost"
                size="xs"
                onClick={closeFilterDialog}
                aria-label="Close filter cards"
              >
                ✕
              </Button>
            </div>
            <div className="board-filter-dialog-body">
              {/* Labels filter section */}
              <div>
                <h2 className="board-filter-group-heading">
                  Labels
                </h2>
                <div className="flex flex-col gap-1">
                  {filterLabels.length === 0 ? (
                    <p className="py-1 text-xs text-muted-foreground">No labels on this board yet.</p>
                  ) : (
                    filterLabels.map((label) => (
                      <button
                        key={label.id}
                        type="button"
                        aria-label={`Filter by label ${label.name}`}
                        aria-pressed={filterTokens.includes(label.id)}
                        onClick={() => toggleFilterToken(label.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-card-foreground hover:bg-accent hover:text-accent-foreground pointer-coarse:min-h-11"
                      >
                        <span className={`size-3.5 rounded ${LABEL_COLOR_META[label.color].swatch}`} />
                        <span className="min-w-0 flex-1 truncate">{label.name}</span>
                        {filterTokens.includes(label.id) && (
                          <Check aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                        )}
                      </button>
                    ))
                  )}
                  <button
                    type="button"
                    aria-label="Filter by no label"
                    aria-pressed={filterTokens.includes(UNLABELED_FILTER)}
                    onClick={() => toggleFilterToken(UNLABELED_FILTER)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-card-foreground hover:bg-accent hover:text-accent-foreground pointer-coarse:min-h-11"
                  >
                    <span className="size-3.5 rounded border border-dashed border-input" />
                    <span className="min-w-0 flex-1 truncate">No label</span>
                    {filterTokens.includes(UNLABELED_FILTER) && (
                      <Check aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                </div>
              </div>

              {/* Assignees filter section */}
              <div>
                <h2 className="board-filter-group-heading">
                  Assignees
                </h2>
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    aria-label="Filter by unassigned"
                    aria-pressed={selectedAssigneeTokens.has(UNASSIGNED_FILTER)}
                    onClick={() => toggleAssigneeFilterToken(UNASSIGNED_FILTER)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-card-foreground hover:bg-accent hover:text-accent-foreground pointer-coarse:min-h-11"
                  >
                    <span
                      aria-hidden
                      className="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-input"
                    />
                    <span className="min-w-0 flex-1 truncate">Unassigned</span>
                    {selectedAssigneeTokens.has(UNASSIGNED_FILTER) && (
                      <Check aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                  {members.isPending ? (
                    <p role="status" className="py-1 text-xs text-muted-foreground">
                      Loading board members…
                    </p>
                  ) : members.isError ? (
                    <div role="alert" className="flex items-center gap-2 py-1 text-xs text-destructive">
                      <span>Could not load board members.</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => void members.refetch()}
                        className="h-auto px-2 py-1 text-xs pointer-coarse:min-h-11"
                      >
                        Retry
                      </Button>
                    </div>
                  ) : memberList.length === 0 ? (
                    <p className="py-1 text-xs text-muted-foreground">No board members.</p>
                  ) : (
                    memberList.map((member) => (
                      <button
                        key={member.id}
                        type="button"
                        aria-pressed={selectedAssigneeTokens.has(member.id)}
                        onClick={() => toggleAssigneeFilterToken(member.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-card-foreground hover:bg-accent hover:text-accent-foreground pointer-coarse:min-h-11"
                      >
                        <Avatar
                          name={member.name}
                          githubLogin={member.githubLogin}
                          avatarVersion={member.avatarVersion}
                          userId={member.id}
                        />
                        <span className="min-w-0 flex-1 truncate">{member.name}</span>
                        {selectedAssigneeTokens.has(member.id) && (
                          <Check aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
            {activeLabelFilterCount + activeAssigneeFilterCount > 0 && (
              <div className="board-filter-dialog-footer">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearAllFilters}
                  className="w-full text-sm pointer-coarse:min-h-11"
                >
                  Clear filters
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      {columnToDelete && state && (
        <ColumnDeleteDialog
          columnTitle={columnToDelete.title}
          cardCount={columnCards(state, columnToDelete.id).length}
          onCancel={closeColumnDelete}
          onConfirm={confirmColumnDelete}
        />
      )}
      {archiveOpen && state && (
        <CardArchiveDialog
          archivedCards={state.archivedCards}
          columns={state.columns}
          boardKey={meta.key}
          onClose={closeArchive}
          onRestore={restoreArchivedCard}
          onPurge={purgeArchivedCard}
        />
      )}
      {state && openCard && !columnToDelete && !archiveOpen && (
        <CardModal
          key={openCard.id}
          card={openCard}
          boardId={boardId}
          boardKey={meta.key}
          items={cardChecklist(state, openCard.id)}
          attachments={cardAttachments(state, openCard.id)}
          boardAttachments={boardAttachments}
          uploadScope={authored}
          comments={cardComments(state, openCard.id)}
          commentsRead={{
            count: state.commentCounts[openCard.id] ?? 0,
            status: commentsQuery.status,
            retry: () => void commentsQuery.refetch(),
          }}
          relations={cardRelations(state, openCard.id, activeCardIds)}
          hierarchy={hierarchy}
          labels={state.labels}
          cardLabels={cardLabelViews(state, openCard.id)}
          cards={state.cards}
          columns={columns}
          onRequestMove={(id, columnId, trigger) => requestCardMove(id, { columnId }, trigger)}
          onOpenCard={openFromCard}
          members={memberList}
          membersLoading={members.isPending}
          membersError={members.isError}
          onRetryMembers={() => void members.refetch()}
          send={sendMutation}
          subscribeMutation={subscribeMutation}
          retireTrackedMutation={retireTrackedMutation}
          connected={connected}
          handshakeFailed={handshakeFailed}
          onRetryConnection={retry}
          onClose={closeCard}
          onDirtyChange={(isDirty: boolean) => {
            setDirtyCardId(isDirty ? openCard.id : null);
          }}
          onRegisterDiscardPrompt={(triggerPrompt) => {
            cardModalDiscardRef.current = triggerPrompt;
          }}
          onConfirmBlockedNavigation={() => {
            isDiscardingRef.current = true;
            setDirtyCardId(null);
            blocker.proceed?.();
            setTimeout(() => {
              isDiscardingRef.current = false;
            }, 100);
          }}
          onCancelBlockedNavigation={() => {
            blocker.reset?.();
          }}
          view={view === "full" ? "full" : "modal"}
          onViewChange={setCardView}
          openAttachmentId={attachmentParam}
          onOpenAttachment={openAttachment}
          onCloseAttachment={closeAttachment}
          onTransferSuccess={(_destBoardId, destBoardKey, _destCardId, destTaskNumber) => {
            queryClient.invalidateQueries({ queryKey: ["boards"] });
            queryClient.removeQueries({ queryKey: boardQueryKey(boardId) });
            void navigate({
              to: "/board/$boardKey",
              params: { boardKey: destBoardKey },
              search: {
                card: `${destBoardKey}-${destTaskNumber}`,
              },
              resetScroll: false,
            });
          }}
        />
      )}
    </>
  );
}
