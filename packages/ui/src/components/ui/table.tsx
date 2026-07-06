import type * as React from "react";
import { cn } from "../../lib/utils";

export function Table({ className, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <table
      data-slot="table"
      className={cn("w-full caption-bottom border-collapse", className)}
      {...props}
    />
  );
}

export function TableHeader({
  className,
  stickyHeader,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement> & {
  stickyHeader?: boolean;
}) {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        "border-b border-rule text-left text-[11px] font-medium uppercase tracking-wider text-faint",
        stickyHeader && "sticky top-0 z-10",
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody data-slot="table-body" className={className} {...props} />;
}

export function TableFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t border-rule font-medium text-ink last:border-b-0", className)}
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      data-slot="table-row"
      className={cn("transition-colors duration-fast data-[state=selected]:bg-surface", className)}
      {...props}
    />
  );
}

export function TableHead({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableHeaderCellElement>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-6 px-3 py-1 text-left align-middle font-normal first:pl-0 last:pr-0",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableDataCellElement>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-11 border-b border-rule px-3 py-2 align-middle text-sm text-ink first:pl-0 last:pr-0",
        className,
      )}
      {...props}
    />
  );
}

export function TableCaption({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableCaptionElement>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-2 text-xs text-muted", className)}
      {...props}
    />
  );
}
