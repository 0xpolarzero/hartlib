import { Fragment, type ReactNode } from "react";

import { cn } from "../../lib/utils";

export type BreadcrumbItem = {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
  truncate?: boolean;
};

export type BreadcrumbsProps = {
  items: readonly BreadcrumbItem[];
  className?: string;
  separator?: ReactNode;
  "aria-label"?: string;
};

export function Breadcrumbs({
  items,
  className,
  separator = "/",
  "aria-label": ariaLabel = "Breadcrumb",
}: BreadcrumbsProps) {
  const linkClassName =
    "font-mono uppercase tracking-wider text-muted transition-transform duration-fast ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 [@media(hover:hover)_and_(pointer:fine)]:hover:text-ink";
  const truncateClassName =
    "min-w-0 max-w-[min(48vw,13rem)] truncate sm:max-w-[min(42vw,22rem)] lg:max-w-[min(36vw,32rem)]";

  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "flex min-w-0 items-center gap-2 overflow-hidden font-mono text-[11px] uppercase tracking-wider",
        className,
      )}
    >
      {items.map((item, index) => {
        const isCurrent = index === items.length - 1;
        const title = item.truncate && typeof item.label === "string" ? item.label : undefined;
        const itemClassName = cn(item.truncate ? truncateClassName : "shrink-0");

        return (
          <Fragment key={index}>
            {index > 0 ? <span className="shrink-0 text-faint">{separator}</span> : null}
            {item.href && item.onClick ? (
              <a
                href={item.href}
                title={title}
                onClick={(event) => {
                  event.preventDefault();
                  item.onClick?.();
                }}
                className={cn(linkClassName, itemClassName)}
              >
                {item.label}
              </a>
            ) : item.href ? (
              <a
                href={item.href}
                aria-current={isCurrent ? "page" : undefined}
                title={title}
                className={cn(linkClassName, itemClassName)}
              >
                {item.label}
              </a>
            ) : (
              <span
                aria-current={isCurrent ? "page" : undefined}
                title={title}
                className={cn("text-ink", itemClassName)}
              >
                {item.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
