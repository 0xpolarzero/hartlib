import { useMemo, useState } from "react";
import { Check, CirclePause, FileText, Pencil, PlusCircle, RotateCcw, Upload } from "lucide-react";
import { formatDate, formatNumber, uiMessage } from "../../lib/format";
import { cn } from "../../lib/utils";
import { Badge, SectionHeader } from "../ui/atoms";
import { Button } from "../ui/button";
import { ConfirmingDeleteButton } from "../ui/confirming-delete-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "../ui/dialog";
import { DataTable, type DataTableColumn, type DemoDataState } from "./data-table";
import { FileUpload, type UploadedFile } from "../ui/file-upload";
import { InlineEditableField } from "../ui/inline-editable-field";
import { Input } from "../ui/input";
import { Switch } from "../ui/controls";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { HoverCard, HoverCardContent, HoverCardTrigger, Tooltip } from "../ui/overlays";

const sourceKindLabel = (locale: string, kind: PublisherSourceRow["kind"]): string =>
  kind === "invitation"
    ? uiMessage(locale, "sources.typeInvitation")
    : uiMessage(locale, "sources.typePublic");
const publicationStatusLabel = (
  locale: string,
  status: PublisherPublicationRow["status"],
): string => {
  switch (status) {
    case "draft":
      return uiMessage(locale, "ui.publicationStatusDraft");
    case "scheduled":
      return uiMessage(locale, "ui.publicationStatusScheduled");
    case "published":
      return uiMessage(locale, "ui.publicationStatusPublished");
    case "failed":
      return uiMessage(locale, "ui.publicationStatusFailed");
  }
};
const documentStatusLabel = (locale: string, status: PublisherDocument["status"]): string => {
  switch (status) {
    case "ready":
      return uiMessage(locale, "ui.documentStatusReady");
    case "processing":
      return uiMessage(locale, "ui.documentStatusProcessing");
    case "missing":
      return uiMessage(locale, "ui.documentStatusMissing");
    case "error":
      return uiMessage(locale, "ui.documentStatusError");
  }
};
const subscriberStatusLabel = (
  locale: string,
  status: PublisherSubscriberRow["status"],
): string => {
  switch (status) {
    case "active":
      return uiMessage(locale, "ui.subscriberStatusActive");
    case "paused":
      return uiMessage(locale, "ui.subscriberStatusPaused");
    case "invalid":
      return uiMessage(locale, "ui.subscriberStatusInvalid");
  }
};
function DemoDataControl({
  value,
  onChange,
  label,
  locale,
}: {
  value: DemoDataState;
  onChange: (value: DemoDataState) => void;
  label: string;
  locale: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as DemoDataState)}>
      <SelectTrigger className="h-6 w-36" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="data">{uiMessage(locale, "demoState.data")}</SelectItem>
        <SelectItem value="loading">{uiMessage(locale, "demoState.loading")}</SelectItem>
        <SelectItem value="empty">{uiMessage(locale, "demoState.empty")}</SelectItem>
        <SelectItem value="error">{uiMessage(locale, "demoState.error")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

export interface PublisherSourceRow {
  id: string;
  name: string;
  kind: "public" | "publisher" | "invitation";
  country: string;
  enabled: boolean;
  status?: "active" | "paused";
  publicationCount?: number | null;
  subscriberCount?: number | null;
  latestPublicationAt?: string | null;
  updatedAt?: string | null;
  error?: string | null;
}
export interface PublisherPublicationRow {
  id: string;
  sourceId: string;
  title: string;
  status: "draft" | "scheduled" | "published" | "failed";
  publicationDate?: string | null;
  subscriberCount?: number | null;
  openRate?: number | null;
  immutable?: boolean;
  autoDeleteAt?: string | null;
  deleted?: boolean;
  error?: string | null;
}
export interface PublisherDocument {
  id: string;
  issueId: string;
  name: string;
  status: "ready" | "processing" | "missing" | "error";
  sizeBytes?: number | null;
  createdAt?: string | null;
  url?: string | null;
  error?: string | null;
}
export interface PublisherSubscriberRow {
  id: string;
  email: string;
  company?: string | null;
  status: "active" | "paused" | "invalid";
  subscribedAt?: string | null;
  lastDeliveryAt?: string | null;
  deleted?: boolean;
  error?: string | null;
}
export interface PublisherTableState {
  state?: DemoDataState;
  error?: string | null;
  onRetry?: () => void;
  locale?: string;
  showHeader?: boolean;
  showDemoStateControl?: boolean;
}

export interface SourcesTableProps extends PublisherTableState {
  rows?: readonly PublisherSourceRow[];
  onRename?: (id: string, name: string) => void | Promise<void>;
  onToggle?: (id: string, enabled: boolean) => void | Promise<void>;
  onOpen?: (id: string) => void;
}
export function SourcesTable({
  rows = [],
  state = "empty",
  error = null,
  onRetry,
  onRename,
  locale = "en-US",
  showDemoStateControl = false,
  showHeader = true,
}: SourcesTableProps) {
  const [demoState, setDemoState] = useState<DemoDataState>(state);
  const effectiveState = showDemoStateControl ? demoState : state;
  const columns = useMemo<DataTableColumn<PublisherSourceRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: uiMessage(locale, "sources.colName"),
        cell: ({ row }) =>
          onRename ? (
            <InlineEditableField
              value={row.original.name}
              ariaLabel={row.original.name}
              locale={locale}
              className="text-[13px]"
              onSave={(name) => onRename(row.original.id, name)}
            />
          ) : (
            row.original.name
          ),
      },
      {
        accessorKey: "kind",
        header: uiMessage(locale, "sources.colType"),
        cell: ({ value }) => (
          <Badge tone={value === "invitation" ? "accent" : "outline"}>
            {sourceKindLabel(locale, value as PublisherSourceRow["kind"])}
          </Badge>
        ),
      },
      {
        id: "latestPublicationAt",
        accessorFn: (row) => row.latestPublicationAt ?? row.updatedAt ?? "",
        header: uiMessage(locale, "sources.colLatest"),
        cell: ({ value }) => (
          <span className="font-mono text-[12px] text-ink-2">
            {formatDate(locale, value as string)}
          </span>
        ),
      },
      {
        accessorKey: "subscriberCount",
        header: uiMessage(locale, "sources.colSubscribers"),
        cell: ({ value }) => (
          <span className="font-mono text-[12.5px]">
            {value === null || value === undefined ? "—" : formatNumber(locale, value as number)}
          </span>
        ),
      },
      {
        accessorKey: "enabled",
        header: uiMessage(locale, "sources.colSubscription"),
        cell: ({ row }) => {
          const subscribed = row.original.enabled;
          return (
            <Tooltip content={uiMessage(locale, "sources.readOnlySubscription")}>
              <span className="inline-flex items-center gap-2">
                <Switch
                  checked={subscribed}
                  disabled
                  aria-label={`${uiMessage(locale, "sources.colSubscription")} — ${
                    subscribed
                      ? uiMessage(locale, "sources.subscribed")
                      : uiMessage(locale, "sources.notSubscribed")
                  }`}
                />
                <span
                  aria-hidden="true"
                  className={cn("text-[12px]", subscribed ? "text-ink" : "text-ink-2")}
                >
                  {subscribed
                    ? uiMessage(locale, "sources.subscribed")
                    : uiMessage(locale, "sources.notSubscribed")}
                </span>
              </span>
            </Tooltip>
          );
        },
      },
    ],
    [locale, onRename],
  );
  return (
    <section aria-label={uiMessage(locale, "ui.publisherSources")} className="grid gap-2">
      {showHeader && (
        <SectionHeader
          kicker={uiMessage(locale, "ui.publisher")}
          title={uiMessage(locale, "ui.publisherSources")}
          description={error ?? uiMessage(locale, "ui.manageSourcesDescription")}
          count={rows.length}
        />
      )}
      <DataTable
        ariaLabel={uiMessage(locale, "ui.publisherSources")}
        columns={columns}
        data={rows}
        demoState={effectiveState}
        locale={locale}
        {...(onRetry === undefined ? {} : { onRetry })}
        emptyTitle={uiMessage(locale, "ui.noPublisherSources")}
        emptyDescription={uiMessage(locale, "ui.sourceRowsEmpty")}
        facets={["kind", "enabled"]}
        facetLabel={(column, value) =>
          value === "__col"
            ? column === "kind"
              ? uiMessage(locale, "sources.colType")
              : uiMessage(locale, "sources.colSubscription")
            : column === "kind"
              ? sourceKindLabel(locale, value as PublisherSourceRow["kind"])
              : value === "true"
                ? uiMessage(locale, "sources.subscribed")
                : uiMessage(locale, "sources.notSubscribed")
        }
        toolbarExtra={
          showDemoStateControl ? (
            <DemoDataControl
              value={demoState}
              onChange={setDemoState}
              label={uiMessage(locale, "demoState.label")}
              locale={locale}
            />
          ) : undefined
        }
        stickyHeader
      />
    </section>
  );
}

