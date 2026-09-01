import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import * as React from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
import { Button } from "./button";

type DialogCtx = {
  open: boolean;
  setOpen: (open: boolean) => void;
  titleId?: string | undefined;
  setTitleId: (id: string | undefined) => void;
  role: "dialog" | "alertdialog";
  locale: string;
};
const DialogContext = createContext<DialogCtx | null>(null);

type DialogRootProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale?: string;
  children: ReactNode;
};

function DialogRoot({
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  locale = "en-US",
  role,
  children,
}: DialogRootProps & { role: "dialog" | "alertdialog" }) {
  const [internal, setInternal] = useState(defaultOpen);
  const open = controlled ?? internal;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlled === undefined) setInternal(next);
      onOpenChangeRef.current?.(next);
    },
    [controlled],
  );
  const [titleId, setTitleId] = useState<string | undefined>();
  const value = useMemo(
    () => ({ open, setOpen, titleId, setTitleId, role, locale }),
    [locale, open, role, titleId],
  );
  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

export function Dialog(props: DialogRootProps) {
  return <DialogRoot {...props} role="dialog" />;
}

export function AlertDialog(props: DialogRootProps) {
  return <DialogRoot {...props} role="alertdialog" />;
}

export function DialogTrigger({
  asChild,
  children,
  onClick,
  ...props
}: { asChild?: boolean; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  const ctx = useContext(DialogContext);
  if (asChild && React.isValidElement(children)) {
    const childProps = children.props as {
      className?: string;
      onClick?: (event: React.MouseEvent) => void;
    };
    return React.cloneElement(children, {
      ...props,
      className: cn(props.className, childProps.className),
      onClick: (event: React.MouseEvent) => {
        childProps.onClick?.(event);
        if (!event.defaultPrevented) onClick?.(event as React.MouseEvent<HTMLElement>);
        if (!event.defaultPrevented) ctx?.setOpen(true);
      },
    } as never);
  }
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx?.setOpen(true);
      }}
    >
      {children}
    </button>
  );
}
export function DialogClose({
  children,
  ...props
}: { children?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const ctx = useContext(DialogContext);
  const resolvedChildren = children ?? uiMessage(ctx?.locale ?? "en-US", "ui.close");
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) ctx?.setOpen(false);
      }}
    >
      {resolvedChildren}
    </button>
  );
}

export function DialogContent({
  className,
  children,
  hideClose = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { hideClose?: boolean }) {
  const ctx = useContext(DialogContext);
  const ref = useRef<HTMLDivElement>(null);
  const isOpen = ctx?.open ?? false;
  const setOpen = ctx?.setOpen;
  useEffect(() => {
    if (!isOpen || !setOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key === "Tab" && ref.current) {
        const focusable = Array.from(
          ref.current.querySelectorAll<HTMLElement>(
            "button,a,input,textarea,select,[tabindex]:not([tabindex='-1'])",
          ),
        ).filter((node) => !node.hasAttribute("disabled"));
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() =>
      (
        ref.current?.querySelector<HTMLElement>(
          "[autofocus],button,input,textarea,select,[tabindex]:not([tabindex='-1'])",
        ) ?? ref.current
      )?.focus(),
    );
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, [isOpen, setOpen]);
  if (!ctx?.open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={uiMessage(ctx.locale, "ui.close")}
        className="absolute inset-0 bg-ink/25 animate-enter-fade"
        onClick={() => ctx.setOpen(false)}
      />
      <div
        ref={ref}
        {...props}
        role={ctx.role}
        aria-modal="true"
        tabIndex={-1}
        {...(ctx.titleId === undefined
          ? { "aria-label": uiMessage(ctx.locale, "ui.dialog") }
          : { "aria-labelledby": ctx.titleId })}
        className={cn(
          "absolute left-1/2 top-[12vh] max-h-[76vh] w-[min(94vw,44rem)] -translate-x-1/2 overflow-y-auto rounded-tiny border border-line-2 bg-surface animate-enter",
          className,
        )}
      >
        {children}
        {!hideClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-2.5 top-2.5 flex size-6 items-center justify-center rounded-tiny text-ink-2 transition-colors duration-100 hover:bg-paper-deep hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            aria-label={uiMessage(ctx.locale, "ui.close")}
            onClick={() => ctx.setOpen(false)}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-h-12 items-center justify-between gap-8 border-b border-line px-4",
        className,
      )}
      {...props}
    />
  );
}
export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  const id = useId();
  const ctx = useContext(DialogContext);
  const setTitleId = ctx?.setTitleId;
  useEffect(() => {
    if (!setTitleId) return;
    setTitleId(id);
    return () => setTitleId(undefined);
  }, [id, setTitleId]);
  return (
    <h2
      id={id}
      className={cn("font-display text-[17px] font-medium text-ink", className)}
      {...props}
    />
  );
}
export function DialogDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-[13px] leading-relaxed text-ink-2", className)} {...props} />;
}
export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3.5 text-[13px]", className)} {...props} />;
}
export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-h-12 items-center justify-end gap-2 border-t border-line px-4",
        className,
      )}
      {...props}
    />
  );
}
export function AlertDialogTrigger(props: Parameters<typeof DialogTrigger>[0]) {
  return <DialogTrigger {...props} />;
}
export function AlertDialogAction(props: Parameters<typeof DialogClose>[0]) {
  return <DialogClose {...props} />;
}
export function AlertDialogCancel(props: Parameters<typeof DialogClose>[0]) {
  return <DialogClose {...props} />;
}
export function AlertDialogContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { hideClose?: boolean }) {
  return <DialogContent {...props} className={cn("top-[18vh] w-[min(92vw,30rem)]", className)} />;
}
export function AlertDialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <DialogTitle className={cn("text-[16px]", className)} {...props} />;
}
export function AlertDialogDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return <DialogDescription className={cn("mt-1", className)} {...props} />;
}
