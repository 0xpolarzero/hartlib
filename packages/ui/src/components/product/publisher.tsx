import { useMemo } from "react";
import { AppShell, type AppShellProps } from "./app-shell";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/atoms";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
  DocumentsTable,
  PublicationsTable,
  SourcesTable,
  SubscribersTable,
  type DocumentsTableProps,
  type PublisherDocument,
  type PublisherPublicationRow,
  type PublisherSourceRow,
  type PublisherSubscriberRow,
  type SubscribersTableProps,
  type PublicationsTableProps,
  type SourcesTableProps,
} from "./tables";
import { IssueWizard, type IssueWizardProps } from "./issue-wizard";
import {
  NotificationSettings,
  type NotificationSettingRow,
  type NotificationSettingsProps,
} from "./notification-settings";
import { NotificationBell, type PublisherNotification } from "./notification-bell";
import { uiMessage } from "../../lib/format";

export const PUBLISHER_COMPOSITION_TABS = [
  "sources",
  "publications",
  "documents",
  "subscribers",
  "issue",
  "settings",
] as const;

export type PublisherCompositionTab = (typeof PUBLISHER_COMPOSITION_TABS)[number];

type TableState = NonNullable<SourcesTableProps["state"]>;

export interface PublisherCompositionProps {
  sources?: readonly PublisherSourceRow[];
  publications?: readonly PublisherPublicationRow[];
  documents?: readonly PublisherDocument[];
  subscribers?: readonly PublisherSubscriberRow[];
  notifications?: readonly PublisherNotification[];
  notificationSettings?: readonly NotificationSettingRow[];
  locale?: string;
  className?: string;
  activeTab?: PublisherCompositionTab;
  defaultTab?: PublisherCompositionTab;
  onTabChange?: (tab: PublisherCompositionTab) => void;
  sourceState?: TableState;
  publicationState?: TableState;
  documentState?: TableState;
  subscriberState?: TableState;
  sourceError?: string | null;
  publicationError?: string | null;
  documentError?: string | null;
  subscriberError?: string | null;
  onRetrySources?: () => void;
  onRetryPublications?: () => void;
  onRetryDocuments?: () => void;
  onRetrySubscribers?: () => void;
  onRenameSource?: SourcesTableProps["onRename"];
  onToggleSource?: SourcesTableProps["onToggle"];
  onOpenSource?: SourcesTableProps["onOpen"];
  onOpenPublication?: PublicationsTableProps["onOpen"];
  onDeletePublication?: PublicationsTableProps["onDelete"];
  onUndoPublication?: PublicationsTableProps["onUndo"];
  onUploadDocument?: DocumentsTableProps["onUpload"];
  onOpenDocument?: DocumentsTableProps["onOpen"];
  onAddSubscriber?: SubscribersTableProps["onAdd"];
  onValidateSubscriber?: SubscribersTableProps["onValidate"];
  onPauseSubscriber?: SubscribersTableProps["onPause"];
  onDeleteSubscriber?: SubscribersTableProps["onDelete"];
  onUndoSubscriber?: SubscribersTableProps["onUndo"];
  issueProps?: Omit<IssueWizardProps, "locale">;
  notificationSettingsProps?: Omit<NotificationSettingsProps, "locale" | "rows">;
  notificationOnOpenSettings?: () => void;
  appShellProps?: Omit<
    AppShellProps,
    "children" | "locale" | "publisherSubnav" | "actions" | "className"
  >;
}

/**
 * Route-free publisher composition. It keeps every publisher presentation
 * behind props so the production app can pass empty, read-only collections.
 */
