import { forwardRef, type HTMLAttributes, type LabelHTMLAttributes } from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <LabelPrimitive.Root
      ref={ref}
      className={cn("font-sans text-[12px] font-medium text-ink select-none", className)}
      {...props}
    />
  ),
);
Label.displayName = "Label";

export const Separator = forwardRef<
  HTMLHRElement,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      "shrink-0 bg-line",
      orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch",
      className,
    )}
    {...props}
  />
));
Separator.displayName = "Separator";

const badgeVariants = cva(
  "inline-flex select-none items-center gap-1 rounded-tiny border px-1.5 py-0.5 font-sans text-[11px] font-medium leading-4 whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-line-2 bg-paper-deep/60 text-ink-2",
        outline: "border-line-2 bg-transparent text-ink-2",
        success: "border-ok/30 bg-ok/10 text-ok",
        warning: "border-warn/30 bg-warn/10 text-warn",
        danger: "border-danger/30 bg-danger/10 text-danger",
        accent: "border-accent/30 bg-accent/10 text-accent",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/** Flat hairline card — no shadow, no nesting. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-tiny border border-line bg-surface", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex min-h-9 items-center justify-between gap-2 border-b border-line px-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("font-display text-[15px] font-medium", className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-3 py-3 text-[13px]", className)} {...props} />;
}

/** Flat opacity pulse — no shimmer gradient (register: no gradient motion). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("animate-pulse-soft bg-paper-deep", className)} {...props} />;
}

/** Keyboard key hint. */
export function Kbd({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-tiny border border-line-2 bg-surface px-1 font-mono text-[10px] text-ink-2",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Small-caps meta label. */
export function CapsLabel({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("caps-label text-ink-2", className)} {...props} />;
}

/** Metadata key–value row (dl semantics). */
export function MetaRow({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 border-b border-line py-1.5 last:border-b-0", className)}>
      <dt className="caps-label shrink-0 text-ink-2">{label}</dt>
      <dd className="text-right text-[13px] text-ink">{children}</dd>
    </div>
  );
}
