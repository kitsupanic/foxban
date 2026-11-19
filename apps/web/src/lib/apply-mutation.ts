import type {
  ArchivedCard,
  Attachment,
  Card,
  CardLabel,
  CardRelation,
  ChecklistItem,
  ClientMessage,
  Column,
  Comment,
  Label,
} from "@foxban/shared";
import { removeAttachmentReferences, type SubtaskHierarchy } from "@foxban/shared";

/** The shape held in the `["board", boardId]` query cache. Populated solely by WS snapshots. */
export type BoardState = {
  /** False while the starting and completed columns follow the board's ends; true once an admin chose them. */
  workflowRolesExplicit: boolean;
  columns: Column[];
  cards: Card[];
  archivedCards: ArchivedCard[];
  checklistItems: ChecklistItem[];
  attachments: Attachment[];
  /**
   * Comments of the cards whose comments were read (ADR 0078), plus any created
   * live since: a cache for the card modal, not the board's full set.
   */
  comments: Comment[];
  /** Active comments per card, from the snapshot and kept live by comment frames; the card faces count from it. */
  commentCounts: Record<string, number>;
  relations: CardRelation[];
  labels: Label[];
  cardLabels: CardLabel[];
};

/**
 * Position strings can legitimately collide when two clients insert against the
 * same neighbours; the id tiebreak keeps the resulting order identical
 * everywhere (ADR 0010).
 */
export const byPosition = (
  a: { id: string; position: string },
  b: { id: string; position: string },
): number => {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
};

export function sortedColumns(state: BoardState): Column[] {
  return [...state.columns].sort(byPosition);
}

/**
 * Every card stored in `columnId`, in position order, subtasks included. Callers
 * that need only the draggable/rendered roots use `columnRootCards` — archive
 * counts, restore tails and drag ordering all need this flat answer, and none
 * of them may miss a child.
 */
export function columnCards(state: BoardState, columnId: string): Card[] {
  return state.cards.filter((card) => card.columnId === columnId).sort(byPosition);
}

/**
 * The board's rendered roots in one column, in position order: every card there
 * that is not nested under a parent in the same column. Root-only callers (drag
 * siblings, the tail key for a new or restored card, the board's own rows) read
 * this instead of filtering `columnCards` by hand, because a nested child must
 * never become a second draggable row or be counted as a match of its own.
 */
export function columnRootCards(
  state: BoardState,
  columnId: string,
  hierarchy: SubtaskHierarchy,
  cardsById: ReadonlyMap<string, Card> = new Map(state.cards.map((card) => [card.id, card])),
): Card[] {
  return columnCards(state, columnId).filter((card) => {
    const parentId = hierarchy.parentByChild.get(card.id);
    return parentId === undefined || cardsById.get(parentId)?.columnId !== card.columnId;
  });
}

/** Ancestors that actually contain this row in the board's presentation. */
export function boardAncestors(
  state: BoardState,
  hierarchy: SubtaskHierarchy,
  cardId: string,
  cards: ReadonlyMap<string, Card> = new Map(state.cards.map((card) => [card.id, card])),
): string[] {
  const ancestors: string[] = [];
  let childId = cardId;
  let parentId = hierarchy.parentByChild.get(childId);
  while (parentId !== undefined) {
    if (cards.get(parentId)?.columnId !== cards.get(childId)?.columnId) break;
    ancestors.push(parentId);
    childId = parentId;
    parentId = hierarchy.parentByChild.get(childId);
  }
  return ancestors;
}

/** The `?labels=` token meaning "cards that carry no label at all". */
export const UNLABELED_FILTER = "none";

/** The `?assignees=` token meaning "cards with no assignee". */
export const UNASSIGNED_FILTER = "none";

/**
 * Card ids visible under the board's three filter dimensions: any selected
 * label (plus unlabeled cards when requested), any selected assignee (plus
 * unassigned cards when requested), and a case-insensitive title substring.
 * The active dimensions intersect. Unknown label ids are ignored because their
 * definitions no longer exist; unknown assignee ids remain valid selections
 * and can still match snapshot cards. Returns null when no dimension is active.
 */
