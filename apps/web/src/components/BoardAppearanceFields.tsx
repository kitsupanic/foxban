import type { ComponentType } from "react";
import {
  BookOpen,
  BriefcaseBusiness,
  Code2,
  Fish,
  FlaskConical,
  Heart,
  Palette,
  Rocket,
  Shuffle,
  SquareKanban,
  Star,
  Target,
  type LucideProps,
} from "lucide-react";
import type { BoardColor, BoardIcon } from "@foxban/shared";

const ICONS: ReadonlyArray<{ value: BoardIcon; label: string; Icon: ComponentType<LucideProps> }> = [
  { value: "square-kanban", label: "Board", Icon: SquareKanban },
  { value: "fish", label: "Fish", Icon: Fish },
  { value: "shuffle", label: "Shuffle", Icon: Shuffle },
  { value: "briefcase", label: "Briefcase", Icon: BriefcaseBusiness },
  { value: "code", label: "Code", Icon: Code2 },
  { value: "flask", label: "Flask", Icon: FlaskConical },
  { value: "rocket", label: "Rocket", Icon: Rocket },
  { value: "target", label: "Target", Icon: Target },
  { value: "book-open", label: "Book", Icon: BookOpen },
  { value: "palette", label: "Palette", Icon: Palette },
  { value: "heart", label: "Heart", Icon: Heart },
  { value: "star", label: "Star", Icon: Star },
];

const COLORS: ReadonlyArray<{ value: BoardColor; label: string; hex: string }> = [
  { value: "amber", label: "Amber", hex: "#b45309" },
  { value: "orange", label: "Orange", hex: "#c2410c" },
  { value: "rose", label: "Rose", hex: "#be123c" },
  { value: "purple", label: "Purple", hex: "#6d28d9" },
  { value: "blue", label: "Blue", hex: "#2563eb" },
  { value: "teal", label: "Teal", hex: "#0f766e" },
  { value: "green", label: "Green", hex: "#15803d" },
  { value: "slate", label: "Slate", hex: "#52525b" },
];

export const DEFAULT_BOARD_ICON: BoardIcon = "square-kanban";
export const DEFAULT_BOARD_COLOR: BoardColor = "amber";

export function BoardAppearanceIcon({ icon, color, className }: { icon: BoardIcon; color: BoardColor; className?: string }) {
  const Icon = ICONS.find((option) => option.value === icon)?.Icon ?? SquareKanban;
  return <Icon aria-hidden="true" data-board-icon={icon} data-board-color={color} className={className} />;
}

export function BoardAppearanceFields({
  name,
  boardKey,
  icon,
  color,
  disabled,
  onIconChange,
  onColorChange,
}: {
  name: string;
  boardKey: string;
  icon: BoardIcon;
  color: BoardColor;
  disabled: boolean;
  onIconChange: (icon: BoardIcon) => void;
  onColorChange: (color: BoardColor) => void;
}) {
  const selectedIcon = ICONS.find((option) => option.value === icon) ?? ICONS[0];
  const selectedColor = COLORS.find((option) => option.value === color) ?? COLORS[0];
  const SelectedIcon = selectedIcon.Icon;
  return (
    <fieldset className="boards-appearance" disabled={disabled}>
      <legend>Appearance <span>Optional</span></legend>
      <div className="boards-appearance-preview" data-board-color={color}>
        <span><SelectedIcon aria-hidden="true" /></span>
        <span><strong>{name.trim() || "Untitled board"}</strong><small>{boardKey.trim() || "KEY"}</small></span>
        <span>Preview</span>
      </div>
      <div className="boards-appearance-label"><span>Icon</span><span>{selectedIcon.label}</span></div>
      <div className="boards-icon-options">
        {ICONS.map(({ value, label, Icon }) => (
          <button key={value} type="button" role="radio" aria-checked={icon === value} aria-label={`${label} icon`} disabled={disabled} onClick={() => onIconChange(value)} data-board-color={color}>
            <Icon aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="boards-appearance-label"><span>Color</span><span>{selectedColor.label}</span></div>
      <div className="boards-color-options">
        {COLORS.map(({ value, label, hex }) => (
          <button key={value} type="button" role="radio" aria-checked={color === value} aria-label={`${label} color`} disabled={disabled} onClick={() => onColorChange(value)} style={{ "--board-swatch": hex } as React.CSSProperties}>
            <span />
          </button>
        ))}
      </div>
    </fieldset>
  );
}
