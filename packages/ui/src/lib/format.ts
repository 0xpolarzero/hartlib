import { catalogs, messageForLocale } from "@hartlib/i18n/catalogs";
import type { Messages } from "@hartlib/i18n";

export type Locale = "en-US" | "fr-FR";

const asIntlLocale = (locale: Locale | string): string =>
  locale === "fr" || locale === "fr-FR" ? "fr-FR" : "en-US";

/** Resolve chrome copy from the canonical catalogs without requiring a React provider. */
export function uiMessage(locale: Locale | string | undefined, id: keyof Messages): string {
  const resolvedLocale = asIntlLocale(locale ?? "en-US") as Locale;
  const catalog = catalogs[resolvedLocale];
  if (!Object.prototype.hasOwnProperty.call(catalog, id))
    throw new Error(`Missing localized message: ${String(id)}`);
  return messageForLocale(resolvedLocale, id);
}

export function formatNumber(locale: Locale | string, value: number): string {
  return new Intl.NumberFormat(asIntlLocale(locale)).format(value);
}

export function formatDate(
  locale: Locale | string,
  value: string | Date | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(asIntlLocale(locale), { dateStyle: "medium" }).format(date);
}

export function formatDateShort(
  locale: Locale | string,
  value: string | Date | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(asIntlLocale(locale), { dateStyle: "short" }).format(date);
}

export function formatTime(locale: Locale | string, value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(asIntlLocale(locale), { timeStyle: "short" }).format(date);
}

export function formatDateTime(locale: Locale | string, value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(asIntlLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatMonthYear(locale: Locale | string, value: Date): string {
  return new Intl.DateTimeFormat(asIntlLocale(locale), { month: "long", year: "numeric" }).format(
    value,
  );
}

export function formatBytes(locale: Locale | string, value: number): string {
  const isFrench = asIntlLocale(locale) === "fr-FR";
  const units = isFrench ? ["o", "Ko", "Mo"] : ["B", "kB", "MB"];
  if (value < 1_000) return `${value} ${units[0]}`;
  if (value < 1_000_000) return `${formatNumber(locale, Math.round(value / 1_000))} ${units[1]}`;
  return `${formatNumber(locale, Math.round(value / 1_000_000))} ${units[2]}`;
}
