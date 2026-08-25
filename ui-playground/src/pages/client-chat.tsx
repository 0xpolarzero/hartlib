import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BookOpen, Brain, ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { usePersistedState } from "@/lib/storage";
import { Button, Segmented } from "@/components/ui";
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
type SidebarSide = "left" | "right";

const SIDEBAR_MIN_WIDTH = 432;
const SIDEBAR_MAX_WIDTH = 720;
const CHAT_MIN_WIDTH = 576;
const CHAT_MAX_WIDTH = 1440;

type SidebarTracks = {
  left: number;
  leftMin: number;
  leftMax: number;
  right: number;
  rightMin: number;
  rightMax: number;
};

function normalizeSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return SIDEBAR_MIN_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function sidebarMaxWidth(viewportWidth: number, minWidth: number, otherTrack: number) {
  return Math.max(minWidth, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - CHAT_MIN_WIDTH - otherTrack));
}

function resolveSidebarTracks({
  viewportWidth,
  leftOpen,
  rightOpen,
  leftRequested,
  rightRequested,
}: {
  viewportWidth: number;
  leftOpen: boolean;
  rightOpen: boolean;
  leftRequested: number;
  rightRequested: number;
}): SidebarTracks {
  const naturalGutter = Math.max(0, (viewportWidth - CHAT_MAX_WIDTH) / 2);
  const leftMin = Math.max(SIDEBAR_MIN_WIDTH, naturalGutter);
  const rightMin = Math.max(SIDEBAR_MIN_WIDTH, naturalGutter);
  let left = leftOpen ? Math.max(leftMin, normalizeSidebarWidth(leftRequested)) : naturalGutter;
  let right = rightOpen ? Math.max(rightMin, normalizeSidebarWidth(rightRequested)) : naturalGutter;

  // Preserve a usable center when both requested tracks would consume too much
  // space. Reduce only the portion above each side's effective minimum.
  const availableForSidebars = Math.max(0, viewportWidth - CHAT_MIN_WIDTH);
  const overflow = Math.max(0, left + right - availableForSidebars);
  if (overflow > 0) {
    const leftFlex = leftOpen ? Math.max(0, left - leftMin) : 0;
    const rightFlex = rightOpen ? Math.max(0, right - rightMin) : 0;
    const flexTotal = leftFlex + rightFlex;
    if (flexTotal > 0) {
      left -= Math.min(leftFlex, overflow * (leftFlex / flexTotal));
      right -= Math.min(rightFlex, overflow * (rightFlex / flexTotal));
    }
  }

  return {
    left,
    leftMin,
    leftMax: sidebarMaxWidth(viewportWidth, leftMin, right),
    right,
    rightMin,
    rightMax: sidebarMaxWidth(viewportWidth, rightMin, left),
  };
}

