import {
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import * as React from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "../../lib/utils";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked = false, onCheckedChange, className, disabled, onClick, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cn(
        "inline-flex h-[16px] w-[28px] shrink-0 items-center rounded-full border border-line-2 bg-paper-deep",
        "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-55",
        checked && "border-ok bg-ok",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) onCheckedChange?.(!checked);
      }}
      {...props}
    >
      <span
        className={cn(
          "block size-[12px] translate-x-[2px] rounded-full bg-ink shadow-none transition-transform duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
          checked && "translate-x-[14px] bg-paper",
        )}
      />
    </button>
  ),
);
Switch.displayName = "Switch";

export type CheckboxValue = boolean | "indeterminate";
export interface CheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: CheckboxValue;
  onCheckedChange?: (value: boolean) => void;
  invalid?: boolean;
}
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked = false, onCheckedChange, className, invalid, disabled, onClick, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked === "indeterminate" ? "mixed" : checked}
      disabled={disabled}
      className={cn(
        "flex size-[15px] shrink-0 items-center justify-center rounded-tiny border border-line-2 bg-surface",
        "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:border-line disabled:bg-paper-deep disabled:text-ink-3",
        (checked === true || checked === "indeterminate") && "border-ink bg-ink text-paper",
        invalid && "border-danger",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled)
          onCheckedChange?.(checked === "indeterminate" ? true : !checked);
      }}
      {...props}
    >
      {checked === "indeterminate" ? (
        <Minus className="size-3" strokeWidth={2.5} />
      ) : checked ? (
        <Check className="size-3" strokeWidth={2.5} />
      ) : null}
    </button>
  ),
);
Checkbox.displayName = "Checkbox";
export const NativeCheckbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        "relative size-[15px] shrink-0 cursor-pointer appearance-none rounded-tiny border border-line-2 bg-surface",
        "checked:border-ink checked:bg-ink transition-colors duration-100",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "after:absolute after:inset-0 after:flex after:items-center after:justify-center after:text-paper after:content-['✓'] after:text-[10px] after:leading-none checked:after:opacity-100 after:opacity-0",
        className,
      )}
      {...props}
    />
  ),
);

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, rows = 3, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        "min-h-7 w-full resize-y rounded-tiny border border-line-2 bg-surface px-2.5 py-1.5 font-sans text-[13px] text-ink",
        "placeholder:text-ink-2/80 transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-ink-3",
        "focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:border-line disabled:bg-paper-deep/50 disabled:text-ink-2",
        invalid && "border-danger hover:border-danger focus-visible:border-danger",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
NativeCheckbox.displayName = "NativeCheckbox";

type RadioContextValue = {
  value?: string;
  firstValue?: string;
  onValueChange?: (value: string) => void;
};
const RadioContext = createContext<RadioContextValue | null>(null);
export interface RadioGroupProps {
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}
export function RadioGroup({
  value,
  onValueChange,
  children,
  className,
  ...props
}: RadioGroupProps) {
  const baseContext: RadioContextValue = {
    ...(value === undefined ? {} : { value }),
    ...(onValueChange === undefined ? {} : { onValueChange }),
  };
  const items = React.Children.toArray(children);
  const firstValue = items
    .map((child) =>
      React.isValidElement(child) ? (child.props as { value?: unknown }).value : undefined,
    )
    .find((item): item is string => typeof item === "string");
  const contextValue: RadioContextValue = {
    ...baseContext,
    ...(firstValue === undefined ? {} : { firstValue }),
  };
  return (
    <RadioContext.Provider value={contextValue}>
      <div
        role="radiogroup"
        className={cn("grid gap-1", className)}
        onKeyDown={(event) => {
          if (
            !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          )
            return;
          const radios = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
          ).filter((radio) => !radio.disabled);
          if (radios.length === 0) return;
          event.preventDefault();
          const index = radios.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? radios.length - 1
                : (Math.max(index, 0) +
                    (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) +
                    radios.length) %
                  radios.length;
          const radio = radios[next];
          radio?.focus();
          const nextValue = radio?.dataset.radioValue;
          if (nextValue) onValueChange?.(nextValue);
        }}
        {...props}
      >
        {items.map((child, index) =>
          React.isValidElement(child)
            ? React.cloneElement(child, { "data-radio-index": index } as never)
            : child,
        )}
      </div>
    </RadioContext.Provider>
  );
}
export function RadioItem({
  value,
  children,
  className,
  onClick,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) {
  const context = useContext(RadioContext);
  const checked = context?.value === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked || (context?.value === undefined && context?.firstValue === value) ? 0 : -1}
      disabled={disabled}
      className={cn(
        "flex min-h-8 cursor-pointer items-center gap-2 rounded-tiny px-1 py-1 text-[13px] text-left",
        "transition-colors duration-100 hover:bg-paper-deep/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) context?.onValueChange?.(value);
      }}
      data-radio-value={value}
      {...props}
    >
      <span
        className={cn(
          "flex size-[15px] shrink-0 items-center justify-center rounded-full border border-line-2 bg-surface",
          "transition-colors duration-100",
          checked && "border-ok",
        )}
      >
        {checked && <span className="block size-[7px] rounded-full bg-ok" />}
      </span>
      <span className="text-left leading-tight">{children}</span>
    </button>
  );
}

export const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { maxRows?: number }
>(({ className, maxRows = 8, ...props }, ref) => {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight) || 20;
    const pad =
      (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0);
    el.style.height = "0px";
    const max = line * maxRows + pad;
    const height = Math.min(max, Math.max(line + pad, el.scrollHeight));
    el.style.height = `${height}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [props.value, maxRows]);
  return (
    <textarea
      ref={(node) => {
        inner.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      className={cn(
        "min-h-7 w-full resize-none overflow-hidden rounded-tiny border border-line-2 bg-surface px-2.5 py-1.5 font-sans text-[13px] text-ink",
        "placeholder:text-ink-2/80 transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-ink-3",
        "focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:border-line disabled:bg-paper-deep/50 disabled:text-ink-2",
        className,
      )}
      {...props}
    />
  );
});
AutoTextarea.displayName = "AutoTextarea";
