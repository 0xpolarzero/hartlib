import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { formatMonthYear, uiMessage } from "../../lib/format";
import { Button } from "./button";

const isoDate = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const parseIsoDate = (value: string | null | undefined): Date | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
};

const localToday = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
};

const startOfMonth = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

const addDays = (date: Date, amount: number): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + amount));

const addMonths = (date: Date, amount: number): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1));

const daysInMonth = (date: Date): number =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();

const clampToMonth = (date: Date, month: Date): Date =>
  new Date(
    Date.UTC(
      month.getUTCFullYear(),
      month.getUTCMonth(),
      Math.min(date.getUTCDate(), daysInMonth(month)),
    ),
  );

const intlLocale = (locale: string): string =>
  locale === "fr" || locale === "fr-FR" ? "fr-FR" : "en-US";

export function DatePicker({
  value,
  onChange,
  ariaLabel,
  placeholder,
  className,
  invalid,
  id,
  describedBy,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  locale = "en-US",
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  invalid?: boolean;
  "aria-invalid"?: boolean;
  locale?: string;
  id?: string;
  describedBy?: string;
  "aria-describedby"?: string;
}) {
  const calendarId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedDate = parseIsoDate(value);
  const today = localToday();
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(selectedDate ?? today));
  const [activeDate, setActiveDate] = useState(() => selectedDate ?? today);
  const localeTag = intlLocale(locale);
  const described = ariaDescribedBy ?? describedBy;
  const resolvedPlaceholder = placeholder ?? uiMessage(locale, "ui.chooseDate");
  const firstDayIndex = localeTag === "en-US" ? 0 : 1;

  const weekdays = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(localeTag, { weekday: "short" });
    const sunday = new Date(Date.UTC(2024, 0, 7));
    return Array.from({ length: 7 }, (_, index) =>
      formatter.format(addDays(sunday, (index + firstDayIndex) % 7)),
    );
  }, [firstDayIndex, localeTag]);

  const days = useMemo(() => {
    const first = startOfMonth(viewMonth);
    const offset = (first.getUTCDay() - firstDayIndex + 7) % 7;
    const start = addDays(first, -offset);
    return Array.from({ length: 42 }, (_, index) => addDays(start, index));
  }, [firstDayIndex, viewMonth]);

  const dateLabel = (date: Date): string =>
    new Intl.DateTimeFormat(localeTag, { dateStyle: "full" }).format(date);
  const displayDate = selectedDate
    ? new Intl.DateTimeFormat(localeTag, { dateStyle: "medium" }).format(selectedDate)
    : resolvedPlaceholder;
  const todayIso = isoDate(today);
  const activeIso = isoDate(activeDate);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const choose = (date: Date | null) => {
    onChange(date ? isoDate(date) : null);
    close();
  };

  const moveActive = (next: Date) => {
    setActiveDate(next);
    const nextMonth = startOfMonth(next);
    if (nextMonth.getTime() !== viewMonth.getTime()) setViewMonth(nextMonth);
  };

  const moveMonth = (amount: number) => {
    const nextMonth = addMonths(viewMonth, amount);
    moveActive(clampToMonth(activeDate, nextMonth));
  };

  const openCalendar = () => {
    if (open) {
      close();
      return;
    }
    const initial = selectedDate ?? today;
    setActiveDate(initial);
    setViewMonth(startOfMonth(initial));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const active = dayRefs.current.get(activeIso) ?? dayRefs.current.values().next().value;
      active?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeIso, days, open]);

  useEffect(() => {
    if (open) return;
    const next = parseIsoDate(value);
    if (next) {
      setActiveDate(next);
      setViewMonth(startOfMonth(next));
    }
  }, [open, value]);

  const onDayKeyDown = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(date);
      return;
    }
    let next: Date | null = null;
    if (event.key === "ArrowRight") next = addDays(date, 1);
    else if (event.key === "ArrowLeft") next = addDays(date, -1);
    else if (event.key === "ArrowDown") next = addDays(date, 7);
    else if (event.key === "ArrowUp") next = addDays(date, -7);
    else if (event.key === "Home") {
      const offset = (date.getUTCDay() - firstDayIndex + 7) % 7;
      next = addDays(date, -offset);
    } else if (event.key === "End") {
      const offset = (date.getUTCDay() - firstDayIndex + 7) % 7;
      next = addDays(date, 6 - offset);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      const amount = event.key === "PageUp" ? -1 : 1;
      next = clampToMonth(date, addMonths(date, event.shiftKey ? amount * 12 : amount));
    }
    if (next) {
      event.preventDefault();
      moveActive(next);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        id={id}
        type="button"
        aria-label={`${ariaLabel}${selectedDate ? `, ${dateLabel(selectedDate)}` : ""}`}
        {...(described === undefined ? {} : { "aria-describedby": described })}
        aria-expanded={open}
        aria-controls={calendarId}
        aria-haspopup="dialog"
        aria-invalid={invalid ?? ariaInvalid ?? undefined}
        className={cn(
          "flex h-7 w-full items-center justify-between gap-2 rounded-tiny border border-line-2 bg-surface px-2.5 text-left text-[13px] hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-accent",
          invalid && "border-danger",
          className,
        )}
        onClick={openCalendar}
      >
        <span className={cn(!selectedDate && "text-ink-2")}>{displayDate}</span>
        <CalendarDays className="size-3.5 shrink-0 text-ink-2" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={calendarId}
          role="dialog"
          aria-label={ariaLabel}
          className="absolute z-50 mt-1 w-64 rounded-tiny border border-line-2 bg-surface p-2.5 shadow-none animate-enter"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="mb-1.5 flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={uiMessage(locale, "ui.previousMonth")}
              onClick={() => moveMonth(-1)}
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
            </Button>
            <p aria-live="polite" className="font-display text-[14px] font-medium">
              {formatMonthYear(locale, viewMonth)}
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={uiMessage(locale, "ui.nextMonth")}
              onClick={() => moveMonth(1)}
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
          <div
            role="grid"
            aria-label={formatMonthYear(locale, viewMonth)}
            className="grid gap-y-0.5"
          >
            <div role="row" className="grid grid-cols-7">
              {weekdays.map((weekday) => (
                <div
                  key={weekday}
                  role="columnheader"
                  className="flex h-6 items-center justify-center text-[10.5px] font-medium text-ink-2"
                >
                  {weekday}
                </div>
              ))}
            </div>
            {Array.from({ length: 6 }, (_, row) => (
              <div key={row} role="row" className="grid grid-cols-7">
                {days.slice(row * 7, row * 7 + 7).map((date) => {
                  const dateKey = isoDate(date);
                  const inMonth = date.getUTCMonth() === viewMonth.getUTCMonth();
                  const selected = value === dateKey;
                  const isToday = todayIso === dateKey;
                  return (
                    <button
                      key={dateKey}
                      ref={(element) => {
                        if (element) dayRefs.current.set(dateKey, element);
                        else dayRefs.current.delete(dateKey);
                      }}
                      type="button"
                      role="gridcell"
                      tabIndex={activeIso === dateKey ? 0 : -1}
                      data-day={dateKey}
                      aria-selected={selected}
                      aria-label={dateLabel(date)}
                      aria-current={isToday ? "date" : undefined}
                      onClick={() => choose(date)}
                      onKeyDown={(event) => onDayKeyDown(event, date)}
                      className={cn(
                        "relative flex size-8 items-center justify-center rounded-tiny text-[12.5px] transition-colors duration-100 hover:bg-paper-deep focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                        inMonth ? "text-ink" : "text-ink-3",
                        selected && "bg-ink font-semibold text-paper hover:bg-ink",
                        isToday &&
                          !selected &&
                          "after:absolute after:bottom-1 after:size-1 after:rounded-full after:bg-accent",
                      )}
                    >
                      <span aria-hidden="true">{date.getUTCDate()}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between border-t border-line pt-2">
            <Button variant="ghost" size="sm" onClick={() => choose(null)}>
              {uiMessage(locale, "ui.clear")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => choose(today)}>
              {uiMessage(locale, "ui.today")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
