import { useMemo, useState } from "react";
import {
  AppShell,
  Breadcrumbs,
  DocumentsTable,
  Gallery,
  IssueWizard,
  NotificationBell,
  NotificationSettings,
  PublicationsTable,
  SectionHeader,
  SourcesTable,
  SubscribersTable,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToastProvider,
  uiMessage,
  type NotificationSettingRow,
  type PublisherDocument,
  type PublisherPublicationRow,
  TooltipProvider,
  type PublisherSourceRow,
  type PublisherSubscriberRow,
} from "@hartlib/ui";
import type { Locale } from "@hartlib/i18n";
import {
  publisherFixtureDocuments,
  publisherFixtureNotifications,
  publisherFixturePublications,
  publisherFixtureSources,
  publisherFixtureSubscribers,
} from "./fixtures/publisher.fixture";

const publisherTabs = ["sources", "publications", "documents", "subscribers"] as const;
type PublisherTab = (typeof publisherTabs)[number];

const navigate = (path: string): void => {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

const localePrefix = (locale: Locale): string => `/${locale}`;

function PublisherShell({
  locale,
  active,
  children,
}: {
  locale: Locale;
  active: "sources" | "issues" | "settings";
  children: React.ReactNode;
}) {
  const prefix = localePrefix(locale);
  return (
    <ToastProvider locale={locale}>
      <TooltipProvider>
        <AppShell
          locale={locale}
          initialView="publisher"
          clientSubnav={[
            {
              id: "chat",
              label: uiMessage(locale, "ui.chat"),
              href: `${prefix}/client/chat`,
            },
          ]}
          publisherSubnav={[
            {
              id: "sources",
              label: uiMessage(locale, "ui.sources"),
              active: active === "sources",
              href: `${prefix}/publisher`,
            },
            {
              id: "new-issue",
              label: uiMessage(locale, "nav.newIssue"),
              active: active === "issues",
              href: `${prefix}/publisher/issues/new`,
            },
            {
              id: "settings",
              label: uiMessage(locale, "ui.settings"),
              active: active === "settings",
              href: `${prefix}/publisher/settings/notifications`,
            },
            {
              id: "gallery",
              label: uiMessage(locale, "nav.gallery"),
              href: `${prefix}/components`,
            },
          ]}
          actions={
            <NotificationBell
              items={publisherFixtureNotifications}
              locale={locale}
              onOpenSettings={() => navigate(`${prefix}/publisher/settings/notifications`)}
            />
          }
          onLocaleChange={(next) =>
            navigate(`/${next}${window.location.pathname.replace(/^\/(?:en-US|fr-FR|en|fr)/, "")}`)
          }
        >
          {children}
        </AppShell>
      </TooltipProvider>
    </ToastProvider>
  );
}

export function PublisherReferencePage({ locale }: { locale: Locale }) {
  const initialTab = useMemo<PublisherTab>(() => {
    const value =
      typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
    return publisherTabs.includes(value as PublisherTab) ? (value as PublisherTab) : "sources";
  }, []);
  const [tab, setTab] = useState<PublisherTab>(initialTab);
  const [sources, setSources] = useState<readonly PublisherSourceRow[]>(publisherFixtureSources);
  const [publications, setPublications] = useState<readonly PublisherPublicationRow[]>(
    publisherFixturePublications,
  );
  const [documents, setDocuments] =
    useState<readonly PublisherDocument[]>(publisherFixtureDocuments);
  const [subscribers, setSubscribers] = useState<readonly PublisherSubscriberRow[]>(
    publisherFixtureSubscribers,
  );
  const selectTab = (next: string) => {
    const selected = publisherTabs.includes(next as PublisherTab)
      ? (next as PublisherTab)
      : "sources";
    setTab(selected);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", selected);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };
  return (
    <PublisherShell locale={locale} active="sources">
      <div className="grid gap-4">
        <Breadcrumbs
          locale={locale}
          items={[
            {
              label: uiMessage(locale, "shell.publisherView"),
              href: `${localePrefix(locale)}/publisher`,
            },
            { label: uiMessage(locale, `publisher.tab_${tab}` as never) },
          ]}
        />
        <SectionHeader
          kicker={uiMessage(locale, "publisher.kicker")}
          title={uiMessage(locale, "publisher.title")}
          description={uiMessage(locale, "publisher.description")}
        />
        <Tabs value={tab} onValueChange={selectTab}>
          <TabsList aria-label={uiMessage(locale, "publisher.tabsLabel")}>
            {publisherTabs.map((key) => (
              <TabsTrigger key={key} value={key}>
                {uiMessage(locale, `publisher.tab_${key}` as never)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="sources" className="pt-4">
            <h3 className="sr-only">{uiMessage(locale, "publisher.tab_sources")}</h3>
            <SourcesTable
              rows={sources}
              state="data"
              locale={locale}
              showHeader={false}
              showDemoStateControl
              onRename={(id, name) =>
                setSources((rows) => rows.map((row) => (row.id === id ? { ...row, name } : row)))
              }
              onToggle={(id, enabled) =>
                setSources((rows) => rows.map((row) => (row.id === id ? { ...row, enabled } : row)))
              }
              onOpen={() => undefined}
            />
          </TabsContent>
          <TabsContent value="publications" className="pt-4">
            <h3 className="sr-only">{uiMessage(locale, "publisher.tab_publications")}</h3>
            <PublicationsTable
              rows={publications}
              state="data"
              locale={locale}
              showHeader={false}
              onOpen={() => undefined}
              onDelete={(id) => setPublications((rows) => rows.filter((row) => row.id !== id))}
            />
          </TabsContent>
          <TabsContent value="documents" className="pt-4">
            <h3 className="sr-only">{uiMessage(locale, "publisher.tab_documents")}</h3>
            <DocumentsTable
              rows={documents}
              state="data"
              locale={locale}
              showHeader={false}
              onOpen={() => undefined}
              onUpload={(file) =>
                setDocuments((rows) => [
                  ...rows,
                  {
                    id: `document-${rows.length + 1}`,
                    issueId: publisherFixturePublications[0]?.id ?? "issue",
                    name: file.name,
                    sizeBytes: file.sizeKb * 1024,
                    status: "ready",
                  },
                ])
              }
            />
          </TabsContent>
          <TabsContent value="subscribers" className="pt-4">
            <h3 className="sr-only">{uiMessage(locale, "publisher.tab_subscribers")}</h3>
            <SubscribersTable
              rows={subscribers}
              state="data"
              locale={locale}
              showHeader={false}
              onPause={(id) =>
                setSubscribers((rows) =>
                  rows.map((row) =>
                    row.id === id
                      ? { ...row, status: row.status === "paused" ? "active" : "paused" }
                      : row,
                  ),
                )
              }
              onDelete={(id) => setSubscribers((rows) => rows.filter((row) => row.id !== id))}
            />
          </TabsContent>
        </Tabs>
      </div>
    </PublisherShell>
  );
}

export function PublisherIssueReferencePage({ locale }: { locale: Locale }) {
  return (
    <PublisherShell locale={locale} active="issues">
      <div className="grid gap-4">
        <Breadcrumbs
          locale={locale}
          items={[
            {
              label: uiMessage(locale, "shell.publisherView"),
              href: `${localePrefix(locale)}/publisher`,
            },
            { label: uiMessage(locale, "ui.createIssue") },
          ]}
        />
        <IssueWizard
          locale={locale}
          sourceOptions={publisherFixtureSources.map((source) => ({
            id: source.id,
            label: source.name,
          }))}
          onCancel={() => navigate(`${localePrefix(locale)}/publisher`)}
          onPublish={() => navigate(`${localePrefix(locale)}/publisher?tab=publications`)}
          onSchedule={() => navigate(`${localePrefix(locale)}/publisher?tab=publications`)}
        />
      </div>
    </PublisherShell>
  );
}

const initialNotificationRows: readonly NotificationSettingRow[] = [
  {
    id: "publication",
    label: "Publication delivery",
    description: "New issue and publication notifications",
    enabled: true,
    delivery: "both",
  },
  {
    id: "validation",
    label: "Validation errors",
    description: "Document and publishing failures",
    enabled: true,
    delivery: "email",
  },
];

export function PublisherNotificationsReferencePage({ locale }: { locale: Locale }) {
  const [rows, setRows] = useState(initialNotificationRows);
  return (
    <PublisherShell locale={locale} active="settings">
      <div className="grid gap-4">
        <Breadcrumbs
          locale={locale}
          items={[
            {
              label: uiMessage(locale, "shell.publisherView"),
              href: `${localePrefix(locale)}/publisher`,
            },
            { label: uiMessage(locale, "ui.notificationSettings") },
          ]}
        />
        <NotificationSettings
          locale={locale}
          rows={rows}
          language={locale}
          onChange={setRows}
          onSave={() => undefined}
        />
      </div>
    </PublisherShell>
  );
}

export function GalleryReferencePage({ locale }: { locale: Locale }) {
  return (
    <PublisherShell locale={locale} active="sources">
      <Gallery locale={locale} />
    </PublisherShell>
  );
}
