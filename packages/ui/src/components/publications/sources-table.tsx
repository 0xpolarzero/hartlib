import { useIntl } from "@hartlib/i18n";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { DataTable } from "../ui/data-table";
import { TableCell } from "../ui/table";
import { formatPublicationDate, renderTableContent } from "./table-utils";

export type SourceTableRow = {
  id: string;
  name: string;
  issueCount: number;
  lastPublishedAt: string | null;
  subscriberCount: number | null;
};

const sourceColumnHelper = createColumnHelper<SourceTableRow>();

export function SourcesTable({
  rows,
  onSelectSource,
}: {
  rows: readonly SourceTableRow[];
  onSelectSource: (id: string) => void;
}) {
  const intl = useIntl();
  const [sorting, setSorting] = useState<SortingState>([{ id: "lastPublishedAt", desc: true }]);
  const tableRows = useMemo(() => [...rows], [rows]);

  const columns = useMemo(
    () => [
      sourceColumnHelper.accessor("name", {
        header: intl.formatMessage({ id: "column.feed" }),
      }),
      sourceColumnHelper.accessor("subscriberCount", {
        header: intl.formatMessage({ id: "column.subscribers" }),
      }),
      sourceColumnHelper.accessor("issueCount", {
        header: intl.formatMessage({ id: "section.publications" }),
      }),
      sourceColumnHelper.accessor((row) => row.lastPublishedAt ?? "", {
        id: "lastPublishedAt",
        header: intl.formatMessage({ id: "column.latestPublication" }),
        sortingFn: (a, b) => {
          const av = a.original.lastPublishedAt;
          const bv = b.original.lastPublishedAt;
          if (!av && !bv) return 0;
          if (!av) return 1;
          if (!bv) return -1;
          return av < bv ? -1 : av > bv ? 1 : 0;
        },
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
    <DataTable<SourceTableRow>
      table={table}
      renderContent={renderTableContent}
      onRowClick={(row) => onSelectSource(row.original.id)}
      getColumnClassName={(columnId) =>
        columnId === "lastPublishedAt" ? "hidden sm:table-cell" : ""
      }
      renderCell={(cell, row) => (
        <TableCell
          key={cell.id}
          className={cn(
            "tabular-nums text-ink",
            cell.column.id === "lastPublishedAt" && "hidden sm:table-cell",
          )}
        >
          {cell.column.id === "lastPublishedAt" ? (
            row.original.lastPublishedAt ? (
              formatPublicationDate(row.original.lastPublishedAt, intl.locale)
            ) : (
              "-"
            )
          ) : cell.column.id === "name" ? (
            <span className="font-medium text-ink">
              {renderTableContent(cell.column.columnDef.cell, cell.getContext())}
            </span>
          ) : cell.column.id === "subscriberCount" && row.original.subscriberCount === null ? (
            "-"
          ) : (
            renderTableContent(cell.column.columnDef.cell, cell.getContext())
          )}
        </TableCell>
      )}
    />
  );
}
