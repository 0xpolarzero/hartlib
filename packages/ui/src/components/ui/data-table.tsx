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
  getToggleSortingHandler: () => React.MouseEventHandler<HTMLButtonElement> | undefined;
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
  children,
}: {
  column: DataTableColumn<TData>;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const sorted = column.getIsSorted();

  return (
    <TableHead className={cn(align === "right" && "text-right")}>
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
          onClick={column.getToggleSortingHandler()}
          className={cn(
            "group flex h-6 w-full items-center text-faint",
            align === "right" ? "justify-end text-right" : "justify-start text-left",
          )}
        >
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="min-w-0 truncate">{children}</span>
            <span className="flex size-3 shrink-0 items-center justify-center">
              {sorted === "desc" ? (
                <span className="block h-0 w-0 border-x-[3px] border-t-[5px] border-x-transparent border-t-ink" />
              ) : sorted === "asc" ? (
                <span className="block h-0 w-0 border-x-[3px] border-b-[5px] border-x-transparent border-b-ink" />
              ) : (
                <span className="flex flex-col gap-px opacity-0 transition-opacity duration-fast group-hover:opacity-100">
                  <span className="block h-0 w-0 border-x-[3px] border-b-[4px] border-x-transparent border-b-faint" />
                  <span className="block h-0 w-0 border-x-[3px] border-t-[4px] border-x-transparent border-t-faint" />
                </span>
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
  hiddenColumnIds,
  getHeaderAlign,
  getRowClassName,
  onRowClick,
  renderContent,
  renderBeforeRows,
  renderCell,
}: {
  table: DataTableInstance<TData>;
  hiddenColumnIds?: readonly string[];
  getHeaderAlign?: (header: DataTableHeader<TData>) => "left" | "right";
  getRowClassName?: (row: DataTableRow<TData>) => string | undefined;
  onRowClick?: (row: DataTableRow<TData>) => void;
  renderContent: (renderer: unknown, context: unknown) => React.ReactNode;
  renderBeforeRows?: () => React.ReactNode;
  renderCell?: (cell: DataTableCell<TData>, row: DataTableRow<TData>) => React.ReactNode;
}) {
  const hiddenColumns = new Set(hiddenColumnIds ?? []);

  return (
    <Table>
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
                  <TableCell key={cell.id}>
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
