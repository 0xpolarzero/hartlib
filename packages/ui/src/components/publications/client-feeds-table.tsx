import { useIntl } from "@brief/i18n";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { Badge } from "../ui/badge";
import { DataTable } from "../ui/data-table";
import { TableCell } from "../ui/table";
import { formatPublicationDate, renderTableContent } from "./table-utils";

export type ClientFeedSourceType = "publisher_invite" | "public";

export type ClientFeedTableRow = {
  id: string;
  name: string;
  description: string;
  sourceType: ClientFeedSourceType;
  subscribed: boolean;
  lastPublicationDate: string | null;
  publisherName: string;
};

const feedColumnHelper = createColumnHelper<ClientFeedTableRow>();

export function ClientFeedsTable({
  rows,
  onSelectFeed,
  onToggleSubscribed,
}: {
  rows: readonly ClientFeedTableRow[];
  onSelectFeed: (id: string) => void;
  onToggleSubscribed: (id: string) => void;
}) {
  const intl = useIntl();
  const [sorting, setSorting] = useState<SortingState>([{ id: "lastPublishedAt", desc: true }]);
  const tableRows = useMemo(() => [...rows], [rows]);

  const columns = useMemo(
    () => [
      feedColumnHelper.accessor("name", { header: intl.formatMessage({ id: "column.feed" }) }),
      feedColumnHelper.display({
        id: "sourceType",
        header: "",
        enableSorting: false,
      }),
      feedColumnHelper.accessor((row) => row.lastPublicationDate ?? "", {
        id: "lastPublishedAt",
        header: intl.formatMessage({ id: "column.latestPublication" }),
        sortingFn: (a, b) => {
          const av = a.original.lastPublicationDate;
          const bv = b.original.lastPublicationDate;
          if (!av && !bv) return 0;
          if (!av) return 1;
          if (!bv) return -1;
          return av < bv ? -1 : av > bv ? 1 : 0;
        },
      }),
      feedColumnHelper.display({
        id: "subscribed",
        header: intl.formatMessage({ id: "column.subscribed" }),
        enableSorting: false,
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
    <DataTable<ClientFeedTableRow>
      table={table}
      renderContent={renderTableContent}
      hiddenColumnIds={["sourceType"]}
      getColumnClassName={(columnId) =>
        columnId === "lastPublishedAt" ? "hidden sm:table-cell" : ""
      }
      onRowClick={(row) => onSelectFeed(row.original.id)}
      renderCell={(cell, row) => {
        if (cell.column.id === "name") {
          return (
            <TableCell key={cell.id}>
              <div className="flex min-w-0 flex-col" title={row.original.description}>
                <div className="flex items-center gap-2">
                  <span className="max-w-[24rem] truncate font-medium text-ink">
                    {row.original.name}
                  </span>
                  {row.original.sourceType === "publisher_invite" ? (
                    <Badge
                      variant="outline"
                      className="shrink-0 rounded-sm border-accent/30 px-1.5 py-0 text-[10px] text-accent"
                    >
                      {intl.formatMessage({ id: "status.invited" })}
                    </Badge>
                  ) : null}
                </div>
                <span className="max-w-[24rem] truncate text-[11px] text-faint">
                  {row.original.publisherName}
                </span>
              </div>
            </TableCell>
          );
        }
        if (cell.column.id === "lastPublishedAt") {
          return (
            <TableCell
              key={cell.id}
              className="hidden whitespace-nowrap font-mono text-[11px] text-faint sm:table-cell"
            >
              {row.original.lastPublicationDate
                ? formatPublicationDate(row.original.lastPublicationDate, intl.locale)
                : "-"}
            </TableCell>
          );
        }
        if (cell.column.id === "subscribed") {
          return (
            <TableCell key={cell.id} className="w-10 text-center">
              <input
                type="checkbox"
                checked={row.original.subscribed}
                onClick={(event) => event.stopPropagation()}
                onChange={() => onToggleSubscribed(row.original.id)}
                aria-label={intl.formatMessage(
                  { id: "action.subscribeTo" },
                  { name: row.original.name },
                )}
                className="size-4 cursor-pointer accent-accent"
              />
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
