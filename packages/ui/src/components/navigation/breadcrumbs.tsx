import { Fragment, type ReactNode } from "react";

import { cn } from "../../lib/utils";

export type BreadcrumbItem = {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
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
  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider",
        className,
      )}
    >
      {items.map((item, index) => {
        const isCurrent = index === items.length - 1;

        return (
          <Fragment key={index}>
            {index > 0 ? <span className="text-faint">{separator}</span> : null}
            {item.href && item.onClick ? (
              <a
                href={item.href}
                onClick={(event) => {
                  event.preventDefault();
                  item.onClick?.();
                }}
                className="font-mono uppercase tracking-wider text-muted transition-colors duration-fast hover:text-ink"
              >
                {item.label}
              </a>
            ) : item.href ? (
              <a
                href={item.href}
                aria-current={isCurrent ? "page" : undefined}
                className="font-mono uppercase tracking-wider text-muted transition-colors duration-fast hover:text-ink"
              >
                {item.label}
              </a>
            ) : (
              <span aria-current={isCurrent ? "page" : undefined} className="text-ink">
                {item.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
