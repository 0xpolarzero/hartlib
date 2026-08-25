import { useNavigate, useSearch } from "@tanstack/react-router";
import { useI18n } from "@/i18n";
import { Breadcrumbs, SectionHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { DocumentsTable, PublicationsTable, SourcesTable, SubscribersTable } from "@/components/product/tables";

const TABS = ["sources", "publications", "documents", "subscribers"] as const;

export function PublisherPage() {
  const { locale, t } = useI18n();
  const search = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const tab = (TABS as readonly string[]).includes(search.tab ?? "") ? search.tab! : "sources";

  return (
    <div className="grid gap-4">
      <Breadcrumbs
        items={[
          { label: t("shell.publisherView"), to: "/$locale/publisher", params: { locale } },
          { label: t(`publisher.tab_${tab}`) },
        ]}
      />
      <SectionHeader
        kicker={t("publisher.kicker")}
        title={t("publisher.title")}
        description={t("publisher.description")}
      />
      <Tabs
        value={tab}
        onValueChange={(next) => void navigate({ search: { tab: next } as never, replace: true })}
      >
        <TabsList aria-label={t("publisher.tabsLabel")}>
          {TABS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`publisher.tab_${key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="sources" className="pt-4">
          <h3 className="sr-only">{t("publisher.tab_sources")}</h3>
          <SourcesTable />
        </TabsContent>
        <TabsContent value="publications" className="pt-4">
          <h3 className="sr-only">{t("publisher.tab_publications")}</h3>
          <PublicationsTable />
        </TabsContent>
        <TabsContent value="documents" className="pt-4">
          <h3 className="sr-only">{t("publisher.tab_documents")}</h3>
          <DocumentsTable />
        </TabsContent>
        <TabsContent value="subscribers" className="pt-4">
          <h3 className="sr-only">{t("publisher.tab_subscribers")}</h3>
          <SubscribersTable />
        </TabsContent>
      </Tabs>
    </div>
  );
}
