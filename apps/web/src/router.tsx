import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  DEFAULT_LOCALE,
  DEFAULT_MARKET_FOR_LOCALE,
  type LocaleMarketPair,
  FormattedMessage,
  I18nProvider,
  htmlLang,
  isLocale,
  useIntl,
  useLocale,
  LOCALE_MARKET_ALIASES,
} from "@hartlib/i18n";
import { Button } from "@hartlib/ui";

import { AppShell } from "@/components/layout/app-shell";
import { useCurrentWorkspaces } from "@/components/layout/workspace-switcher";
import { WorkspaceState } from "@/components/layout/workspace-page";
import { RequireAuthentication, useWebSecurityContext } from "@/components/auth/auth-boundary";
import { ProductChatPage } from "@/components/chat/product-chat-page";
import { ChatWorkspacePage } from "@/components/chat/chat-workspace-page";
import {
  PublisherSubscriptionPage,
  PublisherWorkspacePage,
} from "@/components/publisher/publisher-workspace-page";
import { PublisherIssuePage } from "@/components/publisher/publisher-issue-page";
import { PublisherSettingsPage } from "@/components/publisher/publisher-settings-page";
import { ClientArchivePage, ClientIssuePage } from "@/components/client/client-archive-page";
import { ClientNotificationsPage } from "@/components/client/client-notifications-page";
import { ClientBillingPage } from "@/components/client/client-billing-page";
import { ClientSettingsPage } from "@/components/client/client-settings-page";
import { ClientTeamPage, PublisherTeamPage } from "@/components/team/workspace-team-pages";
import {
  PlatformOperationsPage,
  PlatformSupportPage,
} from "@/components/admin/platform-operations-page";
import { queryClient } from "@/lib/query-client";
import { workspaceRoleLabel } from "@/lib/workspace-labels";
import { setStoredLocale } from "@/locale-bootstrap";

type RouterContext = {
  queryClient: QueryClient;
};

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "docs",
  component: DocsDocument,
});

/**
 * Layout route for the locale segment (`/$locale`). Validates the segment in
 * `beforeLoad`: aliases (`fr`/`us`) resolve to their canonical locale, and
 * anything that isn't a real locale redirects to the default locale.
 */
const localeLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$locale",
  component: RootLayout,
  beforeLoad: ({ params }) => {
    const segment = params.locale;

    // Canonical locale: allow through.
    if (isLocale(segment)) return;

    // Short alias (e.g. `/fr`, `/us`): redirect to the canonical locale prefix.
    const alias = LOCALE_MARKET_ALIASES[segment];
    if (alias) {
      throw redirect({
        to: "/$locale",
        params: { locale: alias.locale },
        replace: true,
      });
    }

    // Anything else: redirect to the default locale.
    throw redirect({
      to: "/$locale",
      params: { locale: DEFAULT_LOCALE },
      replace: true,
    });
  },
});

const indexRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "/",
  component: HomeRoute,
});

const chatRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "chat/$chatId",
  component: ChatRoute,
});

const clientChatsRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "client/$companyId/chats",
  component: ClientChatsRoute,
});

const clientArchiveRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "client/$companyId",
  component: ClientArchiveRoute,
});

const clientIssueRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "client/$companyId/issues/$issueId",
  component: ClientIssueRoute,
});

const clientNotificationsRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "client/$companyId/notifications",
  component: ClientNotificationsRoute,
});

const clientTeamRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "client/$companyId/team",
  component: ClientTeamRoute,
});

const clientBillingRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "client/$companyId/billing",
  component: ClientBillingRoute,
});

const clientSettingsRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "client/$companyId/settings",
  component: ClientSettingsRoute,
});

const publisherWorkspaceRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "publisher/$companyId",
  component: PublisherWorkspaceRoute,
});

const publisherSubscriptionRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "publisher/$companyId/subscriptions/$subscriptionId",
  component: PublisherSubscriptionRoute,
});

const publisherIssueRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "publisher/$companyId/issues/$issueId",
  component: PublisherIssueRoute,
});

const publisherTeamRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "publisher/$companyId/team",
  component: PublisherTeamRoute,
});

const publisherSettingsRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "publisher/$companyId/settings",
  component: PublisherSettingsRoute,
});

const platformOperationsRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "platform",
  component: PlatformOperationsRoute,
});

const platformSupportRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "platform/support",
  component: PlatformSupportRoute,
});

const securityRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "security",
  component: SecurityRoute,
});

const privacyRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "privacy",
  component: PrivacyRoute,
});

const publisherTermsRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "legal/publisher-terms",
  component: PublisherTermsRoute,
});

const clientTermsRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "legal/client-terms",
  component: ClientTermsRoute,
});

const dataProcessingRoute = createRoute({
  getParentRoute: () => localeLayoutRoute,
  path: "legal/data-processing",
  component: DataProcessingRoute,
});

const routeTree = rootRoute.addChildren([
  docsRoute,
  localeLayoutRoute.addChildren([
    indexRoute,
    chatRoute,
    clientChatsRoute,
    clientArchiveRoute,
    clientIssueRoute,
    clientNotificationsRoute,
    clientTeamRoute,
    clientBillingRoute,
    clientSettingsRoute,
    publisherWorkspaceRoute,
    publisherSubscriptionRoute,
    publisherIssueRoute,
    publisherTeamRoute,
    publisherSettingsRoute,
    platformOperationsRoute,
    platformSupportRoute,
    securityRoute,
    privacyRoute,
    publisherTermsRoute,
    clientTermsRoute,
    dataProcessingRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function DocsDocument() {
  const [docsHtml, setDocsHtml] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const previousTitle = document.title;
    const previousLang = document.documentElement.lang;
    document.title = "Hartlib — How chat works";
    document.documentElement.lang = "en";
    void import("@hartlib/docs").then(({ DOCS_HTML }) => {
      if (active) setDocsHtml(DOCS_HTML);
    });
    return () => {
      active = false;
      document.title = previousTitle;
      document.documentElement.lang = previousLang;
    };
  }, []);

  if (docsHtml === null) return null;

  return (
    <iframe
      srcDoc={docsHtml}
      title="Hartlib — How chat works"
      style={{ border: 0, display: "block", height: "100dvh", width: "100%" }}
    />
  );
}

function RootLayout() {
  // The active locale param is read reactively from the locale layout route.
  // `beforeLoad` on the locale layout route guarantees the segment is a valid
  // locale, so narrow the `string` param to `Locale` here.
  const params = useParams({ from: localeLayoutRoute.id });
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const navigate = useNavigate({ from: localeLayoutRoute.id });
  const location = useLocation();

  const market = DEFAULT_MARKET_FOR_LOCALE[locale];

  // Keep `<html lang>` in sync with the live locale param so it stays correct
  // for client-side navigation (not just full reloads / switcher changes).
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = htmlLang(locale);
    }
  }, [locale]);

  function handleChangeLocaleMarket(next: LocaleMarketPair) {
    setStoredLocale(next.locale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = htmlLang(next.locale);
    }
    // Switch to the same route in the other locale: swap only the locale
    // segment of the current pathname, preserving the rest (e.g. chat id).
    const segments = location.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      segments[0] = next.locale;
    }
    const nextPath = `/${segments.join("/")}`;
    void navigate({ to: nextPath, replace: true });
  }

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale={locale} market={market} onChangeLocaleMarket={handleChangeLocaleMarket}>
        <AppShell>
          <Outlet />
        </AppShell>
      </I18nProvider>
    </QueryClientProvider>
  );
}

function HomeRoute() {
  return (
    <RequireAuthentication>
      <AuthenticatedHome />
    </RequireAuthentication>
  );
}

