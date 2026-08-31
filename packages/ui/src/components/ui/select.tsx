import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "../../lib/utils";

type SelectCtx = {
  value: string | undefined;
  setValue: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  activeValue: string | undefined;
  setActiveValue: (value: string | undefined) => void;
  contentId: string;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
  setOption: (value: string, label: ReactNode | undefined) => void;
  labels: Readonly<Record<string, ReactNode>>;
};
const SelectContext = createContext<SelectCtx | null>(null);

export function Select({
  value: controlled,
  defaultValue,
  onValueChange,
  children,
  className,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const [value, setValueState] = useState(controlled ?? defaultValue);
  const [open, setOpenState] = useState(false);
  const [activeValue, setActiveValue] = useState<string | undefined>(controlled ?? defaultValue);
  const [labels, setLabels] = useState<Record<string, ReactNode>>({});
  const contentId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (next) setActiveValue((current) => current ?? value);
    },
    [value],
  );
  const setValue = useCallback(
    (next: string) => {
      if (controlled === undefined) setValueState(next);
      setActiveValue(next);
      onValueChange?.(next);
      setOpenState(false);
    },
    [controlled, onValueChange],
  );
  const setOption = useCallback((next: string, label: ReactNode | undefined) => {
    setLabels((current) => {
      if (current[next] === label) return current;
      const nextLabels = { ...current };
      if (label === undefined) delete nextLabels[next];
      else nextLabels[next] = label;
      return nextLabels;
    });
  }, []);
  useEffect(() => {
    if (controlled !== undefined) {
      setValueState(controlled);
      setActiveValue(controlled);
    }
  }, [controlled]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenState(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const contextValue = useMemo(
    () => ({
      value,
      setValue,
      open,
      setOpen,
      activeValue,
      setActiveValue,
      contentId,
      triggerRef,
      setOption,
      labels,
    }),
    [activeValue, contentId, labels, open, setOpen, setOption, setValue, value],
  );
  return (
    <SelectContext.Provider value={contextValue}>
      <div ref={root} className={cn("relative", className)}>
        {children}
      </div>
    </SelectContext.Provider>
  );
}

export function SelectTrigger({
  children,
  className,
  onClick,
  onKeyDown,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ctx = useContext(SelectContext);
  return (
    <button
      ref={ctx?.triggerRef}
      type="button"
      aria-haspopup="listbox"
      aria-expanded={ctx?.open ?? false}
      aria-controls={ctx?.contentId}
      className={cn(
        "flex h-7 w-full items-center justify-between gap-2 rounded-tiny border border-line-2 bg-surface px-2.5 text-left text-[13px] text-ink hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-accent",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx?.setOpen(!ctx.open);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !ctx) return;
        if (event.key === "Escape" && ctx.open) {
          event.preventDefault();
          event.stopPropagation();
          ctx.setOpen(false);
          ctx.triggerRef.current?.focus();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
        event.preventDefault();
        ctx.setOpen(true);
      }}
      {...props}
    >
      {children}
      <ChevronDown className="size-3.5 text-ink-2" aria-hidden="true" />
    </button>
  );
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  const ctx = useContext(SelectContext);
  const label =
    (ctx?.value === undefined ? undefined : ctx.labels[ctx.value]) ??
    ctx?.value ??
    placeholder ??
    "";
  return <span className={cn(!ctx?.value && "text-ink-2")}>{label}</span>;
}

export function SelectContent({
  children,
  className,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const ctx = useContext(SelectContext);
  const trigger = ctx?.triggerRef.current;
  const labelledBy = trigger?.getAttribute("aria-labelledby") ?? undefined;
  const label = ariaLabel ?? trigger?.getAttribute("aria-label") ?? "Select";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctx?.open) return;
    const target =
      (ctx.activeValue === undefined
        ? null
        : ref.current?.querySelector<HTMLButtonElement>(
            `[data-select-value="${CSS.escape(ctx.activeValue)}"]`,
          )) ?? ref.current?.querySelector<HTMLButtonElement>("[role=option]");
    requestAnimationFrame(() => target?.focus());
  }, [ctx?.activeValue, ctx?.open]);
  if (!ctx?.open) return null;
  return (
    <div
      ref={ref}
      id={ctx.contentId}
      role="listbox"
      aria-label={labelledBy === undefined ? label : undefined}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      className={cn(
        "absolute z-50 mt-1 max-h-72 min-w-full overflow-y-auto rounded-tiny border border-line-2 bg-surface p-1 shadow-none animate-enter",
        className,
      )}
      onKeyDown={(event) => {
        const options = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=option]"),
        ).filter((option) => !option.disabled);
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          ctx.setOpen(false);
          ctx.triggerRef.current?.focus();
          return;
        }
        if (
          options.length === 0 ||
          !["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)
        )
          return;
        event.preventDefault();
        const index = options.findIndex((option) => option.dataset.selectValue === ctx.activeValue);
        if (event.key === "Enter" || event.key === " ") {
          const option = options[Math.max(index, 0)];
          if (option) option.click();
          return;
        }
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : (Math.max(index, 0) + (event.key === "ArrowUp" ? -1 : 1) + options.length) %
                options.length;
        const option = options[nextIndex];
        if (!option) return;
        ctx.setActiveValue(option.dataset.selectValue);
        option.focus();
      }}
    >
      {children}
    </div>
  );
}

export function SelectItem({
  value,
  children,
  disabled,
  className,
}: {
  value: string;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const ctx = useContext(SelectContext);
  const selected = ctx?.value === value;
  useEffect(() => {
    ctx?.setOption(value, children);
  }, [children, ctx?.setOption, value]);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-select-value={value}
      disabled={disabled}
      className={cn(
        "flex min-h-7 w-full items-center gap-2 rounded-tiny px-1.5 py-1 text-left text-[13px] hover:bg-paper-deep disabled:pointer-events-none disabled:opacity-45",
        selected && "font-medium",
        className,
      )}
      onClick={() => ctx?.setValue(value)}
      onMouseEnter={() => ctx?.setActiveValue(value)}
    >
      {children}
      {selected && <Check className="ml-auto size-3 text-accent" />}
    </button>
  );
}
export function SelectLabel({ children }: { children: ReactNode }) {
  return <p className="caps-label px-1.5 py-1 text-ink-2">{children}</p>;
}
export function SelectGroup({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}
