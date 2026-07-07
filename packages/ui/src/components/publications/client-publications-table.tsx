import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { DataTable } from "../ui/data-table";
import { TableCell } from "../ui/table";
import { formatPublicationDate, renderTableContent } from "./table-utils";

export type ClientPublicationTableRow = {
  id: string;
  title: string;
  publicationDate: string;
};

const clientPublicationColumnHelper = createColumnHelper<ClientPublicationTableRow>();

export function ClientPublicationsTable({
  publications,
  onSelectPublication,
}: {
  publications: readonly ClientPublicationTableRow[];
  onSelectPublication: (id: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "publicationDate", desc: true }]);
  const tableRows = useMemo(() => [...publications], [publications]);

  const columns = useMemo(
    () => [
      clientPublicationColumnHelper.accessor("title", { header: "Publication" }),
      clientPublicationColumnHelper.accessor("publicationDate", { header: "Date" }),
    ],
    [],
  );

  const table = useReactTable({
    data: tableRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <DataTable<ClientPublicationTableRow>
      table={table}
      renderContent={renderTableContent}
      getColumnClassName={(columnId) =>
        columnId === "publicationDate" ? "hidden sm:table-cell" : ""
      }
      onRowClick={(row) => onSelectPublication(row.original.id)}
      renderCell={(cell, row) => {
        if (cell.column.id === "title") {
          return (
            <TableCell key={cell.id}>
              <div className="max-w-[32rem] truncate font-medium text-ink">
                {row.original.title}
              </div>
            </TableCell>
          );
        }
        if (cell.column.id === "publicationDate") {
          return (
            <TableCell
              key={cell.id}
              className="hidden whitespace-nowrap font-mono text-[11px] text-faint sm:table-cell"
            >
              {formatPublicationDate(row.original.publicationDate)}
            </TableCell>
          );
        }
        return (
          <TableCell key={cell.id}>
            {renderTableContent(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      }}
    />
  );
}
