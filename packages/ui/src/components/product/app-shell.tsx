import { useMemo, useState, type ReactNode } from "react";
import { ArrowRightLeft, Globe, MessageSquare, Search } from "lucide-react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
import { Button } from "../ui/button";
import { Segmented } from "../ui/tabs";
import { CommandPalette, useCommandPalette, type PaletteAction } from "./command-palette";

export interface PublisherSubnavItem {
  id: string;
  label: string;
  active?: boolean;
  onSelect?: () => void;
  /** Replaces the reference TanStack link target with plain href data. */
  href?: string;
}
export interface AppShellProps {
  children: ReactNode;
  locale?: string;
  initialView?: "client" | "publisher";
  onLocaleChange?: (locale: string) => void;
  showLocaleSwitch?: boolean;
  clientSubnav?: readonly PublisherSubnavItem[];
  publisherSubnav?: readonly PublisherSubnavItem[];
  actions?: ReactNode;
  paletteActions?: readonly PaletteAction[];
  onResetDemo?: () => void;
  resetPending?: boolean;
  className?: string;
}

/**
 * App shell (reference tree): skip link, top bar (wordmark, command search,
 * publisher actions, workspace switcher, locale switcher), contextual
 * subnavigation, and the main landmark. Focus rings come from the global
 * :focus-visible token. Locale and navigation are prop-driven: the caller
 * owns the locale, the routes, and every nav/palette action.
 */
