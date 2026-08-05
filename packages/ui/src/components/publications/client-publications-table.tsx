import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { useIntl } from "@hartlib/i18n";

import { DataTable } from "../ui/data-table";
import { TableCell } from "../ui/table";
import { formatPublicationDate, renderTableContent } from "./table-utils";

export type ClientPublicationTableRow = {
  id: string;
  title: string;
  publicationDate: string | null;
};

const clientPublicationColumnHelper = createColumnHelper<ClientPublicationTableRow>();

export function ClientPublicationsTable({
  publications,
  onSelectPublication,
}: {
  publications: readonly ClientPublicationTableRow[];
  onSelectPublication: (id: string) => void;
}) {
  const intl = useIntl();
  const [sorting, setSorting] = useState<SortingState>([{ id: "publicationDate", desc: true }]);
  const tableRows = useMemo(() => [...publications], [publications]);

  const columns = useMemo(
    () => [
      clientPublicationColumnHelper.accessor("title", {
        header: intl.formatMessage({ id: "column.publication" }),
      }),
      clientPublicationColumnHelper.accessor("publicationDate", {
        header: intl.formatMessage({ id: "column.date" }),
      }),
    ],
    [intl],
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
              {formatPublicationDate(row.original.publicationDate, intl.locale)}
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
