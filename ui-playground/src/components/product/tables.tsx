import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui/toast";
import type { ColumnDef } from "@tanstack/react-table";
import { CalendarClock, ExternalLink, FileWarning, Lock, PlusCircle, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { api } from "@/services";
import type { DocumentFile, Publication, Source, Subscriber } from "@/services/types";
import { formatDate, formatDateShort, formatNumber, formatPercent } from "@/lib/format";
import { useAnnounce } from "@/lib/announce";
import {
  Badge, Button, Switch, Tooltip, Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
  HoverCard, HoverCardTrigger, HoverCardContent, AlertDialog, AlertDialogContent,
  AlertDialogTitle, AlertDialogDescription, AlertDialogCancel, AlertDialogAction,
  Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetBody,
  Combobox, type ComboboxOption, Input,
} from "@/components/ui";
import { InlineEditableField } from "@/components/ui/inline-editable-field";
import { ConfirmingDeleteButton } from "@/components/ui/confirming-delete-button";
import { FileUpload } from "@/components/ui/file-upload";
import { DataTable, type DemoDataState } from "./data-table";
function useTableData<T>(loader: () => Promise<T[]>): { data: T[] | null; loading: boolean; error: boolean; reload: () => void } {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    loader()
      .then((rows) => {
        if (alive) {
          setData(rows);
          setError(false);
        }
      })
      .catch((e) => {
        if (alive) {
          console.error("[table] load failed:", e);
          setError(true);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading: data === null && !error, error, reload };
}

/** Toolbar control that switches the table between data/loading/empty/error. */
function DemoDataControl({ value, onChange, label }: { value: DemoDataState; onChange: (v: DemoDataState) => void; label: string }) {
  const { t } = useI18n();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as DemoDataState)}>
      <SelectTrigger className="h-6 w-36" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="data">{t("demoState.data")}</SelectItem>
        <SelectItem value="loading">{t("demoState.loading")}</SelectItem>
        <SelectItem value="empty">{t("demoState.empty")}</SelectItem>
        <SelectItem value="error">{t("demoState.error")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

const useDemoState = () => useState<DemoDataState>("data");

/* ── SourcesTable ──────────────────────────────────────────────────────── */

export function SourcesTable() {
  const { locale, t } = useI18n();
  const { data, loading, error, reload } = useTableData(() => api.listSources());
  const [demoState, setDemoState] = useDemoState();

  const columns = useMemo<ColumnDef<Source, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("sources.colName"),
        cell: ({ row }) => (
          <InlineEditableField
            ariaLabel={row.original.name}
            value={row.original.name}
            onSave={async (next) => {
              await api.renameSource(row.original.id, next);
              reload();
            }}
            className="text-[13px]"
          />
        ),
      },
      {
        accessorKey: "type",
        header: t("sources.colType"),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ getValue }) => {
          const v = getValue() as Source["type"];
          return v === "invitation" ? (
            <Badge tone="accent">{t("sources.typeInvitation")}</Badge>
          ) : (
            <Badge tone="outline">{t("sources.typePublic")}</Badge>
          );
        },
      },
      {
        accessorKey: "latestPublicationAt",
        header: t("sources.colLatest"),
        cell: ({ getValue }) => <span className="font-mono text-[12px] text-ink-2">{formatDate(locale, getValue() as string)}</span>,
      },
      {
        accessorKey: "subscriberCount",
        header: t("sources.colSubscribers"),
        cell: ({ getValue }) => <span className="font-mono text-[12.5px]">{formatNumber(locale, getValue() as number)}</span>,
      },
      {
        accessorKey: "subscription",
        header: t("sources.colSubscription"),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ getValue }) => {
          const subscribed = getValue() === "subscribed";
          return (
            <Tooltip content={t("sources.readOnlySubscription")}>
              <span className="inline-flex items-center gap-2">
                <Switch checked={subscribed} disabled aria-label={`${t("sources.colSubscription")} — ${subscribed ? t("sources.subscribed") : t("sources.notSubscribed")}`} />
                <span aria-hidden="true" className={cn("text-[12px]", subscribed ? "text-ink" : "text-ink-2")}>
                  {subscribed ? t("sources.subscribed") : t("sources.notSubscribed")}
                </span>
              </span>
            </Tooltip>
          );
        },
      },
    ],
    [locale, t, reload],
  );

  const effective: DemoDataState = error ? "error" : loading ? "loading" : demoState;

  return (
    <DataTable
      ariaLabel={t("sources.title")}
      columns={columns}
      data={data ?? []}
      demoState={effective}
      onRetry={reload}
      urlKey="src"
      facets={["type", "subscription"]}
      facetLabel={(col, value) =>
        value === "__col"
          ? col === "type"
            ? t("sources.colType")
            : t("sources.colSubscription")
          : col === "type"
            ? value === "invitation"
              ? t("sources.typeInvitation")
              : t("sources.typePublic")
            : value === "subscribed"
              ? t("sources.subscribed")
              : t("sources.notSubscribed")
      }
      emptyTitle={t("sources.emptyTitle")}
      emptyDescription={t("sources.emptyDescription")}
      stickyHeader
      toolbarExtra={<DemoDataControl value={demoState} onChange={setDemoState} label={t("demoState.label")} />}
    />
  );
}

