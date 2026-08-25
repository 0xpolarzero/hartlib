import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { Check, RotateCcw, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ToastSpec {
  id: number;
  title: string;
  description?: string;
  tone: "success" | "error" | "neutral";
  /** Renders an “Undo” action; called when clicked or on timeout. */
  undo?: { label: string; onUndo: () => void };
  durationMs?: number;
}

interface ToastApi {
  toast: (spec: Omit<ToastSpec, "id">) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

/**
 * Toasts double as announcements: success/neutral use role=status (polite,
 * Radix default), errors are forced to role=alert.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastSpec[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (spec: Omit<ToastSpec, "id">) => {
      const id = ++seq.current;
      setToasts((prev) => [...prev.slice(-3), { ...spec, id }]);
    },
    [],
  );

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
        {children}
        {toasts.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            onOpenChange={(open) => {
              if (!open) dismiss(t.id);
            }}
            duration={t.durationMs ?? (t.tone === "error" ? 7000 : t.undo ? 6500 : 5000)}
            role={t.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto grid w-[min(92vw,22rem)] grid-cols-[auto_1fr] items-start gap-2.5 rounded-tiny border bg-surface px-3 py-2.5",
              "data-[state=open]:animate-enter data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
              t.tone === "error" ? "border-danger/40" : "border-line-2",
            )}
          >
            <div className="mt-0.5">
              {t.tone === "success" && <Check className="size-3.5 text-ok" />}
              {t.tone === "error" && <TriangleAlert className="size-3.5 text-danger" />}
              {t.tone === "neutral" && <span className="block size-1.5 rounded-full bg-accent" />}
            </div>
            <div className="min-w-0">
              <ToastPrimitive.Title className="text-[13px] font-medium text-ink">{t.title}</ToastPrimitive.Title>
              {t.description && (
                <ToastPrimitive.Description className="mt-0.5 text-[12px] leading-snug text-ink-2">
                  {t.description}
                </ToastPrimitive.Description>
              )}
              {t.undo && (
                <ToastPrimitive.Action
                  altText={t.undo.label}
                  onClick={(e) => {
                    e.preventDefault();
                    t.undo!.onUndo();
                    dismiss(t.id);
                  }}
                  className="mt-1.5 inline-flex h-6 items-center gap-1 rounded-tiny border border-line-2 bg-transparent px-2 text-[12px] font-medium text-ink transition-colors duration-100 hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <RotateCcw className="size-3" />
                  {t.undo.label}
                </ToastPrimitive.Action>
              )}
            </div>
            <ToastPrimitive.Close
              aria-label="Fermer"
              className="col-start-3 row-start-1 flex size-5 items-center justify-center rounded-tiny text-ink-2 transition-colors duration-100 hover:bg-paper-deep hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <X className="size-3" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
