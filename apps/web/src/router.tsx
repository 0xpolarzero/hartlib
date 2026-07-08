import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
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
  type Market,
  FormattedMessage,
  I18nProvider,
  htmlLang,
  isLocale,
  useIntl,
  useLocale,
  LOCALE_MARKET_ALIASES,
} from "@brief/i18n";
import { ArtifactFrame, Button } from "@brief/ui";

import { AppShell } from "@/components/layout/app-shell";
import { queryClient } from "@/lib/query-client";
import { setStoredLocale, setStoredMarket } from "@/locale-bootstrap";

type RouterContext = {
  queryClient: QueryClient;
};

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

/**
 * Layout route for the locale segment (`/$locale`). Validates the segment in
 * `beforeLoad`: aliases (`fr`/`us`) resolve to their canonical locale, and
 * anything that isn't a real locale redirects to the default locale.
 */
const localeLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$locale",
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

const routeTree = rootRoute.addChildren([localeLayoutRoute.addChildren([indexRoute, chatRoute])]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function RootLayout() {
  // The active locale param is read reactively from the locale layout route.
  // `beforeLoad` on the locale layout route guarantees the segment is a valid
  // locale, so narrow the `string` param to `Locale` here.
  const params = useParams({ from: localeLayoutRoute.id });
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const navigate = useNavigate({ from: localeLayoutRoute.id });
  const location = useLocation();

  // Market is coupled to the locale by default.
  const market: Market = DEFAULT_MARKET_FOR_LOCALE[locale];

  // Keep `<html lang>` in sync with the live locale param so it stays correct
  // for client-side navigation (not just full reloads / switcher changes).
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = htmlLang(locale);
    }
  }, [locale]);

  function handleChangeLocaleMarket(next: LocaleMarketPair) {
    setStoredLocale(next.locale);
    setStoredMarket(next.market);
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
  const locale = useLocale();
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-10">
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

      <div className="flex gap-3">
        <Button asChild>
          <a href={`/${locale}/chat/demo`}>
            <FormattedMessage id="web.home.openChat" />
          </a>
        </Button>
      </div>
    </section>
  );
}

function ChatRoute() {
  const intl = useIntl();
  const artifactTitle = intl.formatMessage({ id: "web.artifact.title" });
  return (
    <section className="grid min-h-[calc(100vh-8rem)] gap-4 py-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex min-h-[32rem] flex-col rounded-sm border border-rule bg-paper">
        <div className="border-b border-rule px-4 py-3">
          <h1 className="text-sm font-medium">
            <FormattedMessage id="web.chat.title" />
          </h1>
        </div>
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted">
          <FormattedMessage id="web.chat.placeholder" />
        </div>
      </div>

      <ArtifactFrame title={artifactTitle} html={sampleArtifactHtml} className="min-h-[32rem]" />
    </section>
  );
}

const sampleArtifactHtml = `
  <main style="font-family: 'IBM Plex Sans', ui-sans-serif, system-ui; padding: 24px;">
    <p style="font-size: 12px; color: #64748b; margin: 0 0 8px;">Artifact</p>
    <h1 style="font-size: 24px; margin: 0 0 12px;">Issue timeline placeholder</h1>
    <p style="line-height: 1.6; color: #334155;">
      AI-generated HTML artifacts will render in this sandbox.
    </p>
  </main>
`;
