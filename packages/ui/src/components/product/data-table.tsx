import { useMemo, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type CellContext,
  type ColumnFiltersState,
  type FilterFn,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, Columns3, Filter, Search, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { useAnnounce } from "../../lib/announce";
import { formatNumber, uiMessage } from "../../lib/format";
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Popover,
  PopoverTriggerButton,
  PopoverContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Table,
  TableScroll,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  SortableTh,
  TableSkeleton,
  EmptyState,
  ErrorState,
} from "../ui";

export type DemoDataState = "data" | "loading" | "empty" | "error";

/**
 * Column contract accepted by the publisher tables. Cells receive the same
 * context as the ui-playground reference (`row.original`, `getValue`,
 * `value`); columns are normalized onto TanStack `ColumnDef` internally so
 * the rendered tree matches the reference DataTable exactly.
 */
export interface DataTableColumn<T> {
  id?: string;
  accessorKey?: keyof T & string;
  accessorFn?: (row: T) => unknown;
  header?: ReactNode;
  sortable?: boolean;
  /** Fixed column width in px (used by the selection column). */
  size?: number;
  filterFn?: FilterFn<T>;
  cell?: (context: { row: { original: T }; getValue: () => unknown; value: unknown }) => ReactNode;
}

export interface DataTableProps<T extends { id: string }> {
  ariaLabel: string;
  columns: readonly DataTableColumn<T>[];
  data: readonly T[];
  /** Controlled demo state — lets reviewers reach loading/empty/error. */
  demoState?: DemoDataState;
  onRetry?: () => void;
  /** Column ids that get a faceted filter button. */
  facets?: string[];
  /** Human labels: facetLabel(columnId, value) — value "__col" returns the column header. */
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

/** Map → sorted plain array (not a hook despite the name). */
function uniquesOf(map: Map<unknown, number>): unknown[] {
  const out: unknown[] = [];
  map.forEach((_count, key) => out.push(key));
  return out;
}

function toColumnDef<T extends { id: string }>(column: DataTableColumn<T>): ColumnDef<T, unknown> {
  const id =
    column.id ?? (column.accessorKey !== undefined ? String(column.accessorKey) : undefined);
  return {
    ...(id === undefined ? {} : { id }),
    ...(column.accessorKey === undefined ? {} : { accessorKey: column.accessorKey }),
    ...(column.accessorFn === undefined ? {} : { accessorFn: column.accessorFn }),
    header: column.header as ColumnDef<T, unknown>["header"],
    enableSorting: column.sortable !== false,
    ...(column.size === undefined ? {} : { size: column.size }),
    ...(column.filterFn === undefined ? {} : { filterFn: column.filterFn }),
    ...(column.cell === undefined
      ? {}
      : {
          cell: ({ row, getValue }: CellContext<T, unknown>) =>
            column.cell!({ row: { original: row.original }, getValue, value: getValue() }),
        }),
  } as unknown as ColumnDef<T, unknown>;
}

/**
 * DataTable on TanStack Table: multi-sort headers (shift-click adds a sort),
 * faceted filters, global search, column visibility, tri-state row selection
 * with a bulk-action bar, pagination. Markup matches the ui-playground
 * reference; `locale` and `className` are production-only adapters.
 */
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
  stickyHeader,
  toolbarExtra,
  locale = "en-US",
  className,
}: DataTableProps<T>) {
  const announce = useAnnounce();

  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState({});
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize });

  const dataRows = useMemo(() => [...data], [data]);

  const columnsFinal = useMemo<ColumnDef<T, unknown>[]>(() => {
    const base = columns.map(toColumnDef);
    if (!enableSelection) return base;
    const selectColumn: ColumnDef<T, unknown> = {
      id: "__select",
      enableSorting: false,
      enableHiding: false,
      size: 34,
      header: ({ table }) => (
        <Checkbox
          aria-label={uiMessage(locale, "table.selectAll")}
          checked={
            table.getIsAllPageRowsSelected()
              ? true
              : table.getIsSomePageRowsSelected()
                ? "indeterminate"
                : false
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={uiMessage(locale, "table.selectRow")}
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
        />
      ),
    };
    return [selectColumn, ...base];
  }, [columns, enableSelection, locale]);

  const table = useReactTable({
    data: dataRows,
    columns: columnsFinal,
    state: { sorting, columnFilters, globalFilter, columnVisibility, rowSelection, pagination },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
    getRowId: (row) => row.id,
    enableMultiSort: true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const rows = table.getRowModel().rows;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original);
  const label = (columnId: string, value: string) =>
    facetLabel ? facetLabel(columnId, value) : value;
  const visibilityLabel = (column: ReturnType<typeof table.getAllColumns>[number]) => {
    const header = column.columnDef.header;
    return typeof header === "string" && header.trim() !== "" ? header : label(column.id, "__col");
  };

  const noResults =
    rows.length === 0 && demoState === "data" && (globalFilter !== "" || columnFilters.length > 0);
  const isEmpty =
    rows.length === 0 && demoState === "data" && globalFilter === "" && columnFilters.length === 0;

  return (
    <div className={cn("grid gap-2", className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {searchable && (
          <div className="relative w-full sm:w-60">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-ink-3"
            />
            <Input
              type="search"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={uiMessage(locale, "table.searchPlaceholder")}
              aria-label={uiMessage(locale, "table.searchLabel").replace("{label}", ariaLabel)}
              className="pl-7"
            />
          </div>
        )}

        {facets.map((facetId) => {
          const column = table.getColumn(facetId);
          if (!column) return null;
          const facetedValues = column.getFacetedUniqueValues();
          const selected = (column.getFilterValue() as string[] | undefined) ?? [];
          const options = uniquesOf(facetedValues);
          return (
            <Popover key={facetId}>
              <PopoverTriggerButton
                className={cn(
                  "inline-flex h-7 select-none items-center gap-1.5 rounded-tiny border border-line-2 bg-transparent px-2.5 font-sans text-[12.5px] font-medium text-ink",
                  "transition-colors duration-100 hover:border-ink",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  selected.length > 0 && "border-accent/60 text-accent",
                )}
              >
                <Filter aria-hidden="true" className="size-3 text-ink-2" />
                {label(facetId, "__col")}
                {selected.length > 0 && <Badge tone="accent">{selected.length}</Badge>}
              </PopoverTriggerButton>
              <PopoverContent className="w-56 p-2">
                <p className="caps-label mb-1.5 px-1 text-ink-2">{label(facetId, "__col")}</p>
                <div role="group" aria-label={label(facetId, "__col")} className="grid gap-0.5">
                  {options.map((value) => {
                    const v = String(value);
                    const checked = selected.includes(v);
                    return (
                      <label
                        key={v}
                        className="flex min-h-7 cursor-pointer items-center gap-2 rounded-tiny px-1 text-[13px] transition-colors duration-100 hover:bg-paper-deep"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(check) => {
                            const next = check ? [...selected, v] : selected.filter((s) => s !== v);
                            column.setFilterValue(next.length ? next : undefined);
                          }}
                          aria-label={label(facetId, v)}
                        />
                        <span className="flex-1">{label(facetId, v)}</span>
                        <span className="font-mono text-[11px] text-ink-2">
                          {facetedValues.get(value) ?? 0}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {selected.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1.5 w-full"
                    onClick={() => column.setFilterValue(undefined)}
                  >
                    {uiMessage(locale, "table.clearFilter")}
                  </Button>
                )}
              </PopoverContent>
            </Popover>
          );
        })}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" className="gap-1.5">
              <Columns3 className="size-3 text-ink-2" />
              <span className="hidden sm:inline">{uiMessage(locale, "table.columns")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{uiMessage(locale, "table.visibility")}</DropdownMenuLabel>
            {table
              .getAllColumns()
              .filter(
                (c) =>
                  c.getCanHide() &&
                  !(typeof c.columnDef.header === "string" && c.columnDef.header.trim() === ""),
              )
              .map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={c.getIsVisible()}
                  onCheckedChange={(v) => c.toggleVisibility(!!v)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {visibilityLabel(c)}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {toolbarExtra && <div className="ml-auto flex items-center gap-2">{toolbarExtra}</div>}
      </div>

      {/* Bulk action bar */}
      {enableSelection && selectedRows.length > 0 && (
        <div
          role="toolbar"
          aria-label={uiMessage(locale, "table.bulkBar")}
          className="flex animate-enter flex-wrap items-center gap-3 rounded-tiny border border-accent/30 bg-accent/5 px-3 py-1.5"
        >
          <p className="text-[12.5px] text-ink">
            <span className="font-mono font-medium">{selectedRows.length}</span>{" "}
            {uiMessage(locale, "table.selectedCount")}
          </p>
          {bulkActions?.(selectedRows, () => setRowSelection({}))}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setRowSelection({})}>
            <X className="size-3" />
            {uiMessage(locale, "table.clearSelection")}
          </Button>
        </div>
      )}

      {/* Body */}
      {demoState === "loading" && (
        <TableScroll className="max-h-[540px] overflow-y-auto">
          <Table aria-label={ariaLabel}>
            <THead>
              <tr>
                {columnsFinal.map((c) => (
                  <Th
                    key={
                      c.id ??
                      String(
                        (c as { accessorKey?: string }).accessorKey ?? JSON.stringify(c.header),
                      )
                    }
                  >
                    {typeof c.header === "string" ? c.header : ""}
                  </Th>
                ))}
              </tr>
            </THead>
            <TBody>
              <TableSkeleton cols={columnsFinal.length} />
            </TBody>
          </Table>
        </TableScroll>
      )}

      {demoState === "error" && (
        <div className="rounded-tiny border border-line">
          <ErrorState
            title={uiMessage(locale, "table.errorTitle")}
            description={uiMessage(locale, "table.errorDescription")}
            code="DEMO-ERR-503"
            {...(onRetry ? { onRetry } : {})}
            retryLabel={uiMessage(locale, "common.retry")}
            locale={locale}
          />
        </div>
      )}

      {demoState === "empty" && (
        <div className="rounded-tiny border border-line">
          <EmptyState
            title={emptyTitle}
            {...(emptyDescription ? { description: emptyDescription } : {})}
          />
        </div>
      )}

      {isEmpty && (
        <div className="rounded-tiny border border-line">
          <EmptyState
            title={emptyTitle}
            {...(emptyDescription ? { description: emptyDescription } : {})}
          />
        </div>
      )}

      {noResults && (
        <div className="rounded-tiny border border-line">
          <EmptyState
            title={uiMessage(locale, "table.noMatch")}
            description={uiMessage(locale, "table.noMatchDescription")}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setGlobalFilter("");
                  setColumnFilters([]);
                }}
              >
                {uiMessage(locale, "table.clearFilter")}
              </Button>
            }
          />
        </div>
      )}

      {demoState === "data" && rows.length > 0 && (
        <TableScroll className={cn(stickyHeader && "max-h-[540px] overflow-y-auto")}>
          <Table aria-label={ariaLabel}>
            <THead {...(stickyHeader === undefined ? {} : { sticky: stickyHeader })}>
              <tr>
                {(table.getHeaderGroups()[0]?.headers ?? []).map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const rank = sorting.findIndex((s) => s.id === header.column.id) + 1;
                  const content = header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext());
                  if (!canSort) {
                    return (
                      <Th
                        key={header.id}
                        style={
                          header.column.columnDef.size
                            ? { width: `${header.column.columnDef.size}px` }
                            : undefined
                        }
                      >
                        {content}
                      </Th>
                    );
                  }
                  return (
                    <SortableTh
                      key={header.id}
                      direction={sorted === false ? false : (sorted as "asc" | "desc")}
                      sortRank={rank}
                      onSort={() => header.column.toggleSorting(sorted === "asc")}
                      onSortShift={() => header.column.toggleSorting(sorted === "asc", true)}
                    >
                      {content}
                    </SortableTh>
                  );
                })}
              </tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <Tr key={row.id} data-selected={row.getIsSelected() || undefined}>
                  {row.getVisibleCells().map((cell) => (
                    <Td key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </Td>
                  ))}
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      )}

      {/* Pagination */}
      {demoState === "data" && filteredCount > 0 && (
        <div className="flex items-center justify-between gap-3 pt-0.5">
          <p aria-live="polite" className="font-mono text-[11px] text-ink-2">
            {formatNumber(locale, pagination.pageIndex * pagination.pageSize + 1)}–
            {formatNumber(
              locale,
              Math.min((pagination.pageIndex + 1) * pagination.pageSize, filteredCount),
            )}
            {" / "}
            {formatNumber(locale, filteredCount)}
          </p>
          <div className="flex items-center gap-1.5">
            <Select
              value={String(pagination.pageSize)}
              onValueChange={(v) =>
                setPagination((p) => ({ ...p, pageSize: Number(v), pageIndex: 0 }))
              }
            >
              <SelectTrigger className="h-6 w-24 shrink-0 whitespace-nowrap px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 25, 50].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} / {uiMessage(locale, "table.page")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={uiMessage(locale, "table.prevPage")}
              disabled={!table.getCanPreviousPage()}
              onClick={() => {
                table.previousPage();
                announce.status(
                  uiMessage(locale, "table.pageAnnounce").replace(
                    "{n}",
                    String(pagination.pageIndex),
                  ),
                );
              }}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <p className="font-mono text-[11px] text-ink">
              {pagination.pageIndex + 1}/{Math.max(1, table.getPageCount())}
            </p>
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={uiMessage(locale, "table.nextPage")}
              disabled={!table.getCanNextPage()}
              onClick={() => {
                table.nextPage();
                announce.status(
                  uiMessage(locale, "table.pageAnnounce").replace(
                    "{n}",
                    String(pagination.pageIndex + 2),
                  ),
                );
              }}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Compatibility wrapper kept for the public export: the reference sortable
 * header renders through the shared `SortableTh` primitive.
 */
export function SortableTableHead<T>({
  column,
  direction,
  onSort,
  children,
}: {
  column: DataTableColumn<T>;
  direction: false | "asc" | "desc";
  onSort: () => void;
  children: ReactNode;
  locale?: string;
}) {
  if (column.sortable === false) return <Th>{children}</Th>;
  return (
    <SortableTh direction={direction} onSort={onSort}>
      {children}
    </SortableTh>
  );
}
