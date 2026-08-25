import { useId, useMemo, useRef, useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { formatMonthYear } from "@/lib/format";
import { Button } from "./button";

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * DatePicker used to schedule publications. Calendar grid with roving
 * tabindex: arrows move by day, PageUp/PageDown by month, Home/End to week
 * bounds. All labels localized through Intl.
 */
export function DatePicker({
  value,
  onChange,
  ariaLabel,
  className,
  placeholder,
  invalid,
}: {
  value: string | null; // yyyy-mm-dd
  onChange: (iso: string | null) => void;
  ariaLabel: string;
  className?: string;
  placeholder?: string;
  invalid?: boolean;
}) {
  const { locale, t } = useI18n();
  const gridId = useId();
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => startOfDay(value ? new Date(value + "T12:00:00") : new Date()));
  const focusRef = useRef<HTMLButtonElement | null>(null);

  const intlLocale = locale === "fr" ? "fr-FR" : "en-US";
  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(intlLocale, { weekday: "narrow" });
    const base = new Date(2024, 0, 1); // Monday
    return Array.from({ length: 7 }, (_, i) => fmt.format(addDays(base, i)));
  }, [intlLocale]);
  // Intl.Locale weekInfo is not in TS lib types; hardcode the two demo locales.
  const firstDayIdx = intlLocale === "en-US" ? 0 : 1;
  const days = useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const offset = (first.getDay() - firstDayIdx + 7) % 7;
    const start = addDays(first, -offset);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [viewMonth, firstDayIdx]);

  const dateAria = (d: Date) => new Intl.DateTimeFormat(intlLocale, { dateStyle: "full" }).format(d);
  const todayIso = iso(startOfDay(new Date()));

  const moveFocus = (from: Date, days: number) => {
    const target = addDays(from, days);
    if (target.getMonth() !== viewMonth.getMonth()) setViewMonth(new Date(target.getFullYear(), target.getMonth(), 1));
    requestAnimationFrame(() => {
      const cell = document.querySelector<HTMLButtonElement>(`[data-day="${iso(target)}"]`);
      cell?.focus();
    });
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`${ariaLabel}${value ? `, ${dateAria(new Date(value + "T12:00:00"))}` : ""}`}
          aria-invalid={invalid || undefined}
          className={cn(
            "flex h-7 w-full items-center justify-between gap-2 rounded-tiny border border-line-2 bg-surface px-2.5 text-left font-sans text-[13px]",
            "transition-colors duration-100 hover:border-ink-3",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
            "data-[state=open]:border-ink",
            invalid && "border-danger hover:border-danger",
            className,
          )}
        >
          <span className={cn("truncate", !value && "text-ink-2")}>
            {value ? new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium" }).format(new Date(value + "T12:00:00")) : (placeholder ?? t("datepicker.choose"))}
          </span>
          <CalendarDays aria-hidden="true" className="size-3.5 shrink-0 text-ink-2" />
        </button>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={6}
          align="start"
          className="z-50 w-64 rounded-tiny border border-line-2 bg-surface p-2.5 shadow-none data-[state=open]:animate-enter"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const initial = value ? new Date(value + "T12:00:00") : startOfDay(new Date());
            requestAnimationFrame(() => {
              const cell = document.querySelector<HTMLButtonElement>(`[data-day="${iso(initial)}"]`) ?? focusRef.current;
              cell?.focus();
            });
          }}
        >
          <div className="mb-1.5 flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("datepicker.prevMonth")}
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <p aria-live="polite" className="font-display text-[14px] font-medium">
              {formatMonthYear(locale, viewMonth)}
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("datepicker.nextMonth")}
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
          <div id={gridId} role="grid" aria-label={formatMonthYear(locale, viewMonth)} className="grid grid-cols-7 gap-y-0.5">
            <div role="row" className="col-span-7 grid grid-cols-7">
              {weekdays.map((w, i) => (
                <div key={i} role="columnheader" className="flex h-6 items-center justify-center font-sans text-[10.5px] font-medium text-ink-2">
                  <span aria-hidden="true">{w}</span>
                </div>
              ))}
            </div>
            <div role="row" className="col-span-7 grid grid-cols-7">
              {days.map((d) => {
                const inMonth = d.getMonth() === viewMonth.getMonth();
                const selected = value === iso(d);
                const isToday = iso(d) === todayIso;
                return (
                  <button
                    key={iso(d)}
                    type="button"
                    role="gridcell"
                    tabIndex={-1}
                    data-day={iso(d)}
                    aria-selected={selected}
                    aria-label={dateAria(d)}
                    aria-current={isToday ? "date" : undefined}
                    ref={focusRef.current === null && iso(d) === "1970-01-01" ? focusRef : undefined}
                    onClick={() => {
                      onChange(iso(d));
                      setOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowRight") { e.preventDefault(); moveFocus(d, 1); }
                      else if (e.key === "ArrowLeft") { e.preventDefault(); moveFocus(d, -1); }
                      else if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(d, 7); }
                      else if (e.key === "ArrowUp") { e.preventDefault(); moveFocus(d, -7); }
                      else if (e.key === "Home") { e.preventDefault(); moveFocus(d, -((d.getDay() - firstDayIdx + 7) % 7)); }
                      else if (e.key === "End") { e.preventDefault(); moveFocus(d, 6 - ((d.getDay() - firstDayIdx + 7) % 7)); }
                      else if (e.key === "PageUp") { e.preventDefault(); setViewMonth(new Date(d.getFullYear(), d.getMonth() - 1, 1)); }
                      else if (e.key === "PageDown") { e.preventDefault(); setViewMonth(new Date(d.getFullYear(), d.getMonth() + 1, 1)); }
                    }}
                    className={cn(
                      "relative flex size-8 items-center justify-center rounded-tiny font-sans text-[12.5px] transition-colors duration-100",
                      "hover:bg-paper-deep focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                      inMonth ? "text-ink" : "text-ink-3",
                      selected && "bg-ink font-semibold text-paper hover:bg-ink",
                      isToday && !selected && "after:absolute after:bottom-1 after:size-1 after:rounded-full after:bg-accent",
                    )}
                  >
                    <span aria-hidden="true">{d.getDate()}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-2 flex justify-between border-t border-line pt-2">
            <Button variant="ghost" size="sm" onClick={() => { onChange(null); setOpen(false); }}>
              {t("datepicker.clear")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { onChange(todayIso); setOpen(false); }}>
              {t("datepicker.today")}
            </Button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
