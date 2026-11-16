import type { LabelColor } from "@foxban/shared";

/** Picker order; the create form defaults to the first colour no label uses yet. */
export const LABEL_COLORS: LabelColor[] = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
];

/**
 * Display metadata for the pills, the swatch row and the colour buttons' labels.
 * Every class is a literal string: Tailwind's JIT never sees a constructed one.
 */
export const LABEL_COLOR_META: Record<LabelColor, { label: string; pill: string; swatch: string }> =
  {
    red: { label: "Red", pill: "bg-red-50 text-red-800", swatch: "bg-red-500" },
    orange: { label: "Orange", pill: "bg-orange-50 text-orange-800", swatch: "bg-orange-500" },
    amber: { label: "Amber", pill: "bg-amber-50 text-amber-800", swatch: "bg-amber-500" },
    green: { label: "Green", pill: "bg-green-50 text-green-800", swatch: "bg-green-500" },
    teal: { label: "Teal", pill: "bg-teal-50 text-teal-800", swatch: "bg-teal-500" },
    blue: { label: "Blue", pill: "bg-blue-50 text-blue-800", swatch: "bg-blue-500" },
    purple: { label: "Purple", pill: "bg-purple-50 text-purple-800", swatch: "bg-purple-500" },
    pink: { label: "Pink", pill: "bg-pink-50 text-pink-800", swatch: "bg-pink-500" },
  };
