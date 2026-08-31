import { useEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from "react";
import { ArrowRightLeft, Globe, RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog";
import { uiMessage } from "../../lib/format";

export interface PaletteAction {
  id: string;
  label: string;
  keywords?: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  group?: string;
}
export interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}
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
export function CommandPalette({
  state,
  actions = [],
  onResetDemo,
  resetPending = false,
  title = "Command palette",
  locale = "en-US",
}: {
  state: PaletteState;
  actions?: readonly PaletteAction[];
  onResetDemo?: () => void;
  resetPending?: boolean;
  title?: string;
  locale?: string;
}) {
  const [query, setQuery] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const resolvedTitle =
    title === "Command palette" ? uiMessage(locale, "ui.commandPalette") : title;
  const labels = {
    search: uiMessage(locale, "ui.searchCommands"),
    empty: uiMessage(locale, "ui.noCommands"),
    navigate: `↑↓ ${uiMessage(locale, "ui.navigateCommands")}`,
    select: `↵ ${uiMessage(locale, "ui.selectCommand")}`,
    close: `Esc ${uiMessage(locale, "ui.close")}`,
    reset: uiMessage(locale, "ui.resetConfirmAction"),
    confirmTitle: uiMessage(locale, "ui.resetConfirmTitle"),
    confirmDescription: uiMessage(locale, "ui.resetConfirmDescription"),
    cancel: uiMessage(locale, "ui.cancel"),
  };
  const resetAction: PaletteAction | null = onResetDemo
    ? {
        id: "reset-demo",
        label: labels.reset,
        keywords: "reset identity clear",
        icon: <RotateCcw className="size-3.5" />,
        onSelect: onResetDemo,
        disabled: resetPending,
        group: uiMessage(locale, "ui.actions"),
      }
    : null;
  const all = [...actions, ...(resetAction === null ? [] : [resetAction])];
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
    if (action.id === "reset-demo") {
      setConfirmReset(true);
      return;
    }
    action.onSelect();
  };
  const confirm = () => {
    setConfirmReset(false);
    all.find((action) => action.id === "reset-demo")?.onSelect();
  };
  useEffect(() => {
    if (!state.open) {
      setQuery("");
    }
  }, [state.open]);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (state.open) {
      wasOpen.current = true;
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      state.triggerRef?.current?.focus();
    }
  }, [state.open, state.triggerRef]);
  return (
    <>
      <Dialog locale={locale} open={state.open} onOpenChange={state.setOpen}>
        <DialogContent hideClose className="top-[14vh] w-[min(94vw,36rem)] overflow-hidden p-0">
          <DialogTitle className="sr-only">{resolvedTitle}</DialogTitle>
          <Command
            listId="hartlib-command-palette-options"
            value={query}
            onValueChange={setQuery}
            onSelect={(id) => run(all.find((action) => action.id === id))}
            {...(all[0] === undefined
              ? {}
              : { defaultActiveId: `hartlib-command-palette-options-${all[0].id}` })}
          >
            <div role="search">
              <CommandInput autoFocus placeholder={labels.search} aria-label={labels.search} />
            </div>
            <CommandList aria-label={resolvedTitle}>
              <CommandEmpty>{labels.empty}</CommandEmpty>
              {groups.map(([group, groupActions]) => (
                <CommandGroup key={group || "ungrouped"} {...(group ? { heading: group } : {})}>
                  {groupActions.map((action) => (
                    <CommandItem
                      key={action.id}
                      id={`hartlib-command-palette-options-${action.id}`}
                      value={action.id}
                      keywords={`${action.label} ${action.keywords ?? ""}`}
                      disabled={action.disabled ?? false}
                    >
                      {action.icon ??
                        (action.id.includes("locale") ? (
                          <Globe className="size-3.5" aria-hidden="true" />
                        ) : action.id.includes("switch") ? (
                          <ArrowRightLeft className="size-3.5" aria-hidden="true" />
                        ) : null)}
                      <span>{action.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
          <div className="flex min-h-8 items-center gap-3 border-t border-line px-3.5 text-[11px] text-ink-2">
            <span>{labels.navigate}</span>
            <span>{labels.select}</span>
            <span>{labels.close}</span>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog locale={locale} open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent className="w-[min(92vw,28rem)]">
          <AlertDialogTitle>{labels.confirmTitle}</AlertDialogTitle>
          <AlertDialogDescription>{labels.confirmDescription}</AlertDialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              {labels.cancel}
            </Button>
            <Button variant="destructive" onClick={confirm}>
              {labels.reset}
            </Button>
          </DialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