export function AppShell({
  children,
  locale = "en-US",
  initialView,
  onLocaleChange,
  showLocaleSwitch = true,
  clientSubnav,
  publisherSubnav,
  actions,
  paletteActions = [],
  onResetDemo,
  resetPending,
  className,
}: AppShellProps) {
  const palette = useCommandPalette();
  const [view, setView] = useState<"client" | "publisher">(
    initialView ?? (clientSubnav && clientSubnav.length > 0 ? "client" : "publisher"),
  );
  const hasClient = Boolean(clientSubnav && clientSubnav.length > 0);
  const hasPublisher = Boolean(publisherSubnav && publisherSubnav.length > 0);
  const paletteItems = useMemo(() => {
    const supplied = new Map(paletteActions.map((action) => [action.id, action]));
    const isFrench = locale === "fr" || locale === "fr-FR";
    const openChat = supplied.get("client-chat");
    const localeAction = supplied.get(isFrench ? "locale-en" : "locale-fr");
    const items: PaletteAction[] = [];
    if (openChat) {
      items.push({
        ...openChat,
        id: "client-chat",
        label: "Consultation",
        keywords: `${openChat.keywords ?? ""} consultation archives questions`,
        icon: <MessageSquare aria-hidden="true" className="size-3.5 text-ink-2" />,
        ariaLabel: "Consultation",
        hint: "1",
        group: "Pages",
      });
    }
    if (hasClient && hasPublisher) {
      items.push({
        id: "switch-workspace",
        label: isFrench ? "Passer à l’espace éditeur" : "Switch to publisher",
        keywords: "publisher subscriber éditeur abonné workspace",
        icon: <ArrowRightLeft aria-hidden="true" className="size-3.5 text-ink-2" />,
        onSelect: () => setView("publisher"),
        group: uiMessage(locale, "ui.actions"),
      });
    }
    if (localeAction || onLocaleChange) {
      const targetLocale = isFrench ? "en-US" : "fr-FR";
      items.push({
        id: "switch-locale",
        label: isFrench ? "Passer en anglais" : "Switch to French",
        keywords: "locale language english français anglais langue",
        icon: <Globe aria-hidden="true" className="size-3.5 text-ink-2" />,
        ariaLabel:
          localeAction?.ariaLabel ??
          uiMessage(locale, isFrench ? "ui.languageEnglish" : "ui.languageFrench"),
        onSelect: localeAction?.onSelect ?? (() => onLocaleChange?.(targetLocale)),
        group: uiMessage(locale, "ui.actions"),
      });
    }
    items.push(
      ...paletteActions.filter(
        (action) =>
          ![
            "client-chat",
            "switch-workspace",
            "switch-locale",
            "locale-fr",
            "locale-en",
            "reset-demo",
          ].includes(action.id),
      ),
    );
    return items;
  }, [hasClient, hasPublisher, locale, onLocaleChange, paletteActions]);
  const showWorkspaceSwitch = hasPublisher || paletteActions.length > 0;
  const galleryNav = publisherSubnav?.find((item) => item.id === "gallery");
  return (
    <div
      className={cn("flex min-h-dvh flex-col bg-paper", className)}
      data-app-shell="true"
      data-shell-view={view}
    >
      <a
        href="#content"
        className="sr-only z-[80] focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:inline-flex focus:h-8 focus:items-center focus:rounded-tiny focus:border focus:border-line-2 focus:bg-surface focus:px-3 focus:text-[13px] focus:text-ink focus:outline-2 focus:outline-offset-2 focus:outline-accent"
      >
        {uiMessage(locale, "ui.skipToContent")}
      </a>

      <header className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur-[2px]">
        <div className="mx-auto flex h-12 max-w-[1440px] items-center gap-3 px-4">
          <a
            href="#content"
            className="shrink-0 font-display text-[20px] font-semibold leading-none tracking-[-0.03em] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            hartlib
          </a>

          <Button
            ref={palette.triggerRef}
            variant="secondary"
            size="md"
            onClick={() => palette.setOpen(true)}
            aria-keyshortcuts="Meta+K Control+K"
            className="ml-auto min-w-0 max-w-64 flex-1 justify-between bg-surface px-2.5 text-ink-2 opacity-75 hover:bg-paper-deep/60"
          >
            <Search aria-hidden="true" className="!size-3 overflow-visible" />
            <span
              aria-hidden="true"
              className="shrink-0 rounded-[1px] border border-line-2 bg-paper px-1.5 py-0.5 font-mono text-[10px] font-normal leading-none tracking-wide text-ink-2"
            >
              ⌘K
            </span>
            <span className="sr-only">{uiMessage(locale, "ui.searchCommands")}</span>
          </Button>

          <div className="flex shrink-0 items-center gap-1.5">
            {hasPublisher && view === "publisher" && actions}

            {showWorkspaceSwitch && (
              <nav aria-label={uiMessage(locale, "nav.home")} className="hidden md:block">
                <Segmented
                  aria-label={uiMessage(locale, "nav.home")}
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "publisher", label: uiMessage(locale, "role.publisher") },
                    { value: "client", label: uiMessage(locale, "ui.subscriber") },
                  ]}
                />
              </nav>
            )}

            {showLocaleSwitch && (
              <div
                role="group"
                aria-label={uiMessage(locale, "ui.language")}
                className="flex items-center overflow-hidden rounded-tiny border border-line-2"
              >
                {(["fr-FR", "en-US"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={locale === item}
                    onClick={() => onLocaleChange?.(item)}
                    className={cn(
                      "h-6 px-2 font-mono text-[11px] uppercase tracking-wider transition-colors duration-100",
                      locale === item
                        ? "bg-ink text-paper"
                        : "text-ink-2 hover:bg-paper-deep hover:text-ink",
                      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                      item === "fr-FR" ? "border-r border-line-2" : "",
                    )}
                  >
                    {item === "fr-FR" ? "fr" : "en"}
                    <span className="sr-only">
                      {" "}
                      —{" "}
                      {item === "fr-FR"
                        ? uiMessage(locale, "ui.languageFrench")
                        : uiMessage(locale, "ui.languageEnglish")}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {view === "client" && clientSubnav && clientSubnav.length > 0 && (
          <nav aria-label={uiMessage(locale, "ui.clientNavigation")} className="sr-only">
            <ul className="flex items-center gap-4">
              {clientSubnav.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={item.onSelect}
                    aria-current={item.active ? "page" : undefined}
                    className={cn(
                      "relative inline-flex min-h-9 items-center pb-2 pt-1 text-[13px] transition-colors duration-100",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                      item.active
                        ? "font-medium text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-accent"
                        : "text-ink-2 hover:text-ink",
                    )}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {view === "publisher" && publisherSubnav && publisherSubnav.length > 0 && (
          <div className="mx-auto max-w-[1440px] px-4">
            <nav aria-label={uiMessage(locale, "ui.publisherNavigation")}>
              <ul className="flex items-center gap-4 overflow-x-auto">
                {publisherSubnav
                  .filter((item) => item.id !== "gallery")
                  .map((item) =>
                    item.href ? (
                      <li key={item.id}>
                        <a
                          href={item.href}
                          aria-current={item.active ? "page" : undefined}
                          className={cn(
                            "relative inline-flex min-h-9 items-center pb-2 pt-1 text-[13px] transition-colors duration-100",
                            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                            item.active
                              ? "font-medium text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-accent"
                              : "text-ink-2 hover:text-ink",
                          )}
                        >
                          {item.label}
                        </a>
                      </li>
                    ) : (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={item.onSelect}
                          aria-current={item.active ? "page" : undefined}
                          className={cn(
                            "relative inline-flex min-h-9 items-center pb-2 pt-1 text-[13px] transition-colors duration-100",
                            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                            item.active
                              ? "font-medium text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-accent"
                              : "text-ink-2 hover:text-ink",
                          )}
                        >
                          {item.label}
                        </button>
                      </li>
                    ),
                  )}
                {galleryNav && (
                  <li className="ml-auto hidden py-1 lg:block">
                    <a
                      href={galleryNav.href ?? "#"}
                      onClick={galleryNav.onSelect}
                      className="font-mono text-[11px] tracking-wide text-ink-2 underline-offset-2 transition-colors duration-100 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {galleryNav.label}
                    </a>
                  </li>
                )}
              </ul>
            </nav>
          </div>
        )}
      </header>

      <main
        id="content"
        tabIndex={-1}
        className={cn(
          "mx-auto w-full max-w-[1440px] flex-1 outline-none",
          view === "client" ? "min-h-0 px-4 pt-5" : "px-4 pb-16 pt-5",
        )}
      >
        {children}
      </main>

      <CommandPalette
        state={palette}
        locale={locale}
        actions={paletteItems}
        searchPlaceholder={
          locale === "fr" || locale === "fr-FR"
            ? "Rechercher une page ou une action…"
            : "Search pages and actions…"
        }
        resetLabel={
          locale === "fr" || locale === "fr-FR"
            ? "Réinitialiser les données de démonstration"
            : "Reset demo data"
        }
        {...(onResetDemo === undefined ? {} : { onResetDemo })}
        {...(resetPending === undefined ? {} : { resetPending })}
      />
    </div>
  );
}
