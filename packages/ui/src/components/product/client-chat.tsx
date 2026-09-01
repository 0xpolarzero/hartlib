import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { PanelLeft, PanelRight } from "lucide-react";
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
  const wideRightToggle = useRef<HTMLButtonElement>(null);
  const setLayout = (next: ClientChatLayoutState) => {
    if (controlledLayout === undefined) setLocalLayout(next);
    onLayoutChange?.(next);
  };
  useEffect(() => {
    if (!layout.leftOpen) leftToggle.current?.focus();
  }, [layout.leftOpen]);
  useEffect(() => {
    if (layout.rightOpen) return;
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1536px)").matches
    ) {
      wideRightToggle.current?.focus();
      return;
    }
    rightToggle.current?.focus();
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
  const centerGridStyle = {
    gridTemplateColumns: layout.rightOpen
      ? "minmax(0, 62fr) minmax(0, 38fr)"
      : "minmax(0, 1fr) 0px",
  } as CSSProperties;
  return (
    <section
      className={cn(
        "subscriber-chat-viewport relative -ml-4 -mt-5 flex h-[calc(100dvh-52px)] min-h-0 w-[calc(100%+2rem)] flex-1 flex-col overflow-hidden",
        className,
      )}
      aria-label={resolvedTitle}
    >
      <h1 className="sr-only">{resolvedTitle}</h1>
      <div className="subscriber-compact-nav flex shrink-0 justify-center px-3 py-1.5 min-[1536px]:hidden max-[1535px]:translate-x-[15px]">
        <Segmented
          size="sm"
          aria-label={uiMessage(locale, "nav.chat")}
          value={compactView}
          onChange={setCompactView}
          options={[
            { value: "chat", label: uiMessage(locale, "nav.chat") },
            { value: "subscriptions", label: uiMessage(locale, "ui.subscriptions") },
            { value: "memories", label: uiMessage(locale, "section.memories") },
          ]}
        />
      </div>
      <div
        className="grid min-h-0 flex-1 overflow-hidden min-[1536px]:relative min-[1536px]:left-1/2 min-[1536px]:w-screen min-[1536px]:-translate-x-1/2 min-[1536px]:grid-cols-[var(--left)_minmax(0,1440px)_var(--right)]"
        style={gridStyle}
      >
        <aside
          className="relative hidden min-w-0 overflow-visible border-r border-line bg-paper min-[1536px]:block"
          aria-label={uiMessage(locale, "ui.subscriptions")}
          aria-hidden={!layout.leftOpen}
          {...(!layout.leftOpen ? { inert: true } : {})}
        >
          {layout.leftOpen && (
            <>
              <div className="flex min-h-10 shrink-0 items-center justify-between border-b border-line px-3">
                <span className="caps-label">{uiMessage(locale, "ui.subscriptions")}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${uiMessage(locale, "ui.subscriptions")} · ${uiMessage(locale, "ui.close")}`}
                  onClick={() => setLayout({ ...layout, leftOpen: false })}
                >
                  <PanelLeft className="size-3" aria-hidden="true" />
                </Button>
              </div>
              <div className="h-[calc(100%-40px)] overflow-x-auto overflow-y-auto p-3">
                {subscriptions ?? (
                  <p className="text-[12px] text-ink-2">{uiMessage(locale, "ui.subscriptions")}</p>
                )}
              </div>
              <button
                type="button"
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={uiMessage(locale, "ui.resizeSubscriptions")}
                aria-valuemin={220}
                aria-valuemax={420}
                aria-valuenow={layout.leftWidth}
                className="absolute inset-y-0 -right-1.5 z-10 hidden w-3 cursor-col-resize min-[1536px]:block"
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

        <div className="relative col-start-1 flex min-h-0 min-w-0 flex-col min-[1536px]:col-start-2">
          {!layout.leftOpen && (
            <Button
              ref={leftToggle}
              variant="ghost"
              size="icon-sm"
              className="absolute left-3 top-1.5 z-10 hidden min-[1536px]:inline-flex"
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
              className="absolute right-3 top-1.5 z-10 hidden lg:inline-flex min-[1536px]:hidden"
              aria-label={uiMessage(locale, "ui.openVisualization")}
              onClick={() => setLayout({ ...layout, rightOpen: true })}
            >
              <PanelRight className="size-3.5" aria-hidden="true" />
            </Button>
          )}
          {!layout.rightOpen && (
            <Button
              ref={wideRightToggle}
              variant="ghost"
              size="icon-sm"
              className="absolute right-3 top-1.5 z-10 hidden min-[1536px]:inline-flex"
              aria-label={uiMessage(locale, "ui.openVisualization")}
              onClick={() => setLayout({ ...layout, rightOpen: true })}
            >
              <PanelRight className="size-3.5" aria-hidden="true" />
            </Button>
          )}
          {compactView !== "chat" && (
            <div
              ref={compactPanel}
              tabIndex={-1}
              className="min-h-full min-w-0 overflow-x-auto overflow-y-auto bg-paper p-3 outline-none min-[1536px]:hidden"
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
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col max-[1023px]:min-w-[496px]",
              compactView !== "chat" && "hidden min-[1536px]:flex",
            )}
          >
            <div className="flex shrink-0 justify-center border-b border-line px-4 py-1.5 lg:hidden max-[1535px]:translate-x-[7px]">
              <Segmented
                aria-label={uiMessage(locale, "ui.conversation")}
                value={layout.mobileTab}
                onChange={(value) => setLayout({ ...layout, mobileTab: value })}
                options={[
                  { value: "chat", label: uiMessage(locale, "ui.conversation") },
                  {
                    value: "visualization",
                    label: uiMessage(locale, "ui.visualization"),
                    "aria-label": uiMessage(locale, "ui.visualization"),
                  },
                ]}
              />
            </div>
            <div
              className="flex min-h-0 flex-1 overflow-hidden lg:min-w-0 lg:grid lg:grid-cols-[minmax(0,62fr)_minmax(0,38fr)]"
              style={centerGridStyle}
            >
              <div
                className={cn(
                  "relative flex min-h-0 flex-1 flex-col bg-paper lg:min-w-0",
                  layout.mobileTab !== "chat" && "hidden lg:flex",
                )}
              >
                <div className="flex min-h-0 flex-1 flex-col">{chatView}</div>
                {composerProps && <Composer {...composerProps} />}
              </div>
              <div
                className={cn(
                  "relative hidden min-h-0 min-w-0 overflow-hidden bg-paper lg:block",
                  !layout.rightOpen && "hidden min-[1536px]:block",
                )}
              >
                {layout.rightOpen && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="absolute right-3 top-1.5 z-10 bg-paper"
                    aria-label={`${uiMessage(locale, "ui.visualization")} · ${uiMessage(locale, "ui.close")}`}
                    onClick={() => setLayout({ ...layout, rightOpen: false })}
                  >
                    <PanelRight className="size-3" aria-hidden="true" />
                  </Button>
                )}
                <div className="h-full min-h-0">{vizView}</div>
              </div>
              <div
                className={cn(
                  "min-h-0 flex-1 overflow-hidden bg-paper lg:hidden",
                  layout.mobileTab !== "visualization" && "hidden",
                )}
              >
                {vizView}
              </div>
            </div>
          </div>
        </div>

        <aside
          className="relative hidden min-w-0 overflow-visible border-l border-line bg-paper min-[1536px]:col-start-3 min-[1536px]:block"
          aria-label={uiMessage(locale, "section.memories")}
          aria-hidden={!layout.rightOpen}
          {...(!layout.rightOpen ? { inert: true } : {})}
        >
          {layout.rightOpen && (
            <>
              <div className="flex min-h-10 shrink-0 items-center justify-between border-b border-line px-3">
                <span className="caps-label">{uiMessage(locale, "section.memories")}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${uiMessage(locale, "section.memories")} · ${uiMessage(locale, "ui.close")}`}
                  onClick={() => setLayout({ ...layout, rightOpen: false })}
                >
                  <PanelRight className="size-3" aria-hidden="true" />
                </Button>
              </div>
              <div className="h-[calc(100%-40px)] overflow-x-auto overflow-y-auto p-3">
                {memories}
              </div>
              <button
                type="button"
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={uiMessage(locale, "ui.resizeVisualization")}
                aria-valuemin={280}
                aria-valuemax={480}
                aria-valuenow={layout.rightWidth}
                className="absolute inset-y-0 -left-1.5 z-10 hidden w-3 cursor-col-resize min-[1536px]:block"
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
