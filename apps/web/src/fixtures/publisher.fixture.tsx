import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AppShell,
  Button,
  Combobox,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  DatePicker,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DocumentsTable,
  IssueWizard,
  NotificationSettings,
  NotificationBell,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Popover,
  PopoverContent,
  PopoverTriggerButton,
  PublicationsTable,
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SourcesTable,
  SubscribersTable,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToastProvider,
  type NotificationSettingRow,
  type PublisherNotification,
  type PublisherDocument,
  type PublisherPublicationRow,
  type PublisherSourceRow,
  type PublisherSubscriberRow,
  type DemoDataState,
  uiMessage,
  useToast,
} from "@hartlib/ui";

const fixtureLocale = "en-US" as const;

export const publisherFixtureSources: readonly PublisherSourceRow[] = [
  {
    id: "src-1",
    name: "Lettre Juridique Sociale",
    kind: "invitation",
    country: "FR",
    enabled: true,
    latestPublicationAt: "2026-08-30",
    subscriberCount: 4218,
  },
  {
    id: "src-2",
    name: "La Correspondance Fiscale",
    kind: "invitation",
    country: "FR",
    enabled: true,
    latestPublicationAt: "2026-08-27",
    subscriberCount: 3876,
  },
  {
    id: "src-3",
    name: "Registre des Sociétés Cotées",
    kind: "public",
    country: "FR",
    enabled: true,
    latestPublicationAt: "2026-08-31",
    subscriberCount: 11290,
  },
  {
    id: "src-4",
    name: "Alertes AMF — Fil Presse",
    kind: "public",
    country: "FR",
    enabled: false,
    latestPublicationAt: "2026-09-01",
    subscriberCount: 5210,
  },
  {
    id: "src-5",
    name: "L'Éclairage Réglementaire UE",
    kind: "invitation",
    country: "FR",
    enabled: true,
    latestPublicationAt: "2026-08-23",
    subscriberCount: 2044,
  },
  {
    id: "src-6",
    name: "Revue Contentieux & Arbitrage",
    kind: "invitation",
    country: "FR",
    enabled: false,
    latestPublicationAt: "2026-08-11",
    subscriberCount: 1567,
  },
  {
    id: "src-7",
    name: "Bulletin Officiel des Marchés",
    kind: "public",
    country: "FR",
    enabled: true,
    latestPublicationAt: "2026-08-29",
    subscriberCount: 8301,
  },
  {
    id: "src-8",
    name: "Mémento Paie & RémoNég",
    kind: "invitation",
    country: "FR",
    enabled: false,
    latestPublicationAt: "2026-08-19",
    subscriberCount: 976,
  },
];
export const publisherFixturePublications: readonly PublisherPublicationRow[] = [
  {
    id: "pub-atlas-may",
    sourceId: "src-atlas-energy",
    title: "May 2026 market review",
    status: "published",
    publicationDate: "2026-05-31",
    subscriberCount: 1240,
    openRate: 0.62,
    immutable: true,
  },
  {
    id: "pub-regfin-june",
    sourceId: "src-regfin",
    title: "June 17 regulatory update",
    status: "scheduled",
    publicationDate: "2026-06-17",
    subscriberCount: 318,
    openRate: null,
    autoDeleteAt: "2026-07-17",
  },
];
export const publisherFixtureDocuments: readonly PublisherDocument[] = [
  {
    id: "doc-atlas-may",
    issueId: "pub-atlas-may",
    name: "atlas-energy-2026-05-market.pdf",
    status: "ready",
    sizeBytes: 932_112,
    createdAt: "2026-05-31T11:05:00.000Z",
    url: "/secure/documents/doc-atlas-may",
  },
  {
    id: "doc-regfin-june",
    issueId: "pub-regfin-june",
    name: "regional-finance-2026-06-17.pdf",
    status: "processing",
    sizeBytes: null,
    createdAt: "2026-06-17T08:18:00.000Z",
  },
];
export const publisherFixtureSubscribers: readonly PublisherSubscriberRow[] = [
  {
    id: "sub-001",
    email: "ops@northstar.example",
    company: "Northstar Research",
    status: "active",
    subscribedAt: "2026-04-02",
    lastDeliveryAt: "2026-06-24",
  },
  {
    id: "sub-002",
    email: "analyst@rivermark.example",
    company: "Rivermark Capital",
    status: "paused",
    subscribedAt: "2026-03-11",
    lastDeliveryAt: "2026-06-17",
  },
  {
    id: "sub-003",
    email: "bad-address",
    company: null,
    status: "invalid",
    subscribedAt: "2026-02-20",
    lastDeliveryAt: null,
  },
];
export const publisherFixtureNotifications: readonly PublisherNotification[] = [
  {
    id: "notification-001",
    kind: "delivered",
    publicationTitle: "May 2026 market review",
    at: "2026-05-31T11:05:00.000Z",
    read: false,
  },
];
export interface PublisherFixtureProps {
  onEvent?: (event: string) => void;
}

