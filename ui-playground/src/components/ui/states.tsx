import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/**
 * Illustration-free typographic states: a hairline, a Fraunces line, a sans
 * detail, an optional action. Errors additionally carry a mono code.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("animate-enter-fade px-6 py-10 text-center", className)}>
      <div className="mx-auto w-fit">
        <div className="mx-auto mb-3 h-px w-10 bg-line-2" aria-hidden="true" />
        <p className="font-display text-[17px] leading-snug text-ink">{title}</p>
        {description && <p className="mx-auto mt-1.5 max-w-sm font-sans text-[13px] leading-relaxed text-ink-2">{description}</p>}
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

export function ErrorState({
  title,
  description,
  code,
  onRetry,
  retryLabel,
  className,
}: {
  title: string;
  description?: string;
  code?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("animate-enter-fade px-6 py-10 text-center", className)}>
      <div className="mx-auto w-fit">
        <div className="mx-auto mb-3 h-px w-10 bg-danger/40" aria-hidden="true" />
        <p className="font-display text-[17px] leading-snug text-ink">{title}</p>
        {description && <p className="mx-auto mt-1.5 max-w-sm font-sans text-[13px] leading-relaxed text-ink-2">{description}</p>}
        {code && (
          <p className="mt-2 font-mono text-[11px] tracking-wide text-danger">
            {code}
          </p>
        )}
        {onRetry && (
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {retryLabel ?? "Réessayer"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Section header: small-caps kicker + display title + optional aside. */
export function SectionHeader({
  kicker,
  title,
  aside,
  description,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { kicker?: string; title: string; aside?: ReactNode; description?: string }) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3 pb-3", className)} {...props}>
      <div className="min-w-0">
        {kicker && <p className="caps-label text-accent">{kicker}</p>}
        <h2 className="mt-1 font-display text-[22px] leading-tight font-medium text-ink">{title}</h2>
        {description && <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-2">{description}</p>}
      </div>
      {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </div>
  );
}
