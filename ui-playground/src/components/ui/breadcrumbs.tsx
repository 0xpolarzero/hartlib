import { ChevronRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export interface Crumb {
  label: string;
  to?: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
}

/**
 * Breadcrumbs with responsive truncation: past three levels, middle crumbs
 * collapse to an ellipsis carrying the full path via `title`.
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const collapsed = items.length > 3;
  const visible: (Crumb | "ellipsis")[] = collapsed ? [items[0], "ellipsis", ...items.slice(-2)] : items;
  const hidden = collapsed ? items.slice(1, -2) : [];

  return (
    <nav aria-label="Fil d’Ariane" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1.5">
        {visible.map((crumb, i) => {
          const last = i === visible.length - 1;
          return (
            <li key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-ink-3" />}
              {crumb === "ellipsis" ? (
                <span
                  className="max-w-16 truncate font-sans text-[12px] text-ink-2"
                  title={hidden.map((h) => h.label).join(" › ")}
                >
                  …
                </span>
              ) : crumb.to && !last ? (
                <Link
                  to={crumb.to}
                  params={crumb.params}
                  search={crumb.search as never}
                  className="truncate font-sans text-[12px] text-ink-2 underline-offset-2 transition-colors duration-100 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className="truncate font-sans text-[12px] text-ink" title={crumb.label}>
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
