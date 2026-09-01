import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { BookOpen, Brain, ChevronLeft, ChevronRight } from "lucide-react";
import { cn, clamp } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
import { Button } from "../ui/button";
import { Segmented } from "../ui/tabs";
import { Composer, type ComposerProps } from "./chat/composer";
import { VizPane } from "./chat/viz-pane";

export interface ClientChatLayoutState {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  mobileTab: "chat" | "visualization";
}
const defaultLayout: ClientChatLayoutState = {
  leftOpen: true,
  rightOpen: true,
  leftWidth: 432,
  rightWidth: 432,
  mobileTab: "chat",
};
export interface ClientChatProps {
  transcript?: ReactNode;
  composerProps?: ComposerProps;
  memories?: ReactNode;
  visualization?: ReactNode;
  subscriptions?: ReactNode;
  title?: string;
  locale?: string;
  className?: string;
  layout?: ClientChatLayoutState;
  onLayoutChange?: (layout: ClientChatLayoutState) => void;
  focusPanel?: "subscriptions" | "memories" | null;
  resizeAdapter?: ClientChatResizeAdapter;
}
export interface ClientChatResizeAdapter {
  subscribe: (onMove: (clientX: number) => void, onEnd: () => void) => () => void;
  setCursor: (cursor: string) => void;
}

type WorkspacePage = "chat" | "subscriptions" | "memories";
type SidebarSide = "left" | "right";

const SIDEBAR_MIN_WIDTH = 432;
const SIDEBAR_MAX_WIDTH = 960;
const CHAT_MIN_WIDTH = 480;
const CHAT_MAX_WIDTH = 1440;
/** Center split keeps the conversation above its minimum and the
 * visualization above its own minimum (24%). */
const CHAT_SPLIT_MIN = 30;
const CHAT_SPLIT_MAX = 76;

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
  return Math.max(
    minWidth,
    Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - CHAT_MIN_WIDTH - otherTrack),
  );
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