export function visibleCardIds(
  state: BoardState,
  labelTokens: readonly string[],
  assigneeTokens: readonly string[],
  query?: string,
): ReadonlySet<string> | null {
  const needle = query?.trim().toLowerCase() ?? "";
  const labelIds = new Set(state.labels.map((label) => label.id));
  const selectedLabelIds = new Set(labelTokens.filter((token) => labelIds.has(token)));
  const includeUnlabeled = labelTokens.includes(UNLABELED_FILTER);
  const labelsActive = selectedLabelIds.size > 0 || includeUnlabeled;

  const selectedAssigneeIds = new Set(
    assigneeTokens.filter((token) => token !== UNASSIGNED_FILTER),
  );
  const includeUnassigned = assigneeTokens.includes(UNASSIGNED_FILTER);
  const assigneesActive = selectedAssigneeIds.size > 0 || includeUnassigned;

  if (!labelsActive && !assigneesActive && needle === "") return null;

  const labeledCardIds = new Set<string>();
  const selectedLabelCardIds = new Set<string>();
  if (labelsActive) {
    for (const join of state.cardLabels) {
      // Mirrors cardLabelViews: a join whose definition is gone does not count.
      if (!labelIds.has(join.labelId)) continue;
      labeledCardIds.add(join.cardId);
      if (selectedLabelIds.has(join.labelId)) selectedLabelCardIds.add(join.cardId);
    }
  }

  const visible = new Set<string>();
  for (const card of state.cards) {
    if (
      labelsActive &&
      !selectedLabelCardIds.has(card.id) &&
      !(includeUnlabeled && !labeledCardIds.has(card.id))
    )
      continue;
    if (
      assigneesActive &&
      !(
        card.assigneeId === null
          ? includeUnassigned
          : selectedAssigneeIds.has(card.assigneeId)
      )
    )
      continue;
    if (needle !== "" && !card.title.toLowerCase().includes(needle)) continue;
    visible.add(card.id);
  }
  return visible;
}

export function cardChecklist(state: BoardState, cardId: string): ChecklistItem[] {
  return state.checklistItems.filter((item) => item.cardId === cardId).sort(byPosition);
}

/** Attachments have no `position`: array order (snapshot order, then appends) is display order. */
export function cardAttachments(state: BoardState, cardId: string): Attachment[] {
  return state.attachments.filter((attachment) => attachment.cardId === cardId);
}

