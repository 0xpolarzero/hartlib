import { Eye, EyeOff } from "lucide-react";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import { DataTable } from "../ui/data-table";
import { TableCell } from "../ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { formatPublicationDate, renderTableContent } from "./table-utils";

export type ClientPublicationTableRow = {
  id: string;
  sourceName: string;
  title: string;
  publicationDate: string;
  includedInContext: boolean;
};

type InternalClientPublicationRow = ClientPublicationTableRow & {
  contextRank: number;
};

const clientPublicationColumnHelper = createColumnHelper<InternalClientPublicationRow>();

export function ClientPublicationsTable({
  publications,
  onSelectPublication,
  onToggleContext,
}: {
  publications: readonly ClientPublicationTableRow[];
  onSelectPublication: (id: string) => void;
  onToggleContext: (id: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "publicationDate", desc: true }]);
  const rows = useMemo(
    () =>
      publications.map((publication) => ({
        ...publication,
        contextRank: publication.includedInContext ? 0 : 1,
      })),
    [publications],
  );

  const columns = useMemo(
    () => [
      clientPublicationColumnHelper.accessor("contextRank", {
        header: "",
        cell: () => null,
      }),
      clientPublicationColumnHelper.accessor("sourceName", { header: "Fil" }),
      clientPublicationColumnHelper.accessor("title", { header: "Publication" }),
      clientPublicationColumnHelper.accessor("publicationDate", { header: "Date" }),
      clientPublicationColumnHelper.display({
        id: "actions",
        header: "",
        enableSorting: false,
      }),
    ],
    [],
  );

  const effectiveSorting = useMemo<SortingState>(() => {
    const visibleSort = sorting.filter((s) => s.id !== "contextRank");
    return [{ id: "contextRank", desc: false }, ...visibleSort];
  }, [sorting]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting: effectiveSorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <DataTable<InternalClientPublicationRow>
      table={table}
      renderContent={renderTableContent}
      hiddenColumnIds={["contextRank"]}
      getColumnClassName={(columnId) =>
        columnId === "sourceName" || columnId === "publicationDate"
          ? "hidden sm:table-cell"
          : columnId === "actions"
            ? "w-10"
            : ""
      }
      getHeaderAlign={(header) => (header.column.id === "actions" ? "right" : "left")}
      getRowClassName={(row) => (!row.original.includedInContext ? "opacity-60" : undefined)}
      onRowClick={(row) => onSelectPublication(row.original.id)}
      renderCell={(cell, row) => {
        if (cell.column.id === "sourceName") {
          return (
            <TableCell key={cell.id} className="hidden text-muted sm:table-cell">
              <div className="truncate">{row.original.sourceName}</div>
            </TableCell>
          );
        }
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
        if (cell.column.id === "actions") {
          const isShown = row.original.includedInContext;
          return (
            <TableCell key={cell.id} className="w-10 text-right">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleContext(row.original.id);
                    }}
                    aria-label={
                      isShown
                        ? `Masquer ${row.original.title} pour l'assistant`
                        : `Afficher ${row.original.title} pour l'assistant`
                    }
                    className="!size-5 text-faint/70 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-rule/45 [@media(hover:hover)_and_(pointer:fine)]:hover:text-muted focus-visible:text-muted"
                  >
                    {isShown ? (
                      <Eye className="size-3.5" aria-hidden="true" />
                    ) : (
                      <EyeOff className="size-3.5" aria-hidden="true" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="end">
                  {isShown
                    ? "Visible par l'assistant."
                    : "Masquée: l'assistant ne connaît pas cette publication."}
                </TooltipContent>
              </Tooltip>
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
