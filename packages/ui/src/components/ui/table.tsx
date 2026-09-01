import { forwardRef, type HTMLAttributes, type ThHTMLAttributes } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "../../lib/utils";

export function TableScroll({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("w-full overflow-x-auto", className)} {...props} />;
}
export const Table = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <table
      ref={ref}
      className={cn("w-full border-collapse text-left font-sans text-[13px]", className)}
      {...props}
    />
  ),
);
Table.displayName = "Table";
export function THead({
  className,
  sticky,
  ...props
}: HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }) {
  return (
    <thead
      className={cn(
        "bg-paper",
        sticky && "sticky top-0 z-10 [&_th]:shadow-[inset_0_-1px_0_0_var(--color-line-2)]",
        className,
      )}
      {...props}
    />
  );
}
export const TBody = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody ref={ref} className={className} {...props} />,
);
TBody.displayName = "TBody";
export const TFoot = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot ref={ref} className={cn("bg-paper/95", className)} {...props} />
  ),
);
TFoot.displayName = "TFoot";
export const Tr = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
        "hover:bg-paper-deep/50 data-[selected=true]:bg-accent/6",
        className,
      )}
      {...props}
    />
  ),
);
Tr.displayName = "Tr";
export const Th = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      scope="col"
      className={cn(
        "caps-label h-8 whitespace-nowrap border-b border-line-2 pr-3 text-left text-ink-2 first:pl-2",
        className,
      )}
      {...props}
    />
  ),
);
Th.displayName = "Th";
export const Td = forwardRef<HTMLTableCellElement, HTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        "h-[34px] border-b border-line py-0 pr-3 align-middle text-ink first:pl-2",
        className,
      )}
      {...props}
    />
  ),
);
Td.displayName = "Td";
export function SortableTh({
  direction,
  onSort,
  onSortShift,
  sortRank,
  className,
  children,
}: {
  direction: false | "asc" | "desc";
  onSort: () => void;
  onSortShift?: () => void;
  sortRank?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Th
      aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}
      className={cn("p-0", className)}
    >
      <button
        type="button"
        className="caps-label flex h-8 w-full items-center gap-1 pl-0 pr-3 text-left text-ink-2 transition-colors duration-100 hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-accent"
        onClick={(event) => (event.shiftKey && onSortShift ? onSortShift() : onSort())}
      >
        {children}
        {direction === "asc" ? (
          <ArrowUp className="size-3 shrink-0 text-accent" aria-hidden="true" />
        ) : direction === "desc" ? (
          <ArrowDown className="size-3 shrink-0 text-accent" aria-hidden="true" />
        ) : (
          <ArrowUpDown
            className="size-3 shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-60"
            aria-hidden="true"
          />
        )}
        {sortRank && sortRank > 1 ? (
          <span className="font-mono text-[9px] text-accent">{sortRank}</span>
        ) : null}
      </button>
    </Th>
  );
}
export function TableSkeleton({ rows = 8, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="h-[34px] border-b border-line pr-3 first:pl-2">
              <div
                className="h-2.5 animate-pulse-soft bg-paper-deep"
                style={{ width: `${35 + ((r * 13 + c * 29) % 55)}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
