import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  AppShell,
  IssueWizard,
  NotificationBell,
  NotificationSettings,
  PublicationsTable,
  SourcesTable,
  SubscribersTable,
  DocumentsTable,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type NotificationSettingRow,
  type PublisherDocument,
  type PublisherNotification,
  type PublisherPublicationRow,
  type PublisherSourceRow,
  type PublisherSubscriberRow,
  uiMessage,
} from "@hartlib/ui";

export interface DormantPublisherCompositionProps {
  sources?: readonly PublisherSourceRow[];
  publications?: readonly PublisherPublicationRow[];
  documents?: readonly PublisherDocument[];
  subscribers?: readonly PublisherSubscriberRow[];
  notifications?: readonly PublisherNotification[];
  notificationSettings?: readonly NotificationSettingRow[];
  className?: string;
  locale?: string;
}

/** Route-free publisher composition. The product passes the default empty collections. */
export function PublisherComposition({
  sources = [],
  publications = [],
  documents = [],
  subscribers = [],
  notifications = [],
  notificationSettings = [],
  className,
  locale = "en-US",
}: DormantPublisherCompositionProps) {
  const populated =
    sources.length > 0 || publications.length > 0 || documents.length > 0 || subscribers.length > 0;
  const state = populated ? "data" : "empty";
  return (
    <AppShell
      locale={locale}
      {...(className === undefined ? {} : { className })}
      publisherSubnav={[
        { id: "sources", label: uiMessage(locale, "ui.sources"), active: true },
        { id: "publications", label: uiMessage(locale, "ui.publications") },
        { id: "documents", label: uiMessage(locale, "ui.documents") },
        { id: "subscribers", label: uiMessage(locale, "ui.subscribers") },
        { id: "settings", label: uiMessage(locale, "ui.settings") },
      ]}
      actions={<NotificationBell items={notifications} locale={locale} />}
    >
      <div data-publisher-dormant="true">
        <div className="mb-5">
          <div>
            <p className="caps-label text-accent">{uiMessage(locale, "ui.publisher")}</p>
            <h1 className="mt-1 font-display text-[26px]">
              {uiMessage(locale, "ui.publicationWorkspace")}
            </h1>
          </div>
        </div>
        <Tabs defaultValue="sources">
          <TabsList aria-label={uiMessage(locale, "ui.publisherWorkspaceSections")}>
            <TabsTrigger value="sources">{uiMessage(locale, "ui.sources")}</TabsTrigger>
            <TabsTrigger value="publications">{uiMessage(locale, "ui.publications")}</TabsTrigger>
            <TabsTrigger value="documents">{uiMessage(locale, "ui.documents")}</TabsTrigger>
            <TabsTrigger value="subscribers">{uiMessage(locale, "ui.subscribers")}</TabsTrigger>
            <TabsTrigger value="issue">{uiMessage(locale, "ui.issueWizard")}</TabsTrigger>
            <TabsTrigger value="settings">{uiMessage(locale, "ui.settings")}</TabsTrigger>
          </TabsList>
          <TabsContent value="sources">
            <SourcesTable rows={sources} state={state} locale={locale} />
          </TabsContent>
          <TabsContent value="publications">
            <PublicationsTable rows={publications} state={state} locale={locale} />
          </TabsContent>
          <TabsContent value="documents">
            <DocumentsTable rows={documents} state={state} locale={locale} />
          </TabsContent>
          <TabsContent value="subscribers">
            <SubscribersTable rows={subscribers} state={state} locale={locale} />
          </TabsContent>
          <TabsContent value="issue">
            <IssueWizard
              sourceOptions={sources.map((source) => ({ id: source.id, label: source.name }))}
              locale={locale}
            />
          </TabsContent>
          <TabsContent value="settings">
            <NotificationSettings rows={notificationSettings} locale={locale} />
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

export default PublisherComposition;
