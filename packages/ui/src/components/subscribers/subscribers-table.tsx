import { useIntl, useLocale } from "@brief/i18n";
import { Check, ChevronsUpDown, Pause, Play, Plus, Trash2 } from "lucide-react";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ConfirmingDeleteButton } from "../ui/confirming-delete-button";
import { DataTable } from "../ui/data-table";
import { editableFieldChromeClass } from "../ui/inline-editable-field";
import { TableCell, TableRow } from "../ui/table";
import { formatPublicationDate, renderTableContent } from "../publications/table-utils";

export type SubscriberStatus = "active" | "paused";

export type SubscriberTableRow = {
  id: string;
  company: string;
  email: string;
  subscribedSince: string;
  status: SubscriberStatus;
};

export type DraftSubscriber = {
  company: string;
  email: string;
};

export type DraftSubscriberErrors = Partial<Record<keyof DraftSubscriber, string>>;

type InternalSubscriberTableRow = SubscriberTableRow & {
  statusRank: number;
};

const subscriberColumnHelper = createColumnHelper<InternalSubscriberTableRow>();

export function SubscribersTable({
  rows,
  draft,
  draftErrors,
  companyOptions,
  onCancelDraft,
  onConfirmDraft,
  onDelete,
  onToggleStatus,
  onUpdateDraft,
}: {
  rows: readonly SubscriberTableRow[];
  draft: DraftSubscriber | null;
  draftErrors: DraftSubscriberErrors;
  companyOptions: readonly string[];
  onCancelDraft: () => void;
  onConfirmDraft: () => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string) => void;
  onUpdateDraft: (draft: DraftSubscriber) => void;
}) {
  const intl = useIntl();
  const [sorting, setSorting] = useState<SortingState>([{ id: "company", desc: false }]);
  const tableRows = useMemo<InternalSubscriberTableRow[]>(
    () =>
      rows.map((row) => ({
        ...row,
        statusRank: row.status === "active" ? 0 : 1,
      })),
    [rows],
  );

  const columns = useMemo(
    () => [
      subscriberColumnHelper.accessor("statusRank", {
        header: "",
        cell: () => null,
      }),
      subscriberColumnHelper.accessor("company", {
        header: intl.formatMessage({ id: "column.company" }),
      }),
      subscriberColumnHelper.accessor("email", {
        header: intl.formatMessage({ id: "column.email" }),
      }),
      subscriberColumnHelper.accessor("subscribedSince", {
        header: intl.formatMessage({ id: "column.since" }),
        cell: (info) => formatPublicationDate(info.getValue(), intl.locale),
      }),
      subscriberColumnHelper.display({
        id: "actions",
        header: "",
        enableSorting: false,
        cell: (info) => {
          const row = info.row.original;
          const isPaused = row.status === "paused";
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="!size-5 text-faint/70 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-rule/45 [@media(hover:hover)_and_(pointer:fine)]:hover:text-muted focus-visible:text-muted"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleStatus(row.id);
                }}
                aria-label={
                  isPaused
                    ? intl.formatMessage({ id: "action.resumeSubscription" })
                    : intl.formatMessage({ id: "action.pauseSubscription" })
                }
              >
                {isPaused ? (
                  <Play className="size-3.5" aria-hidden="true" />
                ) : (
                  <Pause className="size-3.5" aria-hidden="true" />
                )}
              </Button>
              <ConfirmingDeleteButton
                confirmLabel={intl.formatMessage({ id: "action.confirm" })}
                idleLabel={intl.formatMessage({ id: "action.deleteSubscriber" })}
                onConfirm={() => onDelete(row.id)}
              />
            </div>
          );
        },
      }),
    ],
    [intl, onDelete, onToggleStatus],
  );

  const effectiveSorting = useMemo<SortingState>(() => {
    const visibleSort = sorting.filter((s) => s.id !== "statusRank");
    return [{ id: "statusRank", desc: false }, ...visibleSort];
  }, [sorting]);

  const table = useReactTable({
    data: tableRows,
    columns,
    state: { sorting: effectiveSorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });

  if (rows.length === 0 && !draft) {
    return (
      <div className="rounded-sm border border-rule bg-paper px-4 py-8 text-center text-sm text-muted">
        {intl.formatMessage({ id: "empty.subscribers" })}
      </div>
    );
  }

  return (
    <DataTable<InternalSubscriberTableRow>
      table={table}
      renderContent={renderTableContent}
      hiddenColumnIds={["statusRank"]}
      getHeaderAlign={(header) => (header.column.id === "actions" ? "right" : "left")}
      getRowClassName={(row) => (row.original.status === "paused" ? "opacity-60" : undefined)}
      renderBeforeRows={() =>
        draft ? (
          <DraftSubscriberTableRow
            draft={draft}
            errors={draftErrors}
            companyOptions={companyOptions}
            onCancel={onCancelDraft}
            onConfirm={onConfirmDraft}
            onUpdate={onUpdateDraft}
          />
        ) : null
      }
      renderCell={(cell, row) => {
        if (cell.column.id === "company") {
          return (
            <TableCell key={cell.id}>
              <div className="max-w-[12rem] truncate font-medium text-ink">
                {row.original.company}
              </div>
            </TableCell>
          );
        }
        if (cell.column.id === "email") {
          return (
            <TableCell key={cell.id} className="font-mono text-[11px] text-muted">
              <div className="max-w-[14rem] truncate">{row.original.email}</div>
            </TableCell>
          );
        }
        if (cell.column.id === "subscribedSince") {
          return (
            <TableCell key={cell.id} className="whitespace-nowrap font-mono text-[11px] text-faint">
              {formatPublicationDate(row.original.subscribedSince, intl.locale)}
            </TableCell>
          );
        }
        return (
          <TableCell key={cell.id} className="text-right">
            {renderTableContent(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      }}
    />
  );
}

function DraftSubscriberTableRow({
  draft,
  errors,
  companyOptions,
  onCancel,
  onConfirm,
  onUpdate,
}: {
  draft: DraftSubscriber;
  errors: DraftSubscriberErrors;
  companyOptions: readonly string[];
  onCancel: () => void;
  onConfirm: () => void;
  onUpdate: (draft: DraftSubscriber) => void;
}) {
  const intl = useIntl();
  return (
    <TableRow className="bg-paper/45">
      <TableCell className="align-top">
        <DraftCompanyCombobox
          value={draft.company}
          options={companyOptions}
          error={errors.company}
          autoFocus
          onChange={(company) => onUpdate({ ...draft, company })}
          onConfirm={onConfirm}
        />
      </TableCell>
      <TableCell className="align-top">
        <DraftEmailInput
          value={draft.email}
          error={errors.email}
          onChange={(email) => onUpdate({ ...draft, email })}
          onConfirm={onConfirm}
        />
      </TableCell>
      <TableCell className="whitespace-nowrap align-top font-mono text-[11px] text-faint">
        -
      </TableCell>
      <TableCell className="pt-2.5 align-top text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="!size-5 text-faint/70 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-rule/45 [@media(hover:hover)_and_(pointer:fine)]:hover:text-accent focus-visible:text-accent"
            onClick={(event) => {
              event.stopPropagation();
              onConfirm();
            }}
            aria-label={intl.formatMessage({ id: "action.createSubscriber" })}
          >
            <Check className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="!size-5 text-faint/70 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-rule/45 [@media(hover:hover)_and_(pointer:fine)]:hover:text-destructive focus-visible:text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              onCancel();
            }}
            aria-label={intl.formatMessage({ id: "action.cancelCreateSubscriber" })}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function DraftCompanyCombobox({
  value,
  options,
  error,
  autoFocus,
  onChange,
  onConfirm,
}: {
  value: string;
  options: readonly string[];
  error: string | undefined;
  autoFocus?: boolean | undefined;
  onChange: (value: string) => void;
  onConfirm: () => void;
}) {
  const intl = useIntl();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = "draft-subscriber-company-options";
  const normalizedValue = value.trim().toLocaleLowerCase(locale);
  const filteredOptions = options
    .filter((option) => option.toLocaleLowerCase(locale).includes(normalizedValue))
    .slice(0, 5);
  const exactMatch = options.some((option) => option.toLocaleLowerCase(locale) === normalizedValue);
  const canCreate = value.trim().length > 0 && !exactMatch;
  const comboboxOptions = [
    ...filteredOptions.map((option) => ({
      id: option,
      label: option,
      value: option,
      kind: "existing" as const,
    })),
    ...(canCreate
      ? [
          {
            id: `create-${value.trim()}`,
            label: intl.formatMessage({ id: "action.createOption" }, { value: value.trim() }),
            value: value.trim(),
            kind: "create" as const,
          },
        ]
      : []),
  ];
  const activeOption = comboboxOptions[activeIndex];

  useEffect(() => {
    setActiveIndex(0);
  }, [value]);

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
  }, [autoFocus]);

  function selectOption(option: (typeof comboboxOptions)[number]) {
    onChange(option.value);
    setOpen(false);
    setActiveIndex(0);
  }

  return (
    <div className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          value={value}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) =>
                comboboxOptions.length === 0 ? 0 : (index + 1) % comboboxOptions.length,
              );
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) =>
                comboboxOptions.length === 0
                  ? 0
                  : (index - 1 + comboboxOptions.length) % comboboxOptions.length,
              );
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (open && activeOption) {
                selectOption(activeOption);
                return;
              }
              onConfirm();
            }
          }}
          aria-label={intl.formatMessage({ id: "column.company" })}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && activeOption ? `${listboxId}-${activeIndex}` : undefined}
          aria-invalid={Boolean(error)}
          className={cn(
            editableFieldChromeClass,
            "w-full px-1 py-0.5 pr-6 text-sm font-medium text-ink",
            error && "border-destructive/60 focus:border-destructive focus:ring-destructive/20",
          )}
        />
        <ChevronsUpDown
          className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-faint"
          aria-hidden="true"
        />
      </div>
      {error ? <p className="mt-1 text-[11px] leading-4 text-destructive">{error}</p> : null}
      {open && comboboxOptions.length > 0 ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 overflow-hidden rounded-sm border border-rule bg-paper"
        >
          {comboboxOptions.map((option, index) =>
            option.kind === "existing" ? (
              <button
                key={option.id}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  "flex w-full items-center justify-between px-2 py-1.5 text-left text-xs text-muted transition-transform duration-fast ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-rule/45 [@media(hover:hover)_and_(pointer:fine)]:hover:text-ink",
                  index === activeIndex && "bg-rule/45 text-ink",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
              >
                <span className="truncate">{option.label}</span>
                {option.value.toLocaleLowerCase(locale) === normalizedValue ? (
                  <Check className="size-3 text-accent" aria-hidden="true" />
                ) : null}
              </button>
            ) : (
              <button
                key={option.id}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  "flex w-full items-center gap-1.5 border-t border-rule px-2 py-1.5 text-left text-xs text-muted transition-transform duration-fast ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-rule/45 [@media(hover:hover)_and_(pointer:fine)]:hover:text-ink",
                  index === activeIndex && "bg-rule/45 text-ink",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
              >
                <Plus className="size-3 text-accent" aria-hidden="true" />
                <span className="min-w-0 truncate">{option.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function DraftEmailInput({
  value,
  error,
  onChange,
  onConfirm,
}: {
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  onConfirm: () => void;
}) {
  const intl = useIntl();
  return (
    <div>
      <input
        value={value}
        type="email"
        inputMode="email"
        autoComplete="email"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onConfirm();
        }}
        aria-label={intl.formatMessage({ id: "column.email" })}
        aria-invalid={Boolean(error)}
        className={cn(
          editableFieldChromeClass,
          "w-full px-1 py-0.5 font-mono text-[11px] text-muted",
          error && "border-destructive/60 focus:border-destructive focus:ring-destructive/20",
        )}
      />
      {error ? <p className="mt-1 text-[11px] leading-4 text-destructive">{error}</p> : null}
    </div>
  );
}
