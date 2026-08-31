import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
import { Button } from "./button";
export { SectionHeader } from "./atoms";
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
    <div className={cn("px-6 py-10 text-center", className)}>
      <div className="mx-auto w-fit">
        <div className="animate-enter-fade mx-auto mb-3 h-px w-10 bg-line-2" aria-hidden="true" />
        <p className="font-display text-[17px] leading-snug text-ink">{title}</p>
        {description && (
          <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">
            {description}
          </p>
        )}
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
  locale = "en-US",
  className,
}: {
  title: string;
  description?: string;
  code?: string;
  onRetry?: () => void;
  retryLabel?: string;
  locale?: string;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("animate-enter-fade px-6 py-10 text-center", className)}>
      <div className="mx-auto w-fit">
        <div className="mx-auto mb-3 h-px w-10 bg-danger/40" aria-hidden="true" />
        <p className="font-display text-[17px] leading-snug text-ink">{title}</p>
        {description && (
          <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">
            {description}
          </p>
        )}
        {code && <p className="mt-2 font-mono text-[11px] text-danger">{code}</p>}
        {onRetry && (
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {retryLabel ?? uiMessage(locale, "ui.retry")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