/** Comments read oldest-first; the id tiebreak keeps two same-millisecond posts stable. */
export function cardComments(state: BoardState, cardId: string): Comment[] {
  return state.comments
    .filter((comment) => comment.cardId === cardId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Both sides: a card owns the relations that name it as source OR as target. */
export function cardRelations(
  state: BoardState,
  cardId: string,
  activeCardIds: ReadonlySet<string>,
): CardRelation[] {
  return state.relations.filter(
    (relation) =>
      (relation.sourceCardId === cardId || relation.targetCardId === cardId) &&
      activeCardIds.has(relation.sourceCardId) &&
      activeCardIds.has(relation.targetCardId),
  );
}

/** One label as it hangs on a card: the join-row id plus its definition. */
export type CardLabelView = { id: string; assignmentIds: string[]; label: Label };

/**
 * The labels of one card, name-sorted. Joins whose definition is gone are
 * dropped (a peer's `label.delete` can land before our own snapshot catches
 * up), and a label assigned twice — two clients racing, which the DO keeps as
 * two rows since there is no UNIQUE constraint — renders once.
 */
export function cardLabelViews(state: BoardState, cardId: string): CardLabelView[] {
  return labelViews(
    state.cardLabels.filter((join) => join.cardId === cardId),
    new Map(state.labels.map((label) => [label.id, label])),
  );
}

function labelViews(joins: readonly CardLabel[], labelsById: ReadonlyMap<string, Label>): CardLabelView[] {
  const seen = new Map<string, CardLabelView>();
  const views: CardLabelView[] = [];
  for (const join of joins) {
    const existing = seen.get(join.labelId);
    if (existing) {
      existing.assignmentIds.push(join.id);
      continue;
    }
    const label = labelsById.get(join.labelId);
    if (!label) continue;
    const view = { id: join.id, assignmentIds: [join.id], label };
    seen.set(join.labelId, view);
    views.push(view);
  }
  return views.sort((a, b) =>
    a.label.name.toLocaleLowerCase().localeCompare(b.label.name.toLocaleLowerCase()),
  );
}

/** What one card front shows, aggregated from the board's flat arrays. */
export type CardFaceData = {
  checklistDone: number;
  checklistTotal: number;
  attachmentCount: number;
  commentCount: number;
  /** Relations naming this card whose both ends are active cards, in board order. */
  relations: CardRelation[];
  /** Name-sorted, like `cardLabelViews`. */
  labels: Label[];
};

export type BoardIndex = {
  cardsById: ReadonlyMap<string, Card>;
  faces: ReadonlyMap<string, CardFaceData>;
};

const EMPTY_FACE: CardFaceData = {
  checklistDone: 0,
  checklistTotal: 0,
  attachmentCount: 0,
  commentCount: 0,
  relations: [],
  labels: [],
};

export const cardFace = (index: BoardIndex, cardId: string): CardFaceData =>
  index.faces.get(cardId) ?? EMPTY_FACE;

/**
 * One pass over the board for everything a card face and the column layout look
 * up per card, so a render is O(board) instead of O(cards x board). Build it
 * once per board state; per card it answers what `cardChecklist`,
 * `cardAttachments`, `cardRelations` and `cardLabelViews` answer, and the
 * snapshot's comment counts.
 */
export function buildBoardIndex(state: BoardState): BoardIndex {
  const cardsById = new Map(state.cards.map((card) => [card.id, card]));
  const faces = new Map<string, CardFaceData>();
  const face = (cardId: string): CardFaceData => {
    let data = faces.get(cardId);
    if (!data) {
      data = { ...EMPTY_FACE, relations: [], labels: [] };
      faces.set(cardId, data);
    }
    return data;
  };
  for (const item of state.checklistItems) {
    const data = face(item.cardId);
    data.checklistTotal += 1;
    if (item.done) data.checklistDone += 1;
  }
  for (const attachment of state.attachments) face(attachment.cardId).attachmentCount += 1;
  for (const [cardId, count] of Object.entries(state.commentCounts)) face(cardId).commentCount = count;
  for (const relation of state.relations) {
    if (!cardsById.has(relation.sourceCardId) || !cardsById.has(relation.targetCardId)) continue;
    face(relation.sourceCardId).relations.push(relation);
    if (relation.targetCardId !== relation.sourceCardId) face(relation.targetCardId).relations.push(relation);
  }
  const joinsByCard = new Map<string, CardLabel[]>();
  for (const join of state.cardLabels) {
    const joins = joinsByCard.get(join.cardId);
    if (joins) joins.push(join);
    else joinsByCard.set(join.cardId, [join]);
  }
  const labelsById = new Map(state.labels.map((label) => [label.id, label]));
  for (const [cardId, joins] of joinsByCard) {
    face(cardId).labels = labelViews(joins, labelsById).map((view) => view.label);
  }
  return { cardsById, faces };
}

const isCompleted = (state: Pick<BoardState, "columns">, columnId: string): boolean =>
  state.columns.some((column) => column.id === columnId && column.completed === true);

/** Sets the two roles (none when absent); every card's derived completion follows its column. */
function withRoles(state: BoardState, startingId?: string, completedId?: string): BoardState {
  return {
    ...state,
    columns: state.columns.map((c) => ({ ...c, starting: c.id === startingId, completed: c.id === completedId })),
    cards: state.cards.map((card) => ({ ...card, subtaskDone: card.columnId === completedId })),
  };
}

/**
 * Until an admin chooses, the roles follow the board's ends: leftmost starting,
 * rightmost completed, none below two columns. Mirrors the BoardDO's rule after
 * every column create, move and delete. A state without the flag counts as chosen.
 */
function syncAutoRoles(state: BoardState): BoardState {
  if (state.workflowRolesExplicit !== false) return state;
  const columns = sortedColumns(state);
  return columns.length < 2 ? withRoles(state) : withRoles(state, columns[0]!.id, columns.at(-1)!.id);
}

/**
 * The single reducer for board mutations, mirroring the DO's SQL semantics: it
 * runs both for the optimistic local apply and for a peer's broadcast. Updates
 * and moves against a missing row are silent no-ops, exactly like the DO.
 *
 * `createdAt`/`updatedAt` are server-set; locally we stamp `Date.now()` and let
 * the next snapshot reconcile them.
 */
export function applyMutation(
  state: BoardState,
  msg: ClientMessage,
  boardId: string,
): BoardState {
  switch (msg.type) {
    case "card.finish": return [{ id: msg.id, position: msg.position }, ...msg.children].reduce((next, move) => applyMutation(next, { type: "card.move", mutationId: msg.mutationId, id: move.id, columnId: msg.columnId, position: move.position }, boardId), state);
    case "workflow.configure": return { ...withRoles(state, msg.startingColumnId, msg.completedColumnId), workflowRolesExplicit: true };
    case "column.create": {
      if (state.columns.some((column) => column.id === msg.id)) return state;
      const column: Column = { id: msg.id, title: msg.title, position: msg.position };
      return syncAutoRoles({ ...state, columns: [...state.columns, column] });
    }
    case "column.rename":
      return {
        ...state,
        columns: state.columns.map((column) =>
          column.id === msg.id ? { ...column, title: msg.title } : column,
        ),
      };
    case "column.move":
      return syncAutoRoles({
        ...state,
        columns: state.columns.map((column) =>
          column.id === msg.id ? { ...column, position: msg.position } : column,
        ),
      });
    case "column.delete": {
      const column = state.columns.find((candidate) => candidate.id === msg.id);
      if (!column) return state;
      const now = Date.now();
      // The cards that leave are the ones stored in this column.
      const doomedCards = state.cards.filter((card) => card.columnId === msg.id);
      const doomedIds = new Set(doomedCards.map((card) => card.id));
      const archived: ArchivedCard[] = doomedCards.map((card) => ({
        ...card,
        columnId: msg.id,
        archivedAt: now,
        archivedColumnTitle: column.title,
      }));
      return syncAutoRoles({
        ...state,
        columns: state.columns.filter((candidate) => candidate.id !== msg.id),
        cards: state.cards.filter((card) => !doomedIds.has(card.id)),
        archivedCards: [...state.archivedCards, ...archived],
      });
    }
    case "card.create": {
      if (state.cards.some((card) => card.id === msg.id)) return state;
      const now = Date.now();
      const card: Card = {
        id: msg.id,
        columnId: msg.columnId,
        title: msg.title,
        description: "",
        position: msg.position,
        taskNumber: 0,
        assigneeId: msg.assigneeId ?? null,
        priority: msg.priority ?? "medium",
        taskType: msg.taskType ?? "task",
        dueDate: null,
        subtaskDone: isCompleted(state, msg.columnId),
        createdAt: now,
        updatedAt: now,
      };
      return { ...state, cards: [...state.cards, card] };
    }
    case "subtask.create": {
      // The child (active or archived) and the relation are this creation's
      // evidence, so a replayed frame — optimistic, echoed, or verified after a
      // reconnect — never inserts a second row or resurrects an archived child.
      if (
        state.cards.some((card) => card.id === msg.id) ||
        state.archivedCards.some((card) => card.id === msg.id)
      ) {
        return state;
      }
      if (state.relations.some((relation) => relation.id === msg.relationId)) return state;
      const parent = state.cards.find((card) => card.id === msg.parentCardId);
      if (!parent || parent.taskType === "subtask") return state;
      // The starting column, or the parent's own on a board without roles.
      let columnId = state.columns.find(c => c.starting)?.id ?? parent.columnId;
      if (!state.columns.some((column) => column.id === columnId)) return state;
      const item =
        msg.checklistItemId === undefined
          ? undefined
          : state.checklistItems.find(
              (candidate) =>
                candidate.id === msg.checklistItemId && candidate.cardId === msg.parentCardId,
            );
      // A conversion whose source item is not on this parent writes nothing: the
      // BoardDO rejects it, so mirroring a card here would strand an orphan.
      if (msg.checklistItemId !== undefined && item === undefined) return state;
      if (item?.done) columnId = state.columns.find(c => c.completed)?.id ?? columnId;
      const now = Date.now();
      const card: Card = {
        id: msg.id,
        columnId,
        title: msg.title,
        description: "",
        position: msg.position,
        taskNumber: 0,
        assigneeId: null,
        priority: "medium",
        taskType: "subtask",
        dueDate: null,
        subtaskDone: isCompleted(state, columnId),
        createdAt: now,
        updatedAt: now,
      };
      const relation: CardRelation = {
        id: msg.relationId,
        sourceCardId: msg.parentCardId,
        targetCardId: msg.id,
        kind: "subtask",
      };
      return {
        ...state,
        cards: [...state.cards, card],
        relations: [...state.relations, relation],
        checklistItems:
          item === undefined
            ? state.checklistItems
            : state.checklistItems.filter((candidate) => candidate.id !== item.id),
      };
    }
    case "card.update":
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === msg.id
            ? {
                ...card,
                title: msg.title ?? card.title,
                description: msg.description ?? card.description,
                updatedAt: Date.now(),
              }
            : card,
        ),
      };
    case "card.move":
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === msg.id
            ? { ...card, columnId: msg.columnId, position: msg.position, subtaskDone: isCompleted(state, msg.columnId), updatedAt: Date.now() }
            : card,
        ),
      };
    case "card.assign":
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === msg.id
            ? { ...card, assigneeId: msg.assigneeId, updatedAt: Date.now() }
            : card,
        ),
      };
    case "card.prioritize":
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === msg.id ? { ...card, priority: msg.priority, updatedAt: Date.now() } : card,
        ),
      };
    case "card.retype":
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === msg.id && card.taskType !== "subtask"
            ? { ...card, taskType: msg.taskType, updatedAt: Date.now() }
            : card,
        ),
      };
    case "card.schedule":
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === msg.id ? { ...card, dueDate: msg.dueDate, updatedAt: Date.now() } : card,
        ),
      };
    case "card.delete": {
      if (!state.cards.some((candidate) => candidate.id === msg.id)) return state;
      return {
        ...state,
        cards: state.cards.filter((candidate) => candidate.id !== msg.id),
      };
    }
    // Permanent removal waits for the BoardDO's authoritative `archive.purged`
    // frame; the verbatim mutation only settles the sender's pending timer.
    case "card.purge":
      return state;
    case "card.restore": {
      const archived = state.archivedCards.find((candidate) => candidate.id === msg.id);
      if (!archived) return state;
      const { archivedAt: _archivedAt, archivedColumnTitle: _archivedColumnTitle, ...cardFields } =
        archived;
      if (!state.columns.some((candidate) => candidate.id === msg.columnId)) return state;
      const restored: Card = {
        ...cardFields,
        subtaskDone: isCompleted(state, msg.columnId),
        columnId: msg.columnId,
        position: msg.position,
        updatedAt: Date.now(),
      };
      return {
        ...state,
        archivedCards: state.archivedCards.filter((card) => card.id !== msg.id),
        cards: [...state.cards.filter((card) => card.id !== msg.id), restored],
      };
    }
    case "checklist.create": {
      if (state.checklistItems.some((item) => item.id === msg.id)) return state;
      const item: ChecklistItem = {
        id: msg.id,
        cardId: msg.cardId,
        text: msg.text,
        done: false,
        position: msg.position,
      };
      return { ...state, checklistItems: [...state.checklistItems, item] };
    }
    case "checklist.update":
      return {
        ...state,
        checklistItems: state.checklistItems.map((item) =>
          item.id === msg.id
            ? { ...item, text: msg.text ?? item.text, done: msg.done ?? item.done }
            : item,
        ),
      };
    case "checklist.delete":
      return {
        ...state,
        checklistItems: state.checklistItems.filter((item) => item.id !== msg.id),
      };
    case "attachment.create": {
      if (state.attachments.some((attachment) => attachment.id === msg.id)) return state;
      const attachment: Attachment = {
        id: msg.id,
        cardId: msg.cardId,
        fileName: msg.fileName,
        contentType: msg.contentType,
        size: msg.size,
      };
      return { ...state, attachments: [...state.attachments, attachment] };
    }
    case "comment.create": {
      // The count moves even when a read already cached the row: counts come from the snapshot and frames only.
      const commentCounts = { ...state.commentCounts, [msg.cardId]: (state.commentCounts[msg.cardId] ?? 0) + 1 };
      if (state.comments.some((comment) => comment.id === msg.id)) return { ...state, commentCounts };
      const comment: Comment = {
        id: msg.id,
        cardId: msg.cardId,
        authorId: msg.authorId,
        parentCommentId: msg.parentCommentId,
        deleted: false,
        body: msg.body,
        createdAt: msg.createdAt,
        updatedAt: msg.createdAt,
      };
      return { ...state, comments: [...state.comments, comment], commentCounts };
    }
    case "comment.update":
      return {
        ...state,
        comments: state.comments.map((comment) =>
          comment.id === msg.id && !comment.deleted
            ? { ...comment, body: msg.body, updatedAt: msg.updatedAt }
            : comment,
        ),
      };
    case "comment.delete": {
      // The server refuses a delete of a missing or tombstoned comment, so each delete frame is one active comment fewer.
      const { [msg.cardId]: count = 0, ...others } = state.commentCounts;
      state = { ...state, commentCounts: count > 1 ? { ...others, [msg.cardId]: count - 1 } : others };
      const target = state.comments.find((comment) => comment.id === msg.id);
      if (!target) return state;

      if (target.parentCommentId === null) {
        // Root comment
        const hasReplies = state.comments.some(
          (comment) => comment.parentCommentId === target.id,
        );
        if (hasReplies) {
          return {
            ...state,
            comments: state.comments.map((c) =>
              c.id === target.id ? { ...c, body: "", deleted: true } : c,
            ),
          };
        }
        return {
          ...state,
          comments: state.comments.filter((c) => c.id !== target.id),
        };
      }

      // Reply deletion
      const filtered = state.comments.filter((c) => c.id !== target.id);
      const parentId = target.parentCommentId;
      const parent = filtered.find((c) => c.id === parentId);
      if (parent && parent.deleted) {
        const remainingReplies = filtered.some((c) => c.parentCommentId === parentId);
        if (!remainingReplies) {
          return {
            ...state,
            comments: filtered.filter((c) => c.id !== parentId),
          };
        }
      }
      return {
        ...state,
        comments: filtered,
      };
    }
    case "relation.create": {
      if (state.relations.some((relation) => relation.id === msg.id)) return state;
      const source = state.cards.find((card) => card.id === msg.sourceCardId);
      const targetOwnsSubtasks = state.relations.some(
        (relation) => relation.kind === "subtask" && relation.sourceCardId === msg.targetCardId,
      );
      if (
        msg.kind === "subtask" &&
        (source?.taskType === "subtask" || targetOwnsSubtasks)
      ) {
        return state;
      }
      const relation: CardRelation = {
        id: msg.id,
        sourceCardId: msg.sourceCardId,
        targetCardId: msg.targetCardId,
        kind: msg.kind,
      };
      return {
        ...state,
        cards:
          msg.kind === "subtask"
            ? state.cards.map((card) =>
                card.id === msg.targetCardId ? { ...card, taskType: "subtask" } : card,
              )
            : state.cards,
        relations: [...state.relations, relation],
      };
    }
    case "relation.delete": {
      const relation = state.relations.find((candidate) => candidate.id === msg.id);
      return {
        ...state,
        cards:
          relation?.kind === "subtask"
            ? state.cards.map((card) => card.id === relation.targetCardId ? { ...card, taskType: "task" as const } : card)
            : state.cards,
        relations: state.relations.filter((relation) => relation.id !== msg.id),
      };
    }
    case "label.create": {
      if (state.labels.some((label) => label.id === msg.id)) return state;
      const label: Label = { id: msg.id, name: msg.name, color: msg.color };
      return { ...state, labels: [...state.labels, label] };
    }
    case "label.update":
      return {
        ...state,
        labels: state.labels.map((label) =>
          label.id === msg.id
            ? { ...label, name: msg.name ?? label.name, color: msg.color ?? label.color }
            : label,
        ),
      };
    case "label.delete":
      // Board-scoped definition: dropping it strips the label from every card.
      return {
        ...state,
        labels: state.labels.filter((label) => label.id !== msg.id),
        cardLabels: state.cardLabels.filter((join) => join.labelId !== msg.id),
      };
    case "label.assign": {
      if (state.cardLabels.some((join) => join.id === msg.id)) return state;
      const join: CardLabel = { id: msg.id, cardId: msg.cardId, labelId: msg.labelId };
      return { ...state, cardLabels: [...state.cardLabels, join] };
    }
    case "label.unassign":
      return {
        ...state,
        cardLabels: state.cardLabels.filter((join) => join.id !== msg.id),
      };
    case "attachment.delete": {
      const attachment = state.attachments.find((candidate) => candidate.id === msg.id);
      if (!attachment) return state;
      const owner = state.cards.find((card) => card.id === attachment.cardId);
      const description = owner
        ? removeAttachmentReferences(owner.description, boardId, attachment.id)
        : undefined;
      return {
        ...state,
        cards:
          owner && description !== undefined && description !== owner.description
            ? state.cards.map((card) =>
                card.id === owner.id
                  ? { ...card, description, updatedAt: Date.now() }
                  : card,
              )
            : state.cards,
        attachments: state.attachments.filter((candidate) => candidate.id !== msg.id),
      };
    }
  }
}

