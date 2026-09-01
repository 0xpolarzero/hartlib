import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Command } from "cmdk";
import { ArrowRightLeft, Globe, RotateCcw } from "lucide-react";
import { Kbd } from "../ui/atoms";
import { CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { uiMessage } from "../../lib/format";

export interface PaletteAction {
  id: string;
  label: string;
  ariaLabel?: string;
  keywords?: string;
  icon?: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  group?: string;
}
export interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/*
 * Publisher, gallery, and settings routes are intentionally dormant in the
 * product. Keep a caller-provided action from exposing one of those routes in
 * the shared palette, even when a fixture or stale caller supplies it.
 */
const isReachablePaletteAction = (action: PaletteAction): boolean => {
  const searchable = `${action.id} ${action.label} ${action.keywords ?? ""}`;
  return !/(?:publisher|éditeur|editeur|gallery|galerie|component|composant|settings|paramètre|parametre|notification|issue|numéro|numero)/iu.test(
    searchable,
  );
};

export function useCommandPalette(): PaletteState {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return useMemo(() => ({ open, setOpen, triggerRef }), [open]);
}

/**
 * ⌘K palette (reference cmdk combobox pattern — the input owns
 * aria-activedescendant; options respond to arrows/Enter/Esc). Page and
 * action entries are prop-driven callbacks; reset stays destructive and is
 * the only product entry for it.
 */
export function CommandPalette({
  state,
  actions = [],
  onResetDemo,
  resetPending = false,
  title = "Command palette",
  locale = "en-US",
  searchPlaceholder,
  resetLabel,
}: {
  state: PaletteState;
  actions?: readonly PaletteAction[];
  onResetDemo?: () => void;
  resetPending?: boolean;
  title?: string;
  locale?: string;
  searchPlaceholder?: string;
  resetLabel?: string;
}) {
  const resolvedTitle =
    title === "Command palette" ? uiMessage(locale, "ui.commandPalette") : title;
  const labels = {
    search: searchPlaceholder ?? uiMessage(locale, "ui.searchCommands"),
    empty: uiMessage(locale, "ui.noCommands"),
    navigate: uiMessage(locale, "ui.navigateCommands"),
    select: uiMessage(locale, "ui.selectCommand"),
    close: uiMessage(locale, "ui.close"),
    reset: resetLabel ?? uiMessage(locale, "ui.resetConfirmAction"),
    resetAria: uiMessage(locale, "ui.resetConfirmAction"),
  };
  const resetAction: PaletteAction | null = onResetDemo
    ? {
        id: "reset-demo",
        label: labels.reset,
        ariaLabel: labels.resetAria,
        keywords: "reset identity clear",
        icon: <RotateCcw />,
        onSelect: onResetDemo,
        disabled: resetPending,
        group: uiMessage(locale, "ui.actions"),
      }
    : null;
  const all = useMemo(() => {
    const next = actions.filter(
      (action) =>
        isReachablePaletteAction(action) && (resetAction === null || action.id !== resetAction.id),
    );
    if (resetAction !== null) next.push(resetAction);
    return next;
  }, [actions, resetAction]);
  const groups = useMemo(() => {
    const grouped = new Map<string, PaletteAction[]>();
    for (const action of all) {
      const key = action.group ?? "";
      const current = grouped.get(key) ?? [];
      current.push(action);
      grouped.set(key, current);
    }
    return [...grouped.entries()];
  }, [all]);
  const run = (action: PaletteAction | undefined) => {
    if (!action || action.disabled) return;
    state.setOpen(false);
    action.onSelect();
  };
  return (
    <Dialog open={state.open} onOpenChange={state.setOpen}>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        className="top-[14vh] w-[min(94vw,36rem)] overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{resolvedTitle}</DialogTitle>
        <Command label={resolvedTitle} loop className="outline-none">
          <CommandInput placeholder={labels.search} aria-label={labels.search} />
          <CommandList aria-label={resolvedTitle}>
            <CommandEmpty>{labels.empty}</CommandEmpty>
            {groups.map(([group, groupActions]) => (
              <CommandGroup key={group || "ungrouped"} heading={group || undefined}>
                {groupActions.map((action) => (
                  <CommandItem
                    key={action.id}
                    value={`${action.label} ${action.keywords ?? ""}`.trim()}
                    onSelect={() => run(action)}
                    aria-label={action.ariaLabel}
                    disabled={action.disabled ?? false}
                  >
                    {action.icon ??
                      (action.id.includes("locale") ? (
                        <Globe aria-hidden="true" />
                      ) : action.id.includes("switch") ? (
                        <ArrowRightLeft aria-hidden="true" />
                      ) : null)}
                    <span>{action.label}</span>
                    {action.hint !== undefined && <Kbd className="ml-auto">{action.hint}</Kbd>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <div className="flex min-h-8 items-center gap-3 border-t border-line px-3.5 text-[11px] text-ink-2">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> {labels.navigate}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> {labels.select}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> {labels.close}
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
