import { forwardRef, type InputHTMLAttributes } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/* Checkbox — supports indeterminate (tri-state header checkboxes). */
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
      {props.checked === "indeterminate" ? <Minus className="size-3" strokeWidth={2.5} /> : <Check className="size-3" strokeWidth={2.5} />}
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
export const RadioGroup = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <RadioGroupPrimitive.Root ref={ref} className={cn("grid gap-1", className)} {...props} />
  ),
);
RadioGroup.displayName = "RadioGroup";

export const RadioItem = forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>>(
  ({ className, children, ...props }, ref) => (
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
  ),
);
RadioItem.displayName = "RadioItem";
