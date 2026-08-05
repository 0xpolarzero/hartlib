import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type * as React from "react";

import { cn } from "../../lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

type TableSortState = false | "asc" | "desc";

export type DataTableColumn<_TData> = {
  id: string;
  columnDef: {
    header?: unknown;
    cell?: unknown;
  };
  getCanSort: () => boolean;
  getIsSorted: () => TableSortState;
  toggleSorting: (desc?: boolean, isMulti?: boolean) => void;
};

export type DataTableHeader<TData> = {
  id: string;
  column: DataTableColumn<TData>;
  getContext: () => unknown;
};

export type DataTableCell<TData> = {
  id: string;
  column: DataTableColumn<TData>;
  getContext: () => unknown;
};

export type DataTableRow<TData> = {
  id: string;
  original: TData;
  getVisibleCells: () => Array<DataTableCell<TData>>;
};

export type DataTableInstance<TData> = {
  getHeaderGroups: () => Array<{
    id: string;
    headers: Array<DataTableHeader<TData>>;
  }>;
  getRowModel: () => {
    rows: Array<DataTableRow<TData>>;
  };
};

export function SortableTableHead<TData>({
  column,
  align = "left",
  className,
  children,
}: {
  column: DataTableColumn<TData>;
  align?: "left" | "right";
  className?: string | undefined;
  children: React.ReactNode;
}) {
  const sorted = column.getIsSorted();

  return (
    <TableHead className={cn(align === "right" && "text-right", className)}>
      {!column.getCanSort() ? (
        <span
          className={cn(
            "flex h-6 w-full items-center text-faint",
            align === "right" ? "justify-end text-right" : "justify-start text-left",
          )}
        >
          {children}
        </span>
      ) : (
        <button
          type="button"
          onClick={(event) => column.toggleSorting(undefined, event.shiftKey)}
          className={cn(
            "hartlib-sortable-head",
            align === "right" ? "justify-end text-right" : "justify-start text-left",
          )}
        >
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="min-w-0 truncate">{children}</span>
            <span className="hartlib-sortable-head-icon">
              {sorted === "desc" ? (
                <ArrowDown className="size-3 text-ink" aria-hidden="true" />
              ) : sorted === "asc" ? (
                <ArrowUp className="size-3 text-ink" aria-hidden="true" />
              ) : (
                <ChevronsUpDown className="hartlib-sortable-head-idle-icon" aria-hidden="true" />
              )}
            </span>
          </span>
        </button>
      )}
    </TableHead>
  );
}

export function DataTable<TData>({
  table,
  tableClassName,
  hiddenColumnIds,
  getColumnClassName,
  getHeaderAlign,
  getRowClassName,
  onRowClick,
  renderContent,
  renderBeforeRows,
  renderCell,
}: {
  table: DataTableInstance<TData>;
  tableClassName?: string | undefined;
  hiddenColumnIds?: readonly string[];
  getColumnClassName?: (columnId: string) => string | undefined;
  getHeaderAlign?: (header: DataTableHeader<TData>) => "left" | "right";
  getRowClassName?: (row: DataTableRow<TData>) => string | undefined;
  onRowClick?: (row: DataTableRow<TData>) => void;
  renderContent: (renderer: unknown, context: unknown) => React.ReactNode;
  renderBeforeRows?: () => React.ReactNode;
  renderCell?: (cell: DataTableCell<TData>, row: DataTableRow<TData>) => React.ReactNode;
}) {
  const hiddenColumns = new Set(hiddenColumnIds ?? []);

  return (
    <Table className={tableClassName}>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              if (hiddenColumns.has(header.column.id)) return null;

              return (
                <SortableTableHead
                  key={header.id}
                  column={header.column}
                  align={getHeaderAlign?.(header) ?? "left"}
                  className={getColumnClassName?.(header.column.id)}
                >
                  {renderContent(header.column.columnDef.header, header.getContext())}
                </SortableTableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {renderBeforeRows?.()}
        {table.getRowModel().rows.map((row) => (
          <TableRow
            key={row.id}
            className={cn(onRowClick && "cursor-pointer", getRowClassName?.(row))}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {row.getVisibleCells().map((cell) => {
              if (hiddenColumns.has(cell.column.id)) return null;
              return (
                renderCell?.(cell, row) ?? (
                  <TableCell key={cell.id} className={getColumnClassName?.(cell.column.id)}>
                    {renderContent(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                )
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
