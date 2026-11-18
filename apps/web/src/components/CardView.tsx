import {
  Ban,
  Bug,
  CalendarDays,
  CornerDownRight,
  GitPullRequest,
  GripVertical,
  Layers,
  Link,
  ListChecks,
  MessageSquare,
  Paperclip,
  Play,
  SquareCheck,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useRef, type MouseEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { useDndMonitor } from "@dnd-kit/core";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import type { Card, Label, TaskType } from "@foxban/shared";
import type { Member } from "../lib/api";
import { cardFace, type BoardIndex } from "../lib/apply-mutation";
import { PRIORITY_META } from "../lib/priority";
import { DUE_STATE_META, dueState, formatDueDate, parseDueDate } from "../lib/due-date";
import { LABEL_COLOR_META } from "../lib/labels";
import { isBlocked, nonSubtaskLinks } from "../lib/relations";
import { DEVELOPMENT_STATE_META, type CardPullRequestBadge } from "../lib/card-development";
import { Avatar, AVATAR_CLASS } from "./Avatar";
import { taskKey } from "../lib/task-key";
import { hasYouTubeVideo } from "../lib/youtube";
import { TASK_TYPE_META } from "../lib/task-type";
import { cn } from "../lib/utils";

/**
 * The one icon per task type on a card front. Exhaustive over `TaskType`: a new
 * type cannot ship without an icon, and the shared type metadata (used by the
 * pickers) stays untouched.
 */
const CARD_TYPE_ICON: Record<TaskType, LucideIcon> = {
  epic: Layers,
  subtask: CornerDownRight,
  spike: Zap,
  task: SquareCheck,
  bug: Bug,
};

export type CardFaceProps = {
  card: Card;
  checklistDone: number;
  checklistTotal: number;
  attachmentCount: number;
  commentCount: number;
  relationCount: number;
  /** Some other card `blocks` this one: the badge turns into a red blocked badge. */
  blocked: boolean;
  /** This card's labels, name-sorted; parent-computed like every other prop. */
  labels: Label[];
  /** Undefined while the members query is still in flight, or if it failed. */
  assignee: Member | undefined;
  boardKey?: string;
  hasVideo: boolean;
  /** The card's pull request state (ADR 0064), or null when it has none to show. */
  pullRequest?: CardPullRequestBadge | null;
  /**
   * This card's subtask family — the disclosure footer and its rows — rendered
   * inside the card's own border below the body. Composed by the caller from the
   * one shared hierarchy, because only the board knows what is expanded.
   */
  subtaskContent?: React.ReactNode;
};

export function getCardFaceProps(
  index: BoardIndex,
  card: Card,
  membersById: Record<string, Member | undefined>,
  boardKey?: string,
  pullRequest?: CardPullRequestBadge | null,
): CardFaceProps {
  const face = cardFace(index, card.id);
  return {
    card,
    checklistDone: face.checklistDone,
    checklistTotal: face.checklistTotal,
    attachmentCount: face.attachmentCount,
    commentCount: face.commentCount,
    relationCount: nonSubtaskLinks(face.relations).length,
    blocked: isBlocked(face.relations, card.id),
    labels: face.labels,
    assignee: card.assigneeId === null ? undefined : membersById[card.assigneeId],
    boardKey,
    hasVideo: hasYouTubeVideo(card.description),
    pullRequest,
  };
}

/**
 * The live card's focusable body: dnd-kit owns the node, the drag attributes and
 * the sensors, and a stationary click or Enter opens the card. It is the parent
 * card's only interactive region, so a subtask control inside the same visual
 * card is never a descendant of it.
 */
type CardBodyActivator = {
  ref: (node: HTMLDivElement | null) => void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  onOpen: (event?: MouseEvent<HTMLDivElement>) => void;
  onPointerDownCapture: () => void;
  isDragging: boolean;
};

export function CardFace({
  card,
  checklistDone,
  checklistTotal,
  attachmentCount,
  commentCount,
  relationCount,
  blocked,
  labels,
  assignee,
  boardKey,
  hasVideo,
  pullRequest,
  subtaskContent,
  className,
  dragAffordance,
  activator,
}: CardFaceProps & {
  className?: string;
  dragAffordance?: React.ReactNode;
  activator?: CardBodyActivator;
}) {
  // Precomputed rather than derived inline: the badge needs the urgency state,
  // the short text, and the full date, and `card.dueDate` narrows only here.
  const due =
    card.dueDate === null
      ? null
      : {
          state: dueState(card.dueDate),
          text: formatDueDate(card.dueDate),
          full: parseDueDate(card.dueDate).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
        };
  const TypeIcon = CARD_TYPE_ICON[card.taskType];
  // The pull request badge is icon-only (plus a count when there are several), so its
  // state comes from the same map Development uses and its wording from the badge itself.
  const pullRequestMeta = pullRequest == null ? null : DEVELOPMENT_STATE_META[pullRequest.state];
  const PullRequestIcon = pullRequestMeta?.icon ?? GitPullRequest;

  return (
    <div
      data-task-type={card.taskType}
      className={cn("board-card", className)}
    >
      {/* The card body is the parent's whole interactive surface: dnd-kit's
          listeners live here, and the subtask family below is a sibling — never
          a descendant of a role=button — so a child control cannot lift or open
          the parent. */}
      <div
        ref={activator?.ref}
        {...(activator?.attributes ?? {})}
        {...(activator?.listeners ?? {})}
        data-card-id={activator === undefined ? undefined : card.id}
        data-card-body={activator === undefined ? undefined : card.id}
        onPointerDownCapture={activator?.onPointerDownCapture}
        onClick={activator?.onOpen}
        onKeyDown={
          activator === undefined
            ? undefined
            : (event) => {
                if (event.target === event.currentTarget && event.key === "Enter" && !activator.isDragging) {
                  event.preventDefault();
                  activator.onOpen();
                  return;
                }
                activator.listeners?.onKeyDown?.(event);
              }
        }
        className={cn(
          "board-card-body",
          activator !== undefined && "board-card-body-live",
        )}
      >
        <div className="board-card-main">
          <div className="board-card-top">
            <span data-testid="task-type-badge" className="board-card-type">
              <TypeIcon aria-hidden="true" className="board-card-type-icon" />
              {TASK_TYPE_META[card.taskType].label}
            </span>
            {boardKey && card.taskNumber > 0 && (
              <span data-testid="task-key" className="board-card-key">{taskKey(boardKey, card.taskNumber)}</span>
            )}
            {dragAffordance}
          </div>
          <span data-card-title={card.title} className="board-card-title">
            {card.title}
          </span>
          {labels.length > 0 && (
            <div className="board-card-labels">
              {labels.map((label) => (
                <span
                  key={label.id}
                  data-testid="label-pill"
                  title={label.name}
                  className={`board-card-label label-chip ${LABEL_COLOR_META[label.color].pill}`}
                >
                  <span aria-hidden="true" className={`label-dot ${LABEL_COLOR_META[label.color].swatch}`} />
                  <span className="label-name">{label.name}</span>
                </span>
              ))}
            </div>
          )}
          {/* The due date keeps a row of its own: it is the one field whose
              urgency must not compete with the metadata icons beside it. */}
          {due !== null && (
            <span
              data-testid="due-badge"
              data-due-state={due.state}
              role="img"
              aria-label={`${DUE_STATE_META[due.state].prefix} ${due.full}`}
              title={`${DUE_STATE_META[due.state].prefix} ${due.full}`}
              className={cn("board-card-due", DUE_STATE_META[due.state].className)}
            >
              <CalendarDays aria-hidden="true" className="board-card-due-icon" />
              {DUE_STATE_META[due.state].label ? (
                <span>
                  {DUE_STATE_META[due.state].label} · {due.text}
                </span>
              ) : (
                <span>{due.text}</span>
              )}
            </span>
          )}
          <div className="board-card-footer">
            {/* Task metadata is separate; lower row starts with priority then risk/progress/context. */}
            <div data-testid="badge-row" className="board-card-badges">
              {(() => {
                const PriorityIcon = PRIORITY_META[card.priority].icon;
                return (
                  <span
                    data-testid="priority-badge"
                    role="img"
                    aria-label={`${PRIORITY_META[card.priority].label} priority`}
                    title={PRIORITY_META[card.priority].label}
                    className={cn("board-card-badge", PRIORITY_META[card.priority].className)}
                  >
                    <PriorityIcon aria-hidden="true" className="board-card-badge-icon" />
                  </span>
                );
              })()}
              {relationCount > 0 && (
                <span
                  data-testid="relation-badge"
                  data-blocked={blocked}
                  role="img"
                  aria-label={
                    blocked
                      ? `Blocked by another card; ${relationCount} linked card${relationCount === 1 ? "" : "s"}`
                      : `${relationCount} linked card${relationCount === 1 ? "" : "s"}`
                  }
                  title={blocked ? "Blocked by another card" : "Linked cards"}
                  className={cn("board-card-badge", blocked && "board-card-badge-blocked")}
                >
                  {blocked ? (
                    <Ban aria-hidden="true" className="board-card-badge-icon" />
                  ) : (
                    <Link aria-hidden="true" className="board-card-badge-icon" />
                  )}
                  <span>{relationCount}</span>
                </span>
              )}
              {checklistTotal > 0 && (
                <span
                  data-testid="checklist-badge"
                  role="img"
                  aria-label={`Checklist: ${checklistDone} of ${checklistTotal} done`}
                  title={`Checklist: ${checklistDone} of ${checklistTotal} done`}
                  className="board-card-badge"
                >
                  <ListChecks aria-hidden="true" className="board-card-badge-icon" />
                  <span>{`${checklistDone}/${checklistTotal}`}</span>
                </span>
              )}
              {pullRequest != null && pullRequestMeta !== null && (
                <span
                  data-testid="pr-badge"
                  role="img"
                  aria-label={pullRequest.label}
                  title={pullRequest.label}
                  className="board-card-badge"
                >
                  <PullRequestIcon aria-hidden="true" className="board-card-badge-icon" style={{ color: pullRequestMeta.color }} />
                  {pullRequest.count > 1 && <span>{pullRequest.count}</span>}
                </span>
              )}
              {commentCount > 0 && (
                <span
                  data-testid="comment-badge"
                  role="img"
                  aria-label={`${commentCount} comment${commentCount === 1 ? "" : "s"}`}
                  title="Comments"
                  className="board-card-badge"
                >
                  <MessageSquare aria-hidden="true" className="board-card-badge-icon" />
                  <span>{commentCount}</span>
                </span>
              )}
              {attachmentCount > 0 && (
                <span
                  data-testid="attachment-badge"
                  role="img"
                  aria-label={`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`}
                  title="Attachments"
                  className="board-card-badge"
                >
                  <Paperclip aria-hidden="true" className="board-card-badge-icon" />
                  <span>{attachmentCount}</span>
                </span>
              )}
              {hasVideo && (
                <span
                  data-testid="video-badge"
                  role="img"
                  aria-label="Has a YouTube video"
                  title="YouTube video"
                  className="board-card-badge"
                >
                  <Play aria-hidden="true" className="board-card-badge-icon" />
                </span>
              )}
            </div>
            {card.assigneeId !== null &&
              (assignee ? (
                <span
                  role="img"
                  aria-label={`Assigned to ${assignee.name}`}
                  title={assignee.name}
                  className="board-card-assignee"
                >
                  <Avatar
                    name={assignee.name}
                    githubLogin={assignee.githubLogin}
                    avatarVersion={assignee.avatarVersion}
                    userId={assignee.id}
                  />
                </span>
              ) : (
                <span className={cn("board-card-assignee", AVATAR_CLASS)}>?</span>
              ))}
          </div>
        </div>
      </div>
      {subtaskContent}
    </div>
  );
}

/** A click — single or double — opens the card modal, which owns renaming. */
export function CardView(props: CardFaceProps & { onOpen: (cardId: string) => void; dropPlacement?: "before" | "after" | "inside" }) {
  // A cancelled mouse/touch drag still owns its eventual release click. The
  // sensor's short document click guard can expire while the button is held.
  // Keep this gesture marked until its click or the next genuine pointerdown.
  const suppressPointerClick = useRef(false);
  useDndMonitor({
    onDragStart({ active, activatorEvent }) {
      if (active.id === props.card.id && activatorEvent.type !== "keydown") {
        suppressPointerClick.current = true;
      }
    },
  });
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useSortable({
    id: props.card.id,
    data: { type: "card" },
    // Families overlap in DOM geometry. Moving both an ancestor and child
    // compounds translations and clips children; keep source rows stationary.
    strategy: () => null,
  });
  const bodyRef = useCallback((node: HTMLDivElement | null) => { setNodeRef(node); setActivatorNodeRef(node); }, [setNodeRef, setActivatorNodeRef]);
  const { onOpen, dropPlacement, ...faceProps } = props;

  // Every synthetic listener (pointer/mouse, keyboard and touch) belongs to the
  // card's body region inside CardFace, not to an ancestor of the subtask rows:
  // a control in the family below must not be able to start a parent drag or
  // trigger the parent's click-to-open. Space is handled by KeyboardSensor (not
  // intercepted here), while Enter opens the modal.
  const dragAffordance = (
    <span
      data-card-drag-affordance
      aria-hidden="true"
      className="board-card-grip"
    >
      <GripVertical aria-hidden="true" />
    </span>
  );

  return (
    <li
      data-drop-placement={dropPlacement}
      className={cn("board-card-item", isDragging && "board-card-item-dragging")}
    >
      <CardFace
        {...faceProps}
        dragAffordance={dragAffordance}
        activator={{
          // Measure the task body, never its independently movable family.
          ref: bodyRef,
          attributes,
          listeners,
          isDragging,
          onPointerDownCapture: () => { suppressPointerClick.current = false; },
          onOpen: (event) => {
            if (event && event.detail > 0 && suppressPointerClick.current) {
              suppressPointerClick.current = false;
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            onOpen(props.card.id);
          },
        }}
      />
    </li>
  );
}
