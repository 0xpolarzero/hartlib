import { useMemo, useState } from "react";
import { Check, CirclePause, FileText, Pencil, PlusCircle, RotateCcw } from "lucide-react";
import { formatDate, formatNumber, uiMessage } from "../../lib/format";
import { Badge, SectionHeader } from "../ui/atoms";
import { Button } from "../ui/button";
import { ConfirmingDeleteButton } from "../ui/confirming-delete-button";
import { DataTable, type DataTableColumn, type DemoDataState } from "./data-table";
import { FileUpload, type UploadedFile } from "../ui/file-upload";
import { InlineEditableField } from "../ui/inline-editable-field";
import { Input } from "../ui/input";

const sourceKindLabel = (locale: string, kind: PublisherSourceRow["kind"]): string =>
  kind === "public"
    ? uiMessage(locale, "ui.sourceKindPublic")
    : uiMessage(locale, "ui.sourceKindPublisher");
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

export interface PublisherSourceRow {
  id: string;
  name: string;
  kind: "public" | "publisher";
  country: string;
  enabled: boolean;
  status?: "active" | "paused";
  publicationCount?: number | null;
  subscriberCount?: number | null;
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
  onToggle,
  onOpen,
  locale = "en-US",
}: SourcesTableProps) {
  const columns = useMemo<DataTableColumn<PublisherSourceRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: uiMessage(locale, "ui.tableSource"),
        cell: ({ row }) =>
          onRename ? (
            <InlineEditableField
              value={row.original.name}
              ariaLabel={`${uiMessage(locale, "ui.rename")} ${row.original.name}`}
              locale={locale}
              onSave={(name) => onRename(row.original.id, name)}
            />
          ) : (
            row.original.name
          ),
      },
      {
        accessorKey: "kind",
        header: uiMessage(locale, "column.type"),
        cell: ({ value }) => (
          <Badge tone={value === "public" ? "outline" : "accent"}>
            {sourceKindLabel(locale, value as PublisherSourceRow["kind"])}
          </Badge>
        ),
      },
      { accessorKey: "country", header: uiMessage(locale, "ui.market") },
      {
        accessorKey: "publicationCount",
        header: uiMessage(locale, "ui.publisherPublications"),
        cell: ({ value }) =>
          value === null || value === undefined ? "—" : formatNumber(locale, value as number),
      },
      {
        accessorKey: "subscriberCount",
        header: uiMessage(locale, "ui.publisherSubscribers"),
        cell: ({ value }) =>
          value === null || value === undefined ? "—" : formatNumber(locale, value as number),
      },
      {
        accessorKey: "enabled",
        header: uiMessage(locale, "ui.state"),
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={row.original.enabled}
              className="font-mono text-[11px] underline"
              onClick={() => onToggle?.(row.original.id, !row.original.enabled)}
            >
              {row.original.enabled
                ? uiMessage(locale, "workspace.delivery.enabled")
                : uiMessage(locale, "workspace.delivery.disabled")}
            </button>
            {row.original.error && (
              <span role="alert" className="text-[11px] text-danger">
                {row.original.error}
              </span>
            )}
          </span>
        ),
      },
      {
        id: "open",
        header: <span className="sr-only">{uiMessage(locale, "ui.actions")}</span>,
        sortable: false,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${uiMessage(locale, "ui.open")} ${row.original.name}`}
            onClick={() => onOpen?.(row.original.id)}
          >
            <Pencil className="size-3" aria-hidden="true" />
          </Button>
        ),
      },
    ],
    [locale, onOpen, onRename, onToggle],
  );
  return (
    <section aria-label={uiMessage(locale, "ui.publisherSources")} className="grid gap-2">
      <SectionHeader
        kicker={uiMessage(locale, "ui.publisher")}
        title={uiMessage(locale, "ui.publisherSources")}
        description={error ?? uiMessage(locale, "ui.manageSourcesDescription")}
        count={rows.length}
      />
      <DataTable
        ariaLabel={uiMessage(locale, "ui.publisherSources")}
        columns={columns}
        data={rows}
        demoState={state}
        locale={locale}
        {...(onRetry === undefined ? {} : { onRetry })}
        emptyTitle={uiMessage(locale, "ui.noPublisherSources")}
        emptyDescription={uiMessage(locale, "ui.sourceRowsEmpty")}
        facets={["kind", "country"]}
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
}: PublicationsTableProps) {
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
            className="text-left font-medium underline-offset-2 hover:underline"
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
          <span className="flex items-center gap-1.5">
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
              <span title={uiMessage(locale, "ui.immutablePublication")}>
                <Check className="size-3 text-ok" aria-label={uiMessage(locale, "ui.immutable")} />
              </span>
            )}
          </span>
        ),
    },
    {
      accessorKey: "publicationDate",
      header: uiMessage(locale, "ui.date"),
      cell: ({ value }) => formatDate(locale, value as string | null),
    },
    {
      accessorKey: "subscriberCount",
      header: uiMessage(locale, "ui.subscribers"),
      cell: ({ value }) =>
        value === null || value === undefined ? "—" : formatNumber(locale, value as number),
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
          <Badge tone="outline">{uiMessage(locale, "ui.immutable")}</Badge>
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
    <section aria-label={uiMessage(locale, "ui.publisherPublications")} className="grid gap-2">
      <SectionHeader
        kicker={uiMessage(locale, "ui.publisher")}
        title={uiMessage(locale, "ui.publisherPublications")}
        description={error ?? uiMessage(locale, "ui.publisherPublicationsDescription")}
        count={rows.length}
      />
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
}: DocumentsTableProps) {
  const columns: DataTableColumn<PublisherDocument>[] = [
    {
      accessorKey: "name",
      header: uiMessage(locale, "ui.document"),
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          <FileText className="size-3 text-ink-2" aria-hidden="true" />
          {row.original.name}
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
      <SectionHeader
        kicker={uiMessage(locale, "ui.publisher")}
        title={uiMessage(locale, "ui.publisherDocuments")}
        description={error ?? uiMessage(locale, "ui.publisherDocumentsDescription")}
        count={rows.length}
      />
      <FileUpload locale={locale} {...(onUpload === undefined ? {} : { onUploaded: onUpload })} />
      <DataTable
        ariaLabel={uiMessage(locale, "ui.publisherDocuments")}
        columns={columns}
        data={rows}
        demoState={state}
        locale={locale}
        {...(onRetry === undefined ? {} : { onRetry })}
        emptyTitle={uiMessage(locale, "ui.noPublisherDocuments")}
        emptyDescription={uiMessage(locale, "ui.uploadedFilesEmpty")}
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
      accessorKey: "email",
      header: uiMessage(locale, "ui.subscriber"),
      cell: ({ row }) => (
        <div className={row.original.deleted ? "text-ink-2 line-through" : undefined}>
          <p className="font-medium">{row.original.email}</p>
          {row.original.company && <p className="text-[11px] text-ink-2">{row.original.company}</p>}
        </div>
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
      {draftOpen && onAdd && (
        <div className="grid gap-2 rounded-tiny border border-line-2 bg-surface p-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
            <label
              className="grid gap-1 text-[12px] font-medium"
              htmlFor="publisher-subscriber-company"
            >
              {uiMessage(locale, "ui.company")}
              <Input
                id="publisher-subscriber-company"
                value={company}
                onChange={(event) => setCompany(event.target.value)}
                placeholder={uiMessage(locale, "ui.companyName")}
              />
            </label>
            <label
              className="grid gap-1 text-[12px] font-medium"
              htmlFor="publisher-subscriber-email"
            >
              {uiMessage(locale, "ui.email")}
              <Input
                id="publisher-subscriber-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={email.length > 0 && !emailValid}
                placeholder={uiMessage(locale, "ui.emailPlaceholder")}
              />
            </label>
            <Button
              variant="primary"
              size="md"
              className="sm:mt-5"
              disabled={!emailValid}
              onClick={() => void addDraft()}
            >
              {uiMessage(locale, "action.add")}
            </Button>
          </div>
          {email.length > 0 && (
            <p
              role="status"
              className={emailValid ? "text-[12px] text-ok" : "text-[12px] text-danger"}
            >
              {emailValid
                ? uiMessage(locale, "ui.emailLooksValid")
                : uiMessage(locale, "ui.invalidEmail")}
            </p>
          )}
          {addError && (
            <p role="alert" className="text-[12px] text-danger">
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
