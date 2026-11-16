/**
 * Returns focus to `target` on the next animation frame, but only while no
 * other control has taken focus in the meantime.
 *
 * Overlays and inline editors hand focus back to the control that opened them,
 * and that hand-back is asynchronous: by the time the frame runs, the user (or
 * a test driving the page) may already have focused another field. An
 * unconditional `focus()` then steals it and swallows the next keystrokes —
 * clearing a search field with `fill("")` is select-all followed by a Delete
 * keypress, so a restore landing in between silently drops the clear.
 *
 * When such an overlay closes, focus falls back to the document body; that is
 * the only state in which the deferred restore still owns the keyboard.
 *
 * Pass a function when the target can be replaced before the frame runs — a
 * card re-parented by a peer move lands in another column's keyed list, so the
 * node captured at close time is already gone. The lookup then happens inside
 * the frame and the current node regains focus.
 */
export function restoreFocusSoon(
  target: HTMLElement | null | undefined | (() => HTMLElement | null),
): void {
  requestAnimationFrame(() => {
    const node = typeof target === "function" ? target() : target;
    if (!node || !node.isConnected || node.closest("[inert]")) return;
    const active = document.activeElement;
    const focusIsFree =
      active === null || active === document.body || active === document.documentElement;
    if (!focusIsFree) return;
    node.focus();
  });
}
