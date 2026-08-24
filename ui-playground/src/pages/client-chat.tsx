import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BookOpen, Brain, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { usePersistedState } from "@/lib/storage";
import { Button, Segmented, Switch, Tooltip } from "@/components/ui";
import { ClientPublicationsTable } from "@/components/product/tables";
import { ChatProvider, useChat } from "@/components/product/chat/chat-store";
import { MemoriesPanel } from "@/components/product/chat/memories-panel";
import { Transcript } from "@/components/product/chat/transcript";
import { Composer } from "@/components/product/chat/composer";
import { VizPane } from "@/components/product/chat/viz-pane";
import { DebugDrawerHost } from "@/components/product/chat/debug-drawer";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

/** Subscriber chat: one persistent conversation with two reflowing side panels. */
export function ClientChatPage() {
  return (
    <ChatProvider>
      <ChatSurface />
    </ChatProvider>
  );
}

function ChatSurface() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { memory?: string; rev?: number };
  const chat = useChat();
  const [mobileTab, setMobileTab] = useState<"conversation" | "visual">("conversation");
  const [publicationsOpen, setPublicationsOpen] = usePersistedState("chat.publicationsOpen", false);
  const [memoriesOpen, setMemoriesOpen] = usePersistedState("chat.memoriesOpen", false);
  const [sizes, setSizes] = usePersistedState<number[]>("chat.panels", [62, 38]);

  useEffect(() => {
    if (!search.memory) return;
    chat.openMemoryRevision({ id: search.memory, revision: search.rev ?? 1 });
    void navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, memory: undefined, rev: undefined })) as never, replace: true });
    // A citation or a deep link opens the independent memories panel.
    setMemoriesOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.memory]);

  useEffect(() => {
    if (chat.memoryFocus) setMemoriesOpen(true);
  }, [chat.memoryFocus, setMemoriesOpen]);

  // “Show” request from an answer referencing the visual: switch to the tab below lg.
  useEffect(() => {
    if (chat.showVizRequest > 0) setMobileTab("visual");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.showVizRequest]);

  const leftColumn = publicationsOpen ? "minmax(18rem, 20rem)" : "2.75rem";
  const rightColumn = memoriesOpen ? "minmax(18rem, 20rem)" : "2.75rem";

  return (
    <div className="-mx-4 -mt-5 h-[calc(100dvh-52px)] min-h-0 overflow-hidden">
      <div
        className="subscriber-chat-layout h-full min-h-0"
        style={{
          "--subscriber-left-column": leftColumn,
          "--subscriber-right-column": rightColumn,
        } as React.CSSProperties}
      >
        <SidePanel
          side="left"
          id="publications-panel"
          label={t("panels.publications")}
          open={publicationsOpen}
          onOpenChange={setPublicationsOpen}
          icon={<BookOpen aria-hidden="true" className="size-4" />}
          openIcon={<PanelLeftClose aria-hidden="true" className="size-3.5" />}
          closedIcon={<PanelLeftOpen aria-hidden="true" className="size-4" />}
          closeLabel={t("panels.closePublications")}
          openLabel={t("panels.openPublications")}
        >
          <div className="grid gap-3 p-3">
            <p className="text-[12px] leading-relaxed text-ink-2">{t("panels.publicationsDescription")}</p>
            <div className="publications-panel-table">
              <ClientPublicationsTable />
            </div>
          </div>
        </SidePanel>

        <section aria-labelledby="chat-heading" className="subscriber-chat-main flex min-h-0 min-w-0 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
            <h1 id="chat-heading" className="truncate font-display text-[15px] font-medium text-ink">{t("chat.title")}</h1>
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden items-center gap-1.5 sm:flex">
                <Switch
                  id="owner-tools"
                  checked={chat.ownerTools}
                  onCheckedChange={chat.setOwnerTools}
                  aria-label={t("chat.ownerTools")}
                />
                <label htmlFor="owner-tools" className="font-mono text-[11px] text-ink-2">
                  {t("chat.ownerTools")}
                </label>
              </span>
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            {/* Below lg: conversation / visualization switch stays local to the chat. */}
            <div className="flex min-h-0 flex-1 flex-col lg:hidden">
              <div className="flex justify-center border-b border-line px-4 py-1.5">
                <Segmented
                  aria-label={t("chat.panes")}
                  value={mobileTab}
                  onChange={setMobileTab}
                  options={[
                    { value: "conversation", label: t("chat.tabConversation") },
                    { value: "visual", label: t("chat.tabVisual") },
                  ]}
                />
              </div>
              <div className={cn("flex min-h-0 flex-1 flex-col", mobileTab !== "conversation" && "hidden")}>
                <Transcript />
                <Composer />
              </div>
              <div className={cn("min-h-0 flex-1", mobileTab !== "visual" && "hidden")}>
                <VizPane />
              </div>
            </div>

            {/* lg+: resizable chat | visualization split. */}
            <div className="hidden min-h-0 flex-1 lg:block">
              <PanelGroup direction="horizontal" onLayout={(layout) => setSizes(layout)}>
                <Panel defaultSize={sizes[0] ?? 62} minSize={30}>
                  <div className="flex h-full min-h-0 flex-col">
                    <Transcript />
                    <Composer />
                  </div>
                </Panel>
                <PanelResizeHandle className="group relative flex w-1.5 items-stretch justify-center outline-none" aria-label={t("chat.divider")}>
                  <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors duration-100 group-hover:bg-accent group-data-[resize-handle-state=drag]:bg-accent" />
                </PanelResizeHandle>
                <Panel defaultSize={sizes[1] ?? 38} minSize={24}>
                  <VizPane />
                </Panel>
              </PanelGroup>
            </div>
          </div>
        </section>

        <SidePanel
          side="right"
          id="memories-panel"
          label={t("panels.memories")}
          open={memoriesOpen}
          onOpenChange={setMemoriesOpen}
          icon={<Brain aria-hidden="true" className="size-4" />}
          openIcon={<PanelRightClose aria-hidden="true" className="size-3.5" />}
          closedIcon={<PanelRightOpen aria-hidden="true" className="size-4" />}
          closeLabel={t("panels.closeMemories")}
          openLabel={t("panels.openMemories")}
        >
          <div className="p-3">
            <MemoriesPanel focus={chat.memoryFocus} onClearFocus={chat.clearMemoryFocus} />
          </div>
        </SidePanel>
      </div>

      <DebugDrawerHost />
    </div>
  );
}

