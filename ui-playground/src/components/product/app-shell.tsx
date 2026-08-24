import { type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Languages, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n, type Locale } from "@/i18n";
import { writePersisted } from "@/lib/storage";
import { Button, Segmented } from "@/components/ui";
import { CommandPalette, useCommandPalette } from "./command-palette";
import { NotificationBell } from "./notification-bell";

/**
 * App shell: skip link, top bar (wordmark, command search, notification bell
 * on publisher views, workspace switcher, locale switcher), contextual nav,
 * and the main landmark. Focus rings come from the global :focus-visible token.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { locale, t, setLocale } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const palette = useCommandPalette();

  const isPublisher = location.pathname.includes("/publisher");
  const view: "publisher" | "client" = isPublisher ? "publisher" : "client";

  const navItems =
    view === "publisher"
      ? [
          { key: "sources", label: t("nav.sources"), to: "/$locale/publisher", params: { locale }, active: location.pathname.endsWith("/publisher") },
          { key: "new-issue", label: t("nav.newIssue"), to: "/$locale/publisher/issues/new", params: { locale }, active: location.pathname.includes("/issues/new") },
          { key: "settings", label: t("nav.settings"), to: "/$locale/publisher/settings/notifications", params: { locale }, active: location.pathname.includes("/settings") },
        ]
      : [
          { key: "chat", label: t("nav.chat"), to: "/$locale/client/chat", params: { locale }, active: location.pathname.includes("/client/chat") },
          { key: "archive", label: t("nav.archive"), to: "/$locale/client", params: { locale }, active: location.pathname.endsWith("/client") },
          { key: "memories", label: t("nav.memories"), to: "/$locale/client/memories", params: { locale }, active: location.pathname.includes("/memories") },
        ];

  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <a
        href="#content"
        className="sr-only z-[80] focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:inline-flex focus:h-8 focus:items-center focus:rounded-tiny focus:border focus:border-line-2 focus:bg-surface focus:px-3 focus:text-[13px] focus:text-ink focus:outline-2 focus:outline-offset-2 focus:outline-accent"
      >
        {t("shell.skipToContent")}
      </a>

      <header className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur-[2px]">
        <div className="mx-auto flex h-12 max-w-[1440px] items-center gap-3 px-4">
          <Link
            to="/$locale/client/chat"
            params={{ locale }}
            className="shrink-0 font-display text-[20px] font-semibold leading-none tracking-[-0.03em] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t("shell.tagline")}
          </Link>

          <Button
            variant="secondary"
            size="md"
            onClick={() => palette.setOpen(true)}
            aria-keyshortcuts="Meta+K Control+K"
            className="mx-auto min-w-0 max-w-md flex-1 justify-between bg-surface px-2.5 text-ink-2 hover:bg-paper-deep/60"
          >
            <Search aria-hidden="true" />
            <span
              aria-hidden="true"
              className="shrink-0 rounded-[1px] border border-line-2 bg-paper px-1.5 py-0.5 font-mono text-[10px] font-normal leading-none tracking-wide text-ink-2"
            >
              ⌘K
            </span>
            <span className="sr-only">{t("palette.open")}</span>
          </Button>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {view === "publisher" && <NotificationBell />}

            <nav aria-label={t("shell.workspace")} className="hidden md:block">
              <Segmented
                aria-label={t("shell.workspace")}
                value={view}
                onChange={(next) => {
                  void navigate({
                    to: next === "publisher" ? "/$locale/publisher" : "/$locale/client/chat",
                    params: { locale },
                  });
                }}
                options={[
                  { value: "publisher", label: t("shell.publisherView") },
                  { value: "client", label: t("shell.clientView") },
                ]}
              />
            </nav>

            <div
              role="group"
              aria-label={t("shell.locale")}
              className="flex items-center overflow-hidden rounded-tiny border border-line-2"
            >
              {(["fr", "en"] as Locale[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={locale === l}
                  onClick={() => {
                    writePersisted("locale", l);
                    setLocale(l);
                  }}
                  className={cn(
                    "h-6 px-2 font-mono text-[11px] uppercase tracking-wider transition-colors duration-100",
                    locale === l ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-deep hover:text-ink",
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                    l === "fr" ? "border-r border-line-2" : "",
                  )}
                >
                  {l}
                  <span className="sr-only"> — {l === "fr" ? "français" : "English"}</span>
                </button>
              ))}
              <Languages aria-hidden="true" className="mx-1.5 hidden size-3 text-ink-2 sm:block" />
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-[1440px] px-4">
          <nav aria-label={view === "publisher" ? t("nav.publisherGroup") : t("nav.clientGroup")}>
            <ul className="flex items-center gap-4 overflow-x-auto">
              {navItems.map((item) => (
                <li key={item.key}>
                  <Link
                    to={item.to}
                    params={item.params}
                    search={item.key === "sources" ? { tab: undefined } : undefined}
                    aria-current={item.active ? "page" : undefined}
                    className={cn(
                      "relative inline-flex min-h-9 items-center pb-2 pt-1 text-[13px] transition-colors duration-100",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                      item.active ? "font-medium text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-accent" : "text-ink-2 hover:text-ink",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
              <li className="ml-auto hidden py-1 lg:block">
                <Link
                  to="/$locale/components"
                  params={{ locale }}
                  className="font-mono text-[11px] tracking-wide text-ink-2 underline-offset-2 transition-colors duration-100 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {t("nav.gallery")}
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main id="content" tabIndex={-1} className="mx-auto w-full max-w-[1440px] flex-1 px-4 pb-16 pt-5 outline-none">
        {children}
      </main>

      <CommandPalette state={palette} />
    </div>
  );
}
