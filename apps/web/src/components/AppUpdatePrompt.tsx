import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui/button";
import { inertElements } from "../lib/inert";
import {
  APP_UPDATE_CHECK_EVENT,
  APP_UPDATE_PROMPT_ACTIVE_ATTR,
  fetchCurrentBuildId,
} from "../lib/app-update";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export function AppUpdatePrompt() {
  const [staleDetected, setStaleDetected] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const refreshButtonRef = useRef<HTMLButtonElement | null>(null);
  const laterButtonRef = useRef<HTMLButtonElement | null>(null);
  const inFlightControllerRef = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);

  // Mount effect: create and manage lifetime of dedicated portal host
  useEffect(() => {
    const host = document.createElement("div");
    host.setAttribute("data-foxban-update-portal-host", "");
    document.body.appendChild(host);
    setPortalHost(host);

    return () => {
      if (host.isConnected) {
        host.remove();
      }
      setPortalHost(null);
    };
  }, []);

  const performCheck = async () => {
    if (unmountedRef.current) return;
    if (inFlightControllerRef.current) return;

    const controller = new AbortController();
    inFlightControllerRef.current = controller;

    try {
      const latestId = await fetchCurrentBuildId(controller.signal);
      if (unmountedRef.current) return;
      const currentId = typeof __FOXBAN_BUILD_ID__ === "string" ? __FOXBAN_BUILD_ID__ : "";
      if (latestId !== null && latestId !== currentId) {
        setStaleDetected(true);
        setDismissed(false);
      }
    } finally {
      if (inFlightControllerRef.current === controller) {
        inFlightControllerRef.current = null;
      }
    }
  };

  useEffect(() => {
    unmountedRef.current = false;
    void performCheck();

    const intervalId = window.setInterval(() => {
      void performCheck();
    }, CHECK_INTERVAL_MS);

    const handleFocus = () => {
      void performCheck();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void performCheck();
      }
    };

    const handleOnline = () => {
      void performCheck();
    };

    const handleCustomCheck = () => {
      void performCheck();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    window.addEventListener(APP_UPDATE_CHECK_EVENT, handleCustomCheck);

    return () => {
      unmountedRef.current = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener(APP_UPDATE_CHECK_EVENT, handleCustomCheck);
      if (inFlightControllerRef.current) {
        inFlightControllerRef.current.abort();
        inFlightControllerRef.current = null;
      }
    };
  }, []);

  const isOpen = staleDetected && !dismissed;

  useEffect(() => {
    if (!isOpen || !portalHost) return;

    document.documentElement.setAttribute(APP_UPDATE_PROMPT_ACTIVE_ATTR, "true");

    const restore = inertElements(Array.from(document.body.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== portalHost,
    ));

    refreshButtonRef.current?.focus();

    return () => {
      restore();
      document.documentElement.removeAttribute(APP_UPDATE_PROMPT_ACTIVE_ATTR);
    };
  }, [isOpen, portalHost]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setDismissed(true);
        return;
      }

      if (event.key === "Tab") {
        const dialogNode = dialogRef.current;
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

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen]);

  if (!isOpen || !portalHost || typeof document === "undefined") {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
  };

  const handleRefresh = () => {
    window.location.reload();
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-dialog"
      >
        <h2 id={titleId} className="text-base font-semibold">
          Foxban updated
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Refresh the page to use the latest version.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            ref={laterButtonRef}
            type="button"
            variant="outline"
            onClick={handleDismiss}
          >
            Later
          </Button>
          <Button
            ref={refreshButtonRef}
            type="button"
            variant="default"
            onClick={handleRefresh}
          >
            Refresh Foxban
          </Button>
        </div>
      </div>
    </div>,
    portalHost,
  );
}
