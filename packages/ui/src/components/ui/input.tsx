import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-7 w-full rounded-tiny border border-line-2 bg-surface px-2.5 font-sans text-[13px] text-ink placeholder:text-ink-2/80",
        "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-ink-3 focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:border-line disabled:bg-paper-deep/50 disabled:text-ink-2",
        "read-only:focus-visible:border-line-2",
        invalid && "border-danger hover:border-danger focus-visible:border-danger",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

// Keep text controls together at the public primitive boundary. The
// implementations live in controls.tsx so composer and form controls share
// the same auto-grow behavior.
export { AutoTextarea, Textarea } from "./controls";
