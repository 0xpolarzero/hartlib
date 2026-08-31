import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

type CommandItemRecord = {
  id: string;
  value: string;
  label: string;
  keywords: string;
  disabled: boolean;
  onSelect?: () => void;
};

type CommandContextValue = {
  listId: string;
  activeId: string | null;
  query: string;
  setQuery: (query: string) => void;
  matches: (value: string, label: string, keywords: string) => boolean;
  register: (item: CommandItemRecord) => () => void;
  isVisible: (id: string) => boolean;
  isActive: (id: string) => boolean;
  move: (direction: "next" | "previous" | "first" | "last") => void;
  select: (id: string) => void;
  hasVisibleItems: boolean;
  firstEnabledId: string | null;
  registryReady: boolean;
};

const CommandContext = createContext<CommandContextValue | null>(null);

const textContent = (children: ReactNode): string => {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textContent).join(" ");
  return "";
};

export type CommandProps = HTMLAttributes<HTMLDivElement> & {
  defaultValue?: string;
  defaultActiveId?: string;
  listId?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  onSelect?: (value: string) => void;
};

export function Command({
  defaultValue = "",
  defaultActiveId,
  listId: requestedListId,
  value: controlledValue,
  onValueChange,
  onSelect,
  className,
  children,
  ...props
}: CommandProps) {
  const generatedListId = `${useId()}-list`;
  const listId = requestedListId ?? generatedListId;
  const [internalQuery, setInternalQuery] = useState(defaultValue);
  const query = controlledValue ?? internalQuery;
  const [items, setItems] = useState<CommandItemRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(defaultActiveId ?? null);
  const [registryReady, setRegistryReady] = useState(false);
  useEffect(() => setRegistryReady(true), []);
  const matches = useCallback(
    (itemValue: string, label: string, keywords: string) => {
      const normalized = query.trim().toLocaleLowerCase();
      return (
        !normalized ||
        itemValue.toLocaleLowerCase().includes(normalized) ||
        label.toLocaleLowerCase().includes(normalized) ||
        keywords.toLocaleLowerCase().includes(normalized)
      );
    },
    [query],
  );
  const setQuery = useCallback(
    (next: string) => {
      if (controlledValue === undefined) setInternalQuery(next);
      onValueChange?.(next);
    },
    [controlledValue, onValueChange],
  );
  const register = useCallback((item: CommandItemRecord) => {
    setItems((current) => {
      const existing = current.findIndex((candidate) => candidate.id === item.id);
      if (existing < 0) return [...current, item];
      const next = current.slice();
      next[existing] = item;
      return next;
    });
    return () => setItems((current) => current.filter((candidate) => candidate.id !== item.id));
  }, []);
  const visibleItems = useMemo(() => {
    return items.filter((item) => matches(item.value, item.label, item.keywords));
  }, [items, matches]);
  const enabledItems = useMemo(() => visibleItems.filter((item) => !item.disabled), [visibleItems]);
  useEffect(() => {
    if (enabledItems.some((item) => item.id === activeId)) return;
    setActiveId(enabledItems[0]?.id ?? null);
  }, [activeId, enabledItems]);
  const isVisible = useCallback(
    (id: string) => visibleItems.some((item) => item.id === id),
    [visibleItems],
  );
  const isActive = useCallback((id: string) => activeId === id, [activeId]);
  const move = useCallback(
    (direction: "next" | "previous" | "first" | "last") => {
      if (enabledItems.length === 0) return;
      const current = Math.max(
        0,
        enabledItems.findIndex((item) => item.id === activeId),
      );
      const index =
        direction === "first"
          ? 0
          : direction === "last"
            ? enabledItems.length - 1
            : (current + (direction === "next" ? 1 : -1) + enabledItems.length) %
              enabledItems.length;
      setActiveId(enabledItems[index]?.id ?? null);
    },
    [activeId, enabledItems],
  );
  const select = useCallback(
    (id: string) => {
      const item = items.find((candidate) => candidate.id === id);
      if (!item || item.disabled || !isVisible(id)) return;
      item.onSelect?.();
      onSelect?.(item.value);
    },
    [isVisible, items, onSelect],
  );
  const context = useMemo<CommandContextValue>(
    () => ({
      listId,
      activeId,
      query,
      setQuery,
      matches,
      register,
      isVisible,
      isActive,
      move,
      select,
      hasVisibleItems: visibleItems.length > 0,
      firstEnabledId: enabledItems[0]?.id ?? null,
      registryReady,
    }),
    [
      activeId,
      isActive,
      isVisible,
      listId,
      matches,
      move,
      query,
      register,
      registryReady,
      select,
      setQuery,
      enabledItems,
      visibleItems.length,
    ],
  );
  return (
    <CommandContext.Provider value={context}>
      <div {...props} data-command-root="true" className={cn("grid", className)}>
        {children}
      </div>
    </CommandContext.Provider>
  );
}

