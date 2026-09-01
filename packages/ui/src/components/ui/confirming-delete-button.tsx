import { Check, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { uiMessage } from "../../lib/format";
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
  const resolvedIdleLabel = idleLabel ?? uiMessage(locale, "action.delete");
  const resolvedConfirmLabel = confirmLabel ?? uiMessage(locale, "action.confirm");
  const resolvedUndoLabel = undoLabel ?? uiMessage(locale, "ui.undo");
  const [armed, setArmed] = useState(false);
  const [showUndo, setShowUndo] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!armed && !showUndo) return;
    const timer = window.setTimeout(() => {
      setArmed(false);
      setShowUndo(false);
    }, 6000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setArmed(false);
        setShowUndo(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
    };
  }, [armed, showUndo]);
  return (
    <span ref={ref} className={cn("inline-flex items-center gap-1", className)}>
      {armed ? (
        <>
          <Button
            ref={(node) => node?.focus()}
            variant="destructive"
            size="sm"
            className="animate-enter-fade"
            aria-label={resolvedConfirmLabel}
            onClick={() => {
              setArmed(false);
              onConfirm();
              if (undo) setShowUndo(true);
            }}
          >
            <Check className="size-3" />
            {resolvedConfirmLabel}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
            {uiMessage(locale, "ui.cancel")}
          </Button>
        </>
      ) : showUndo && undo ? (
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
      ) : (
        <Button
          variant="ghost"
          size={size}
          aria-label={label ?? resolvedIdleLabel}
          title={label ?? resolvedIdleLabel}
          className="text-danger hover:text-danger hover:decoration-danger/40"
          onClick={() => setArmed(true)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </span>
  );
}
