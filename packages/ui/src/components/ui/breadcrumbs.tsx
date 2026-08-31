import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
export interface BreadcrumbItem {
  label: string;
  href?: string;
  to?: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
  onClick?: () => void;
  truncate?: boolean;
}
export interface BreadcrumbsProps {
  items: readonly BreadcrumbItem[];
  className?: string;
  ariaLabel?: string;
  locale?: string;
}
export function Breadcrumbs({ items, className, ariaLabel, locale = "en-US" }: BreadcrumbsProps) {
  const collapsed = items.length > 3;
  const visible = collapsed ? [items[0]!, { label: "…" }, ...items.slice(-2)] : items;
  return (
    <nav
      aria-label={ariaLabel ?? uiMessage(locale, "ui.breadcrumb")}
      className={cn("min-w-0", className)}
    >
      <ol className="flex min-w-0 items-center gap-1.5">
        {visible.map((item, index) => {
          const last = index === visible.length - 1;
          const href = item.href ?? item.to;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && (
                <ChevronRight className="size-3 shrink-0 text-ink-3" aria-hidden="true" />
              )}
              {href && !last ? (
                <a
                  href={href}
                  onClick={(event) => {
                    if (item.onClick) {
                      event.preventDefault();
                      item.onClick();
                    }
                  }}
                  className="truncate text-[12px] text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                >
                  {item.label}
                </a>
              ) : item.onClick && !last ? (
                <button
                  type="button"
                  onClick={item.onClick}
                  className="truncate text-[12px] text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                >
                  {item.label}
                </button>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn("truncate text-[12px]", item.truncate && "max-w-56")}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
