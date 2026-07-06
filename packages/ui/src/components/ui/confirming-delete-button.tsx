import { Check, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "./button";

export type ConfirmingDeleteButtonProps = {
  confirmLabel: string;
  idleLabel: string;
  onConfirm: () => void;
  className?: string;
};

export function ConfirmingDeleteButton({
  confirmLabel,
  idleLabel,
  onConfirm,
  className,
}: ConfirmingDeleteButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirming) return;

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setConfirming(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setConfirming(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [confirming]);

  return (
    <div ref={rootRef} className={cn("flex justify-end leading-none", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "!size-5",
          confirming
            ? "text-destructive hover:bg-rule/45 hover:text-destructive"
            : "text-faint/70 hover:bg-rule/45 hover:text-destructive focus-visible:text-destructive",
        )}
        onClick={(event) => {
          event.stopPropagation();
          if (confirming) {
            onConfirm();
            setConfirming(false);
            return;
          }
          setConfirming(true);
        }}
        aria-label={confirming ? confirmLabel : idleLabel}
      >
        {confirming ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Trash2 className="size-3.5" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}