/* ── PublicationsTable ─────────────────────────────────────────────────── */

export function PublicationsTable() {
  const { locale, t } = useI18n();
  const [immutablePub, setImmutablePub] = useState<Publication | null>(null);
  const { data, loading, error, reload } = useTableData(() => api.listPublications());
  const [demoState, setDemoState] = useDemoState();

  const columns = useMemo<ColumnDef<Publication, unknown>[]>(
    () => [
      {
        accessorKey: "title",
        header: t("publications.colTitle"),
        cell: ({ row }) => (
          <span className={cn("block max-w-[38ch] truncate", row.original.status !== "published" && "text-ink-2")} title={row.original.title}>
            {row.original.title}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: t("publications.colStatus"),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ row }) => {
          const status = row.original.status;
          return (
            <span className="inline-flex items-center gap-1.5">
              {status === "published" && <Badge tone="success">{t("publications.statusPublished")}</Badge>}
              {status === "scheduled" && (
                <Badge tone="warning">
                  <CalendarClock aria-hidden="true" className="size-3" />
                  {t("publications.statusScheduled")}
                </Badge>
              )}
              {status === "draft" && <Badge tone="neutral">{t("publications.statusDraft")}</Badge>}
              {row.original.autoDeleteAt && (
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      className="font-mono text-[10.5px] text-warn underline decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {t("publications.deletionShort")}
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent className="w-72">
                    <p className="caps-label text-warn">{t("publications.deletionTitle")}</p>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
                      {t("publications.deletionBody", { date: formatDate(locale, row.original.autoDeleteAt) })}
                    </p>
                  </HoverCardContent>
                </HoverCard>
              )}
            </span>
          );
        },
      },
      {
        id: "when",
        header: t("publications.colWhen"),
        accessorFn: (row) => row.publishedAt ?? row.scheduledForAt ?? "",
        cell: ({ row }) => {
          const p = row.original;
          const iso = p.publishedAt ?? p.scheduledForAt;
          return (
            <span className="font-mono text-[12px] text-ink-2">
              {iso ? formatDate(locale, iso) : "—"}
            </span>
          );
        },
      },
      {
        accessorKey: "subscriberCount",
        header: t("publications.colSubs"),
        cell: ({ getValue }) => <span className="font-mono text-[12.5px]">{formatNumber(locale, getValue() as number)}</span>,
      },
      {
        accessorKey: "openRate",
        header: t("publications.colOpen"),
        cell: ({ getValue }) => {
          const rate = getValue() as number;
          if (rate === 0) return <span className="font-mono text-[12px] text-ink-3">—</span>;
          return <span className="font-mono text-[12.5px]">{formatPercent(locale, rate, 1)}</span>;
        },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.status === "published" ? (
            <Tooltip content={t("publications.immutableTip")}>
              <Button variant="ghost" size="icon-sm" aria-label={t("publications.immutableA11y", { title: row.original.title })} onClick={() => setImmutablePub(row.original)}>
                <Lock className="size-3" />
              </Button>
            </Tooltip>
          ) : null,
      },
    ],
    [locale, t],
  );

  const effective: DemoDataState = error ? "error" : loading ? "loading" : demoState;

  return (
    <>
      <DataTable
        ariaLabel={t("publications.title")}
        columns={columns}
        data={data ?? []}
        demoState={effective}
        onRetry={reload}
        urlKey="pub"
      facetLabel={(_col, value) =>
          value === "__col"
            ? t("publications.colStatus")
            : value === "published"
              ? t("publications.statusPublished")
              : value === "scheduled"
                ? t("publications.statusScheduled")
                : t("publications.statusDraft")
        }
        emptyTitle={t("publications.emptyTitle")}
        emptyDescription={t("publications.emptyDescription")}
        stickyHeader
        toolbarExtra={<DemoDataControl value={demoState} onChange={setDemoState} label={t("demoState.label")} />}
      />
      <AlertDialog open={immutablePub !== null} onOpenChange={(o) => !o && setImmutablePub(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("publications.immutableTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("publications.immutableBody", { title: immutablePub?.title ?? "" })}
          </AlertDialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialogCancel asChild>
              <Button variant="ghost">{t("common.close")}</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="secondary" onClick={() => setImmutablePub(null)}>
                {t("publications.immutableAck")}
              </Button>
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* ── ClientPublicationsTable (delivered only) ──────────────────────────── */

export function ClientPublicationsTable() {
  const { locale, t } = useI18n();
  const { toast } = useToast();
  const { data, loading, error, reload } = useTableData(() => api.listPublications());
  const [demoState, setDemoState] = useDemoState();

  const delivered = useMemo(() => (data ?? []).filter((p) => p.status === "published"), [data]);

  const openDocument = async (publication: Publication) => {
    const docs = await api.listDocuments();
    const doc = docs.find((d) => d.publicationId === publication.id && d.url);
    if (doc?.url) {
      window.open(doc.url, "_blank", "noopener");
    } else {
      toast({
        title: t("clientPub.openMissingTitle"),
        description: t("clientPub.openMissingBody"),
        tone: "error",
      });
    }
  };

  const columns = useMemo<ColumnDef<Publication, unknown>[]>(
    () => [
      {
        accessorKey: "title",
        header: t("clientPub.colTitle"),
        cell: ({ getValue }) => <span className="block w-full min-w-0 truncate" title={getValue() as string}>{getValue() as string}</span>,
      },
      {
        accessorKey: "publishedAt",
        header: t("clientPub.colDelivered"),
        cell: ({ getValue }) => {
          const iso = getValue() as string;
          const fullDate = formatDate(locale, iso);
          return (
            <time dateTime={iso} title={fullDate} aria-label={fullDate} className="whitespace-nowrap font-mono text-[12px] text-ink-2">
              {formatDateShort(locale, iso)}
            </time>
          );
        },
      },
      {
        id: "read",
        header: t("clientPub.colRead"),
        // Deterministic pseudo read-state (title checksum) — stable per row.
        accessorFn: (row) => [...row.title].reduce((acc, ch) => acc + ch.codePointAt(0)!, 0) % 3 !== 0,
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ getValue }) =>
          getValue() === true ? (
            <Badge tone="neutral">{t("clientPub.read")}</Badge>
          ) : (
            <Badge tone="accent">{t("clientPub.unread")}</Badge>
          ),
      },
      {
        id: "open",
        header: "",
        enableSorting: false,
        size: 32,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("clientPub.open")}
            title={t("clientPub.open")}
            onClick={() => void openDocument(row.original)}
          >
            <ExternalLink aria-hidden="true" className="size-3" />
          </Button>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, t],
  );

  const effective: DemoDataState = error ? "error" : loading ? "loading" : demoState;

  return (
    <DataTable
      ariaLabel={t("clientPub.title")}
      columns={columns}
      data={delivered}
      demoState={effective}
      onRetry={reload}
      urlKey="cli"
      facets={["read"]}
      facetLabel={(_col, value) => (value === "__col" ? t("clientPub.colRead") : value === "true" ? t("clientPub.read") : t("clientPub.unread"))}
      emptyTitle={t("clientPub.emptyTitle")}
      emptyDescription={t("clientPub.emptyDescription")}
      stickyHeader
      toolbarExtra={<DemoDataControl value={demoState} onChange={setDemoState} label={t("demoState.label")} />}
    />
  );
}

/* ── DocumentsTable ────────────────────────────────────────────────────── */

export function DocumentsTable() {
  const { locale, t } = useI18n();
  const { toast } = useToast();
  const [uploads, setUploads] = useState<DocumentFile[]>([]);
  const { data, loading, error, reload } = useTableData(() => api.listDocuments());
  const [demoState, setDemoState] = useDemoState();

  const docs = useMemo(() => [...uploads, ...(data ?? [])], [data, uploads]);
  const columns = useMemo<ColumnDef<DocumentFile, unknown>[]>(
    () => [
      {
        accessorKey: "title",
        header: t("documents.colTitle"),
        cell: ({ getValue }) => <span className="font-mono text-[12.5px]">{getValue() as string}</span>,
      },
      {
        accessorKey: "description",
        header: t("documents.colDescription"),
        cell: ({ getValue }) => (
          <span className="block max-w-[42ch] truncate text-[12.5px] text-ink-2" title={getValue() as string}>
            {getValue() as string}
          </span>
        ),
      },
      {
        accessorKey: "sizeKb",
        header: t("documents.colSize"),
        cell: ({ getValue }) => <span className="font-mono text-[12px]">{formatNumber(locale, getValue() as number)} Ko</span>,
      },
      {
        id: "status",
        header: t("documents.colStatus"),
        accessorFn: (row) => (row.url ? "ready" : "missing"),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ row }) =>
          row.original.url ? (
            <Badge tone="success">{t("documents.ready")}</Badge>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Badge tone="danger">
                <FileWarning aria-hidden="true" className="size-3" />
                {t("documents.missing")}
              </Badge>
            </span>
          ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.url ? (
            <Button variant="link" size="sm" onClick={() => window.open(row.original.url!, "_blank", "noopener")}>
              {t("documents.openPdf")}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                toast({
                  title: t("documents.retryTitle"),
                  description: t("documents.retryBody"),
                  tone: "error",
                })
              }
            >
              {t("common.retry")}
            </Button>
          ),
      },
    ],
    [locale, t],
  );

  const effective: DemoDataState = error ? "error" : loading ? "loading" : demoState;

  return (
    <DataTable
      ariaLabel={t("documents.title")}
      columns={columns}
      data={docs}
      demoState={effective}
      onRetry={reload}
      urlKey="doc"
      facets={["status"]}
      facetLabel={(_col, value) =>
        value === "__col" ? t("documents.colStatus") : value === "ready" ? t("documents.ready") : t("documents.missing")
      }
      emptyTitle={t("documents.emptyTitle")}
      emptyDescription={t("documents.emptyDescription")}
      stickyHeader
      toolbarExtra={
        <>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="secondary" size="sm" className="gap-1.5">
                <Upload className="size-3 text-ink-2" />
                {t("documents.upload")}
              </Button>
            </SheetTrigger>
            <SheetContent side="right">
              <SheetHeader>
                <SheetTitle className="font-display text-[16px] font-medium">{t("documents.uploadTitle")}</SheetTitle>
              </SheetHeader>
              <SheetBody>
                <FileUpload
                  onUploaded={(file) => {
                    setUploads((prev) => [
                      {
                        id: `up-${Date.now()}-${prev.length}`,
                        title: file.name,
                        description: t("documents.uploadedJustNow"),
                        sizeKb: file.sizeKb,
                        url: file.url,
                        uploadedAt: new Date().toISOString(),
                        publicationId: null,
                      },
                      ...prev,
                    ]);
                  }}
                />
              </SheetBody>
            </SheetContent>
          </Sheet>
          <DemoDataControl value={demoState} onChange={setDemoState} label={t("demoState.label")} />
        </>
      }
    />
  );
}


