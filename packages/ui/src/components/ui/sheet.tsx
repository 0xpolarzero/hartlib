import type { HTMLAttributes } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "./dialog";
export const Sheet = Dialog;
export const SheetTrigger = DialogTrigger;
export const SheetClose = DialogClose;
export function SheetContent({
  side = "right",
  locale = "en-US",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { side?: "left" | "right" | "bottom"; locale?: string }) {
  return (
    <DialogContent
      hideClose
      className={cn(
        "inset-y-0 top-0 h-full max-h-none w-[min(92vw,26rem)] translate-x-0 rounded-none",
        side === "left"
          ? "left-0 border-r"
          : side === "bottom"
            ? "bottom-0 left-0 top-auto h-auto w-full"
            : "right-0 left-auto",
        className,
      )}
      {...props}
    >
      {children}
      <DialogClose
        aria-label={uiMessage(locale, "ui.close")}
        className="absolute right-2.5 top-2.5 flex size-6 items-center justify-center rounded-tiny text-ink-2 hover:bg-paper-deep"
      >
        <X className="size-3.5" />
      </DialogClose>
    </DialogContent>
  );
}
export function SheetHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-h-12 shrink-0 items-center justify-between gap-8 border-b border-line px-4",
        className,
      )}
      {...props}
    />
  );
}
export function SheetBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-3.5", className)} {...props} />;
}
export function SheetFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}
export { DialogTitle as SheetTitle, DialogDescription as SheetDescription };
