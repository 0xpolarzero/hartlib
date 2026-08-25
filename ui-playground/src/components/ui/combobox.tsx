import { useId, useRef, useState, type ReactNode } from "react";
import { Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

export interface ComboboxOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Searchable combobox following the WAI-ARIA authoring pattern:
 * input[role=combobox] with aria-expanded / aria-controls / aria-activedescendant,
 * popup listbox with role=option. Options are filtered asynchronously by
 * `loader` (the mock service adds latency, so a loading state is visible).
 */
export function Combobox({
  value,
  onChange,
  loader,
  placeholder,
  ariaLabel,
  className,
  renderOption,
}: {
  value: string | null;
  onChange: (option: ComboboxOption | null) => void;
  loader: (query: string) => Promise<ComboboxOption[]>;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  renderOption?: (option: ComboboxOption) => ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ComboboxOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const loadSeq = useRef(0);

  const runLoad = (q: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    loader(q)
      .then((result) => {
        if (seq !== loadSeq.current) return;
        setOptions(result);
        setActiveIndex(result.length > 0 ? 0 : -1);
        setLoading(false);
      })
      .catch(() => {
        if (seq !== loadSeq.current) return;
        setOptions([]);
        setLoading(false);
      });
  };

  const openList = () => {
    setOpen(true);
    runLoad(query);
  };

  const select = (option: ComboboxOption) => {
    onChange(option);
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((idx) => (options.length ? (idx + delta + options.length) % options.length : -1));
    } else if (e.key === "Enter") {
      if (open && activeIndex >= 0 && options[activeIndex]) {
        e.preventDefault();
        select(options[activeIndex]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.stopPropagation();
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const selectedLabel = value;

  return (
    <div className={cn("relative", className)}>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-ink-3" />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
          aria-label={ariaLabel}
          value={open ? query : (selectedLabel ?? query)}
          placeholder={placeholder}
          onClick={() => {
            if (!open) openList();
          }}
          onFocus={() => {
            if (!open) openList();
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            openList();
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "h-7 w-full rounded-tiny border border-line-2 bg-surface pl-7 pr-2.5 font-sans text-[13px] text-ink",
            "placeholder:text-ink-2/80 transition-colors duration-100 hover:border-ink-3",
            "focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
          )}
        />
        {loading && (
          <Loader2 aria-hidden="true" className="absolute right-2.5 top-1/2 size-3 -translate-y-1/2 animate-spin-slow text-ink-2" />
        )}
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-tiny border border-line-2 bg-surface py-1 animate-enter"
        >
          {options.length === 0 && !loading && (
            <li className="px-2.5 py-2 text-[12.5px] text-ink-2" role="presentation">
              {t("combobox.noResults")}
            </li>
          )}
          {options.map((opt, i) => (
            <li
              key={opt.value}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                select(opt);
              }}
              className={cn(
                "flex min-h-7 cursor-pointer items-center justify-between gap-3 px-2.5 py-1 text-[13px]",
                i === activeIndex ? "bg-paper-deep" : "bg-transparent",
              )}
            >
              {renderOption ? renderOption(opt) : <span className="truncate text-ink">{opt.label}</span>}
              {opt.hint && <span className="shrink-0 font-mono text-[11px] text-ink-2">{opt.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
