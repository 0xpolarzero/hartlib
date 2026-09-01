import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Filter,
  Search,
  X,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { formatNumber, uiMessage } from "../../lib/format";
import { Badge } from "../ui/atoms";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/controls";
import { EmptyState, ErrorState } from "../ui/states";
import { Input } from "../ui/input";
import { Table, TableScroll, THead, TBody, Tr, Th, Td, TableSkeleton } from "../ui/table";

export type DemoDataState = "data" | "loading" | "empty" | "error";
export interface DataTableColumn<T> {
  id?: string;
  accessorKey?: keyof T & string;
  accessorFn?: (row: T) => unknown;
  header?: ReactNode;
  sortable?: boolean;
  cell?: (context: { row: { original: T }; getValue: () => unknown; value: unknown }) => ReactNode;
}
export interface DataTableProps<T extends { id: string }> {
  ariaLabel: string;
  columns: readonly DataTableColumn<T>[];
  data: readonly T[];
  demoState?: DemoDataState;
  onRetry?: () => void;
  facets?: readonly string[];
  facetLabel?: (columnId: string, value: string) => string;
  searchable?: boolean;
  enableSelection?: boolean;
  bulkActions?: (rows: T[], clear: () => void) => ReactNode;
  pageSize?: number;
  emptyTitle: string;
  emptyDescription?: string;
  stickyHeader?: boolean;
  toolbarExtra?: ReactNode;
  locale?: string;
  className?: string;
}

function columnId<T>(column: DataTableColumn<T>): string {
  return String(column.id ?? column.accessorKey ?? "");
}
function valueFor<T>(column: DataTableColumn<T>, row: T): unknown {
  return column.accessorFn
    ? column.accessorFn(row)
    : column.accessorKey
      ? row[column.accessorKey]
      : undefined;
}

export function SortableTableHead<T>({
  column,
  direction,
  onSort,
  children,
  locale = "en-US",
}: {
  column: DataTableColumn<T>;
  direction: false | "asc" | "desc";
  onSort: () => void;
  children: ReactNode;
  locale?: string;
}) {
  if (column.sortable === false) return <Th>{children}</Th>;
  return (
    <Th
      className="p-0"
      aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}
    >
      <button
        type="button"
        aria-label={uiMessage(locale, "ui.sortBy").replace("{label}", String(children))}
        className="caps-label flex h-8 w-full items-center gap-1 pr-3 text-left text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        onClick={onSort}
      >
        {children}
        {direction === "asc" ? (
          <ArrowUp className="size-3 text-accent" aria-hidden="true" />
        ) : direction === "desc" ? (
          <ArrowDown className="size-3 text-accent" aria-hidden="true" />
        ) : (
          <ArrowUpDown className="size-3 opacity-40" aria-hidden="true" />
        )}
      </button>
    </Th>
  );
}

