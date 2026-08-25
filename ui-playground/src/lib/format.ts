import type { Locale } from "@/i18n";

const dtCache = new Map<string, Intl.DateTimeFormat>();
const nfCache = new Map<string, Intl.NumberFormat>();

function dtf(locale: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(opts);
  let f = dtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-US", opts);
    dtCache.set(key, f);
  }
  return f;
}

function nf(locale: Locale, opts: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = locale + JSON.stringify(opts);
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", opts);
    nfCache.set(key, f);
  }
  return f;
}

export const formatDate = (locale: Locale, iso: string) =>
  dtf(locale, { dateStyle: "medium" }).format(new Date(iso));

export const formatDateShort = (locale: Locale, iso: string) =>
  dtf(locale, { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(iso));

export const formatDateTime = (locale: Locale, iso: string) =>
  dtf(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

export const formatTime = (locale: Locale, iso: string) =>
  dtf(locale, { timeStyle: "short" }).format(new Date(iso));

export const formatMonthYear = (locale: Locale, date: Date) =>
  dtf(locale, { month: "long", year: "numeric" }).format(date);

export const formatNumber = (locale: Locale, n: number) => nf(locale).format(n);

export const formatPercent = (locale: Locale, n: number, digits = 1) =>
  nf(locale, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

/** Full date for aria-labels / title attributes. */
export const formatDateFull = (locale: Locale, iso: string) =>
  dtf(locale, { dateStyle: "full", timeStyle: "short" }).format(new Date(iso));

/** Byte size, localized. */
export const formatBytes = (locale: Locale, bytes: number) =>
  nf(locale, { style: "unit", unit: "kilobyte", maximumFractionDigits: 0 }).format(bytes / 1000);
