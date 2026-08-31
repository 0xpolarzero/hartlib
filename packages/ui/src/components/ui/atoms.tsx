import { forwardRef, type HTMLAttributes, type LabelHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn("select-none font-sans text-[12px] font-medium text-ink", className)}
      {...props}
    />
  ),
);
Label.displayName = "Label";

export const Separator = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    orientation?: "horizontal" | "vertical";
    decorative?: boolean;
  }
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <div
    ref={ref}
    role={decorative ? undefined : "separator"}
    aria-orientation={decorative ? undefined : orientation}
    className={cn(
      "shrink-0 bg-line",
      orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch",
      className,
    )}
    {...props}
  />
));
Separator.displayName = "Separator";

export type BadgeTone = "neutral" | "outline" | "success" | "warning" | "danger" | "accent";
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}
export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  const toneClass: Record<BadgeTone, string> = {
    neutral: "border-line-2 bg-paper-deep/60 text-ink-2",
    outline: "border-line-2 bg-transparent text-ink-2",
    success: "border-ok/30 bg-ok/10 text-ok",
    warning: "border-warn/30 bg-warn/10 text-warn",
    danger: "border-danger/30 bg-danger/5 text-danger",
    accent: "border-accent/30 bg-accent/10 text-accent",
  };
  return (
    <span
      className={cn(
        "inline-flex select-none items-center gap-1 rounded-tiny border px-1.5 py-0.5 font-sans text-[11px] font-medium leading-4 whitespace-nowrap",
        toneClass[tone],
        className,
      )}
      {...props}
    />
  );
}
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-tiny border border-line bg-surface", className)} {...props} />;
}
export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-h-9 items-center justify-between gap-2 border-b border-line px-3",
        className,
      )}
      {...props}
    />
  );
}
export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("font-display text-[15px] font-medium", className)} {...props} />;
}
export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-3 py-3 text-[13px]", className)} {...props} />;
}
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse-soft bg-paper-deep", className)}
      {...props}
    />
  );
}
export function Kbd({ className, children }: { className?: string; children: ReactNode }) {
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
export function CapsLabel({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("caps-label text-ink-2", className)} {...props} />;
}
export function MetaRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 border-b border-line py-1.5 last:border-b-0",
        className,
      )}
    >
      <dt className="caps-label shrink-0 text-ink-2">{label}</dt>
      <dd className="text-right text-[13px] text-ink">{children}</dd>
    </div>
  );
}
export interface SectionHeaderProps extends HTMLAttributes<HTMLDivElement> {
  kicker?: string;
  title: string;
  description?: string;
  aside?: ReactNode;
  count?: number;
}
export function SectionHeader({
  kicker,
  title,
  description,
  aside,
  count,
  className,
  ...props
}: SectionHeaderProps) {
  return (
    <div
      className={cn("flex flex-wrap items-end justify-between gap-3 pb-3", className)}
      {...props}
    >
      <div className="min-w-0">
        {kicker && <p className="caps-label text-accent">{kicker}</p>}
        <h2 className="mt-1 font-display text-[22px] font-medium leading-tight">
          {title}
          {count !== undefined && (
            <span className="ml-2 font-mono text-[11px] text-ink-2">{count}</span>
          )}
        </h2>
        {description && (
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-2">{description}</p>
        )}
      </div>
      {aside && <div>{aside}</div>}
    </div>
  );
}
