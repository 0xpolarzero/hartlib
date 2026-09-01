import { forwardRef } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "../../lib/utils";

export const Command: typeof CommandPrimitive = CommandPrimitive;
export type CommandProps = React.ComponentPropsWithoutRef<typeof CommandPrimitive>;

/**
 * Command palette pieces on cmdk (ARIA combobox pattern: input with
 * aria-expanded/controls, listbox with options, active option tracked).
 */
export const CommandInput = forwardRef<
  HTMLInputElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center gap-2 border-b border-line px-3.5" cmdk-input-wrapper="">
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "h-11 w-full bg-transparent font-sans text-[14px] text-ink outline-none",
        "placeholder:text-ink-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = "CommandInput";

export const CommandList = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("max-h-[min(60vh,26rem)] overflow-y-auto overflow-x-hidden p-1.5", className)}
    {...props}
  />
));
CommandList.displayName = "CommandList";

export const CommandEmpty = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="px-3 py-8 text-center text-[13px] text-ink-2"
    {...props}
  />
));
CommandEmpty.displayName = "CommandEmpty";

export const CommandGroup = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "overflow-hidden text-ink",
      "[&_[cmdk-group-heading]]:caps-label [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-ink-2",
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = "CommandGroup";

export const CommandItem = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "flex min-h-8 cursor-pointer select-none items-center gap-2.5 rounded-tiny px-2 py-1.5 text-[13px] text-ink",
      "transition-colors duration-100",
      "data-[selected=true]:bg-paper-deep data-[disabled=true]:pointer-events-none data-[disabled=true]:text-ink-3",
      "[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ink-2",
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = "CommandItem";

export const CommandSeparator = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator ref={ref} className={cn("my-1 h-px bg-line", className)} {...props} />
));
CommandSeparator.displayName = "CommandSeparator";