function SidePanel({
  side,
  id,
  label,
  open,
  onOpenChange,
  icon,
  openIcon,
  closedIcon,
  closeLabel,
  openLabel,
  children,
}: {
  side: "left" | "right";
  id: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
  openIcon: ReactNode;
  closedIcon: ReactNode;
  closeLabel: string;
  openLabel: string;
  children: ReactNode;
}) {
  return (
    <aside
      id={id}
      className={cn(
        "subscriber-panel subscriber-panel-" + side,
        "min-h-0 min-w-0 overflow-hidden bg-paper",
        side === "left" ? "border-r border-line" : "border-l border-line",
      )}
      data-open={open}
      aria-label={label}
    >
      {open ? (
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-3">
            <span className="text-accent">{icon}</span>
            <h2 className="truncate font-display text-[15px] font-medium text-ink">{label}</h2>
            <Tooltip content={closeLabel}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label={closeLabel}
                aria-expanded={open}
                aria-controls={id}
                onClick={() => onOpenChange(false)}
              >
                {openIcon}
              </Button>
            </Tooltip>
          </header>
          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">{children}</div>
        </div>
      ) : (
        <div className="flex h-full min-h-0 items-start justify-center pt-2">
          <Tooltip content={openLabel}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={openLabel}
              aria-expanded={open}
              aria-controls={id}
              onClick={() => onOpenChange(true)}
            >
              {closedIcon}
              <span className="sr-only">{label}</span>
            </Button>
          </Tooltip>
        </div>
      )}
    </aside>
  );
}
