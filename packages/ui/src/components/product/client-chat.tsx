import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { MessageSquare, PanelLeft, PanelRight } from "lucide-react";
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
  leftWidth: 280,
  rightWidth: 360,
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
  const [compactView, setCompactView] = useState<"chat" | "subscriptions" | "memories">("chat");
  const compactPanel = useRef<HTMLDivElement>(null);
  const leftToggle = useRef<HTMLButtonElement>(null);
  const rightToggle = useRef<HTMLButtonElement>(null);
  const setLayout = (next: ClientChatLayoutState) => {
    if (controlledLayout === undefined) setLocalLayout(next);
    onLayoutChange?.(next);
  };
  useEffect(() => {
    if (!layout.leftOpen) leftToggle.current?.focus();
  }, [layout.leftOpen]);
  useEffect(() => {
    if (!layout.rightOpen) rightToggle.current?.focus();
  }, [layout.rightOpen]);
  const dragging = useRef<{
    readonly side: "left" | "right";
    readonly startX: number;
    readonly startWidth: number;
  } | null>(null);
  useEffect(() => {
    if (!resizeAdapter) return;
    const move = (clientX: number) => {
      const drag = dragging.current;
      if (!drag) return;
      const delta = clientX - drag.startX;
      const width =
        drag.side === "left"
          ? clamp(drag.startWidth + delta, 220, 420)
          : clamp(drag.startWidth - delta, 280, 480);
      setLayout({
        ...layout,
        ...(drag.side === "left" ? { leftWidth: width } : { rightWidth: width }),
      });
    };
    const up = () => {
      dragging.current = null;
      resizeAdapter.setCursor("");
    };
    return resizeAdapter.subscribe(move, up);
  }, [layout, resizeAdapter]);
  const chatView = transcript ?? null;
  const vizView = visualization ?? <VizPane versions={[]} activeVersionId={null} locale={locale} />;
  const compactContent = compactView === "subscriptions" ? subscriptions : memories;
  useEffect(() => {
    if (compactView !== "chat") compactPanel.current?.focus();
  }, [compactView]);
  useEffect(() => {
    if (focusPanel !== null) setCompactView(focusPanel);
  }, [focusPanel]);
  const gridStyle = {
    "--left": layout.leftOpen ? `${layout.leftWidth}px` : "0px",
    "--right": layout.rightOpen ? `${layout.rightWidth}px` : "0px",
  } as CSSProperties;
  const resizeWithKeyboard = (
    side: "left" | "right",
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const min = side === "left" ? 220 : 280;
    const max = side === "left" ? 420 : 480;
    const current = side === "left" ? layout.leftWidth : layout.rightWidth;
    const delta =
      side === "left"
        ? event.key === "ArrowRight"
          ? 16
          : -16
        : event.key === "ArrowLeft"
          ? 16
          : -16;
    const width =
      event.key === "Home" ? min : event.key === "End" ? max : clamp(current + delta, min, max);
    setLayout({ ...layout, ...(side === "left" ? { leftWidth: width } : { rightWidth: width }) });
  };
  return (
    <section
      className={cn("subscriber-chat-viewport relative flex min-h-[640px] flex-col", className)}
      aria-label={resolvedTitle}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="font-display text-[24px] font-medium">{resolvedTitle}</h1>
          <span className="caps-label text-ink-2">
            {uiMessage(locale, "ui.singleConversation")}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {!layout.leftOpen && (
            <Button
              ref={leftToggle}
              variant="ghost"
              size="icon-sm"
              className="hidden lg:inline-flex"
              aria-label={uiMessage(locale, "ui.openSubscriptions")}
              onClick={() => setLayout({ ...layout, leftOpen: true })}
            >
              <PanelLeft className="size-3.5" aria-hidden="true" />
            </Button>
          )}
          {!layout.rightOpen && (
            <Button
              ref={rightToggle}
              variant="ghost"
              size="icon-sm"
              className="hidden lg:inline-flex"
              aria-label={uiMessage(locale, "ui.openVisualization")}
              onClick={() => setLayout({ ...layout, rightOpen: true })}
            >
              <PanelRight className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1 lg:hidden">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={uiMessage(locale, "ui.conversation")}
            aria-pressed={layout.mobileTab === "chat"}
            onClick={() => setLayout({ ...layout, mobileTab: "chat" })}
          >
            <MessageSquare className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={uiMessage(locale, "ui.visualization")}
            aria-pressed={layout.mobileTab === "visualization"}
            onClick={() => setLayout({ ...layout, mobileTab: "visualization" })}
          >
            <PanelRight className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-1 min-[1536px]:hidden">
        <Segmented
          aria-label={uiMessage(locale, "nav.chat")}
          value={compactView}
          onChange={setCompactView}
          options={[
            { value: "chat", label: uiMessage(locale, "ui.conversation") },
            { value: "subscriptions", label: uiMessage(locale, "ui.subscriptions") },
            { value: "memories", label: uiMessage(locale, "section.memories") },
          ]}
        />
      </div>
      <div className={cn("mb-3 flex gap-1 lg:hidden", compactView !== "chat" && "hidden")}>
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
      <div
        className="grid min-h-[600px] flex-1 overflow-hidden border-y border-line lg:grid-cols-[0_minmax(0,1fr)_var(--right)] min-[1536px]:!grid-cols-[var(--left)_minmax(0,1fr)_var(--right)]"
        style={gridStyle}
      >
        <aside
          className={cn(
            "relative hidden min-w-0 overflow-y-auto border-r border-line p-3 min-[1536px]:block",
            !layout.leftOpen && "pointer-events-none opacity-0",
          )}
          aria-label={uiMessage(locale, "ui.subscriptions")}
          aria-hidden={!layout.leftOpen}
          {...(!layout.leftOpen ? { inert: true } : {})}
        >
          {layout.leftOpen && (
            <>
              <div className="mb-3 flex items-center justify-between">
                <span className="caps-label">{uiMessage(locale, "ui.subscriptions")}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${uiMessage(locale, "ui.subscriptions")} · ${uiMessage(locale, "ui.close")}`}
                  onClick={() => setLayout({ ...layout, leftOpen: !layout.leftOpen })}
                >
                  <PanelLeft className="size-3" aria-hidden="true" />
                </Button>
              </div>
              {subscriptions ?? (
                <p className="text-[12px] text-ink-2">{uiMessage(locale, "ui.subscriptions")}</p>
              )}
              <div className="mt-4">{memories}</div>
              <button
                type="button"
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={uiMessage(locale, "ui.resizeSubscriptions")}
                aria-valuemin={220}
                aria-valuemax={420}
                aria-valuenow={layout.leftWidth}
                className="absolute inset-y-0 right-0 z-10 hidden w-3 cursor-col-resize lg:block"
                onKeyDown={(event) => resizeWithKeyboard("left", event)}
                onPointerDown={(event) => {
                  dragging.current = {
                    side: "left",
                    startX: event.clientX,
                    startWidth: layout.leftWidth,
                  };
                  resizeAdapter?.setCursor("col-resize");
                }}
              >
                <span className="mx-auto block h-full w-px bg-line" />
              </button>
            </>
          )}
        </aside>
        <div
          className={cn(
            "relative flex min-w-0 flex-col bg-paper lg:col-start-2",
            compactView !== "chat" && "hidden min-[1536px]:flex",
            compactView === "chat" && layout.mobileTab !== "chat" && "hidden lg:flex",
          )}
        >
          <div className="min-h-0 flex-1">{chatView}</div>
          {composerProps && <Composer {...composerProps} />}
        </div>
        {compactView === "chat" && layout.mobileTab === "visualization" && (
          <div className="min-w-0 flex-1 overflow-y-auto bg-paper p-3 lg:hidden">{vizView}</div>
        )}
        {compactView !== "chat" && (
          <div
            ref={compactPanel}
            tabIndex={-1}
            className="min-w-0 overflow-y-auto bg-paper p-3 outline-none lg:col-span-2 min-[1536px]:hidden"
            aria-label={
              compactView === "subscriptions"
                ? uiMessage(locale, "ui.subscriptions")
                : uiMessage(locale, "section.memories")
            }
          >
            {compactContent ?? (
              <p className="text-[12px] text-ink-2">{uiMessage(locale, "ui.noContent")}</p>
            )}
          </div>
        )}
        <aside
          className={cn(
            "relative hidden min-w-0 overflow-hidden border-l border-line bg-paper lg:col-start-3 lg:block",
            !layout.rightOpen && "pointer-events-none opacity-0",
          )}
          aria-label={uiMessage(locale, "ui.visualization")}
          aria-hidden={!layout.rightOpen}
          {...(!layout.rightOpen ? { inert: true } : {})}
        >
          {layout.rightOpen && (
            <>
              <div className="flex items-center justify-between border-b border-line px-3 py-2">
                <span className="caps-label">{uiMessage(locale, "ui.visualization")}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${uiMessage(locale, "ui.visualization")} · ${uiMessage(locale, "ui.close")}`}
                  onClick={() => setLayout({ ...layout, rightOpen: !layout.rightOpen })}
                >
                  <PanelRight className="size-3" aria-hidden="true" />
                </Button>
              </div>
              <div className="h-[calc(100%-34px)]">{vizView}</div>
              <button
                type="button"
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={uiMessage(locale, "ui.resizeVisualization")}
                aria-valuemin={280}
                aria-valuemax={480}
                aria-valuenow={layout.rightWidth}
                className="absolute inset-y-0 left-0 z-10 hidden w-3 cursor-col-resize lg:block"
                onKeyDown={(event) => resizeWithKeyboard("right", event)}
                onPointerDown={(event) => {
                  dragging.current = {
                    side: "right",
                    startX: event.clientX,
                    startWidth: layout.rightWidth,
                  };
                  resizeAdapter?.setCursor("col-resize");
                }}
              >
                <span className="mx-auto block h-full w-px bg-line" />
              </button>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