type FixtureTableState = DemoDataState;
const fixtureTableStates: readonly FixtureTableState[] = ["data", "loading", "empty", "error"];
const gallerySourceOptions = [
  { value: "source", label: "Atlas Energy Commission" },
  { value: "publication", label: "May 2026 market review" },
  { value: "subscriber", label: "Northstar Research" },
];
const gallerySourceLoader = async (query: string) =>
  gallerySourceOptions.filter((option) => option.label.toLowerCase().includes(query.toLowerCase()));

function FixtureStateSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: FixtureTableState;
  onChange: (value: FixtureTableState) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-ink-2">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as FixtureTableState)}
        className="h-7 rounded-tiny border border-line-2 bg-surface px-2 text-[12px] text-ink"
      >
        {fixtureTableStates.map((state) => (
          <option key={state} value={state}>
            {state}
          </option>
        ))}
      </select>
    </label>
  );
}

function GalleryFixture({ onEvent }: PublisherFixtureProps) {
  const { toast } = useToast();
  const [comboValue, setComboValue] = useState<string | null>(null);
  const [dateValue, setDateValue] = useState<string | null>(null);
  return (
    <section
      data-testid="gallery-fixture"
      aria-labelledby="gallery-fixture-title"
      className="grid gap-4"
    >
      <div>
        <p className="caps-label text-accent">04</p>
        <h2 id="gallery-fixture-title" className="mt-1 font-display text-[22px]">
          Component gallery interactions
        </h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2 rounded-tiny border border-line p-3">
          <p className="caps-label text-ink-2">Commands and combobox</p>
          <Command onSelect={(value) => onEvent?.(`gallery.command:${value}`)}>
            <CommandInput aria-label="Gallery commands" placeholder="Search commands" />
            <CommandList aria-label="Gallery commands">
              <CommandEmpty>No commands</CommandEmpty>
              <CommandItem value="open-source">Open source</CommandItem>
              <CommandItem value="open-publication">Open publication</CommandItem>
            </CommandList>
          </Command>
          <Combobox
            ariaLabel="Gallery source"
            placeholder="Choose a source"
            value={comboValue}
            onChange={(option) => {
              setComboValue(option?.value ?? null);
              if (option) onEvent?.(`gallery.combobox:${option.value}`);
            }}
            loader={gallerySourceLoader}
          />
        </div>
        <div className="grid gap-2 rounded-tiny border border-line p-3">
          <p className="caps-label text-ink-2">Menus and overlays</p>
          <div className="flex flex-wrap gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Gallery dialog</DialogTitle>
                </DialogHeader>
                <DialogDescription className="px-4 py-3">
                  Dialog content remains focusable and dismissible.
                </DialogDescription>
                <DialogFooter>
                  <Button variant="ghost">Cancel</Button>
                  <Button variant="primary" onClick={() => onEvent?.("gallery.dialog.confirm")}>
                    Confirm
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <AlertDialog>
              <DialogTrigger asChild>
                <Button variant="destructive">Open alert</Button>
              </DialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>Immutable publication</AlertDialogTitle>
                <AlertDialogDescription>Published issues cannot be edited.</AlertDialogDescription>
                <div className="mt-4 flex justify-end gap-2">
                  <AlertDialogCancel className="rounded-tiny px-2.5 py-1.5 text-[13px]">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="rounded-tiny bg-ink px-2.5 py-1.5 text-[13px] text-paper"
                    onClick={() => onEvent?.("gallery.alert.confirm")}
                  >
                    Acknowledge
                  </AlertDialogAction>
                </div>
              </AlertDialogContent>
            </AlertDialog>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="secondary">Open sheet</Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>Gallery sheet</SheetTitle>
                </SheetHeader>
                <SheetBody>
                  <p className="text-[13px] text-ink-2">Sheet content.</p>
                </SheetBody>
              </SheetContent>
            </Sheet>
            <Popover>
              <PopoverTriggerButton asChild>
                <Button variant="secondary">Open popover</Button>
              </PopoverTriggerButton>
              <PopoverContent className="p-3">
                <p className="text-[13px] text-ink-2">Popover content.</p>
              </PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary">Open menu</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => onEvent?.("gallery.menu.rename")}>
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onEvent?.("gallery.menu.share")}>
                  Share
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <HoverCard>
              <HoverCardTrigger asChild>
                <Button variant="link">Hover details</Button>
              </HoverCardTrigger>
              <HoverCardContent>
                <p className="text-[13px] text-ink-2">Citation details.</p>
              </HoverCardContent>
            </HoverCard>
          </div>
        </div>
      </div>
      <div className="grid gap-2 rounded-tiny border border-line p-3 sm:max-w-sm">
        <p className="caps-label text-ink-2">Datepicker and toast</p>
        <DatePicker
          ariaLabel="Gallery date"
          value={dateValue}
          onChange={(value) => {
            setDateValue(value);
            if (value) onEvent?.(`gallery.date:${value}`);
          }}
        />
        <Button
          variant="secondary"
          onClick={() =>
            toast({
              title: "Gallery saved",
              description: "The component state was saved.",
              tone: "success",
              durationMs: 30_000,
              undo: { label: "Undo", onUndo: () => onEvent?.("gallery.toast.undo") },
            })
          }
        >
          Show toast
        </Button>
      </div>
    </section>
  );
}