function AuthenticatedHome() {
  const locale = useLocale();
  const intl = useIntl();
  const workspaces = useCurrentWorkspaces();
  const all = [
    ...(workspaces.data?.publisherWorkspaces ?? []),
    ...(workspaces.data?.clientWorkspaces ?? []),
  ];
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 py-10">
      <div className="space-y-3">
        <p className="text-sm font-medium text-muted">
          <FormattedMessage id="web.home.eyebrow" />
        </p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink">
          <FormattedMessage id="web.home.title" />
        </h1>
        <p className="text-base leading-7 text-muted">
          <FormattedMessage id="web.home.body" />
        </p>
      </div>

      {workspaces.isPending ? (
        <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
      ) : workspaces.isError ? (
        <WorkspaceState
          tone="danger"
          title={intl.formatMessage({ id: "workspace.discovery.failed" })}
          action={
            <Button variant="outline" onClick={() => void workspaces.refetch()}>
              <FormattedMessage id="action.retry" />
            </Button>
          }
        />
      ) : all.length === 0 ? (
        <WorkspaceState
          title={intl.formatMessage({ id: "workspace.discovery.empty" })}
          body={intl.formatMessage({ id: "workspace.discovery.emptyBody" })}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {all.map((workspace) => (
            <a
              key={`${workspace.kind}:${workspace.companyId}`}
              href={`/${locale}${workspace.landingPath}`}
              className="rounded-sm border border-rule bg-paper p-5 hover:border-accent/40 hover:bg-surface"
            >
              <p className="text-xs font-medium uppercase tracking-wider text-accent">
                <FormattedMessage
                  id={workspace.kind === "publisher" ? "role.publisher" : "role.client"}
                />
              </p>
              <h2 className="mt-2 font-display text-xl text-ink">{workspace.companyName}</h2>
              <p className="mt-2 text-xs text-faint">{workspaceRoleLabel(intl, workspace.role)}</p>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function ChatRoute() {
  const { chatId } = useParams({ from: chatRoute.id });
  return (
    <RequireAuthentication>
      <ProductChatPage chatId={chatId} />
    </RequireAuthentication>
  );
}

function ClientChatsRoute() {
  const { companyId } = useParams({ from: clientChatsRoute.id });
  return (
    <RequireAuthentication>
      <ChatWorkspacePage companyId={companyId} />
    </RequireAuthentication>
  );
}

function ClientArchiveRoute() {
  const { companyId } = useParams({ from: clientArchiveRoute.id });
  return (
    <RequireAuthentication>
      <ClientArchivePage companyId={companyId} />
    </RequireAuthentication>
  );
}

function ClientIssueRoute() {
  const { companyId, issueId } = useParams({ from: clientIssueRoute.id });
  return (
    <RequireAuthentication>
      <ClientIssuePage companyId={companyId} issueId={issueId} />
    </RequireAuthentication>
  );
}

function ClientNotificationsRoute() {
  const { companyId } = useParams({ from: clientNotificationsRoute.id });
  return (
    <RequireAuthentication>
      <ClientNotificationsPage companyId={companyId} />
    </RequireAuthentication>
  );
}

function ClientTeamRoute() {
  const { companyId } = useParams({ from: clientTeamRoute.id });
  return (
    <RequireAuthentication>
      <ClientTeamPage companyId={companyId} />
    </RequireAuthentication>
  );
}

function ClientBillingRoute() {
  const { companyId } = useParams({ from: clientBillingRoute.id });
  return (
    <RequireAuthentication>
      <ClientBillingPage companyId={companyId} />
    </RequireAuthentication>
  );
}

function ClientSettingsRoute() {
  const { companyId } = useParams({ from: clientSettingsRoute.id });
  return (
    <RequireAuthentication>
      <ClientSettingsPage companyId={companyId} />
    </RequireAuthentication>
  );
}

function PublisherWorkspaceRoute() {
  const { companyId } = useParams({ from: publisherWorkspaceRoute.id });
  return (
    <RequireAuthentication>
      <PublisherWorkspacePage companyId={companyId} />
    </RequireAuthentication>
  );
}

function PublisherSubscriptionRoute() {
  const { companyId, subscriptionId } = useParams({ from: publisherSubscriptionRoute.id });
  return (
    <RequireAuthentication>
      <PublisherSubscriptionPage companyId={companyId} subscriptionId={subscriptionId} />
    </RequireAuthentication>
  );
}

function PublisherIssueRoute() {
  const { companyId, issueId } = useParams({ from: publisherIssueRoute.id });
  return (
    <RequireAuthentication>
      <PublisherIssuePage companyId={companyId} issueId={issueId} />
    </RequireAuthentication>
  );
}

function PublisherTeamRoute() {
  const { companyId } = useParams({ from: publisherTeamRoute.id });
  return (
    <RequireAuthentication>
      <PublisherTeamPage companyId={companyId} />
    </RequireAuthentication>
  );
}

function PublisherSettingsRoute() {
  const { companyId } = useParams({ from: publisherSettingsRoute.id });
  return (
    <RequireAuthentication>
      <PublisherSettingsPage companyId={companyId} />
    </RequireAuthentication>
  );
}

function PlatformOperationsRoute() {
  return (
    <RequireAuthentication>
      <PlatformOperationsPage />
    </RequireAuthentication>
  );
}

function PlatformSupportRoute() {
  return (
    <RequireAuthentication>
      <PlatformSupportPage />
    </RequireAuthentication>
  );
}

const disclosureSections = {
  security: [
    ["web.security.eu.title", "web.security.eu.body"],
    ["web.security.ai.title", "web.security.ai.body"],
    ["web.security.subprocessors.title", "web.security.subprocessors.body"],
    ["web.security.access.title", "web.security.access.body"],
    ["web.security.retention.title", "web.security.retention.body"],
    ["web.security.encryption.title", "web.security.encryption.body"],
  ],
  publisher: [
    ["web.legal.publisher.content.title", "web.legal.publisher.content.body"],
    ["web.legal.publisher.delivery.title", "web.legal.publisher.delivery.body"],
    ["web.legal.publisher.commercial.title", "web.legal.publisher.commercial.body"],
  ],
  client: [
    ["web.legal.client.ai.title", "web.legal.client.ai.body"],
    ["web.legal.client.billing.title", "web.legal.client.billing.body"],
    ["web.legal.client.rights.title", "web.legal.client.rights.body"],
  ],
  processing: [
    ["web.legal.processing.roles.title", "web.legal.processing.roles.body"],
    ["web.legal.processing.providers.title", "web.legal.processing.providers.body"],
    ["web.legal.processing.support.title", "web.legal.processing.support.body"],
  ],
  privacy: [
    ["web.privacy.data.title", "web.privacy.data.body"],
    ["web.privacy.purpose.title", "web.privacy.purpose.body"],
    ["web.privacy.retention.title", "web.privacy.retention.body"],
    ["web.privacy.rights.title", "web.privacy.rights.body"],
    ["web.privacy.providers.title", "web.privacy.providers.body"],
  ],
} as const;

function DisclosurePage({
  titleId,
  introId,
  sections,
  references,
}: {
  readonly titleId: string;
  readonly introId: string;
  readonly sections: ReadonlyArray<readonly [string, string]>;
  readonly references?: ReadonlyArray<readonly [string, string]>;
}) {
  const { securityContactEmail } = useWebSecurityContext();
  return (
    <main className="mx-auto w-full max-w-3xl py-10">
      <header className="border-b border-rule pb-6">
        <h1 className="font-display text-3xl text-ink">
          <FormattedMessage id={titleId} />
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          <FormattedMessage id={introId} />
        </p>
      </header>
      {sections.map(([heading, body]) => (
        <section key={heading} className="border-b border-rule py-6">
          <h2 className="text-base font-semibold text-ink">
            <FormattedMessage id={heading} />
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            <FormattedMessage id={body} />
          </p>
        </section>
      ))}
      {references ? (
        <section className="border-b border-rule py-6">
          <h2 className="text-base font-semibold text-ink">
            <FormattedMessage id="web.references.title" />
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {references.map(([label, href]) => (
              <li key={href}>
                <a
                  className="text-accent underline-offset-4 hover:underline"
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FormattedMessage id={label} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="pt-6 text-sm text-muted">
        {securityContactEmail === null ? (
          <FormattedMessage id="web.legal.contactMissing" />
        ) : (
          <FormattedMessage id="web.legal.contact" values={{ email: securityContactEmail }} />
        )}
      </p>
    </main>
  );
}

function SecurityRoute() {
  return (
    <DisclosurePage
      titleId="web.security.title"
      introId="web.security.intro"
      sections={disclosureSections.security}
    />
  );
}

function PrivacyRoute() {
  return (
    <DisclosurePage
      titleId="web.privacy.title"
      introId="web.privacy.intro"
      sections={disclosureSections.privacy}
    />
  );
}

function PublisherTermsRoute() {
  return (
    <DisclosurePage
      titleId="web.legal.publisher.title"
      introId="web.legal.publisher.intro"
      sections={disclosureSections.publisher}
    />
  );
}

function ClientTermsRoute() {
  return (
    <DisclosurePage
      titleId="web.legal.client.title"
      introId="web.legal.client.intro"
      sections={disclosureSections.client}
    />
  );
}

function DataProcessingRoute() {
  return (
    <DisclosurePage
      titleId="web.legal.processing.title"
      introId="web.legal.processing.intro"
      sections={disclosureSections.processing}
    />
  );
}
