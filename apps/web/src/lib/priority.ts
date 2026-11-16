import type { LucideIcon } from "lucide-react";
import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Minus } from "lucide-react";
import type { Priority } from "@foxban/shared";

/** Jira's ordering: most urgent first. */
export const PRIORITIES: Priority[] = ["highest", "high", "medium", "low", "lowest"];

/**
 * Display metadata for the picker and the card-front badge. Lucide icons rather
 * than text glyphs for consistent rendering across platforms.
 */
export const PRIORITY_META: Record<
  Priority,
  { label: string; icon: LucideIcon; className: string }
> = {
  highest: { label: "Highest", icon: ChevronsUp, className: "text-red-600" },
  high: { label: "High", icon: ArrowUp, className: "text-orange-500" },
  medium: { label: "Medium", icon: Minus, className: "text-amber-500" },
  low: { label: "Low", icon: ArrowDown, className: "text-green-600" },
  lowest: { label: "Lowest", icon: ChevronsDown, className: "text-sky-600" },
};
