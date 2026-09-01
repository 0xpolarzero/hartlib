import { forwardRef, type ComponentProps } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

/* ── Popover ──────────────────────────────────────────────────────────── */

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Anchor;
export const PopoverTriggerButton = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 rounded-tiny border border-line-2 bg-surface shadow-none",
        "data-[state=open]:animate-enter",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";

/* ── Dropdown menu ───────────────────────────────────────────────────── */

export type DropdownMenuProps = ComponentProps<typeof DropdownMenuPrimitive.Root> & {
  locale?: string;
};
export function DropdownMenu({ locale: _locale, ...props }: DropdownMenuProps) {
  return <DropdownMenuPrimitive.Root {...props} />;
}
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;

export const DropdownMenuContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-44 rounded-tiny border border-line-2 bg-surface p-1 shadow-none",
        "data-[state=open]:animate-enter",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "flex min-h-7 cursor-pointer select-none items-center gap-2 rounded-tiny px-1.5 py-1 text-[13px] text-ink",
      "outline-none transition-colors duration-100",
      "data-[highlighted]:bg-paper-deep",
      "data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-3 data-[disabled]:pointer-events-none",
      "[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ink-2",
      destructive && "text-danger [&_svg]:text-danger data-[highlighted]:bg-danger/10",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuCheckboxItem = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    {...(checked === undefined ? {} : { checked })}
    className={cn(
      "relative flex min-h-7 cursor-pointer select-none items-center gap-2 rounded-tiny py-1 pr-2 pl-6 text-[13px] text-ink",
      "outline-none transition-colors duration-100 data-[highlighted]:bg-paper-deep",
      "data-[disabled]:pointer-events-none data-[disabled]:text-ink-3",
      className,
    )}
    {...props}
  >
    <DropdownMenuPrimitive.ItemIndicator className="absolute left-1.5">
      <Check className="size-3 text-accent" />
    </DropdownMenuPrimitive.ItemIndicator>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export const DropdownMenuLabel = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn("caps-label px-1.5 py-1.5 text-ink-2", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn("my-1 h-px bg-line", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuSubTrigger = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      "flex min-h-7 cursor-pointer select-none items-center gap-2 rounded-tiny px-1.5 py-1 text-[13px] outline-none transition-colors duration-100 data-[highlighted]:bg-paper-deep data-[state=open]:bg-paper-deep",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto size-3 text-ink-2" />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      sideOffset={2}
      className={cn(
        "z-50 min-w-40 rounded-tiny border border-line-2 bg-surface p-1 shadow-none data-[state=open]:animate-enter",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

/* ── Tooltip (keyboard-triggerable: Radix opens on focus) ────────────── */

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  content,
  children,
  side = "top",
  shortcut,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  shortcut?: string;
}) {
  return (
    <TooltipPrimitive.Root delayDuration={320}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={5}
          className={cn(
            "z-50 flex items-center gap-1.5 rounded-tiny border border-line-2 bg-ink px-2 py-1",
            "font-sans text-[11.5px] leading-none text-paper",
            "data-[state=delayed-open]:animate-enter-fade",
          )}
        >
          {content}
          {shortcut && <span className="font-mono text-[10px] text-paper/70">{shortcut}</span>}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ── HoverCard (citation / source previews) ──────────────────────────── */

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;

export const HoverCardContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-80 rounded-tiny border border-line-2 bg-surface p-3 shadow-none",
        "data-[state=open]:animate-enter",
        className,
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = "HoverCardContent";
