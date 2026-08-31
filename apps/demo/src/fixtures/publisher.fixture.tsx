import { useState } from "react";
import {
  AppShell,
  DocumentsTable,
  IssueWizard,
  NotificationSettings,
  NotificationBell,
  PublicationsTable,
  SourcesTable,
  SubscribersTable,
  type NotificationSettingRow,
  type PublisherNotification,
  type PublisherDocument,
  type PublisherPublicationRow,
  type PublisherSourceRow,
  type PublisherSubscriberRow,
  uiMessage,
} from "@hartlib/ui";

const fixtureLocale = "en-US" as const;

export const publisherFixtureSources: readonly PublisherSourceRow[] = [
  {
    id: "src-atlas-energy",
    name: "Atlas Energy Commission",
    kind: "public",
    country: "US",
    enabled: true,
    status: "active",
    publicationCount: 18,
    subscriberCount: 1240,
    updatedAt: "2026-06-24T10:20:00.000Z",
  },
  {
    id: "src-regfin",
    name: "Regional Financial Authority",
    kind: "public",
    country: "FR",
    enabled: false,
    status: "paused",
    publicationCount: 7,
    subscriberCount: 318,
    updatedAt: "2026-06-17T08:15:00.000Z",
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
