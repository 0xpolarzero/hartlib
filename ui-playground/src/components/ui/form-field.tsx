import { createContext, useId, useContext, type ReactNode } from "react";
import { Check, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export type FieldState = "default" | "error" | "success";

interface FieldCtx {
  id: string;
  describedBy: string | undefined;
  state: FieldState;
}

const FieldContext = createContext<FieldCtx | null>(null);

/** Renders a control function INSIDE the provider so it can read context. */
function FieldSlot({ children }: { children: (ctx: FieldCtx) => ReactNode }) {
  const ctx = useField();
  if (!ctx) throw new Error("FieldSlot requires FormField");
  return <>{children(ctx)}</>;
}

/**
 * FormField wires label, description and validation message to its control
 * (htmlFor, aria-describedby, aria-invalid). Three validation states:
 * default, error, success. Children may be plain nodes or a function
 * receiving { id, describedBy, invalid }.
 */
export function FormField({
  label,
  description,
  message,
  state = "default",
  children,
  required,
  className,
}: {
  label: string;
  description?: string;
  message?: string;
  state?: FieldState;
  children: ReactNode | ((ctx: { id: string; describedBy?: string; invalid: boolean }) => ReactNode);
  required?: boolean;
  className?: string;
}) {
  const id = useId();
  const descId = useId();
  const msgId = useId();
  const describedBy = [description ? descId : "", message ? msgId : ""].filter(Boolean).join(" ") || undefined;

  return (
    <FieldContext.Provider value={{ id, describedBy, state }}>
      <div className={cn("grid gap-1", className)} data-field-state={state}>
        <label htmlFor={id} className="flex items-baseline gap-1 font-sans text-[12px] font-medium text-ink">
          {label}
          {required && (
            <>
              <span className="text-accent" aria-hidden="true">
                ∗
              </span>
              <span className="sr-only">(obligatoire)</span>
            </>
          )}
        </label>
        {description && (
          <p id={descId} className="flex items-start gap-1 text-[12px] leading-snug text-ink-2">
            <Info aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-ink-3" />
            {description}
          </p>
        )}
        {typeof children === "function" ? (
          <FieldSlot>
            {(ctx) => children({ id: ctx.id, describedBy: ctx.describedBy, invalid: ctx.state === "error" })}
          </FieldSlot>
        ) : (
          children
        )}
        {message && (
          <p
            id={msgId}
            role={state === "error" ? "alert" : "status"}
            className={cn(
              "flex items-center gap-1.5 text-[12px] leading-snug",
              state === "error" && "text-danger",
              state === "success" && "text-ok",
              state === "default" && "text-ink-2",
            )}
          >
            {state === "error" && <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />}
            {state === "success" && <Check aria-hidden="true" className="size-3 shrink-0" />}
            {message}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

export function useField(): FieldCtx | null {
  return useContext(FieldContext);
}

/** Control wiring for raw inputs placed inside a FormField. */
export function fieldControlProps() {
  const ctx = useField();
  if (!ctx) throw new Error("fieldControlProps must be used inside FormField");
  return {
    id: ctx.id,
    "aria-describedby": ctx.describedBy,
    "aria-invalid": (ctx.state === "error" || undefined) as boolean | undefined,
  };
}
