import { useEffect, useState, type CSSProperties, type RefObject } from "react";

/** The gutter between a trigger and its menu. */
const MENU_GAP = 6;
/** Keeps a menu off the viewport edges. */
const VIEWPORT_MARGIN = 12;
/** The smallest menu worth showing when neither side has room; it scrolls instead. */
const MIN_MENU_HEIGHT = 96;

/**
 * Anchors a picker menu to its trigger while the menu renders at the document
 * root.
 *
 * Board dialogs scroll — `.boards-dialog-panel` is `overflow-y: auto` — so a
 * menu laid out inside its own field is clipped at the panel's edge and can
 * never be scrolled into reach: an absolutely positioned box does not extend a
 * scroll container's scrollable area. The menu is therefore portaled to the
 * document body and fixed to the trigger's viewport rectangle, flipping above
 * the trigger when the space below is too small and never taller than the
 * space it has.
 */
export function usePickerMenuStyle(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({});

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
      const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
      const flip = below < MIN_MENU_HEIGHT && above > below;
      const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN);
      setStyle({
        position: "fixed",
        zIndex: 60,
        left: Math.min(Math.max(rect.left, VIEWPORT_MARGIN), maxLeft),
        width: rect.width,
        maxHeight: Math.max(MIN_MENU_HEIGHT, flip ? above : below),
        overflowY: "auto",
        ...(flip
          ? { bottom: window.innerHeight - rect.top + MENU_GAP }
          : { top: rect.bottom + MENU_GAP }),
      });
    };
    place();
    // A scrolled canvas or a resized window moves the trigger under the menu.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, triggerRef]);

  return style;
}