/**
 * Reconciles the authoritative `cards.archived` broadcast: replaces archive
 * entries by id, removes any same-id active cards left by an interleaved
 * optimistic mutation, and installs the BoardDO rows and server timestamp
 * without touching dependents. A frame can also arrive without a local
 * optimistic archive (a peer archived the card).
 */
export function reconcileArchivedCards(
  state: BoardState,
  cards: readonly ArchivedCard[],
): BoardState {
  if (cards.length === 0) return state;
  const incomingById = new Map(cards.map((card) => [card.id, card]));
  const archivedCards: ArchivedCard[] = [];
  const handled = new Set<string>();

  for (const existing of state.archivedCards) {
    const updated = incomingById.get(existing.id);
    if (updated) {
      archivedCards.push(updated);
      handled.add(existing.id);
    } else {
      archivedCards.push(existing);
    }
  }

  for (const card of cards) {
    if (!handled.has(card.id)) {
      archivedCards.push(card);
    }
  }

  return {
    ...state,
    cards: state.cards.filter((card) => !incomingById.has(card.id)),
    archivedCards,
  };
}

/**
 * Reconciles server-assigned taskNumber on an active or archived card.
 */
export function reconcileTaskNumber(
  state: BoardState,
  id: string,
  taskNumber: number,
): BoardState {
  const cardIndex = state.cards.findIndex((card) => card.id === id);
  if (cardIndex !== -1) {
    const cards = [...state.cards];
    cards[cardIndex] = { ...cards[cardIndex]!, taskNumber };
    return { ...state, cards };
  }
  const archivedIndex = state.archivedCards.findIndex((card) => card.id === id);
  if (archivedIndex !== -1) {
    const archivedCards = [...state.archivedCards];
    archivedCards[archivedIndex] = { ...archivedCards[archivedIndex]!, taskNumber };
    return { ...state, archivedCards };
  }
  return state;
}

