import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { Button } from "./button";
import { useToast } from "./toast";

/**
 * Two-step inline confirm: the first click arms the destructive action,
 * the second confirms. Escape cancels; the armed state auto-resets after
 * 6 s. On confirm, an undo toast is offered when `undo` is provided.
 */
export function ConfirmingDeleteButton({
  onConfirm,
  label,
  confirmLabel,
  undoLabel,
  undo,
  size = "icon-sm",
  className,
}: {
  onConfirm: () => void;
  label: string;
  confirmLabel?: string;
  undoLabel?: string;
  undo?: () => void;
  size?: "sm" | "icon-sm" | "icon";
  className?: string;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [armed, setArmed] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!armed) return;
    confirmRef.current?.focus();
    const timer = window.setTimeout(() => setArmed(false), 6000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const fire = () => {
    setArmed(false);
    onConfirm();
    if (undo) {
      toast({
        title: t("confirmDelete.doneTitle"),
        tone: "neutral",
        undo: { label: undoLabel ?? t("confirmDelete.undo"), onUndo: undo },
      });
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
          aria-label={label}
          title={label}
          className={cn("text-danger hover:text-danger hover:decoration-danger/40")}
          onClick={() => setArmed(true)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="size-3.5">
            <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" strokeLinecap="round" strokeLinejoin="round" />
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
            {confirmLabel ?? t("confirmDelete.confirm")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
            {t("confirmDelete.cancel")}
          </Button>
        </>
      )}
    </span>
  );
}
