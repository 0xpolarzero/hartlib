import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { ArrowRightLeft, Globe, LayoutGrid, MessageSquarePlus, Newspaper, PlusCircle, RotateCcw, Settings2 } from "lucide-react";
import { useI18n } from "@/i18n";
import { api } from "@/services";
import {
  Dialog, DialogContent, DialogTitle, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, Kbd,
} from "@/components/ui";

export interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export function useCommandPalette(): PaletteState {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return useMemo<PaletteState>(() => ({ open, setOpen }), [open]);
}

/**
 * ⌘K palette: search over pages and actions (cmdk combobox pattern — the
 * input owns aria-activedescendant; options respond to arrows/Enter/Esc).
 */
export function CommandPalette({ state }: { state: PaletteState }) {
  const { locale, t, setLocale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const isPublisher = location.pathname.includes("/publisher");
  const workspaceLabel = isPublisher ? t("palette.switchToSubscriber") : t("palette.switchToPublisher");
  const workspacePath = isPublisher ? `/${locale}/client/chat` : `/${locale}/publisher`;
  const targetLocale = locale === "fr" ? "en" : "fr";
  const localeLabel = targetLocale === "fr" ? t("palette.switchToFrench") : t("palette.switchToEnglish");

  const go = (to: string) => {
    state.setOpen(false);
    void navigate({ to });
  };

  const resetDemo = () => {
    state.setOpen(false);
    api.resetOverrides();
    window.location.reload();
  };

  return (
    <Dialog open={state.open} onOpenChange={state.setOpen}>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        className="top-[14vh] w-[min(94vw,36rem)] overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{t("palette.title")}</DialogTitle>
        <Command label={t("palette.title")} loop className="outline-none">
          <CommandInput placeholder={t("palette.placeholder")} aria-label={t("palette.placeholder")} />
          <CommandList>
            <CommandEmpty>{t("palette.empty")}</CommandEmpty>

            <CommandGroup heading={t("palette.pages")}>
              <CommandItem value={`${t("nav.chat")} consultation chat archives questions`} onSelect={() => go(`/${locale}/client/chat`)}>
                <MessageSquarePlus />
                {t("nav.chat")}
                <Kbd className="ml-auto">1</Kbd>
              </CommandItem>
              <CommandItem value={`${t("nav.archive")} publications livrées archive client`} onSelect={() => go(`/${locale}/client`)}>
                <Newspaper />
                {t("nav.archive")}
                <Kbd className="ml-auto">2</Kbd>
              </CommandItem>
              <CommandItem value={`${t("nav.newIssue")} créer numéro planifier publisher`} onSelect={() => go(`/${locale}/publisher/issues/new`)}>
                <PlusCircle />
                {t("nav.newIssue")}
              </CommandItem>
              <CommandItem value={`${t("nav.memories")} mémoires souvenirs memories`} onSelect={() => go(`/${locale}/client/memories`)}>
                <Settings2 />
                {t("nav.memories")}
              </CommandItem>
              <CommandItem value={`${t("nav.settings")} notifications paramètres settings`} onSelect={() => go(`/${locale}/publisher/settings/notifications`)}>
                <Settings2 />
                {t("nav.settings")}
              </CommandItem>
              <CommandItem value={`${t("nav.gallery")} components composants gallery demo`} onSelect={() => go(`/${locale}/components`)}>
                <LayoutGrid />
                {t("nav.gallery")}
              </CommandItem>
            </CommandGroup>

            <CommandGroup heading={t("palette.actions")}>
              <CommandItem
                value={`${workspaceLabel} publisher subscriber éditeur abonné`}
                onSelect={() => go(workspacePath)}
              >
                <ArrowRightLeft />
                {workspaceLabel}
              </CommandItem>
              <CommandItem
                value={`${localeLabel} english français language langue`}
                onSelect={() => {
                  state.setOpen(false);
                  setLocale(targetLocale);
                }}
              >
                <Globe />
                {localeLabel}
              </CommandItem>
              <CommandItem value={`${t("palette.reset")} reset demo données demonstration`} onSelect={resetDemo}>
                <RotateCcw />
                {t("palette.reset")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
          <div className="flex min-h-8 items-center gap-3 border-t border-line px-3.5 text-[11px] text-ink-2">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> {t("palette.navigate")}</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd> {t("palette.select")}</span>
            <span className="flex items-center gap-1"><Kbd>esc</Kbd> {t("palette.close")}</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
