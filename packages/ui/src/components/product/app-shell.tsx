import { useState, type ReactNode } from "react";
import { Search } from "lucide-react";
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
}
export interface AppShellProps {
  children: ReactNode;
  locale?: string;
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

export function AppShell({
  children,
  locale = "en-US",
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
  const [view, setView] = useState<"client" | "publisher">(() =>
    clientSubnav && clientSubnav.length > 0 ? "client" : "publisher",
  );
  const hasPublisher = Boolean(publisherSubnav && publisherSubnav.length > 0);
  return (
    <div className={cn("flex min-h-dvh flex-col bg-paper", className)} data-app-shell="true">
      <a
        href="#content"
        className="sr-only z-[80] focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:inline-flex focus:h-8 focus:items-center focus:border focus:border-line-2 focus:bg-surface focus:px-3 focus:text-[13px] focus:text-ink"
      >
        {uiMessage(locale, "ui.skipToContent")}
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur-[2px]">
        <div className="mx-auto flex h-12 w-full max-w-[1440px] items-center gap-3 px-4">
          <a
            href="#content"
            className="shrink-0 font-display text-[20px] font-semibold leading-none tracking-[-.03em] text-ink"
          >
            hartlib<span className="text-accent">.</span>
          </a>
          <Button
            ref={palette.triggerRef}
            variant="secondary"
            size="md"
            onClick={() => palette.setOpen(true)}
            aria-keyshortcuts="Meta+K Control+K"
            className="ml-auto min-w-0 max-w-64 flex-1 justify-between bg-surface px-2.5 text-ink-2"
          >
            <Search aria-hidden="true" className="size-3" />
            <span className="truncate">{uiMessage(locale, "ui.search")}</span>
            <kbd
              aria-hidden="true"
              className="rounded-[1px] border border-line-2 bg-paper px-1.5 py-0.5 font-mono text-[10px]"
            >
              ⌘K
            </kbd>
          </Button>
          {actions}
          {hasPublisher && (
            <nav aria-label={uiMessage(locale, "nav.home")} className="hidden md:block">
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: "client", label: uiMessage(locale, "role.client") },
                  { value: "publisher", label: uiMessage(locale, "role.publisher") },
                ]}
              />
            </nav>
          )}
          {showLocaleSwitch && (
            <div
              role="group"
              aria-label={uiMessage(locale, "ui.language")}
              className="flex overflow-hidden rounded-tiny border border-line-2"
            >
              {(["fr-FR", "en-US"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={locale === item}
                  className={cn(
                    "h-6 px-2 font-mono text-[11px] uppercase tracking-wider",
                    locale === item ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-deep",
                    item === "fr-FR" && "border-r border-line-2",
                  )}
                  onClick={() => onLocaleChange?.(item)}
                >
                  {item === "fr-FR" ? "fr" : "en"}
                </button>
              ))}
            </div>
          )}
        </div>
        {view === "client" && clientSubnav && clientSubnav.length > 0 && (
          <nav
            aria-label={uiMessage(locale, "ui.clientNavigation")}
            className="mx-auto max-w-[1440px] overflow-x-auto px-4"
          >
            <ul className="flex items-center gap-4">
              {clientSubnav.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={item.onSelect}
                    aria-current={item.active ? "page" : undefined}
                    className={cn(
                      "relative inline-flex min-h-9 items-center pb-2 pt-1 text-[13px]",
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
          <nav
            aria-label={uiMessage(locale, "ui.publisherNavigation")}
            className="mx-auto max-w-[1440px] overflow-x-auto px-4"
          >
            <ul className="flex items-center gap-4">
              {publisherSubnav.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={item.onSelect}
                    aria-current={item.active ? "page" : undefined}
                    className={cn(
                      "relative inline-flex min-h-9 items-center pb-2 pt-1 text-[13px]",
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
      </header>
      <main
        id="content"
        tabIndex={-1}
        className="mx-auto w-full max-w-[1440px] flex-1 min-h-0 px-4 pb-16 pt-5 outline-none"
      >
        {children}
      </main>
      <CommandPalette
        state={palette}
        locale={locale}
        actions={paletteActions}
        {...(onResetDemo === undefined ? {} : { onResetDemo })}
        {...(resetPending === undefined ? {} : { resetPending })}
      />
    </div>
  );
}
