import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, RotateCcw, TriangleAlert, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
export interface ToastSpec {
  id: number;
  title: string;
  description?: string;
  tone: "success" | "error" | "neutral";
  durationMs?: number;
  undo?: { label: string; onUndo: () => void };
}
type ToastApi = { toast: (spec: Omit<ToastSpec, "id">) => void };
const ToastContext = createContext<ToastApi | null>(null);
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}
export function ToastProvider({
  children,
  locale = "en-US",
}: {
  children: ReactNode;
  locale?: string;
}) {
  const [toasts, setToasts] = useState<ToastSpec[]>([]);
  const sequence = useRef(0);
  const dismiss = useCallback(
    (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    [],
  );
  const toast = useCallback(
    (spec: Omit<ToastSpec, "id">) => {
      const id = ++sequence.current;
      setToasts((current) => [...current.slice(-3), { ...spec, id }]);
      window.setTimeout(() => dismiss(id), spec.durationMs ?? 5000);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-label={uiMessage(locale, "ui.notifications")}
        className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 outline-none"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto grid w-[min(92vw,22rem)] grid-cols-[auto_1fr_auto] items-start gap-2.5 rounded-tiny border bg-surface px-3 py-2.5",
              "animate-enter",
              item.tone === "error" ? "border-danger/40" : "border-line-2",
            )}
          >
            <span className="mt-0.5">
              {item.tone === "success" ? (
                <Check className="size-3.5 text-ok" />
              ) : item.tone === "error" ? (
                <TriangleAlert className="size-3.5 text-danger" />
              ) : (
                <span className="block size-1.5 rounded-full bg-accent" />
              )}
            </span>
            <div>
              <p className="text-[13px] font-medium text-ink">{item.title}</p>
              {item.description && (
                <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{item.description}</p>
              )}
              {item.undo && (
                <button
                  type="button"
                  className="mt-1.5 inline-flex h-6 items-center gap-1 rounded-tiny border border-line-2 bg-transparent px-2 text-[12px] font-medium text-ink transition-colors duration-100 hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  onClick={() => {
                    item.undo?.onUndo();
                    dismiss(item.id);
                  }}
                >
                  <RotateCcw className="size-3" aria-hidden="true" />
                  {item.undo.label}
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label={uiMessage(locale, "ui.close")}
              onClick={() => dismiss(item.id)}
              className="flex size-5 items-center justify-center rounded-tiny text-ink-2 transition-colors duration-100 hover:bg-paper-deep hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
