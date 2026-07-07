import { Info } from "lucide-react";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { ConfirmingDeleteButton } from "../ui/confirming-delete-button";
import { DataTable } from "../ui/data-table";
import { TableCell } from "../ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { ScheduledPublicationIcon } from "./scheduled-publication-icon";
import { formatPublicationDate, renderTableContent } from "./table-utils";

export type PublicationTableIssue = {
  id: string;
  title: string;
  sourceName?: string | undefined;
  publicationDate: string | null;
  opens: number;
  downloads: number;
  contextPulls: number;
  status: "published" | "scheduled";
};

const publicationColumnHelper = createColumnHelper<PublicationTableIssue>();

export function PublicationsTable({
  issues,
  compact,
  onDeleteScheduledIssue,
  onSelectIssue,
}: {
  issues: readonly PublicationTableIssue[];
  compact?: boolean | undefined;
  onDeleteScheduledIssue?: ((id: string) => void) | undefined;
  onSelectIssue?: ((id: string) => void) | undefined;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "publicationDate", desc: true }]);
  const tableIssues = useMemo(() => [...issues], [issues]);

  const columns = useMemo(
    () => [
      publicationColumnHelper.accessor("title", { header: "Publication" }),
      ...(compact
        ? []
        : [
            publicationColumnHelper.accessor("sourceName", {
              header: "Fil",
            }),
          ]),
      publicationColumnHelper.accessor("opens", { header: "Ouvertures" }),
      publicationColumnHelper.accessor("downloads", { header: "Téléchargements" }),
      publicationColumnHelper.accessor("contextPulls", {
        header: () => (
          <span className="inline-flex items-center gap-1">
            Contexte
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="size-3 text-faint" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent side="top" align="center">
                Nombre de fois où l'archive a été lue par l'IA pour répondre.
              </TooltipContent>
            </Tooltip>
          </span>
        ),
      }),
      publicationColumnHelper.accessor("publicationDate", {
        header: "Date",
      }),
      ...(onDeleteScheduledIssue
        ? [
            publicationColumnHelper.display({
              id: "actions",
              header: "",
              enableSorting: false,
              cell: () => null,
            }),
          ]
        : []),
    ],
    [compact, onDeleteScheduledIssue],
  );

  const table = useReactTable({
    data: tableIssues,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <DataTable<PublicationTableIssue>
      table={table}
      renderContent={renderTableContent}
      getHeaderAlign={(header) => (header.column.id === "actions" ? "right" : "left")}
      {...(onSelectIssue ? { onRowClick: (row) => onSelectIssue(row.original.id) } : {})}
      renderCell={(cell, row) => {
        if (cell.column.id === "title") {
          return (
            <TableCell key={cell.id}>
              <div className="max-w-[24rem] truncate font-medium text-ink">
                {row.original.title}
              </div>
            </TableCell>
          );
        }
        if (cell.column.id === "actions") {
          return (
            <TableCell key={cell.id} className="text-right">
              {row.original.status === "scheduled" && onDeleteScheduledIssue ? (
                <ConfirmingDeleteButton
                  confirmLabel="Confirmer"
                  idleLabel="Supprimer la publication programmée"
                  onConfirm={() => onDeleteScheduledIssue(row.original.id)}
                />
              ) : null}
            </TableCell>
          );
        }
        if (cell.column.id === "publicationDate") {
          return (
            <TableCell key={cell.id} className="whitespace-nowrap font-mono text-[11px] text-faint">
              <span className="inline-flex items-center gap-2">
                <span>{formatPublicationDate(row.original.publicationDate)}</span>
                {row.original.status === "scheduled" ? <ScheduledPublicationIcon /> : null}
              </span>
            </TableCell>
          );
        }
        if (
          row.original.status === "scheduled" &&
          (cell.column.id === "opens" ||
            cell.column.id === "downloads" ||
            cell.column.id === "contextPulls")
        ) {
          return (
            <TableCell key={cell.id} className="whitespace-nowrap font-mono text-[11px] text-faint">
              -
            </TableCell>
          );
        }
        if (cell.column.id === "contextPulls") {
          return (
            <TableCell
              key={cell.id}
              className="whitespace-nowrap tabular-nums font-medium text-accent"
            >
              {renderTableContent(cell.column.columnDef.cell, cell.getContext())}
            </TableCell>
          );
        }
        return (
          <TableCell key={cell.id} className="whitespace-nowrap tabular-nums text-ink">
            {renderTableContent(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      }}
    />
  );
}
