import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Loader2, Search } from "lucide-react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
export interface ComboboxOption {
  value: string;
  label: string;
  hint?: string;
}
export interface ComboboxProps {
  value: string | null;
  onChange: (option: ComboboxOption | null) => void;
  loader: (query: string) => Promise<ComboboxOption[]>;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  renderOption?: (option: ComboboxOption) => ReactNode;
  locale?: string;
}
export function Combobox({
  value,
  onChange,
  loader,
  placeholder,
  ariaLabel,
  className,
  renderOption,
  locale = "en-US",
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ComboboxOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const [selectedOption, setSelectedOption] = useState<ComboboxOption | null>(null);
  const seq = useRef(0);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const close = () => {
    seq.current += 1;
    setOpen(false);
    setQuery("");
    setActive(-1);
  };
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);
  useEffect(() => {
    if (!open) return;
    const current = ++seq.current;
    setLoading(true);
    void loader(query)
      .then((rows) => {
        if (current !== seq.current) return;
        setOptions(rows);
        setActive(rows.length ? 0 : -1);
        setLoading(false);
      })
      .catch(() => {
        if (current === seq.current) {
          setOptions([]);
          setLoading(false);
        }
      });
  }, [loader, open, query]);
  useEffect(() => {
    if (value === null) setSelectedOption(null);
    else if (selectedOption?.value !== value) {
      const option = options.find((candidate) => candidate.value === value);
      if (option) setSelectedOption(option);
    }
  }, [options, selectedOption?.value, value]);
  return (
    <div ref={root} className={cn("relative", className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-ink-3"
      />
      <input
        ref={input}
        role="combobox"
        aria-expanded={open}
        aria-controls={id}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        aria-label={ariaLabel}
        value={open ? query : (selectedOption?.label ?? value ?? "")}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && open) {
            e.preventDefault();
            setActive((n) =>
              options.length
                ? (n + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
                : -1,
            );
          } else if ((e.key === "Home" || e.key === "End") && open && options.length > 0) {
            e.preventDefault();
            setActive(e.key === "Home" ? 0 : options.length - 1);
          } else if (e.key === "Enter" && active >= 0 && options[active]) {
            e.preventDefault();
            const next = options[active]!;
            setSelectedOption(next);
            onChange(next);
            close();
            input.current?.focus();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          } else if (e.key === "Tab") {
            setOpen(false);
          }
        }}
        className="h-7 w-full rounded-tiny border border-line-2 bg-surface pl-7 pr-2.5 font-sans text-[13px] text-ink placeholder:text-ink-2/80 transition-colors duration-100 hover:border-ink-3 focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      />
      {loading && (
        <Loader2
          aria-hidden="true"
          className="absolute right-2.5 top-1/2 size-3 -translate-y-1/2 animate-spin-slow text-ink-2"
        />
      )}
      {open && (
        <ul
          id={id}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-tiny border border-line-2 bg-surface py-1 animate-enter"
        >
          {options.length === 0 && !loading && (
            <li role="presentation" className="px-2.5 py-2 text-[12.5px] text-ink-2">
              {uiMessage(locale, "ui.noResults")}
            </li>
          )}
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                setSelectedOption(option);
                onChange(option);
                close();
              }}
              className={cn(
                "flex min-h-7 cursor-pointer items-center justify-between gap-3 px-2.5 py-1 text-[13px]",
                index === active ? "bg-paper-deep" : "bg-transparent",
              )}
            >
              {renderOption ? (
                renderOption(option)
              ) : (
                <span className="truncate text-ink">{option.label}</span>
              )}
              {option.hint && (
                <span className="shrink-0 font-mono text-[11px] text-ink-2">{option.hint}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