function clampSidebarWidth(width: number, minWidth: number, maxWidth: number) {
  return Math.min(maxWidth, Math.max(minWidth, width));
}

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
  const [publicationsWidth, setPublicationsWidth] = usePersistedState("chat.publicationsWidth", SIDEBAR_MIN_WIDTH);
  const [memoriesWidth, setMemoriesWidth] = usePersistedState("chat.memoriesWidth", SIDEBAR_MIN_WIDTH);
  const [sizes, setSizes] = usePersistedState<number[]>("chat.panels", [62, 38]);
  const [resizingSide, setResizingSide] = useState<SidebarSide | null>(null);
  const viewportWidth = useViewportWidth();
  const sidebarTracks = resolveSidebarTracks({
    viewportWidth,
    leftOpen: publicationsOpen,
    rightOpen: memoriesOpen,
    leftRequested: publicationsWidth,
    rightRequested: memoriesWidth,
  });

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

  return (
    <div
      className="subscriber-chat-viewport -mt-5 flex h-[calc(100dvh-52px)] min-h-0 flex-col overflow-hidden"
      data-sidebar-resizing={resizingSide ? "true" : undefined}
      style={
        {
          "--subscriber-left-track": `${sidebarTracks.left}px`,
          "--subscriber-right-track": `${sidebarTracks.right}px`,
        } as CSSProperties
      }
    >
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
      <div className="subscriber-chat-layout min-h-0 flex-1">
        <SidePanel
          side="left"
          id="publications-panel"
          label={t("panels.publications")}
          open={publicationsOpen}
          compactActive={workspacePage === "publications"}
          wide={isWideDesktop}
          width={sidebarTracks.left}
          minWidth={sidebarTracks.leftMin}
          maxWidth={sidebarTracks.leftMax}
          resizeLabel={t("panels.resizePublications")}
          onResize={setPublicationsWidth}
          onResizeStart={() => setResizingSide("left")}
          onResizeEnd={() => setResizingSide((current) => (current === "left" ? null : current))}
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
          className="subscriber-chat-main relative flex min-h-0 min-w-0 flex-col"
          data-compact-active={workspacePage === "chat"}
          aria-hidden={!isWideDesktop && workspacePage !== "chat"}
          inert={!isWideDesktop && workspacePage !== "chat"}
        >
          <Button
            variant="secondary"
            size="icon-sm"
            className="subscriber-wide-only subscriber-chat-panel-toggle subscriber-chat-panel-toggle-left absolute left-3 top-2 z-[1] w-8 gap-0.5 bg-surface"
            id="publications-panel-toggle"
            title={publicationsOpen ? t("panels.closePublications") : t("panels.openPublications")}
            aria-label={publicationsOpen ? t("panels.closePublications") : t("panels.openPublications")}
            aria-expanded={publicationsOpen}
            aria-controls="publications-panel"
            onClick={() => setPublicationsOpen((open) => !open)}
          >
            <BookOpen aria-hidden="true" className="size-3.5" />
            {publicationsOpen ? (
              <ChevronLeft aria-hidden="true" className="!size-2.5" />
            ) : (
              <ChevronRight aria-hidden="true" className="!size-2.5" />
            )}
          </Button>
          <Button
            variant="secondary"
            size="icon-sm"
            className="subscriber-wide-only subscriber-chat-panel-toggle subscriber-chat-panel-toggle-right absolute right-3 top-2 z-[1] w-8 gap-0.5 bg-surface"
            id="memories-panel-toggle"
            title={memoriesOpen ? t("panels.closeMemories") : t("panels.openMemories")}
            aria-label={memoriesOpen ? t("panels.closeMemories") : t("panels.openMemories")}
            aria-expanded={memoriesOpen}
            aria-controls="memories-panel"
            onClick={() => setMemoriesOpen((open) => !open)}
          >
            <Brain aria-hidden="true" className="size-3.5" />
            {memoriesOpen ? (
              <ChevronRight aria-hidden="true" className="!size-2.5" />
            ) : (
              <ChevronLeft aria-hidden="true" className="!size-2.5" />
            )}
          </Button>

          <div className="flex min-h-0 flex-1 overflow-hidden">
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
            <div className="hidden min-h-0 flex-1 overflow-hidden lg:block">
              <PanelGroup direction="horizontal" onLayout={(layout) => setSizes(layout)}>
                <Panel defaultSize={sizes[0] ?? 62} minSize={30}>
                  <div className="subscriber-chat-panel-content flex h-full min-h-0 flex-col overflow-hidden">
                    <Transcript />
                    <Composer />
                  </div>
                </Panel>
                <PanelResizeHandle
                  className="subscriber-chat-resize-handle group relative flex w-5 cursor-col-resize items-stretch justify-center outline-none"
                  hitAreaMargins={{ coarse: 16, fine: 8 }}
                  aria-label={t("chat.divider")}
                >
                  <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors duration-100 group-hover:bg-accent group-focus-visible:bg-accent group-data-[resize-handle-state=drag]:bg-accent" />
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
          width={sidebarTracks.right}
          minWidth={sidebarTracks.rightMin}
          maxWidth={sidebarTracks.rightMax}
          resizeLabel={t("panels.resizeMemories")}
          onResize={setMemoriesWidth}
          onResizeStart={() => setResizingSide("right")}
          onResizeEnd={() => setResizingSide((current) => (current === "right" ? null : current))}
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
  width,
  minWidth,
  maxWidth,
  resizeLabel,
  onResize,
  onResizeStart,
  onResizeEnd,
  children,
}: {
  side: "left" | "right";
  id: string;
  label: string;
  open: boolean;
  compactActive: boolean;
  wide: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  resizeLabel: string;
  onResize: (width: number) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
  children: ReactNode;
}) {
  const visible = wide ? open : compactActive;

  return (
    <aside
      id={id}
      className={cn(
        "subscriber-panel subscriber-panel-" + side,
        "relative min-h-0 min-w-0 overflow-visible bg-paper",
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
        <header className="flex min-h-10 shrink-0 items-center border-b border-line px-3">
          <h2 className="truncate font-display text-[15px] font-medium text-ink">{label}</h2>
        </header>
        <div className="subscriber-panel-scroll min-h-0 flex-1 overflow-x-auto overflow-y-auto">{children}</div>
      </div>
      {wide && open && (
        <SidebarResizeHandle
          side={side}
          width={width}
          minWidth={minWidth}
          maxWidth={maxWidth}
          label={resizeLabel}
          onResize={onResize}
          onResizeStart={onResizeStart}
          onResizeEnd={onResizeEnd}
        />
      )}
    </aside>
  );
}

function SidebarResizeHandle({
  side,
  width,
  minWidth,
  maxWidth,
  label,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  side: SidebarSide;
  width: number;
  minWidth: number;
  maxWidth: number;
  label: string;
  onResize: (width: number) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const growsWithRightwardMotion = side === "left";

  const finishPointerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setIsDragging(false);
    onResizeEnd();
  };

  return (
    <div
      className="subscriber-sidebar-resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={Math.round(minWidth)}
      aria-valuemax={Math.round(maxWidth)}
      aria-valuenow={Math.round(width)}
      data-resize-dragging={isDragging ? "true" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Home") {
          event.preventDefault();
          onResize(minWidth);
          return;
        }
        const grows = growsWithRightwardMotion ? event.key === "ArrowRight" : event.key === "ArrowLeft";
        const shrinks = growsWithRightwardMotion ? event.key === "ArrowLeft" : event.key === "ArrowRight";
        if (!grows && !shrinks) return;
        event.preventDefault();
        onResize(clampSidebarWidth(width + (grows ? 16 : -16), minWidth, maxWidth));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
        setIsDragging(true);
        onResizeStart();
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const delta = event.clientX - drag.startX;
        const signedDelta = growsWithRightwardMotion ? delta : -delta;
        onResize(clampSidebarWidth(drag.startWidth + signedDelta, minWidth, maxWidth));
      }}
      onPointerUp={finishPointerResize}
      onPointerCancel={finishPointerResize}
    >
      <span aria-hidden="true" className="subscriber-sidebar-resize-line" />
    </div>
  );
}

function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return width;
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
