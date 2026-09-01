import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  type ReactNode,
} from "react";
import { Check, Info, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
export type FieldState = "default" | "error" | "success";
type FieldContextValue = { id: string; describedBy?: string; invalid: boolean };
const FieldContext = createContext<FieldContextValue | null>(null);
export function FormField({
  label,
  description,
  message,
  state = "default",
  children,
  required,
  locale = "en-US",
  className,
}: {
  label: string;
  description?: string;
  message?: string;
  state?: FieldState;
  children: ReactNode | ((props: FieldContextValue) => ReactNode);
  required?: boolean;
  locale?: string;
  className?: string;
}) {
  const id = useId();
  const descId = useId();
  const messageId = useId();
  const describedBy =
    [description ? descId : "", message ? messageId : ""].filter(Boolean).join(" ") || undefined;
  const field: FieldContextValue = {
    id,
    invalid: state === "error",
    ...(describedBy === undefined ? {} : { describedBy }),
  };
  const control =
    typeof children === "function"
      ? children(field)
      : isValidElement(children)
        ? cloneElement(children, {
            id,
            ...(describedBy === undefined ? {} : { "aria-describedby": describedBy }),
            ...(field.invalid ? { "aria-invalid": true } : {}),
          } as never)
        : children;
  return (
    <FieldContext.Provider value={field}>
      <div className={cn("grid gap-1", className)} data-field-state={state}>
        <label
          htmlFor={id}
          className="flex items-baseline gap-1 font-sans text-[12px] font-medium text-ink"
        >
          {label}
          {required && (
            <>
              <span aria-hidden="true" className="text-accent">
                ∗
              </span>
              <span className="sr-only">{uiMessage(locale, "ui.required")}</span>
            </>
          )}
        </label>
        {description && (
          <p id={descId} className="flex items-start gap-1 text-[12px] leading-snug text-ink-2">
            <Info aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-ink-3" />
            {description}
          </p>
        )}
        {control}
        {message && (
          <p
            id={messageId}
            role={state === "error" ? "alert" : "status"}
            className={cn(
              "flex items-center gap-1.5 text-[12px] leading-snug",
              state === "error" && "text-danger",
              state === "success" && "text-ok",
              state === "default" && "text-ink-2",
            )}
          >
            {state === "error" && <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />}
            {state === "success" && <Check className="size-3 shrink-0" aria-hidden="true" />}
            {message}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}
export function useField() {
  return useContext(FieldContext);
}
export function fieldControlProps() {
  const field = useField();
  if (!field) throw new Error("fieldControlProps must be used inside FormField");
  return {
    id: field.id,
    "aria-describedby": field.describedBy,
    "aria-invalid": field.invalid || undefined,
  };
}