/**
 * Route-free state matrix for the dormant publisher and gallery compositions.
 * The live product never imports this fixture; direct tests use it to prove
 * every state remains reachable without adding a production route.
 */
export function PublisherStateFixture({ onEvent }: PublisherFixtureProps = {}) {
  const [sourceState, setSourceState] = useState<FixtureTableState>("data");
  const [publicationState, setPublicationState] = useState<FixtureTableState>("data");
  const [documentState, setDocumentState] = useState<FixtureTableState>("data");
  const [subscriberState, setSubscriberState] = useState<FixtureTableState>("data");
  const [sources, setSources] = useState<readonly PublisherSourceRow[]>(publisherFixtureSources);
  const [publications, setPublications] = useState<readonly PublisherPublicationRow[]>(
    publisherFixturePublications,
  );
  const [subscribers, setSubscribers] = useState<readonly PublisherSubscriberRow[]>(
    publisherFixtureSubscribers,
  );
  const [documents, setDocuments] =
    useState<readonly PublisherDocument[]>(publisherFixtureDocuments);
  const [wizardStatus, setWizardStatus] = useState<"idle" | "saving" | "published" | "error">(
    "idle",
  );
  const [settingsStatus, setSettingsStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [settings, setSettings] = useState<readonly NotificationSettingRow[]>([
    {
      id: "publication",
      label: uiMessage(fixtureLocale, "fixture.publicationDelivery"),
      description: uiMessage(fixtureLocale, "fixture.publicationDeliveryDescription"),
      enabled: true,
      delivery: "both",
    },
  ]);
  const saveSettings = async (rows: readonly NotificationSettingRow[], language: string) => {
    onEvent?.(`settings.save:${language}:${rows.length}`);
    setSettingsStatus("saving");
    await Promise.resolve();
    setSettingsStatus("saved");
  };
  return (
    <ToastProvider locale={fixtureLocale}>
      <div data-testid="publisher-state-fixture" className="grid gap-5">
        <div>
          <p className="caps-label text-accent">Route-free fixture</p>
          <h1 className="mt-1 font-display text-[26px]">Dormant publisher states</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-2">
            Direct state coverage for publisher tables, issue creation, notification settings, and
            component overlays.
          </p>
        </div>
        <Tabs defaultValue="sources">
          <TabsList aria-label="Publisher fixture sections">
            <TabsTrigger value="sources">Sources</TabsTrigger>
            <TabsTrigger value="publications">Publications</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
            <TabsTrigger value="subscribers">Subscribers</TabsTrigger>
            <TabsTrigger value="issue">Issue wizard</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="gallery">Gallery</TabsTrigger>
          </TabsList>
          <TabsContent value="sources" className="pt-4">
            <FixtureStateSelect
              label="Sources demo state"
              value={sourceState}
              onChange={setSourceState}
            />
            <SourcesTable
              rows={sources}
              state={sourceState}
              onRetry={() => setSourceState("data")}
              onRename={(id, name) => {
                onEvent?.(`source.rename:${id}:${name}`);
                setSources((rows) => rows.map((row) => (row.id === id ? { ...row, name } : row)));
              }}
              onToggle={(id, enabled) => {
                onEvent?.(`source.toggle:${id}:${enabled}`);
                setSources((rows) =>
                  rows.map((row) => (row.id === id ? { ...row, enabled } : row)),
                );
              }}
            />
          </TabsContent>
          <TabsContent value="publications" className="pt-4">
            <FixtureStateSelect
              label="Publications demo state"
              value={publicationState}
              onChange={setPublicationState}
            />
            <PublicationsTable
              rows={publications}
              state={publicationState}
              onRetry={() => setPublicationState("data")}
              onOpen={(id) => onEvent?.(`publication.open:${id}`)}
              onDelete={(id) => {
                onEvent?.(`publication.delete:${id}`);
                setPublications((rows) =>
                  rows.map((row) => (row.id === id ? { ...row, deleted: true } : row)),
                );
              }}
              onUndo={(id) => {
                onEvent?.(`publication.undo:${id}`);
                setPublications((rows) =>
                  rows.map((row) => (row.id === id ? { ...row, deleted: false } : row)),
                );
              }}
            />
            <AlertDialog>
              <DialogTrigger asChild>
                <Button variant="secondary" className="mt-3">
                  Open immutable publication dialog
                </Button>
              </DialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>Immutable publication</AlertDialogTitle>
                <AlertDialogDescription>
                  May 2026 market review is published and cannot be changed.
                </AlertDialogDescription>
                <AlertDialogAction className="mt-4 rounded-tiny bg-ink px-2.5 py-1.5 text-[13px] text-paper">
                  Acknowledge
                </AlertDialogAction>
              </AlertDialogContent>
            </AlertDialog>
          </TabsContent>
          <TabsContent value="documents" className="pt-4">
            <FixtureStateSelect
              label="Documents demo state"
              value={documentState}
              onChange={setDocumentState}
            />
            <DocumentsTable
              rows={documents}
              state={documentState}
              onRetry={() => setDocumentState("data")}
              onUpload={(file) => {
                onEvent?.(`document.upload:${file.name}`);
                setDocuments((rows) => [
                  ...rows,
                  {
                    id: `doc-fixture-${rows.length + 1}`,
                    issueId: "fixture-issue",
                    name: file.name,
                    status: "processing",
                    sizeBytes: file.sizeKb * 1000,
                    createdAt: "2026-06-24T10:20:00.000Z",
                  },
                ]);
              }}
              onOpen={(id) => onEvent?.(`document.open:${id}`)}
            />
          </TabsContent>
          <TabsContent value="subscribers" className="pt-4">
            <FixtureStateSelect
              label="Subscribers demo state"
              value={subscriberState}
              onChange={setSubscriberState}
            />
            <SubscribersTable
              rows={subscribers}
              state={subscriberState}
              onRetry={() => setSubscriberState("data")}
              onAdd={(subscriber) => {
                onEvent?.(`subscriber.add:${subscriber.email}`);
                setSubscribers((rows) => [
                  ...rows,
                  {
                    id: `sub-fixture-${rows.length + 1}`,
                    ...subscriber,
                    status: "active",
                    subscribedAt: "2026-06-24",
                  },
                ]);
              }}
              onValidate={(id) => {
                onEvent?.(`subscriber.validate:${id}`);
                setSubscribers((rows) =>
                  rows.map((row) => (row.id === id ? { ...row, status: "active" } : row)),
                );
              }}
              onPause={(id) => {
                onEvent?.(`subscriber.pause:${id}`);
                setSubscribers((rows) =>
                  rows.map((row) =>
                    row.id === id
                      ? { ...row, status: row.status === "paused" ? "active" : "paused" }
                      : row,
                  ),
                );
              }}
              onDelete={(id) => {
                onEvent?.(`subscriber.delete:${id}`);
                setSubscribers((rows) =>
                  rows.map((row) => (row.id === id ? { ...row, deleted: true } : row)),
                );
              }}
              onUndo={(id) => {
                onEvent?.(`subscriber.undo:${id}`);
                setSubscribers((rows) =>
                  rows.map((row) => (row.id === id ? { ...row, deleted: false } : row)),
                );
              }}
            />
          </TabsContent>
          <TabsContent value="issue" className="pt-4">
            <label className="flex w-fit items-center gap-2 text-[12px] text-ink-2">
              <span>Issue status</span>
              <select
                aria-label="Issue status"
                value={wizardStatus}
                onChange={(event) => setWizardStatus(event.target.value as typeof wizardStatus)}
                className="h-7 rounded-tiny border border-line-2 bg-surface px-2 text-[12px] text-ink"
              >
                {(["idle", "saving", "published", "error"] as const).map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <IssueWizard
              sourceOptions={publisherFixtureSources.map((source) => ({
                id: source.id,
                label: source.name,
              }))}
              status={wizardStatus}
              error={wizardStatus === "error" ? "Unable to publish this issue." : null}
              onUpload={(file) => onEvent?.(`issue.document.upload:${file.name}`)}
              onSchedule={(value) => onEvent?.(`issue.schedule:${value.title}`)}
              onPublish={(value) => onEvent?.(`issue.publish:${value.title}`)}
            />
          </TabsContent>
          <TabsContent value="settings" className="pt-4">
            <label className="flex w-fit items-center gap-2 text-[12px] text-ink-2">
              <span>Settings status</span>
              <select
                aria-label="Settings status"
                value={settingsStatus}
                onChange={(event) => setSettingsStatus(event.target.value as typeof settingsStatus)}
                className="h-7 rounded-tiny border border-line-2 bg-surface px-2 text-[12px] text-ink"
              >
                {(["idle", "saving", "saved", "error"] as const).map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <NotificationSettings
              rows={settings}
              status={settingsStatus}
              error={settingsStatus === "error" ? "Unable to save settings." : null}
              onChange={setSettings}
              onLanguageChange={(language) => onEvent?.(`settings.language:${language}`)}
              onSave={saveSettings}
            />
          </TabsContent>
          <TabsContent value="gallery" className="pt-4">
            <GalleryFixture {...(onEvent === undefined ? {} : { onEvent })} />
          </TabsContent>
        </Tabs>
      </div>
    </ToastProvider>
  );
}

export function PublisherFixture({ onEvent }: PublisherFixtureProps = {}) {
  const [sources, setSources] = useState<readonly PublisherSourceRow[]>(publisherFixtureSources);
  const [publications, setPublications] = useState<readonly PublisherPublicationRow[]>(
    publisherFixturePublications,
  );
  const [documents, setDocuments] =
    useState<readonly PublisherDocument[]>(publisherFixtureDocuments);
  const [subscribers, setSubscribers] = useState<readonly PublisherSubscriberRow[]>(
    publisherFixtureSubscribers,
  );
  const [settings, setSettings] = useState<readonly NotificationSettingRow[]>([
    {
      id: "publication",
      label: uiMessage(fixtureLocale, "fixture.publicationDelivery"),
      description: uiMessage(fixtureLocale, "fixture.publicationDeliveryDescription"),
      enabled: true,
      delivery: "both",
    },
    {
      id: "validation",
      label: uiMessage(fixtureLocale, "fixture.validationErrors"),
      description: uiMessage(fixtureLocale, "fixture.validationErrorsDescription"),
      enabled: true,
      delivery: "email",
    },
  ]);
  return (
    <AppShell
      locale="en-US"
      publisherSubnav={[
        { id: "sources", label: uiMessage(fixtureLocale, "ui.sources"), active: true },
        { id: "publications", label: uiMessage(fixtureLocale, "ui.publications") },
        { id: "documents", label: uiMessage(fixtureLocale, "ui.documents") },
        { id: "subscribers", label: uiMessage(fixtureLocale, "ui.subscribers") },
        { id: "settings", label: uiMessage(fixtureLocale, "ui.settings") },
      ]}
      actions={
        <NotificationBell
          items={publisherFixtureNotifications}
          locale="en-US"
          onOpenSettings={() => onEvent?.("notification.settings.open")}
        />
      }
    >
      <div className="grid gap-8" data-testid="publisher-fixture">
        <h1 className="font-display text-[26px]">
          {uiMessage(fixtureLocale, "fixture.publisherTitle")}
        </h1>
        <SourcesTable
          rows={sources}
          state="data"
          onRename={(id, name) => {
            onEvent?.(`source.rename:${id}`);
            setSources((rows) => rows.map((row) => (row.id === id ? { ...row, name } : row)));
          }}
          onToggle={(id, enabled) => {
            onEvent?.(`source.toggle:${id}:${enabled}`);
            setSources((rows) => rows.map((row) => (row.id === id ? { ...row, enabled } : row)));
          }}
          onOpen={() => undefined}
        />
        <PublicationsTable
          rows={publications}
          state="data"
          onOpen={(id) => onEvent?.(`publication.open:${id}`)}
          onDelete={(id) => {
            onEvent?.(`publication.delete:${id}`);
            setPublications((rows) =>
              rows.map((row) => (row.id === id ? { ...row, deleted: true } : row)),
            );
          }}
          onUndo={(id) => {
            onEvent?.(`publication.undo:${id}`);
            setPublications((rows) =>
              rows.map((row) => (row.id === id ? { ...row, deleted: false } : row)),
            );
          }}
        />
        <DocumentsTable
          rows={documents}
          state="data"
          onUpload={(file) => {
            onEvent?.(`document.upload:${file.name}`);
            setDocuments((rows) => [
              ...rows,
              {
                id: `doc-${rows.length + 1}`,
                issueId: "pub-atlas-may",
                name: file.name,
                status: "processing",
                sizeBytes: file.sizeKb * 1000,
                createdAt: new Date().toISOString(),
              },
            ]);
          }}
          onOpen={(id) => onEvent?.(`document.open:${id}`)}
        />
        <SubscribersTable
          rows={subscribers}
          state="data"
          onAdd={(subscriber) => {
            onEvent?.(`subscriber.add:${subscriber.email}`);
            setSubscribers((rows) => [
              ...rows,
              {
                id: `sub-${rows.length + 1}`,
                ...subscriber,
                status: "active",
                subscribedAt: new Date().toISOString(),
              },
            ]);
          }}
          onValidate={(id) => {
            onEvent?.(`subscriber.validate:${id}`);
            setSubscribers((rows) =>
              rows.map((row) => (row.id === id ? { ...row, status: "active" } : row)),
            );
          }}
          onPause={(id) => {
            onEvent?.(`subscriber.pause:${id}`);
            setSubscribers((rows) =>
              rows.map((row) =>
                row.id === id
                  ? { ...row, status: row.status === "paused" ? "active" : "paused" }
                  : row,
              ),
            );
          }}
          onDelete={(id) => {
            onEvent?.(`subscriber.delete:${id}`);
            setSubscribers((rows) =>
              rows.map((row) => (row.id === id ? { ...row, deleted: true } : row)),
            );
          }}
          onUndo={(id) => {
            onEvent?.(`subscriber.undo:${id}`);
            setSubscribers((rows) =>
              rows.map((row) => (row.id === id ? { ...row, deleted: false } : row)),
            );
          }}
        />
        <IssueWizard
          sourceOptions={sources.map((source) => ({
            id: source.id,
            label: source.name,
          }))}
          onUpload={(file) => {
            onEvent?.(`issue.document.upload:${file.name}`);
            setDocuments((rows) => [
              ...rows,
              {
                id: `doc-${rows.length + 1}`,
                issueId: "new-issue",
                name: file.name,
                status: "processing",
                sizeBytes: file.sizeKb * 1000,
                createdAt: new Date().toISOString(),
              },
            ]);
          }}
          onSchedule={(value) => onEvent?.(`issue.schedule:${value.title}`)}
          onPublish={(value) => onEvent?.(`issue.publish:${value.title}`)}
        />
        <NotificationSettings
          rows={settings}
          onChange={setSettings}
          onLanguageChange={(language) => onEvent?.(`settings.language:${language}`)}
          onSave={(rows, language) => onEvent?.(`settings.save:${language}:${rows.length}`)}
        />
      </div>
    </AppShell>
  );
}
export default PublisherFixture;