export function ClientChat({
  transcript,
  composerProps,
  memories,
  visualization,
  subscriptions,
  title = "Chat",
  locale = "en-US",
  className,
  layout: controlledLayout,
  onLayoutChange,
  focusPanel = null,
  resizeAdapter,
}: ClientChatProps) {
  const resolvedTitle = title === "Chat" ? uiMessage(locale, "nav.chat") : title;
  const [localLayout, setLocalLayout] = useState(defaultLayout);
  const layout = controlledLayout ?? localLayout;
  const setLayout = (next: ClientChatLayoutState) => {
    if (controlledLayout === undefined) setLocalLayout(next);
    onLayoutChange?.(next);
  };
  const [workspacePage, setWorkspacePage] = useState<WorkspacePage>("chat");
  const [resizingSide, setResizingSide] = useState<SidebarSide | null>(null);
  const [chatSplit, setChatSplit] = useState(62);
  const [chatSplitDragging, setChatSplitDragging] = useState(false);
  const leftToggle = useRef<HTMLButtonElement>(null);
  const rightToggle = useRef<HTMLButtonElement>(null);
  const subscriptionsPanel = useRef<HTMLElement | null>(null);
  const memoriesPanel = useRef<HTMLElement | null>(null);
  const isWideDesktop = useMediaQuery("(min-width: 1536px)");
  const viewportWidth = useViewportWidth();
  const sidebarTracks = resolveSidebarTracks({
    viewportWidth,
    leftOpen: layout.leftOpen,
    rightOpen: layout.rightOpen,
    leftRequested: layout.leftWidth,
    rightRequested: layout.rightWidth,
  });

  useEffect(() => {
    if (!layout.leftOpen) leftToggle.current?.focus();
  }, [layout.leftOpen]);
  useEffect(() => {
    if (layout.rightOpen) return;
    rightToggle.current?.focus();
  }, [layout.rightOpen]);
  // A citation or a deep link opens the corresponding side panel.
  useEffect(() => {
    if (focusPanel === null) return;
    setWorkspacePage(focusPanel);
    if (focusPanel === "subscriptions") setLayout({ ...layout, leftOpen: true });
    if (focusPanel === "memories") setLayout({ ...layout, rightOpen: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPanel]);
  // Compact pages below the wide breakpoint move keyboard focus into the panel.
  useEffect(() => {
    if (workspacePage === "chat" || isWideDesktop) return;
    const panel = workspacePage === "subscriptions" ? subscriptionsPanel : memoriesPanel;
    panel.current?.focus();
  }, [workspacePage, isWideDesktop]);

  const selectWorkspacePage = (page: WorkspacePage) => {
    setWorkspacePage(page);
    if (page === "subscriptions") setLayout({ ...layout, leftOpen: true });
    if (page === "memories") setLayout({ ...layout, rightOpen: true });
  };

  const chatView = transcript ?? null;
  const vizView = visualization ?? <VizPane versions={[]} activeVersionId={null} locale={locale} />;
  const subscriptionsLabel = uiMessage(locale, "ui.subscriptions");
  const memoriesLabel = uiMessage(locale, "section.memories");

  return (
    <section
      className={cn(
        "subscriber-chat-viewport relative -mt-5 flex h-[calc(100dvh-52px)] min-h-0 flex-1 flex-col overflow-hidden",
        className,
      )}
      aria-label={resolvedTitle}
      data-sidebar-resizing={resizingSide ? "true" : undefined}
      style={
        {
          "--subscriber-left-track": `${sidebarTracks.left}px`,
          "--subscriber-right-track": `${sidebarTracks.right}px`,
        } as CSSProperties
      }
    >
      <h1 className="sr-only">{resolvedTitle}</h1>
      <div className="subscriber-compact-nav flex shrink-0 justify-center px-3 py-1.5">
        <Segmented
          size="sm"
          aria-label={resolvedTitle}
          value={workspacePage}
          onChange={selectWorkspacePage}
          options={[
            { value: "chat", label: uiMessage(locale, "nav.chat") },
            { value: "subscriptions", label: subscriptionsLabel },
            { value: "memories", label: memoriesLabel },
          ]}
        />
      </div>
      <div className="subscriber-chat-layout min-h-0 flex-1">
        <SidePanel
          side="left"
          id="subscriptions-panel"
          label={subscriptionsLabel}
          open={layout.leftOpen}
          compactActive={workspacePage === "subscriptions"}
          wide={isWideDesktop}
          width={sidebarTracks.left}
          minWidth={sidebarTracks.leftMin}
          maxWidth={sidebarTracks.leftMax}
          resizeLabel={uiMessage(locale, "ui.resizeSubscriptions")}
          panelRef={subscriptionsPanel}
          {...(resizeAdapter ? { adapter: resizeAdapter } : {})}
          onResize={(width) => setLayout({ ...layout, leftWidth: width })}
          onResizeStart={() => setResizingSide("left")}
          onResizeEnd={() => setResizingSide((current) => (current === "left" ? null : current))}
        >
          <div className="subscriptions-panel-table">
            {subscriptions ?? <p className="text-[12px] text-ink-2">{subscriptionsLabel}</p>}
          </div>
        </SidePanel>

        <section
          aria-label={resolvedTitle}
          className="subscriber-chat-main relative flex min-h-0 min-w-0 flex-col"
          data-compact-active={workspacePage === "chat"}
          aria-hidden={!isWideDesktop && workspacePage !== "chat"}
          inert={!isWideDesktop && workspacePage !== "chat"}
        >
          <Button
            ref={leftToggle}
            variant="secondary"
            size="md"
            className={cn(
              "subscriber-wide-only subscriber-chat-panel-toggle subscriber-chat-panel-toggle-left absolute top-1.5 z-[1] bg-surface gap-1 px-2.5",
              layout.leftOpen ? "-left-14" : "left-3",
            )}
            id="subscriptions-panel-toggle"
            title={
              layout.leftOpen
                ? `${subscriptionsLabel} · ${uiMessage(locale, "ui.close")}`
                : uiMessage(locale, "ui.openSubscriptions")
            }
            aria-label={
              layout.leftOpen
                ? `${subscriptionsLabel} · ${uiMessage(locale, "ui.close")}`
                : uiMessage(locale, "ui.openSubscriptions")
            }
            aria-expanded={layout.leftOpen}
            aria-controls="subscriptions-panel"
            onClick={() => setLayout({ ...layout, leftOpen: !layout.leftOpen })}
          >
            <BookOpen aria-hidden="true" className="size-3.5" />
            {layout.leftOpen ? (
              <ChevronLeft aria-hidden="true" className="!size-2.5" />
            ) : (
              <ChevronRight aria-hidden="true" className="!size-2.5" />
            )}
          </Button>
          <Button
            ref={rightToggle}
            variant="secondary"
            size="md"
            className={cn(
              "subscriber-wide-only subscriber-chat-panel-toggle subscriber-chat-panel-toggle-right absolute top-1.5 z-[1] bg-surface gap-1 px-2.5",
              layout.rightOpen ? "-right-14" : "right-3",
            )}
            id="memories-panel-toggle"
            title={
              layout.rightOpen
                ? `${memoriesLabel} · ${uiMessage(locale, "ui.close")}`
                : uiMessage(locale, "ui.openVisualization")
            }
            aria-label={
              layout.rightOpen
                ? `${memoriesLabel} · ${uiMessage(locale, "ui.close")}`
                : uiMessage(locale, "ui.openVisualization")
            }
            aria-expanded={layout.rightOpen}
            aria-controls="memories-panel"
            onClick={() => setLayout({ ...layout, rightOpen: !layout.rightOpen })}
          >
            <Brain aria-hidden="true" className="size-3.5" />
            {layout.rightOpen ? (
              <ChevronRight aria-hidden="true" className="!size-2.5" />
            ) : (
              <ChevronLeft aria-hidden="true" className="!size-2.5" />
            )}
          </Button>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
            {/* Below lg: conversation / visualization switch stays local to the chat. */}
            <div className="flex shrink-0 justify-center border-b border-line px-4 py-1.5 lg:hidden">
              <Segmented
                aria-label={uiMessage(locale, "ui.conversation")}
                value={layout.mobileTab}
                onChange={(value) => setLayout({ ...layout, mobileTab: value })}
                options={[
                  { value: "chat", label: uiMessage(locale, "ui.conversation") },
                  { value: "visualization", label: uiMessage(locale, "ui.visualization") },
                ]}
              />
            </div>

            {/* One conversation subtree serves both compact and wide layouts. */}
            <div
              className={cn(
                "subscriber-chat-panel-content min-h-0 min-w-0 flex-col overflow-hidden lg:flex",
                layout.mobileTab === "chat" ? "flex" : "hidden",
              )}
              style={{
                flexBasis: 0,
                flexGrow: chatSplit,
                flexShrink: 1,
                overflow: "hidden",
                pointerEvents: chatSplitDragging ? "none" : undefined,
              }}
            >
              {chatView}
              {composerProps && <Composer {...composerProps} />}
            </div>

            <ChatSplitHandle
              percent={chatSplit}
              label={`${uiMessage(locale, "ui.conversation")} / ${uiMessage(locale, "ui.visualization")}`}
              onResize={setChatSplit}
              onResizeStart={() => setChatSplitDragging(true)}
              onResizeEnd={() => setChatSplitDragging(false)}
            />

            {/* The same visualization subtree is a mobile tab pane and the lg+ split pane. */}
            <div
              className={cn(
                "min-h-0 min-w-0 overflow-hidden lg:block",
                layout.mobileTab === "visualization" ? "block" : "hidden",
              )}
              style={{
                flexBasis: 0,
                flexGrow: 100 - chatSplit,
                flexShrink: 1,
                overflow: "hidden",
                pointerEvents: chatSplitDragging ? "none" : undefined,
              }}
            >
              {vizView}
            </div>
          </div>
        </section>

        <SidePanel
          side="right"
          id="memories-panel"
          label={memoriesLabel}
          open={layout.rightOpen}
          compactActive={workspacePage === "memories"}
          wide={isWideDesktop}
          width={sidebarTracks.right}
          minWidth={sidebarTracks.rightMin}
          maxWidth={sidebarTracks.rightMax}
          resizeLabel={uiMessage(locale, "ui.resizeVisualization")}
          panelRef={memoriesPanel}
          {...(resizeAdapter ? { adapter: resizeAdapter } : {})}
          onResize={(width) => setLayout({ ...layout, rightWidth: width })}
          onResizeStart={() => setResizingSide("right")}
          onResizeEnd={() => setResizingSide((current) => (current === "right" ? null : current))}
        >
          <div className="p-3">
            {memories ?? (
              <p className="text-[12px] text-ink-2">{uiMessage(locale, "ui.noContent")}</p>
            )}
          </div>
        </SidePanel>
      </div>
    </section>
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
  panelRef,
  adapter,
  onResize,
  onResizeStart,
  onResizeEnd,
  children,
}: {
  side: SidebarSide;
  id: string;
  label: string;
  open: boolean;
  compactActive: boolean;
  wide: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  resizeLabel: string;
  panelRef?: Ref<HTMLElement>;
  adapter?: ClientChatResizeAdapter;
  onResize: (width: number) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
  children: ReactNode;
}) {
  const visible = wide ? open : compactActive;

  return (
    <aside
      ref={panelRef}
      id={id}
      tabIndex={-1}
      className={cn(
        "subscriber-panel subscriber-panel-" + side,
        "relative min-h-0 min-w-0 overflow-visible bg-paper outline-none",
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
        <div className="subscriber-panel-scroll min-h-0 flex-1 overflow-x-auto overflow-y-auto">
          {children}
        </div>
      </div>
      {wide && open && (
        <SidebarResizeHandle
          side={side}
          width={width}
          minWidth={minWidth}
          maxWidth={maxWidth}
          label={resizeLabel}
          {...(adapter ? { adapter } : {})}
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
  adapter,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  side: SidebarSide;
  width: number;
  minWidth: number;
  maxWidth: number;
  label: string;
  adapter?: ClientChatResizeAdapter;
  onResize: (width: number) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
}) {
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    unsubscribe?: () => void;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const growsWithRightwardMotion = side === "left";

  const resizeTo = (clientX: number, start: { startX: number; startWidth: number }) => {
    const delta = clientX - start.startX;
    const signedDelta = growsWithRightwardMotion ? delta : -delta;
    onResize(clampSidebarWidth(start.startWidth + signedDelta, minWidth, maxWidth));
  };

  const endResize = () => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.unsubscribe?.();
    dragRef.current = null;
    setIsDragging(false);
    onResizeEnd();
  };

  const finishPointerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    endResize();
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
        const grows = growsWithRightwardMotion
          ? event.key === "ArrowRight"
          : event.key === "ArrowLeft";
        const shrinks = growsWithRightwardMotion
          ? event.key === "ArrowLeft"
          : event.key === "ArrowRight";
        if (!grows && !shrinks) return;
        event.preventDefault();
        onResize(clampSidebarWidth(width + (grows ? 16 : -16), minWidth, maxWidth));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const start = { startX: event.clientX, startWidth: width };
        if (adapter) {
          adapter.setCursor("col-resize");
          dragRef.current = {
            pointerId: event.pointerId,
            ...start,
            unsubscribe: adapter.subscribe(
              (clientX) => resizeTo(clientX, start),
              () => {
                adapter.setCursor("");
                endResize();
              },
            ),
          };
        } else {
          dragRef.current = { pointerId: event.pointerId, ...start };
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        setIsDragging(true);
        onResizeStart();
      }}
      {...(adapter
        ? {}
        : {
            onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              resizeTo(event.clientX, drag);
            },
            onPointerUp: finishPointerResize,
            onPointerCancel: finishPointerResize,
          })}
    >
      <span aria-hidden="true" className="subscriber-sidebar-resize-line" />
    </div>
  );
}

/** Resizable conversation | visualization divider (lg+), mirroring the
 * reference PanelGroup: 62/38 default split, 10% keyboard steps. */
function ChatSplitHandle({
  percent,
  label,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  percent: number;
  label: string;
  onResize: (percent: number) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startPercent: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const handleRef = useRef<HTMLDivElement>(null);

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
      ref={handleRef}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={CHAT_SPLIT_MIN}
      aria-valuemax={CHAT_SPLIT_MAX}
      aria-valuenow={Math.round(percent)}
      className="subscriber-chat-resize-handle group relative hidden w-5 cursor-col-resize items-stretch justify-center outline-none lg:flex"
      style={{ touchAction: "none", userSelect: "none" }}
      data-resize-handle-state={isDragging ? "drag" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Home") {
          event.preventDefault();
          onResize(CHAT_SPLIT_MIN);
          return;
        }
        if (event.key === "End") {
          event.preventDefault();
          onResize(CHAT_SPLIT_MAX);
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onResize(
          clamp(percent + (event.key === "ArrowRight" ? 10 : -10), CHAT_SPLIT_MIN, CHAT_SPLIT_MAX),
        );
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startPercent: percent,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsDragging(true);
        onResizeStart();
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const width = handleRef.current?.parentElement?.getBoundingClientRect().width ?? 1;
        const deltaPercent = ((event.clientX - drag.startX) / width) * 100;
        onResize(clamp(drag.startPercent + deltaPercent, CHAT_SPLIT_MIN, CHAT_SPLIT_MAX));
      }}
      onPointerUp={finishPointerResize}
      onPointerCancel={finishPointerResize}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors duration-100 group-hover:bg-accent group-focus-visible:bg-accent group-data-[resize-handle-state=drag]:bg-accent"
      />
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