export interface PublicationsTableProps extends PublisherTableState {
  rows?: readonly PublisherPublicationRow[];
  onOpen?: (id: string) => void;
  onDelete?: (id: string) => void;
  onUndo?: (id: string) => void;
}
export function PublicationsTable({
  rows = [],
  state = "empty",
  error = null,
  onRetry,
  onOpen,
  onDelete,
  onUndo,
  locale = "en-US",
  showHeader = true,
}: PublicationsTableProps) {
  const [immutablePublication, setImmutablePublication] = useState<PublisherPublicationRow | null>(
    null,
  );
  const columns: DataTableColumn<PublisherPublicationRow>[] = [
    {
      accessorKey: "title",
      header: uiMessage(locale, "column.publication"),
      cell: ({ row }) =>
        row.original.deleted ? (
          <span className="text-left font-medium text-ink-2 line-through">
            {row.original.title}
          </span>
        ) : (
          <button
            type="button"
            className={cn(
              "block max-w-[38ch] truncate text-left underline-offset-2 hover:underline",
              row.original.status !== "published" && "text-ink-2",
            )}
            title={row.original.title}
            onClick={() => onOpen?.(row.original.id)}
          >
            {row.original.title}
          </button>
        ),
    },
    {
      accessorKey: "status",
      header: uiMessage(locale, "ui.status"),
      cell: ({ row }) =>
        row.original.deleted ? (
          <Badge tone="outline">{uiMessage(locale, "ui.deleted")}</Badge>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <Badge
              tone={
                row.original.status === "published"
                  ? "success"
                  : row.original.status === "failed"
                    ? "danger"
                    : "warning"
              }
            >
              {publicationStatusLabel(locale, row.original.status)}
            </Badge>
            {row.original.immutable && (
              <span
                role="button"
                tabIndex={0}
                title={uiMessage(locale, "ui.immutablePublication")}
                aria-label={uiMessage(locale, "ui.immutable")}
                onClick={() => setImmutablePublication(row.original)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setImmutablePublication(row.original);
                  }
                }}
              >
                <Check className="size-3 text-ok" aria-hidden="true" />
              </span>
            )}
            {row.original.autoDeleteAt && (
              <HoverCard>
                <HoverCardTrigger asChild>
                  <button
                    type="button"
                    className="font-mono text-[10.5px] text-warn underline decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {uiMessage(locale, "publications.deletionShort")}
                  </button>
                </HoverCardTrigger>
                <HoverCardContent className="w-72">
                  <p className="caps-label text-warn">
                    {uiMessage(locale, "publications.deletionTitle")}
                  </p>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
                    {uiMessage(locale, "publications.deletionBody").replace(
                      "{date}",
                      formatDate(locale, row.original.autoDeleteAt),
                    )}
                  </p>
                </HoverCardContent>
              </HoverCard>
            )}
          </span>
        ),
    },
    {
      accessorKey: "publicationDate",
      header: uiMessage(locale, "ui.date"),
      cell: ({ value }) => (
        <span className="font-mono text-[12px] text-ink-2">
          {formatDate(locale, value as string | null)}
        </span>
      ),
    },
    {
      accessorKey: "subscriberCount",
      header: uiMessage(locale, "ui.subscribers"),
      cell: ({ value }) => (
        <span className="font-mono text-[12.5px]">
          {value === null || value === undefined ? "—" : formatNumber(locale, value as number)}
        </span>
      ),
    },
    {
      accessorKey: "openRate",
      header: uiMessage(locale, "ui.openRate"),
      cell: ({ value }) => (typeof value === "number" ? `${Math.round(value * 100)}%` : "—"),
    },
    {
      id: "actions",
      header: <span className="sr-only">{uiMessage(locale, "ui.actions")}</span>,
      sortable: false,
      cell: ({ row }) =>
        row.original.deleted ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={uiMessage(locale, "ui.undoRow").replace("{label}", row.original.title)}
            onClick={() => onUndo?.(row.original.id)}
          >
            <RotateCcw className="size-3" />
            {uiMessage(locale, "ui.undo")}
          </Button>
        ) : row.original.immutable ? (
          <Badge
            tone="outline"
            role="button"
            tabIndex={0}
            aria-label={`${uiMessage(locale, "ui.immutablePublication")}: ${row.original.title}`}
            onClick={() => setImmutablePublication(row.original)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setImmutablePublication(row.original);
              }
            }}
          >
            {uiMessage(locale, "ui.immutable")}
          </Badge>
        ) : (
          <span className="flex items-center gap-1">
            {onOpen && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={uiMessage(locale, "ui.openRow").replace("{label}", row.original.title)}
                onClick={() => onOpen(row.original.id)}
              >
                <Pencil className="size-3" />
              </Button>
            )}
            {onUndo && row.original.status === "failed" && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={uiMessage(locale, "ui.undoRow").replace("{label}", row.original.title)}
                onClick={() => onUndo(row.original.id)}
              >
                <RotateCcw className="size-3" />
              </Button>
            )}
            {onDelete && (
              <ConfirmingDeleteButton
                onConfirm={() => onDelete(row.original.id)}
                {...(onUndo === undefined ? {} : { undo: () => onUndo(row.original.id) })}
                label={uiMessage(locale, "ui.deleteRow").replace("{label}", row.original.title)}
                locale={locale}
              />
            )}
          </span>
        ),
    },
  ];
  return (
    <>
      <section aria-label={uiMessage(locale, "ui.publisherPublications")} className="grid gap-2">
        {showHeader && (
          <SectionHeader
            kicker={uiMessage(locale, "ui.publisher")}
            title={uiMessage(locale, "ui.publisherPublications")}
            description={error ?? uiMessage(locale, "ui.publisherPublicationsDescription")}
            count={rows.length}
          />
        )}
        <DataTable
          ariaLabel={uiMessage(locale, "ui.publisherPublications")}
          columns={columns}
          data={rows}
          demoState={state}
          locale={locale}
          {...(onRetry === undefined ? {} : { onRetry })}
          emptyTitle={uiMessage(locale, "ui.noPublisherPublications")}
          emptyDescription={uiMessage(locale, "ui.publicationRowsEmpty")}
          facets={["status"]}
          stickyHeader
        />
      </section>
      <AlertDialog
        open={immutablePublication !== null}
        onOpenChange={(open) => {
          if (!open) setImmutablePublication(null);
        }}
        locale={locale}
      >
        <AlertDialogContent hideClose>
          <AlertDialogTitle>{uiMessage(locale, "ui.immutablePublication")}</AlertDialogTitle>
          <AlertDialogDescription>
            {immutablePublication?.title ?? uiMessage(locale, "ui.immutable")}
          </AlertDialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialogAction>{uiMessage(locale, "ui.close")}</AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export interface DocumentsTableProps extends PublisherTableState {
  rows?: readonly PublisherDocument[];
  onUpload?: (file: UploadedFile) => void;
  onOpen?: (id: string) => void;
}
export function DocumentsTable({
  rows = [],
  state = "empty",
  error = null,
  onRetry,
  onUpload,
  onOpen,
  locale = "en-US",
  showHeader = true,
}: DocumentsTableProps) {
  const columns: DataTableColumn<PublisherDocument>[] = [
    {
      accessorKey: "name",
      header: uiMessage(locale, "ui.document"),
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <FileText className="size-3 text-ink-2" aria-hidden="true" />
          <span className="block max-w-[42ch] truncate text-[12.5px] text-ink-2">
            {row.original.name}
          </span>
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: uiMessage(locale, "ui.status"),
      cell: ({ value }) => (
        <Badge
          tone={
            value === "ready"
              ? "success"
              : value === "error" || value === "missing"
                ? "danger"
                : "warning"
          }
        >
          {documentStatusLabel(locale, value as PublisherDocument["status"])}
        </Badge>
      ),
    },
    {
      accessorKey: "createdAt",
      header: uiMessage(locale, "ui.uploaded"),
      cell: ({ value }) => formatDate(locale, value as string | null),
    },
    {
      id: "open",
      header: <span className="sr-only">{uiMessage(locale, "ui.actions")}</span>,
      sortable: false,
      cell: ({ row }) =>
        row.original.url && onOpen ? (
          <Button variant="ghost" size="sm" onClick={() => onOpen(row.original.id)}>
            {uiMessage(locale, "ui.open")}
          </Button>
        ) : null,
    },
  ];
  return (
    <section aria-label={uiMessage(locale, "ui.publisherDocuments")} className="grid gap-2">
      {showHeader && (
        <SectionHeader
          kicker={uiMessage(locale, "ui.publisher")}
          title={uiMessage(locale, "ui.publisherDocuments")}
          description={error ?? uiMessage(locale, "ui.publisherDocumentsDescription")}
          count={rows.length}
        />
      )}
      <DataTable
        ariaLabel={uiMessage(locale, "ui.publisherDocuments")}
        columns={columns}
        data={rows}
        demoState={state}
        locale={locale}
        {...(onRetry === undefined ? {} : { onRetry })}
        emptyTitle={uiMessage(locale, "ui.noPublisherDocuments")}
        emptyDescription={uiMessage(locale, "ui.uploadedFilesEmpty")}
        toolbarExtra={
          onUpload ? (
            <Sheet locale={locale}>
              <SheetTrigger asChild>
                <Button variant="secondary" size="sm" className="gap-1.5">
                  <Upload className="size-3 text-ink-2" />
                  {uiMessage(locale, "documents.upload")}
                </Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle className="font-display text-[16px] font-medium">
                    {uiMessage(locale, "documents.uploadTitle")}
                  </SheetTitle>
                </SheetHeader>
                <SheetBody>
                  <FileUpload locale={locale} onUploaded={onUpload} />
                </SheetBody>
              </SheetContent>
            </Sheet>
          ) : undefined
        }
        stickyHeader
      />
    </section>
  );
}

export interface NewPublisherSubscriber {
  email: string;
  company: string;
}
export interface SubscribersTableProps extends PublisherTableState {
  rows?: readonly PublisherSubscriberRow[];
  onAdd?: (subscriber: NewPublisherSubscriber) => void | Promise<void>;
  onValidate?: (id: string) => void | Promise<void>;
  onPause?: (id: string) => void;
  onDelete?: (id: string) => void;
  onUndo?: (id: string) => void;
}
const subscriberEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u;
export function SubscribersTable({
  rows = [],
  state = "empty",
  error = null,
  onRetry,
  onAdd,
  onValidate,
  onPause,
  onDelete,
  onUndo,
  locale = "en-US",
  showHeader = true,
}: SubscribersTableProps) {
  const [draftOpen, setDraftOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const emailValid = subscriberEmail.test(email.trim());
  const addDraft = async () => {
    if (!onAdd || !emailValid) return;
    setAddError(null);
    try {
      await onAdd({ email: email.trim(), company: company.trim() });
      setEmail("");
      setCompany("");
      setDraftOpen(false);
    } catch {
      setAddError(uiMessage(locale, "ui.addSubscriberError"));
    }
  };
  const columns: DataTableColumn<PublisherSubscriberRow>[] = [
    {
      accessorKey: "company",
      header: uiMessage(locale, "ui.company"),
      cell: ({ value }) => (
        <span className="max-w-[26ch] truncate font-medium">{String(value ?? "—")}</span>
      ),
    },
    {
      accessorKey: "email",
      header: uiMessage(locale, "ui.subscriber"),
      cell: ({ row }) => (
        <span
          className={cn("font-mono text-[12px]", row.original.deleted && "text-ink-2 line-through")}
        >
          {row.original.email}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: uiMessage(locale, "ui.status"),
      cell: ({ row, value }) =>
        row.original.deleted ? (
          <Badge tone="outline">{uiMessage(locale, "ui.deleted")}</Badge>
        ) : (
          <Badge tone={value === "active" ? "success" : value === "invalid" ? "danger" : "warning"}>
            {subscriberStatusLabel(locale, value as PublisherSubscriberRow["status"])}
          </Badge>
        ),
    },
    {
      accessorKey: "subscribedAt",
      header: uiMessage(locale, "column.subscribed"),
      cell: ({ value }) => formatDate(locale, value as string | null),
    },
    {
      id: "actions",
      header: <span className="sr-only">{uiMessage(locale, "ui.actions")}</span>,
      sortable: false,
      cell: ({ row }) =>
        row.original.deleted ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={uiMessage(locale, "ui.undoRow").replace("{label}", row.original.email)}
            onClick={() => onUndo?.(row.original.id)}
          >
            <RotateCcw className="size-3" />
            {uiMessage(locale, "ui.undo")}
          </Button>
        ) : (
          <span className="flex items-center gap-1">
            {row.original.status === "invalid" && onValidate && (
              <Button variant="ghost" size="sm" onClick={() => void onValidate(row.original.id)}>
                {uiMessage(locale, "ui.validate")}
              </Button>
            )}
            {onPause && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={(row.original.status === "paused"
                  ? uiMessage(locale, "ui.resumeSubscriber")
                  : uiMessage(locale, "ui.pauseSubscriber")
                ).replace("{email}", row.original.email)}
                onClick={() => onPause(row.original.id)}
              >
                {row.original.status === "paused" ? (
                  <RotateCcw className="size-3" />
                ) : (
                  <CirclePause className="size-3" />
                )}
              </Button>
            )}
            {onUndo && row.original.status === "invalid" && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={uiMessage(locale, "ui.undoRow").replace("{label}", row.original.email)}
                onClick={() => onUndo(row.original.id)}
              >
                <RotateCcw className="size-3" />
              </Button>
            )}
            {onDelete && (
              <ConfirmingDeleteButton
                onConfirm={() => onDelete(row.original.id)}
                {...(onUndo === undefined ? {} : { undo: () => onUndo(row.original.id) })}
                label={uiMessage(locale, "ui.deleteRow").replace("{label}", row.original.email)}
                locale={locale}
              />
            )}
          </span>
        ),
    },
  ];
  return (
    <section aria-label={uiMessage(locale, "ui.publisherSubscribers")} className="grid gap-2">
      {showHeader && (
        <SectionHeader
          kicker={uiMessage(locale, "ui.publisher")}
          title={uiMessage(locale, "ui.publisherSubscribers")}
          description={error ?? uiMessage(locale, "ui.publisherSubscribersDescription")}
          count={rows.length}
          aside={
            onAdd ? (
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={draftOpen}
                onClick={() => {
                  setDraftOpen((open) => !open);
                  setAddError(null);
                }}
              >
                <PlusCircle className="size-3" />
                {uiMessage(locale, "ui.addSubscriber")}
              </Button>
            ) : undefined
          }
        />
      )}
      {draftOpen && onAdd && (
        <div className="animate-enter rounded-tiny border border-line-2 bg-surface p-3">
          <p className="caps-label mb-2 text-ink-2">
            {uiMessage(locale, "subscribers.draftTitle")}
          </p>
          <div className="grid items-start gap-3 md:grid-cols-[1fr_1fr_auto]">
            <div className="grid gap-1">
              <label
                htmlFor="publisher-subscriber-company"
                className="text-[12px] font-medium text-ink"
              >
                {uiMessage(locale, "ui.company")}
              </label>
              <Input
                id="publisher-subscriber-company"
                value={company}
                onChange={(event) => setCompany(event.target.value)}
                placeholder={uiMessage(locale, "ui.companyName")}
              />
            </div>
            <div className="grid gap-1">
              <label
                htmlFor="publisher-subscriber-email"
                className="text-[12px] font-medium text-ink"
              >
                {uiMessage(locale, "ui.email")}
              </label>
              <Input
                id="publisher-subscriber-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={email.length > 0 && !emailValid}
                placeholder={uiMessage(locale, "ui.emailPlaceholder")}
              />
              <p
                role={email.length > 0 && !emailValid ? "alert" : undefined}
                className={cn(
                  "flex items-center gap-1.5 text-[12px]",
                  email.length === 0 && "text-ink-2",
                  email.length > 0 && !emailValid && "text-danger",
                  emailValid && "text-ok",
                )}
              >
                {email.length === 0
                  ? uiMessage(locale, "subscribers.emailEmpty")
                  : emailValid
                    ? uiMessage(locale, "ui.emailLooksValid")
                    : uiMessage(locale, "ui.invalidEmail")}
              </p>
            </div>
            <div className="flex gap-2 md:pt-6">
              <Button
                variant="primary"
                size="md"
                disabled={!company.trim() || !emailValid}
                onClick={() => void addDraft()}
              >
                {uiMessage(locale, "action.add")}
              </Button>
              <Button
                variant="ghost"
                size="md"
                onClick={() => {
                  setDraftOpen(false);
                  setCompany("");
                  setEmail("");
                }}
              >
                {uiMessage(locale, "ui.cancel")}
              </Button>
            </div>
          </div>
          {addError && (
            <p role="alert" className="mt-2 text-[12px] text-danger">
              {addError}
            </p>
          )}
        </div>
      )}
      <DataTable
        ariaLabel={uiMessage(locale, "ui.publisherSubscribers")}
        columns={columns}
        data={rows}
        demoState={state}
        locale={locale}
        {...(onRetry === undefined ? {} : { onRetry })}
        emptyTitle={uiMessage(locale, "ui.noPublisherSubscribers")}
        emptyDescription={uiMessage(locale, "ui.subscriberRowsEmpty")}
        facets={["status"]}
        stickyHeader
      />
    </section>
  );
}