/**
 * Installs the keys of a server-only `positions.rebalanced` frame on the active
 * cards or the columns it names (ADR 0076). Ids not in the state are ignored.
 */
export function applyRebalancedPositions(
  state: BoardState,
  table: "cards" | "columns",
  positions: readonly { id: string; position: string }[],
): BoardState {
  const keys = new Map(positions.map(({ id, position }) => [id, position]));
  const rekey = <T extends { id: string; position: string }>(rows: T[]): T[] =>
    rows.map((row) => (keys.has(row.id) ? { ...row, position: keys.get(row.id)! } : row));
  return table === "cards" ? { ...state, cards: rekey(state.cards) } : { ...state, columns: rekey(state.columns) };
}

/**
 * Synchronizes the server-only `archive.purged` frame by permanently purging
 * matching ids from both archived and active cards (an active match can only be
 * a stale optimistic restore), plus checklist items, attachments, comments,
 * relations naming either endpoint, and card-label joins. Columns
 * and label definitions are preserved.
 */
export function purgeArchivedCards(
  state: BoardState,
  cardIds: readonly string[],
): BoardState {
  if (cardIds.length === 0) return state;
  const purged = new Set(cardIds);
  const promoted = new Set(state.relations.filter(r => r.kind === "subtask" && purged.has(r.sourceCardId)).map(r => r.targetCardId));
  return {
    workflowRolesExplicit: state.workflowRolesExplicit,
    columns: state.columns,
    cards: state.cards.filter((card) => !purged.has(card.id)).map(card => promoted.has(card.id) ? { ...card, taskType: "task" as const } : card),
    archivedCards: state.archivedCards.filter((card) => !purged.has(card.id)).map(card => promoted.has(card.id) ? { ...card, taskType: "task" as const } : card),
    checklistItems: state.checklistItems.filter((item) => !purged.has(item.cardId)),
    attachments: state.attachments.filter((attachment) => !purged.has(attachment.cardId)),
    comments: state.comments.filter((comment) => !purged.has(comment.cardId)),
    commentCounts: Object.fromEntries(Object.entries(state.commentCounts).filter(([cardId]) => !purged.has(cardId))),
    relations: state.relations.filter(
      (relation) => !purged.has(relation.sourceCardId) && !purged.has(relation.targetCardId),
    ),
    labels: state.labels,
    cardLabels: state.cardLabels.filter((join) => !purged.has(join.cardId)),
  };
}
