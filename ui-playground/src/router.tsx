import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useParams,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { AnnounceProvider } from "@/lib/announce";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/overlays";
import { I18nProvider, type Locale } from "@/i18n";
import { AppShell } from "@/components/product/app-shell";
import { PublisherPage } from "@/pages/publisher";
import { IssueNewPage } from "@/pages/publisher-issue-new";
import { NotificationSettingsPage } from "@/pages/publisher-notifications";
import { ClientChatPage } from "@/pages/client-chat";
import { GalleryPage } from "@/pages/gallery";

function RootLayout() {
  return (
    <AnnounceProvider>
      <ToastProvider>
        <TooltipProvider delayDuration={320}>
          <Outlet />
        </TooltipProvider>
      </ToastProvider>
    </AnnounceProvider>
  );
}

/** Branded fallback for unmatched URLs (replaces the stock “404 Not Found”). */
function NotFound() {
  return (
    <main id="content" className="mx-auto flex min-h-dvh max-w-xl flex-col items-start justify-center px-6">
      <p className="caps-label text-accent">Erreur 404 · Error 404</p>
      <h1 className="mt-2 font-display text-[28px] leading-tight font-medium text-ink">
        Cette page n’existe pas. <span className="text-ink-2">This page doesn’t exist.</span>
      </h1>
      <p className="mt-3 max-w-md text-[13.5px] leading-relaxed text-ink-2">
        Vérifiez l’adresse ou repartez de l’accueil. Check the address, or start again from the home view.
      </p>
      <div className="mt-5 flex gap-3 font-mono text-[12px]">
        <a href="/fr/client/chat" className="text-accent underline underline-offset-4 hover:text-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          fr → Consultation
        </a>
        <a href="/en/client/chat" className="text-accent underline underline-offset-4 hover:text-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          en → Consultation
        </a>
      </div>
    </main>
  );
}
const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: NotFound });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    // Stored locale only seeds the bare-root redirect; explicit /fr|/en URLs always win.
    let stored: string | null = null;
    try { stored = JSON.parse(window.localStorage.getItem("bref.locale") ?? "null"); } catch { /* ignore */ }
    const locale = stored === "en" ? "en" : "fr";
    throw redirect({ to: "/$locale/client/chat", params: { locale }, replace: true });
  },
});

const str = (v: unknown, fallback?: string) => (typeof v === "string" ? v : fallback);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const localeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$locale",
  beforeLoad: ({ params }) => {
    if (params.locale !== "fr" && params.locale !== "en") {
      throw redirect({ to: "/$locale/client/chat", params: { locale: "fr" }, replace: true });
    }
  },
  component: LocaleLayout,
});

const localeIndexRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$locale/client/chat", params, replace: true });
  },
});

const publisherRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: "publisher",
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: str(search.tab, "sources"),
  }),
  component: PublisherPage,
});

const issueNewRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: "publisher/issues/new",
  component: IssueNewPage,
});

const notificationSettingsRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: "publisher/settings/notifications",
  component: NotificationSettingsPage,
});

const clientChatRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: "client/chat",
  validateSearch: (search: Record<string, unknown>): { memory?: string; rev?: number; subscription?: string; issue?: string } => ({
    memory: str(search.memory),
    rev: num(search.rev),
    subscription: str(search.subscription),
    issue: str(search.issue),
  }),
  component: ClientChatPage,
});

const galleryRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: "components",
  component: GalleryPage,
});

function LocaleLayout() {
  const { locale } = useParams({ from: localeRoute.id });
  const location = useLocation();
  const navigate = useNavigate();

  const setLocale = useCallback(
    (next: Locale) => {
      const target = location.pathname.replace(/^\/(fr|en)(\/|$)/, `/${next}$2`);
      void navigate({ to: target || `/${next}`, search: (prev) => prev as never });
    },
    [location.pathname, navigate],
  );

  return (
    <I18nProvider locale={locale as Locale} onLocaleChange={setLocale}>
      <AppShell>
        <Outlet />
      </AppShell>
    </I18nProvider>
  );
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  localeRoute.addChildren([
    localeIndexRoute,
    publisherRoute,
    issueNewRoute,
    notificationSettingsRoute,
    clientChatRoute,
    galleryRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
