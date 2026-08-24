import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BookOpen, Brain, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { usePersistedState } from "@/lib/storage";
import { Button, Segmented, Tooltip } from "@/components/ui";
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

type WorkspacePage = "chat" | "publications" | "memories";

function ChatSurface() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { memory?: string; rev?: number };
  const chat = useChat();
  const isWideDesktop = useMediaQuery("(min-width: 1536px)");
  const [mobileTab, setMobileTab] = useState<"conversation" | "visual">("conversation");
  const [workspacePage, setWorkspacePage] = useState<WorkspacePage>("chat");
  const [publicationsOpen, setPublicationsOpen] = usePersistedState("chat.publicationsOpen", false);
  const [memoriesOpen, setMemoriesOpen] = usePersistedState("chat.memoriesOpen", false);
  const [sizes, setSizes] = usePersistedState<number[]>("chat.panels", [62, 38]);

  const selectWorkspacePage = (page: WorkspacePage) => {
    setWorkspacePage(page);
    if (page === "publications") setPublicationsOpen(true);
    if (page === "memories") setMemoriesOpen(true);
  };

  useEffect(() => {
    if (!search.memory) return;
    chat.openMemoryRevision({ id: search.memory, revision: search.rev ?? 1 });
    void navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, memory: undefined, rev: undefined })) as never, replace: true });
    // A citation or a deep link opens the independent memories panel.
    setMemoriesOpen(true);
    setWorkspacePage("memories");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.memory]);

  useEffect(() => {
    if (chat.memoryFocus) {
      setMemoriesOpen(true);
      setWorkspacePage("memories");
    }
  }, [chat.memoryFocus, setMemoriesOpen]);

  // “Show” request from an answer referencing the visual: switch to the tab below lg.
  useEffect(() => {
    if (chat.showVizRequest > 0) setMobileTab("visual");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.showVizRequest]);

  const leftColumn = publicationsOpen ? "27rem" : "0px";
  const rightColumn = memoriesOpen ? "27rem" : "0px";

  return (
    <div className="subscriber-chat-viewport -mt-5 flex h-[calc(100dvh-52px)] min-h-0 flex-col overflow-hidden">
      <div className="subscriber-compact-nav flex shrink-0 justify-center border-b border-line px-3 py-1.5">
        <Segmented
          size="sm"
          aria-label={t("chat.pageSelector")}
          value={workspacePage}
          onChange={selectWorkspacePage}
          options={[
            { value: "chat", label: t("chat.pageChat") },
            { value: "publications", label: t("panels.publicationsShort") },
            { value: "memories", label: t("panels.memoriesShort") },
          ]}
        />
      </div>
      <div
        className="subscriber-chat-layout min-h-0 flex-1"
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
          compactActive={workspacePage === "publications"}
          wide={isWideDesktop}
          onOpenChange={setPublicationsOpen}
          icon={<BookOpen aria-hidden="true" className="size-4" />}
          openIcon={<PanelLeftClose aria-hidden="true" className="size-3.5" />}
          closeLabel={t("panels.closePublications")}
        >
          <div className="grid gap-3 p-3">
            <p className="text-[12px] leading-relaxed text-ink-2">{t("panels.publicationsDescription")}</p>
            <div className="publications-panel-table">
              <ClientPublicationsTable />
            </div>
          </div>
        </SidePanel>

        <section
          aria-label={t("chat.pageChat")}
          className="subscriber-chat-main flex min-h-0 min-w-0 flex-col"
          data-compact-active={workspacePage === "chat"}
          aria-hidden={!isWideDesktop && workspacePage !== "chat"}
          inert={!isWideDesktop && workspacePage !== "chat"}
        >
          <div className="subscriber-chat-toolbar h-8 shrink-0 items-center border-b border-line px-2">
            <Tooltip content={publicationsOpen ? t("panels.closePublications") : t("panels.openPublications")}>
              <Button
                variant="ghost"
                size="icon-sm"
                id="publications-panel-toggle"
                aria-label={publicationsOpen ? t("panels.closePublications") : t("panels.openPublications")}
                aria-expanded={publicationsOpen}
                aria-controls="publications-panel"
                onClick={() => setPublicationsOpen((open) => !open)}
              >
                {publicationsOpen ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
              </Button>
            </Tooltip>
            <span className="flex-1" aria-hidden="true" />
            <Tooltip content={memoriesOpen ? t("panels.closeMemories") : t("panels.openMemories")}>
              <Button
                variant="ghost"
                size="icon-sm"
                id="memories-panel-toggle"
                aria-label={memoriesOpen ? t("panels.closeMemories") : t("panels.openMemories")}
                aria-expanded={memoriesOpen}
                aria-controls="memories-panel"
                onClick={() => setMemoriesOpen((open) => !open)}
              >
                {memoriesOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
              </Button>
            </Tooltip>
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
          compactActive={workspacePage === "memories"}
          wide={isWideDesktop}
          onOpenChange={setMemoriesOpen}
          icon={<Brain aria-hidden="true" className="size-4" />}
          openIcon={<PanelRightClose aria-hidden="true" className="size-3.5" />}
          closeLabel={t("panels.closeMemories")}
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
  compactActive,
  wide,
  onOpenChange,
  icon,
  openIcon,
  closeLabel,
  children,
}: {
  side: "left" | "right";
  id: string;
  label: string;
  open: boolean;
  compactActive: boolean;
  wide: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
  openIcon: ReactNode;
  closeLabel: string;
  children: ReactNode;
}) {
  const visible = wide ? open : compactActive;

  return (
    <aside
      id={id}
      className={cn(
        "subscriber-panel subscriber-panel-" + side,
        "min-h-0 min-w-0 overflow-hidden bg-paper",
        side === "left" ? "border-r border-line" : "border-l border-line",
      )}
      data-open={open}
      data-compact-active={compactActive}
      data-panel-visible={visible}
      aria-label={label}
      aria-hidden={!visible}
      inert={!visible}
    >
      <div className="subscriber-panel-inner flex h-full min-h-0 flex-col">
        <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="text-accent">{icon}</span>
          <h2 className="truncate font-display text-[15px] font-medium text-ink">{label}</h2>
          <Tooltip content={closeLabel}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="subscriber-wide-only ml-auto"
              aria-label={closeLabel}
              aria-expanded={open}
              aria-controls={id}
              onClick={() => {
                onOpenChange(false);
                document.getElementById(`${id}-toggle`)?.focus();
              }}
            >
              {openIcon}
            </Button>
          </Tooltip>
        </header>
        <div className="subscriber-panel-scroll min-h-0 flex-1 overflow-x-auto overflow-y-auto">{children}</div>
      </div>
    </aside>
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}
