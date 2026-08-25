import { forwardRef, useLayoutEffect, useRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const fieldBase = [
  "w-full rounded-tiny border border-line-2 bg-surface px-2.5 font-sans text-[13px] text-ink",
  "placeholder:text-ink-2/80",
  "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
  "hover:border-ink-3",
  "focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
  "disabled:cursor-not-allowed disabled:border-line disabled:bg-paper-deep/50 disabled:text-ink-2",
  "read-only:focus-visible:border-line-2",
].join(" ");

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, "h-7", invalid && "border-danger hover:border-danger focus-visible:border-danger", className)}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  ({ className, invalid, rows = 3, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, "py-1.5 leading-relaxed", invalid && "border-danger hover:border-danger focus-visible:border-danger", className)}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

/** Auto-growing textarea (composer, inline edit). Caps at maxRows. */
export const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { maxRows?: number; invalid?: boolean }
>(({ className, maxRows = 8, invalid, ...props }, ref) => {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const cs = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(cs.lineHeight) || 20;
    const pad = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
    el.style.height = "0px";
    const contentHeight = Math.ceil(el.scrollHeight);
    const maxHeight = Math.round(lineHeight * maxRows + pad);
    el.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [props.value, maxRows]);
  return (
    <Textarea
      ref={(node) => {
        inner.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      className={cn("min-h-[28px] resize-none overflow-hidden", invalid && "border-danger", className)}
      {...props}
    />
  );
});
AutoTextarea.displayName = "AutoTextarea";
