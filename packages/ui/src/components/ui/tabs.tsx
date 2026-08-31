import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

type TabsCtx = { value: string; setValue: (value: string) => void; id: string };
const TabsContext = createContext<TabsCtx | null>(null);
export function Tabs({
  value: controlled,
  defaultValue,
  onValueChange,
  children,
  className,
  ...props
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
} & HTMLAttributes<HTMLDivElement>) {
  const [internal, setInternal] = useState(defaultValue ?? "");
  const value = controlled ?? internal;
  const id = useId();
  const setValue = (next: string) => {
    if (controlled === undefined) setInternal(next);
    onValueChange?.(next);
  };
  return (
    <TabsContext.Provider value={{ value, setValue, id }}>
      <div {...props} className={className}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}
export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      id={`${useContext(TabsContext)?.id ?? "tabs"}-list`}
      className={cn("flex items-end gap-0.5 border-b border-line", className)}
      {...props}
    />
  );
}
export function TabsTrigger({
  value,
  className,
  children,
  disabled,
  onClick,
  onKeyDown,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) {
  const ctx = useContext(TabsContext);
  const active = ctx?.value === value;
  const tabId = `${ctx?.id ?? "tabs"}-tab-${value.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const panelId = `${ctx?.id ?? "tabs"}-panel-${value.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const move = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (
      !ctx ||
      !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    )
      return;
    const list = event.currentTarget.closest('[role="tablist"]');
    const tabs = list
      ? Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter(
          (tab) => !tab.disabled,
        )
      : [];
    if (tabs.length === 0) return;
    event.preventDefault();
    const index = tabs.indexOf(event.currentTarget);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index +
              (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
              tabs.length) %
            tabs.length;
    const nextTab = tabs[next];
    if (!nextTab) return;
    nextTab.focus();
    const nextValue = nextTab.dataset.tabValue;
    if (nextValue) ctx.setValue(nextValue);
  };
  return (
    <button
      type="button"
      role="tab"
      id={tabId}
      aria-controls={panelId}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      disabled={disabled}
      className={cn(
        "relative -mb-px min-h-8 px-2.5 pb-2 pt-1.5 font-sans text-[13px] text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45",
        active &&
          "font-medium text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-accent",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) ctx?.setValue(value);
      }}
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented) move(event);
      }}
      data-tab-value={value}
    >
      {children}
    </button>
  );
}
export function TabsContent({
  value,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { value: string }) {
  const ctx = useContext(TabsContext);
  if (ctx?.value !== value) return null;
  const suffix = value.replace(/[^A-Za-z0-9_-]/gu, "-");
  return (
    <div
      role="tabpanel"
      id={`${ctx?.id ?? "tabs"}-panel-${suffix}`}
      aria-labelledby={`${ctx?.id ?? "tabs"}-tab-${suffix}`}
      tabIndex={0}
      className={cn("pt-3", className)}
      {...props}
    >
      {children}
    </div>
  );
}
export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  "aria-label"?: string;
}
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex rounded-tiny border border-line-2 bg-paper", className)}
      onKeyDown={(e) => {
        const idx = refs.current.indexOf(document.activeElement as HTMLButtonElement);
        if (idx < 0) return;
        if (
          e.key === "ArrowRight" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowUp"
        ) {
          e.preventDefault();
          const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
          const next = (idx + delta + options.length) % options.length;
          refs.current[next]?.focus();
          onChange(options[next]!.value);
        }
      }}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            aria-label={option["aria-label"]}
            className={cn(
              "border-r border-line-2 px-2.5 font-sans font-medium text-ink-2 last:border-r-0 first:rounded-l-tiny last:rounded-r-tiny hover:bg-paper-deep hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
              size === "sm" ? "h-6 text-[11.5px]" : "h-7 text-[12.5px]",
              selected && "bg-ink text-paper hover:bg-ink",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