/* ── SubscribersTable ──────────────────────────────────────────────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function SubscribersTable() {
  const { locale, t } = useI18n();
  const [draftOpen, setDraftOpen] = useState(false);
  const [company, setCompany] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const { data, loading, error, reload } = useTableData(() => api.listSubscribers());
  const [demoState, setDemoState] = useDemoState();
  const { toast } = useToast();
  const announce = useAnnounce();

  const emailState: "empty" | "invalid" | "valid" = email === "" ? "empty" : EMAIL_RE.test(email) ? "valid" : "invalid";

  const columns = useMemo<ColumnDef<Subscriber, unknown>[]>(
    () => [
      {
        accessorKey: "company",
        header: t("subscribers.colCompany"),
        cell: ({ getValue }) => <span className="max-w-[26ch] truncate font-medium">{getValue() as string}</span>,
      },
      {
        accessorKey: "email",
        header: t("subscribers.colEmail"),
        cell: ({ getValue }) => <span className="font-mono text-[12px]">{getValue() as string}</span>,
      },
      {
        accessorKey: "plan",
        header: t("subscribers.colPlan"),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ getValue }) => {
          const plan = getValue() as Subscriber["plan"];
          return <Badge tone={plan === "sur-mesure" ? "accent" : "neutral"}>{t(`subscribers.plan_${plan}`)}</Badge>;
        },
      },
      {
        accessorKey: "state",
        header: t("subscribers.colState"),
        filterFn: (row, id, value: string[]) => value.includes(String(row.getValue(id))),
        cell: ({ row }) => {
          const paused = row.original.state === "paused";
          return (
            <span className="inline-flex items-center gap-2">
              <Switch
                checked={!paused}
                aria-label={`${t("subscribers.pauseToggle")} — ${row.original.company}`}
                onCheckedChange={async (active) => {
                  await api.setSubscriberState(row.original.id, active ? "active" : "paused");
                  reload();
                  toast({
                    title: active ? t("subscribers.resumedTitle") : t("subscribers.pausedTitle"),
                    description: row.original.company,
                    tone: "success",
                  });
                  announce.status(active ? t("subscribers.resumedTitle") : t("subscribers.pausedTitle"));
                }}
              />
              <Badge tone={paused ? "warning" : "success"}>{paused ? t("subscribers.paused") : t("subscribers.active")}</Badge>
            </span>
          );
        },
      },
      {
        accessorKey: "receivedCount",
        header: t("subscribers.colReceived"),
        cell: ({ getValue }) => <span className="font-mono text-[12.5px]">{formatNumber(locale, getValue() as number)}</span>,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <ConfirmingDeleteButton
            label={t("subscribers.deleteA11y", { company: row.original.company })}
            onConfirm={() => {
              const snapshot = row.original;
              void api.deleteSubscriber(snapshot.id).then(reload);
            }}
            undo={() => {
              void api.addSubscriber({ company: row.original.company, email: row.original.email }).then(reload);
            }}
          />
        ),
      },
    ],
    [locale, t, reload, toast, announce],
  );

  const effective: DemoDataState = error ? "error" : loading ? "loading" : demoState;

  const addDraft = async () => {
    if (!company || emailState !== "valid") return;
    await api.addSubscriber({ company, email });
    setDraftOpen(false);
    setCompany(null);
    setEmail("");
    reload();
    toast({ title: t("subscribers.addedTitle"), description: company, tone: "success" });
    announce.status(t("subscribers.addedTitle"));
  };

  return (
    <div className="grid gap-2">
      <DataTable
        ariaLabel={t("subscribers.title")}
        columns={columns}
        data={data ?? []}
        demoState={effective}
        onRetry={reload}
        urlKey="sub"
        facets={["plan", "state"]}
        enableSelection
        bulkActions={(rows, clear) => (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await Promise.all(rows.map((r) => api.setSubscriberState(r.id, "paused")));
                clear();
                reload();
                toast({ title: t("subscribers.bulkPaused", { n: rows.length }), tone: "success" });
              }}
            >
              {t("subscribers.bulkPause")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await Promise.all(rows.map((r) => api.setSubscriberState(r.id, "active")));
                clear();
                reload();
                toast({ title: t("subscribers.bulkResumed", { n: rows.length }), tone: "success" });
              }}
            >
              {t("subscribers.bulkResume")}
            </Button>
          </>
        )}
        facetLabel={(col, value) =>
          value === "__col"
            ? col === "plan"
              ? t("subscribers.colPlan")
              : t("subscribers.colState")
            : col === "plan"
              ? t(`subscribers.plan_${value}`)
              : value === "active"
                ? t("subscribers.active")
                : t("subscribers.paused")
        }
        emptyTitle={t("subscribers.emptyTitle")}
        emptyDescription={t("subscribers.emptyDescription")}
        stickyHeader
        toolbarExtra={
          <>
            <Button variant="secondary" size="sm" className="gap-1.5" aria-expanded={draftOpen} onClick={() => setDraftOpen((o) => !o)}>
              <PlusCircle className="size-3 text-ink-2" />
              {t("subscribers.add")}
            </Button>
            <DemoDataControl value={demoState} onChange={setDemoState} label={t("demoState.label")} />
          </>
        }
      />

      {draftOpen && (
        <div className="animate-enter rounded-tiny border border-line-2 bg-surface p-3">
          <p className="caps-label mb-2 text-ink-2">{t("subscribers.draftTitle")}</p>
          <div className="grid items-start gap-3 md:grid-cols-[1fr_1fr_auto]">
            <div className="grid gap-1">
              <label htmlFor="draft-company" className="text-[12px] font-medium text-ink">
                {t("subscribers.draftCompany")}
              </label>
              <Combobox
                ariaLabel={t("subscribers.draftCompany")}
                placeholder={t("subscribers.draftCompanyPlaceholder")}
                value={company}
                onChange={(opt) => setCompany(opt?.label ?? null)}
                loader={async (q) => {
                  const companies = await api.listCompanies(q);
                  return companies.map(
                    (c): ComboboxOption => ({ value: c.id, label: c.name, hint: c.city }),
                  );
                }}
              />
            </div>
            <div className="grid gap-1">
              <label htmlFor="draft-email" className="text-[12px] font-medium text-ink">
                {t("subscribers.draftEmail")}
              </label>
              <Input
                id="draft-email"
                type="email"
                value={email}
                invalid={emailState === "invalid"}
                onChange={(e) => setEmail(e.target.value)}
                aria-describedby="draft-email-msg"
                placeholder="abonnements@exemple.fr"
              />
              <p
                id="draft-email-msg"
                role={emailState === "invalid" ? "alert" : undefined}
                className={cn(
                  "flex items-center gap-1.5 text-[12px]",
                  emailState === "invalid" && "text-danger",
                  emailState === "valid" && "text-ok",
                  emailState === "empty" && "text-ink-2",
                )}
              >
                {emailState === "invalid" && t("subscribers.emailInvalid")}
                {emailState === "valid" && t("subscribers.emailValid")}
                {emailState === "empty" && t("subscribers.emailEmpty")}
              </p>
            </div>
            <div className="flex gap-2 md:pt-6">
              <Button variant="primary" size="md" disabled={!company || emailState !== "valid"} onClick={() => void addDraft()}>
                {t("subscribers.addConfirm")}
              </Button>
              <Button
                variant="ghost"
                size="md"
                onClick={() => {
                  setDraftOpen(false);
                  setCompany(null);
                  setEmail("");
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