export const CommandInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, value: inputValue, onChange, onKeyDown, ...props }, ref) => {
    const context = useContext(CommandContext);
    const value = context && inputValue === undefined ? context.query : inputValue;
    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || !context) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        context.move("next");
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        context.move("previous");
      } else if (event.key === "Home") {
        event.preventDefault();
        context.move("first");
      } else if (event.key === "End") {
        event.preventDefault();
        context.move("last");
      } else if (event.key === "Enter") {
        const selectedId =
          context.activeId !== null && context.isVisible(context.activeId)
            ? context.activeId
            : context.firstEnabledId;
        if (selectedId !== null) {
          event.preventDefault();
          context.select(selectedId);
        }
      }
    };
    return (
      <div className="flex items-center border-b border-line px-3.5">
        <input
          ref={ref}
          role="combobox"
          aria-expanded="true"
          aria-controls={context?.listId}
          aria-autocomplete="list"
          aria-activedescendant={context?.activeId ?? undefined}
          className={cn(
            "h-11 w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-2",
            className,
          )}
          {...props}
          {...(value === undefined ? {} : { value })}
          onChange={(event) => {
            onChange?.(event);
            if (!event.defaultPrevented) context?.setQuery(event.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
      </div>
    );
  },
);
CommandInput.displayName = "CommandInput";

export function CommandList({ className, id, role, ...props }: HTMLAttributes<HTMLDivElement>) {
  const context = useContext(CommandContext);
  return (
    <div
      id={id ?? context?.listId}
      role={role ?? "listbox"}
      className={cn("max-h-[min(60vh,26rem)] overflow-y-auto p-1.5", className)}
      {...props}
    />
  );
}

export function CommandEmpty({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const context = useContext(CommandContext);
  if (!context?.registryReady || context.hasVisibleItems) return null;
  return (
    <div className={cn("px-3 py-8 text-center text-[13px] text-ink-2", className)} {...props}>
      {children}
    </div>
  );
}

export function CommandGroup({
  heading,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { heading?: string }) {
  return (
    <div role="group" aria-label={heading} className={cn("overflow-hidden", className)} {...props}>
      {heading && (
        <span aria-hidden="true" className="caps-label block px-2 py-1.5 text-ink-2">
          {heading}
        </span>
      )}
      {children}
    </div>
  );
}

export const CommandItem = forwardRef<
  HTMLButtonElement,
  HTMLAttributes<HTMLButtonElement> & {
    value?: string;
    keywords?: string;
    onSelect?: () => void;
    disabled?: boolean;
  }
>(
  (
    {
      className,
      onSelect,
      onClick,
      children,
      disabled = false,
      value,
      keywords = "",
      id,
      ...props
    },
    ref,
  ) => {
    const context = useContext(CommandContext);
    const generatedId = useId();
    const itemId = id ?? generatedId;
    const label = textContent(children);
    const register = context?.register;
    const directVisible = context?.matches(value ?? label, label, keywords) ?? true;
    useEffect(() => {
      if (!register) return;
      return register({
        id: itemId,
        value: value ?? label,
        label,
        keywords,
        disabled,
        ...(onSelect === undefined ? {} : { onSelect }),
      });
    }, [disabled, itemId, keywords, label, onSelect, register, value]);
    if (context && !directVisible) return null;
    return (
      <button
        ref={ref}
        id={itemId}
        type="button"
        role="option"
        aria-selected={context?.isActive(itemId) ?? false}
        disabled={disabled}
        data-command-item-id={itemId}
        className={cn(
          "flex min-h-8 w-full cursor-pointer select-none items-center gap-2.5 rounded-tiny px-2 py-1.5 text-left text-[13px] text-ink hover:bg-paper-deep disabled:pointer-events-none disabled:text-ink-3",
          context?.isActive(itemId) && "bg-paper-deep",
          className,
        )}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || disabled) return;
          if (context) context.select(itemId);
          else onSelect?.();
        }}
        {...props}
      >
        {children}
      </button>
    );
  },
);
CommandItem.displayName = "CommandItem";

export function CommandSeparator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("my-1 h-px bg-line", className)} {...props} />;
}
