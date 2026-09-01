import {
  forwardRef,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Check, Minus } from "lucide-react";
import { cn } from "../../lib/utils";

/* Checkbox — supports indeterminate (tri-state header checkboxes). */
export type CheckboxValue = boolean | "indeterminate";
export interface CheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: CheckboxValue;
  onCheckedChange?: (value: boolean) => void;
  invalid?: boolean;
}
export const Checkbox = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> & { invalid?: boolean }
>(({ className, invalid, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "flex size-[15px] shrink-0 items-center justify-center rounded-tiny border border-line-2 bg-surface",
      "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
      "hover:border-ink",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      "data-[state=checked]:border-ink data-[state=checked]:bg-ink data-[state=indeterminate]:border-ink data-[state=indeterminate]:bg-ink",
      "disabled:cursor-not-allowed disabled:border-line disabled:bg-paper-deep disabled:text-ink-3",
      invalid && "border-danger",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="text-paper">
      {props.checked === "indeterminate" ? (
        <Minus className="size-3" strokeWidth={2.5} />
      ) : (
        <Check className="size-3" strokeWidth={2.5} />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = "Checkbox";

/* Native-looking checkbox for pure-form cases where Radix is overkill. */
export const NativeCheckbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        "size-[15px] shrink-0 cursor-pointer appearance-none rounded-tiny border border-line-2 bg-surface",
        "checked:border-ink checked:bg-ink",
        "transition-colors duration-100",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "relative after:absolute after:inset-0 after:flex after:items-center after:justify-center",
        "after:text-paper after:content-['✓'] after:text-[10px] after:leading-none checked:after:opacity-100 after:opacity-0",
        className,
      )}
      {...props}
    />
  ),
);
NativeCheckbox.displayName = "NativeCheckbox";

/* Switch */
export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  invalid?: boolean;
}
export const Switch = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & { invalid?: boolean }
>(({ className, invalid, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "inline-flex h-[16px] w-[28px] shrink-0 items-center rounded-full border border-line-2 bg-paper-deep",
      "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
      "data-[state=checked]:border-ok data-[state=checked]:bg-ok",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      "disabled:cursor-not-allowed disabled:opacity-55",
      invalid && "border-danger",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "block size-[12px] translate-x-[2px] rounded-full bg-ink shadow-none",
        "transition-transform duration-100 ease-[cubic-bezier(0.23,1,0.32,1)] data-[state=checked]:translate-x-[14px] data-[state=checked]:bg-paper",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

/* Radio group */
export interface RadioGroupProps {
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}
export const RadioGroup = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn("grid gap-1", className)} {...props} />
));
RadioGroup.displayName = "RadioGroup";

export const RadioItem = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      "flex min-h-8 cursor-pointer items-center gap-2 rounded-tiny px-1 py-1 text-[13px]",
      "transition-colors duration-100 hover:bg-paper-deep/60",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
      className,
    )}
    {...props}
  >
    <span
      className={cn(
        "flex size-[15px] shrink-0 items-center justify-center rounded-full border border-line-2 bg-surface",
        "transition-colors duration-100",
        "data-[state=checked]:border-ok",
      )}
    >
      <RadioGroupPrimitive.Indicator className="block size-[7px] rounded-full bg-ok" />
    </span>
    <span className="text-left leading-tight">{children}</span>
  </RadioGroupPrimitive.Item>
));
RadioItem.displayName = "RadioItem";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}
const fieldBase = [
  "w-full rounded-tiny border border-line-2 bg-surface px-2.5 font-sans text-[13px] text-ink",
  "placeholder:text-ink-2/80",
  "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
  "hover:border-ink-3",
  "focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
  "disabled:cursor-not-allowed disabled:border-line disabled:bg-paper-deep/50 disabled:text-ink-2",
  "read-only:focus-visible:border-line-2",
].join(" ");

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, rows = 3, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        fieldBase,
        "py-1.5 leading-relaxed",
        invalid && "border-danger hover:border-danger focus-visible:border-danger",
        className,
      )}
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
      className={cn(
        "min-h-[28px] resize-none overflow-hidden",
        invalid && "border-danger",
        className,
      )}
      {...props}
    />
  );
});
AutoTextarea.displayName = "AutoTextarea";