export function DataTable<T extends { id: string }>({
  ariaLabel,
  columns,
  data,
  demoState = "data",
  onRetry,
  facets = [],
  facetLabel,
  searchable = true,
  enableSelection = false,
  bulkActions,
  pageSize = 10,
  emptyTitle,
  emptyDescription,
  stickyHeader = false,
  toolbarExtra,
  locale = "en-US",
  className,
}: DataTableProps<T>) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ id: string; direction: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showColumns, setShowColumns] = useState(false);

  const filtered = useMemo(() => {
    let rows = [...data];
    const needle = query.trim().toLowerCase();
    if (needle)
      rows = rows.filter((row) =>
        columns.some((column) =>
          String(valueFor(column, row) ?? "")
            .toLowerCase()
            .includes(needle),
        ),
      );
    rows = rows.filter((row) =>
      facets.every((id) => {
        const choices = filters[id] ?? [];
        if (choices.length === 0) return true;
        const column = columns.find((candidate) => columnId(candidate) === id);
        return column === undefined || choices.includes(String(valueFor(column, row) ?? ""));
      }),
    );
    if (sort) {
      const column = columns.find((candidate) => columnId(candidate) === sort.id);
      if (column)
        rows.sort((a, b) => {
          const av = String(valueFor(column, a) ?? "");
          const bv = String(valueFor(column, b) ?? "");
          const comparison = av.localeCompare(bv, undefined, {
            numeric: true,
            sensitivity: "base",
          });
          return sort.direction === "asc" ? comparison : -comparison;
        });
    }
    return rows;
  }, [columns, data, facets, filters, query, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / Math.max(1, pageSize)));
  const currentPage = Math.min(page, pageCount - 1);
  const normalizedPageSize = Math.max(1, pageSize);
  const visible = filtered.slice(
    currentPage * normalizedPageSize,
    (currentPage + 1) * normalizedPageSize,
  );
  const shownColumns = columns.filter((column) => !hidden.has(columnId(column)));
  const selectedRows = data.filter((row) => selected.has(row.id));
  const allPageSelected = visible.length > 0 && visible.every((row) => selected.has(row.id));
  const sticky = stickyHeader ? { sticky: true as const } : {};
  const setFilter = (id: string, value: string) =>
    setFilters((current) => {
      const previous = current[id] ?? [];
      const next = previous.includes(value)
        ? previous.filter((item) => item !== value)
        : [...previous, value];
      return { ...current, [id]: next };
    });
  const toggleRows = (checked: boolean | "indeterminate", rows: readonly T[]) =>
    setSelected((current) => {
      const next = new Set(current);
      rows.forEach((row) => (checked ? next.add(row.id) : next.delete(row.id)));
      return next;
    });

  const hasActiveFilters =
    query.trim().length > 0 || facets.some((id) => (filters[id] ?? []).length > 0);
  const isNoMatch = demoState === "data" && filtered.length === 0 && hasActiveFilters;
  const isEmpty =
    demoState === "empty" || (demoState === "data" && filtered.length === 0 && !hasActiveFilters);

  return (
    <div className={cn("grid gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {searchable && (
          <div className="relative w-full sm:w-60">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-ink-3"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              placeholder={uiMessage(locale, "ui.searchTable")}
              aria-label={`${uiMessage(locale, "ui.searchTable")} ${ariaLabel}`}
              className="pl-7"
            />
            {query && (
              <button
                type="button"
                aria-label={uiMessage(locale, "ui.clearSearch")}
                className="absolute right-2 top-1/2 -translate-y-1/2"
                onClick={() => setQuery("")}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {facets.map((id) => {
          const column = columns.find((candidate) => columnId(candidate) === id);
          if (!column) return null;
          const options = [
            ...new Set(data.map((row) => String(valueFor(column, row) ?? ""))),
          ].filter(Boolean);
          const selectedValues = filters[id] ?? [];
          return (
            <details key={id} className="relative">
              <summary
                className={cn(
                  "flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-tiny border border-line-2 px-2.5 text-[12.5px]",
                  selectedValues.length > 0 && "border-accent text-accent",
                )}
              >
                <Filter className="size-3" aria-hidden="true" />
                {facetLabel?.(id, "__col") ?? String(column.header ?? id)}
                {selectedValues.length > 0 && <Badge tone="accent">{selectedValues.length}</Badge>}
              </summary>
              <div className="absolute z-20 mt-1 min-w-48 rounded-tiny border border-line-2 bg-surface p-2 shadow-none">
                {options.map((option) => (
                  <label key={option} className="flex items-center gap-2 py-1 text-[12px]">
                    <Checkbox
                      checked={selectedValues.includes(option)}
                      onCheckedChange={() => setFilter(id, option)}
                      aria-label={facetLabel?.(id, option) ?? option}
                    />
                    <span>{facetLabel?.(id, option) ?? option}</span>
                  </label>
                ))}
              </div>
            </details>
          );
        })}
        <Button variant="secondary" size="sm" onClick={() => setShowColumns((value) => !value)}>
          <Columns3 className="size-3" aria-hidden="true" />
          {uiMessage(locale, "ui.columns")}
        </Button>
        {toolbarExtra && <div className="ml-auto flex items-center gap-2">{toolbarExtra}</div>}
      </div>
      {showColumns && (
        <div className="flex flex-wrap gap-2 border border-line px-2 py-1.5">
          {columns.map((column) => {
            const id = columnId(column);
            return (
              <label key={id} className="flex items-center gap-1 text-[12px]">
                <Checkbox
                  checked={!hidden.has(id)}
                  onCheckedChange={(checked) =>
                    setHidden((current) => {
                      const next = new Set(current);
                      if (checked) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                />
                {String(column.header ?? id)}
              </label>
            );
          })}
        </div>
      )}
      {enableSelection && selectedRows.length > 0 && (
        <div
          role="toolbar"
          className="flex items-center gap-3 border border-accent/30 bg-accent/5 px-3 py-1.5 text-[12.5px]"
        >
          <span>
            <span className="font-mono">{selectedRows.length}</span>{" "}
            {uiMessage(locale, "ui.selected")}
          </span>
          {bulkActions?.(selectedRows, () => setSelected(new Set()))}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setSelected(new Set())}
          >
            {uiMessage(locale, "ui.clear")}
          </Button>
        </div>
      )}
      {demoState === "loading" ? (
        <TableScroll className="max-h-[540px] overflow-y-auto">
          <Table aria-label={ariaLabel}>
            <THead {...sticky}>
              <tr>
                {columns.map((column) => (
                  <Th key={columnId(column)}>{column.header}</Th>
                ))}
              </tr>
            </THead>
            <TBody>
              <TableSkeleton cols={columns.length} />
            </TBody>
          </Table>
        </TableScroll>
      ) : demoState === "error" ? (
        <div className="rounded-tiny border border-line">
          <ErrorState
            title={uiMessage(locale, "ui.error")}
            description={uiMessage(locale, "ui.tryAgain")}
            retryLabel={uiMessage(locale, "ui.retry")}
            {...(onRetry === undefined ? {} : { onRetry })}
          />
        </div>
      ) : isEmpty ? (
        <div className="rounded-tiny border border-line">
          <EmptyState
            title={emptyTitle}
            {...(emptyDescription === undefined ? {} : { description: emptyDescription })}
          />
        </div>
      ) : isNoMatch ? (
        <div className="rounded-tiny border border-line">
          <EmptyState
            title={uiMessage(locale, "ui.noMatchingRows")}
            description={uiMessage(locale, "ui.clearFilters")}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setFilters({});
                }}
              >
                {uiMessage(locale, "ui.clearFilters")}
              </Button>
            }
          />
        </div>
      ) : (
        <TableScroll className={stickyHeader ? "max-h-[540px] overflow-y-auto" : undefined}>
          <Table aria-label={ariaLabel}>
            <THead {...sticky}>
              <tr>
                {enableSelection && (
                  <Th>
                    <Checkbox
                      checked={
                        allPageSelected
                          ? true
                          : visible.some((row) => selected.has(row.id))
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(checked) => toggleRows(checked, visible)}
                      aria-label={uiMessage(locale, "ui.selectAllRows")}
                    />
                  </Th>
                )}
                {shownColumns.map((column) => {
                  const id = columnId(column);
                  const direction = sort?.id === id ? sort.direction : false;
                  return (
                    <SortableTableHead
                      key={id}
                      column={column}
                      direction={direction}
                      onSort={() =>
                        setSort({ id, direction: direction === "asc" ? "desc" : "asc" })
                      }
                      locale={locale}
                    >
                      {column.header}
                    </SortableTableHead>
                  );
                })}
              </tr>
            </THead>
            <TBody>
              {visible.map((row) => (
                <Tr key={row.id} data-selected={selected.has(row.id) || undefined}>
                  {enableSelection && (
                    <Td>
                      <Checkbox
                        checked={selected.has(row.id)}
                        onCheckedChange={(checked) => toggleRows(checked, [row])}
                        aria-label={uiMessage(locale, "ui.selectRow").replace("{id}", row.id)}
                      />
                    </Td>
                  )}
                  {shownColumns.map((column) => {
                    const value = valueFor(column, row);
                    return (
                      <Td key={columnId(column)}>
                        {column.cell
                          ? column.cell({ row: { original: row }, getValue: () => value, value })
                          : String(value ?? "—")}
                      </Td>
                    );
                  })}
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      )}
      {demoState === "data" && filtered.length > 0 && (
        <div className="flex items-center justify-between gap-3 pt-0.5">
          <p aria-live="polite" className="font-mono text-[11px] text-ink-2">
            {formatNumber(locale, currentPage * normalizedPageSize + 1)}–
            {formatNumber(
              locale,
              Math.min((currentPage + 1) * normalizedPageSize, filtered.length),
            )}{" "}
            / {formatNumber(locale, filtered.length)}
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={uiMessage(locale, "ui.previousPage")}
              disabled={currentPage === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
            </Button>
            <span className="font-mono text-[11px]">
              {currentPage + 1}/{pageCount}
            </span>
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={uiMessage(locale, "ui.nextPage")}
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
