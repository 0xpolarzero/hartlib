import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
import type { ToastSpec } from "./toast";
import { Button } from "./button";
import { useToast } from "./toast";

type ToastApi = { toast: (spec: Omit<ToastSpec, "id">) => void };

export interface ConfirmingDeleteButtonProps {
  onConfirm: () => void;
  label?: string;
  idleLabel?: string;
  confirmLabel?: string;
  undoLabel?: string;
  undo?: () => void;
  size?: "sm" | "icon-sm" | "icon";
  className?: string;
  locale?: string;
}

/**
 * Two-step inline confirm ported from the ui-playground reference: the first
 * click arms the destructive action, the second confirms. Escape cancels; the
 * armed state auto-resets after 6 s. On confirm, an undo toast is offered when
 * `undo` is provided and a toast host is mounted; hosts without a
 * ToastProvider fall back to an inline undo action so the callback contract
 * survives everywhere.
 */
export function ConfirmingDeleteButton({
  onConfirm,
  label,
  idleLabel,
  confirmLabel,
  undoLabel,
  undo,
  size = "icon-sm",
  className,
  locale = "en-US",
}: ConfirmingDeleteButtonProps) {
  // `useToast` throws outside a ToastProvider (the production shell mounts
  // none today); the toast is a delivery adapter, never part of the armed UI.
  let toastApi: ToastApi | undefined;
  try {
    toastApi = useToast();
  } catch {
    toastApi = undefined;
  }
  const resolvedIdleLabel = idleLabel ?? uiMessage(locale, "action.delete");
  const resolvedUndoLabel = undoLabel ?? uiMessage(locale, "ui.undo");
  const [armed, setArmed] = useState(false);
  const [showUndo, setShowUndo] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!armed && !showUndo) return;
    if (armed) confirmRef.current?.focus();
    const timer = window.setTimeout(() => {
      setArmed(false);
      setShowUndo(false);
    }, 6000);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setArmed(false);
        setShowUndo(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
    };
  }, [armed, showUndo]);

  const fire = () => {
    setArmed(false);
    onConfirm();
    if (!undo) return;
    if (toastApi) {
      toastApi.toast({
        title: uiMessage(locale, "ui.deleted"),
        tone: "neutral",
        undo: { label: resolvedUndoLabel, onUndo: undo },
      });
    } else {
      setShowUndo(true);
    }
  };

  return (
    <span
      ref={containerRef}
      className={cn("inline-flex items-center gap-1", className)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && armed) {
          e.stopPropagation();
          setArmed(false);
        }
      }}
    >
      {!armed ? (
        <Button
          variant="ghost"
          size={size}
          aria-label={label ?? resolvedIdleLabel}
          title={label ?? resolvedIdleLabel}
          className={cn("text-danger hover:text-danger hover:decoration-danger/40")}
          onClick={() => setArmed(true)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            className="size-3.5"
          >
            <path
              d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
      ) : (
        <>
          <Button
            ref={confirmRef}
            variant="destructive"
            size="sm"
            className="animate-enter-fade"
            onClick={fire}
          >
            {confirmLabel ?? uiMessage(locale, "action.confirm")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
            {uiMessage(locale, "ui.cancel")}
          </Button>
        </>
      )}
      {showUndo && undo && (
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            undo();
            setShowUndo(false);
          }}
        >
          {resolvedUndoLabel}
        </Button>
      )}
    </span>
  );
}
