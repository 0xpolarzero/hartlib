import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import * as React from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";

type OpenCtx = {
  open: boolean;
  setOpen: (value: boolean) => void;
  setTrigger: (element: HTMLElement | null) => void;
  contentId: string;
  locale: string;
};
type MenuItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onSelect">;
const OpenContext = createContext<OpenCtx | null>(null);
function Root({
  children,
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  locale = "en-US",
}: {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale?: string;
}) {
  const [internal, setInternal] = useState(defaultOpen);
  const open = controlled ?? internal;
  const trigger = useRef<HTMLElement | null>(null);
  const contentId = useId();
  const previousOpen = useRef(open);
  const setOpen = (next: boolean) => {
    if (controlled === undefined) setInternal(next);
    onOpenChange?.(next);
  };
  useEffect(() => {
    let timer: number | undefined;
    if (previousOpen.current && !open) {
      timer = window.setTimeout(() => trigger.current?.focus(), 0);
    }
    previousOpen.current = open;
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open]);
  return (
    <OpenContext.Provider
      value={{
        open,
        setOpen,
        setTrigger: (element) => {
          trigger.current = element;
        },
        contentId,
        locale,
      }}
    >
      {children}
    </OpenContext.Provider>
  );
}
export const Popover = Root;
export const DropdownMenu = Root;
export function PopoverClose({
  children,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode }) {
  const ctx = useContext(OpenContext);
  const resolvedChildren = children ?? uiMessage(ctx?.locale ?? "en-US", "ui.close");
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx?.setOpen(false);
      }}
    >
      {resolvedChildren}
    </button>
  );
}
/** Positioning anchor for a popover. It does not open the popover. */
export function PopoverTrigger({ children, asChild }: { children: ReactNode; asChild?: boolean }) {
  if (asChild && React.isValidElement(children)) return children;
  return <span>{children}</span>;
}
export function PopoverTriggerButton({
  children,
  asChild,
  popupRole = "true",
}: {
  children: ReactNode;
  asChild?: boolean;
  popupRole?: "true" | "menu" | "dialog";
}) {
  const ctx = useContext(OpenContext);
  if (asChild && React.isValidElement(children)) {
    const childProps = children.props as {
      onClick?: React.MouseEventHandler;
      onKeyDown?: React.KeyboardEventHandler;
    };
    return React.cloneElement(children, {
      "aria-haspopup": popupRole,
      "aria-expanded": ctx?.open ?? false,
      "aria-controls": ctx?.contentId,
      onClick: (event: React.MouseEvent) => {
        ctx?.setTrigger(event.currentTarget as HTMLElement);
        childProps.onClick?.(event);
        if (!event.defaultPrevented) ctx?.setOpen(!ctx.open);
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        childProps.onKeyDown?.(event);
        if (!event.defaultPrevented && event.key === "Escape" && ctx?.open) {
          event.preventDefault();
          event.stopPropagation();
          ctx.setOpen(false);
        }
      },
    } as never);
  }
  return (
    <button
      type="button"
      aria-haspopup={popupRole}
      aria-expanded={ctx?.open ?? false}
      aria-controls={ctx?.contentId}
      onClick={(event) => {
        ctx?.setTrigger(event.currentTarget);
        ctx?.setOpen(!ctx.open);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && ctx?.open) {
          event.preventDefault();
          event.stopPropagation();
          ctx.setOpen(false);
        }
      }}
    >
      {children}
    </button>
  );
}
export function DropdownMenuTrigger(props: { children: ReactNode; asChild?: boolean }) {
  return <PopoverTriggerButton {...props} popupRole="menu" />;
}
function LayerContent({
  className,
  children,
  align = "start",
  onKeyDown,
  ...props
}: HTMLAttributes<HTMLDivElement> & { align?: "start" | "end" | "center" }) {
  const ctx = useContext(OpenContext);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctx?.open) return;
    const menu = ref.current?.getAttribute("role") === "menu" ? ref.current : null;
    const focusableItems = () =>
      menu
        ? Array.from(
            menu.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"], [role="menuitemcheckbox"]',
            ),
          ).filter((item) => !item.disabled)
        : [];
    const focusFirst = () => focusableItems()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const items = focusableItems();
        if (items.length === 0) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) ctx.setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    if (menu) requestAnimationFrame(focusFirst);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [ctx]);
  if (!ctx?.open) return null;
  return (
    <div
      ref={ref}
      id={props.id ?? ctx.contentId}
      className={cn(
        "absolute z-50 mt-1 min-w-44 rounded-tiny border border-line-2 bg-surface p-1 shadow-none animate-enter",
        align === "end" && "right-0",
        className,
      )}
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          ctx?.setOpen(false);
        }
      }}
    >
      {children}
    </div>
  );
}
export const PopoverContent = LayerContent;
export function DropdownMenuContent(
  props: HTMLAttributes<HTMLDivElement> & { align?: "start" | "end" | "center" },
) {
  return <LayerContent role="menu" {...props} />;
}
export function DropdownMenuItem({
  className,
  destructive,
  onSelect,
  onClick,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onSelect"> & {
  destructive?: boolean;
  onSelect?: () => void;
}) {
  const ctx = useContext(OpenContext);
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "flex min-h-7 w-full cursor-pointer select-none items-center gap-2 rounded-tiny px-1.5 py-1 text-left text-[13px] text-ink outline-none hover:bg-paper-deep",
        destructive && "text-danger",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onSelect?.();
          ctx?.setOpen(false);
        }
      }}
      {...props}
    />
  );
}
export function DropdownMenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
  ...props
}: MenuItemProps & { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) {
  return (
    <DropdownMenuItem
      {...props}
      role="menuitemcheckbox"
      aria-checked={checked}
      onSelect={() => onCheckedChange?.(!checked)}
    >
      <span className="w-4">{checked ? <Check className="size-3 text-accent" /> : null}</span>
      {children}
    </DropdownMenuItem>
  );
}
export const DropdownMenuGroup = ({ children }: { children: ReactNode }) => <>{children}</>;
export function DropdownMenuLabel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("caps-label px-1.5 py-1.5 text-ink-2", className)} {...props} />;
}
export function DropdownMenuSeparator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("my-1 h-px bg-line", className)} {...props} />;
}
export const DropdownMenuSub = Root;
export function DropdownMenuSubTrigger({ children, ...props }: MenuItemProps) {
  const ctx = useContext(OpenContext);
  return (
    <PopoverTriggerButton asChild popupRole="menu">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={ctx?.open ?? false}
        className="flex min-h-7 w-full cursor-pointer select-none items-center gap-2 rounded-tiny px-1.5 py-1 text-left text-[13px] text-ink outline-none hover:bg-paper-deep"
        {...props}
      >
        {children}
        <ChevronRight className="ml-auto size-3" />
      </button>
    </PopoverTriggerButton>
  );
}
export function DropdownMenuSubContent(
  props: HTMLAttributes<HTMLDivElement> & { align?: "start" | "end" | "center" },
) {
  return <LayerContent role="menu" {...props} />;
}
export function Tooltip({
  content,
  children,
  side = "top",
  shortcut,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  shortcut?: string;
}) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const child = React.isValidElement(children)
    ? React.cloneElement(children, {
        "aria-describedby": tooltipId,
      } as never)
    : children;
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {child}
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          className={cn(
            "absolute z-50 whitespace-nowrap rounded-tiny border border-line-2 bg-ink px-2 py-1 text-[11.5px] text-paper animate-enter-fade",
            side === "bottom"
              ? "left-1/2 top-full mt-1 -translate-x-1/2"
              : side === "left"
                ? "right-full top-1/2 mr-1 -translate-y-1/2"
                : side === "right"
                  ? "left-full top-1/2 ml-1 -translate-y-1/2"
                  : "bottom-full left-1/2 mb-1 -translate-x-1/2",
          )}
        >
          {content}
          {shortcut && <span className="ml-1 font-mono text-[10px] text-paper/70">{shortcut}</span>}
        </span>
      )}
    </span>
  );
}
export const TooltipProvider = ({ children }: { children: ReactNode }) => <>{children}</>;
type HoverCtx = { open: boolean; setOpen: (open: boolean) => void };
const HoverContext = createContext<HoverCtx | null>(null);
export function HoverCard({
  children,
  open: controlled,
  defaultOpen = false,
  onOpenChange,
}: {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internal, setInternal] = useState(defaultOpen);
  const open = controlled ?? internal;
  const setOpen = (next: boolean) => {
    if (controlled === undefined) setInternal(next);
    onOpenChange?.(next);
  };
  return (
    <HoverContext.Provider value={{ open, setOpen }}>
      <span
        className="relative inline-flex"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children}
      </span>
    </HoverContext.Provider>
  );
}
export function HoverCardTrigger({
  children,
  asChild = false,
}: {
  children: ReactNode;
  asChild?: boolean;
}) {
  const ctx = useContext(HoverContext);
  if (asChild && React.isValidElement(children)) {
    const childProps = children.props as {
      onFocus?: React.FocusEventHandler;
      onMouseEnter?: React.MouseEventHandler;
    };
    return React.cloneElement(children, {
      onFocus: (event: React.FocusEvent) => {
        childProps.onFocus?.(event);
        if (!event.defaultPrevented) ctx?.setOpen(true);
      },
      onMouseEnter: (event: React.MouseEvent) => {
        childProps.onMouseEnter?.(event);
        if (!event.defaultPrevented) ctx?.setOpen(true);
      },
    } as never);
  }
  return (
    <span tabIndex={0} onFocus={() => ctx?.setOpen(true)} onMouseEnter={() => ctx?.setOpen(true)}>
      {children}
    </span>
  );
}
export const HoverCardContent = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => {
  const ctx = useContext(HoverContext);
  return ctx?.open ? (
    <div
      className={cn(
        "absolute z-50 mt-1 rounded-tiny border border-line-2 bg-surface p-3 animate-enter",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ) : null;
};
