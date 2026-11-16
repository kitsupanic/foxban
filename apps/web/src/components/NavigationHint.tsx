import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface NavigationHintProps {
  label: string;
  enabled?: boolean;
  children: (props: HTMLAttributes<HTMLElement>) => ReactNode;
}

/** A label for an icon-only navigation control, without changing its layout. */
export function NavigationHint({ label, enabled = true, children }: NavigationHintProps) {
  const id = useId();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const hintRef = useRef<HTMLSpanElement>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearClose = () => clearTimeout(closeTimer.current);
  const closeSoon = () => {
    clearClose();
    closeTimer.current = setTimeout(() => {
      if (!hovered.current && !focused.current) setTarget(null);
    }, 120);
  };
  const show = (element: HTMLElement) => {
    clearClose();
    if (enabled && matchMedia("(min-width: 601px)").matches) setTarget(element);
  };
  const visible = enabled && target !== null;

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!enabled) setTarget(null);
  }, [enabled]);
  useLayoutEffect(() => {
    if (!visible) return;
    const anchor = target.getBoundingClientRect();
    const hint = hintRef.current?.getBoundingClientRect();
    if (!hint) return;
    setPosition({
      left: Math.max(8, Math.min(anchor.right + 8, innerWidth - hint.width - 8)),
      top: Math.max(8, Math.min(anchor.top + (anchor.height - hint.height) / 2, innerHeight - hint.height - 8)),
    });
  }, [visible, target, label]);
  useEffect(() => {
    if (!visible) return;
    const dismiss = () => setTarget(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismiss();
      // A hovered label must not consume Escape from a menu or dialog that
      // currently owns the keyboard. Only its own focused control owns this key.
      if (target.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [visible]);

  return <>
    {children({
      "aria-describedby": visible ? id : undefined,
      onPointerEnter: (event) => {
        if (event.pointerType === "touch") return;
        hovered.current = true;
        show(event.currentTarget);
      },
      onPointerLeave: () => { hovered.current = false; closeSoon(); },
      onFocus: (event) => { focused.current = true; show(event.currentTarget); },
      onBlur: () => { focused.current = false; closeSoon(); },
    })}
    {visible && createPortal(<span
      ref={hintRef}
      id={id}
      role="tooltip"
      className="navigation-hint"
      style={position}
      onPointerEnter={() => { hovered.current = true; clearClose(); }}
      onPointerLeave={() => { hovered.current = false; closeSoon(); }}
    >{label}</span>, document.body)}
  </>;
}