export function PublisherComposition({
  sources = [],
  publications = [],
  documents = [],
  subscribers = [],
  notifications = [],
  notificationSettings = [],
  locale = "en-US",
  className,
  activeTab,
  defaultTab = "sources",
  onTabChange,
  sourceState,
  publicationState,
  documentState,
  subscriberState,
  sourceError = null,
  publicationError = null,
  documentError = null,
  subscriberError = null,
  onRetrySources,
  onRetryPublications,
  onRetryDocuments,
  onRetrySubscribers,
  onRenameSource,
  onToggleSource,
  onOpenSource,
  onOpenPublication,
  onDeletePublication,
  onUndoPublication,
  onUploadDocument,
  onOpenDocument,
  onAddSubscriber,
  onValidateSubscriber,
  onPauseSubscriber,
  onDeleteSubscriber,
  onUndoSubscriber,
  issueProps,
  notificationSettingsProps,
  notificationOnOpenSettings,
  appShellProps,
}: PublisherCompositionProps) {
  const populated =
    sources.length > 0 || publications.length > 0 || documents.length > 0 || subscribers.length > 0;
  const defaultState: TableState = populated ? "data" : "empty";
  const tableState = {
    sources: sourceState ?? defaultState,
    publications: publicationState ?? defaultState,
    documents: documentState ?? defaultState,
    subscribers: subscriberState ?? defaultState,
  } as const;
  const sourceOptions = useMemo(
    () => sources.map((source) => ({ id: source.id, label: source.name })),
    [sources],
  );
  const publisherSubnav = [
    { id: "sources", label: uiMessage(locale, "ui.sources"), active: true },
    { id: "publications", label: uiMessage(locale, "ui.publications") },
    { id: "documents", label: uiMessage(locale, "ui.documents") },
    { id: "subscribers", label: uiMessage(locale, "ui.subscribers") },
    { id: "settings", label: uiMessage(locale, "ui.settings") },
  ] as const;
  const issue = issueProps ?? {};
  const settings = notificationSettingsProps ?? {};
  return (
    <AppShell
      locale={locale}
      {...(className === undefined ? {} : { className })}
      {...(appShellProps ?? {})}
      publisherSubnav={publisherSubnav}
      actions={
        <NotificationBell
          items={notifications}
          locale={locale}
          {...(notificationOnOpenSettings === undefined
            ? {}
            : { onOpenSettings: notificationOnOpenSettings })}
        />
      }
    >
      <div data-publisher-dormant="true" data-testid="publisher-dormant">
        <div className="mb-5">
          <p className="caps-label text-accent">{uiMessage(locale, "ui.publisher")}</p>
          <h1 className="mt-1 font-display text-[26px]">
            {uiMessage(locale, "ui.publicationWorkspace")}
          </h1>
        </div>
        <Tabs
          {...(activeTab === undefined ? { defaultValue: defaultTab } : { value: activeTab })}
          onValueChange={(next) => {
            if ((PUBLISHER_COMPOSITION_TABS as readonly string[]).includes(next))
              onTabChange?.(next as PublisherCompositionTab);
          }}
        >
          <TabsList aria-label={uiMessage(locale, "ui.publisherWorkspaceSections")}>
            <TabsTrigger value="sources">{uiMessage(locale, "ui.sources")}</TabsTrigger>
            <TabsTrigger value="publications">{uiMessage(locale, "ui.publications")}</TabsTrigger>
            <TabsTrigger value="documents">{uiMessage(locale, "ui.documents")}</TabsTrigger>
            <TabsTrigger value="subscribers">{uiMessage(locale, "ui.subscribers")}</TabsTrigger>
            <TabsTrigger value="issue">{uiMessage(locale, "ui.issueWizard")}</TabsTrigger>
            <TabsTrigger value="settings">{uiMessage(locale, "ui.settings")}</TabsTrigger>
          </TabsList>
          <TabsContent value="sources">
            <SourcesTable
              rows={sources}
              state={tableState.sources}
              locale={locale}
              error={sourceError}
              {...(onRetrySources === undefined ? {} : { onRetry: onRetrySources })}
              {...(onRenameSource === undefined ? {} : { onRename: onRenameSource })}
              {...(onToggleSource === undefined ? {} : { onToggle: onToggleSource })}
              {...(onOpenSource === undefined ? {} : { onOpen: onOpenSource })}
            />
          </TabsContent>
          <TabsContent value="publications">
            <PublicationsTable
              rows={publications}
              state={tableState.publications}
              locale={locale}
              error={publicationError}
              {...(onRetryPublications === undefined ? {} : { onRetry: onRetryPublications })}
              {...(onOpenPublication === undefined ? {} : { onOpen: onOpenPublication })}
              {...(onDeletePublication === undefined ? {} : { onDelete: onDeletePublication })}
              {...(onUndoPublication === undefined ? {} : { onUndo: onUndoPublication })}
            />
          </TabsContent>
          <TabsContent value="documents">
            <DocumentsTable
              rows={documents}
              state={tableState.documents}
              locale={locale}
              error={documentError}
              {...(onRetryDocuments === undefined ? {} : { onRetry: onRetryDocuments })}
              {...(onUploadDocument === undefined ? {} : { onUpload: onUploadDocument })}
              {...(onOpenDocument === undefined ? {} : { onOpen: onOpenDocument })}
            />
          </TabsContent>
          <TabsContent value="subscribers">
            <SubscribersTable
              rows={subscribers}
              state={tableState.subscribers}
              locale={locale}
              error={subscriberError}
              {...(onRetrySubscribers === undefined ? {} : { onRetry: onRetrySubscribers })}
              {...(onAddSubscriber === undefined ? {} : { onAdd: onAddSubscriber })}
              {...(onValidateSubscriber === undefined ? {} : { onValidate: onValidateSubscriber })}
              {...(onPauseSubscriber === undefined ? {} : { onPause: onPauseSubscriber })}
              {...(onDeleteSubscriber === undefined ? {} : { onDelete: onDeleteSubscriber })}
              {...(onUndoSubscriber === undefined ? {} : { onUndo: onUndoSubscriber })}
            />
          </TabsContent>
          <TabsContent value="issue">
            <IssueWizard sourceOptions={sourceOptions} locale={locale} {...issue} />
          </TabsContent>
          <TabsContent value="settings">
            <NotificationSettings rows={notificationSettings} locale={locale} {...settings} />
          </TabsContent>
        </Tabs>
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>{uiMessage(locale, "ui.publisherData")}</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-[12px] text-ink-2">
              {uiMessage(locale, "ui.recordsAvailable").replace(
                "{count}",
                String(
                  sources.length + publications.length + documents.length + subscribers.length,
                ),
              )}
            </p>
          </CardBody>
        </Card>
      </div>
    </AppShell>
  );
}

export type DormantPublisherCompositionProps = PublisherCompositionProps;
export default PublisherComposition;
