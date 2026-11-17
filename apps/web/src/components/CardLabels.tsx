import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, Pencil, Plus, Search, Tag, X } from "lucide-react";
import type { Label, LabelColor } from "@foxban/shared";
import type { BoardCommands } from "../lib/board-commands";
import type { CardLabelView } from "../lib/apply-mutation";
import { LABEL_COLORS, LABEL_COLOR_META } from "../lib/labels";
import { restoreFocusSoon } from "../lib/focus";
import { usePickerMenuStyle } from "../lib/picker-menu";
import type { CardViewMode } from "./CardModal";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * The label picker's UI state, called by the modal rather than the section: the two shells wrap the
 * body differently, so a view switch is not guaranteed to keep a section's own state, and an open
 * picker with a half-typed definition must survive it. Collapsed like the link composer. Open, it can be editing one definition (its own name/colour
 * draft) and confirming that one's delete.
 */
export function useCardLabels(
  commands: Pick<BoardCommands, "createAndAssignLabel" | "updateLabel" | "deleteLabel">,
  { cardId, labels, view, modalRef }: {
    cardId: string;
    labels: Label[];
    view: CardViewMode;
    modalRef: RefObject<HTMLElement | null>;
  },
) {
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

  // Two ordinary mutations from one submit — define it, then hang it on this
  // card. A drop after the first leaves an unassigned definition in the picker:
  // visible and one click from fixed (ADR 0019).
  const createLabel = () => {
    const name = newLabelName.trim();
    if (!name) return;
    if (commands.createAndAssignLabel(cardId, name, createColor) === "not-sent") return;
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

  return {
    composingLabel,
    setComposingLabel,
    creatingLabel,
    setCreatingLabel,
    labelQuery,
    setLabelQuery,
    labelRootRef,
    labelTriggerRef,
    labelSearchRef,
    labelMenuStyle,
    editingLabelId,
    editLabelName,
    setEditLabelName,
    editLabelColor,
    setEditLabelColor,
    confirmingLabelDelete,
    setConfirmingLabelDelete,
    newLabelName,
    setNewLabelName,
    setNewLabelColor,
    labelNameDirtyRef,
    labelColorDirtyRef,
    pickerLabels,
    createColor,
    createLabel,
    startLabelEdit,
    exitLabelEdit,
    saveLabelEdit,
    deleteLabel,
    collapseLabelComposer,
    onLabelPaneEscape,
  };
}

export type CardLabelsState = ReturnType<typeof useCardLabels>;

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

// A `div` (not a `section`), for the same reason as the checklist. Labels are instant-send
// like the metadata block: the picker never joins the Save draft.
export function CardLabels({
  picker: {
    composingLabel, setComposingLabel, creatingLabel, setCreatingLabel, labelQuery, setLabelQuery,
    labelRootRef, labelTriggerRef, labelSearchRef, labelMenuStyle, editingLabelId, editLabelName,
    setEditLabelName, editLabelColor, setEditLabelColor, confirmingLabelDelete, setConfirmingLabelDelete,
    newLabelName, setNewLabelName, setNewLabelColor, labelNameDirtyRef, labelColorDirtyRef, pickerLabels,
    createColor, createLabel, startLabelEdit, exitLabelEdit, saveLabelEdit, deleteLabel,
    collapseLabelComposer, onLabelPaneEscape,
  },
  cardId,
  labels,
  cardLabels,
  toggleLabel,
}: {
  picker: CardLabelsState;
  cardId: string;
  /** Every label definition on the board — the picker lists them all. */
  labels: Label[];
  /** This card's labels, name-sorted, with their join-row ids; the live cache. */
  cardLabels: CardLabelView[];
  toggleLabel: (labelId: string) => void;
}) {
  const editingLabel = labels.find((label) => label.id === editingLabelId);
  const filteredLabels = pickerLabels.filter((label) =>
    label.name.toLocaleLowerCase().includes(labelQuery.trim().toLocaleLowerCase()),
  );
  return (
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
          aria-expanded={composingLabel} aria-controls={`label-picker-${cardId}`}
          variant="outline" size="sm" onClick={() => composingLabel ? collapseLabelComposer() : setComposingLabel(true)}
          className="label-add text-muted-foreground hover:text-foreground">
          <Plus aria-hidden="true" className="size-3.5" />Add labels
        </Button>
        {composingLabel && (
          <div id={`label-picker-${cardId}`} style={labelMenuStyle}
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
}
