import {
  DEFAULT_LOCALE,
  DEFAULT_MARKET,
  type Locale,
  LOCALE_MARKET_ALIASES,
  type LocaleMarketPair,
  type Market,
  isMarket,
  isLocale,
  resolveRedirectTarget,
} from "@brief/i18n";

const LOCALE_STORAGE_KEY = "brief:web:locale";
const MARKET_STORAGE_KEY = "brief:web:market";

export const LOCALE_INDEPENDENT_PATH_LANGUAGES: Readonly<Record<string, string>> = {
  "/docs": "en",
  "/docs/": "en",
};

/**
 * Read a previously stored locale choice from localStorage. Returns `null` when
 * nothing is stored or the value is not a valid locale.
 */
export function getStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (value && isLocale(value)) return value;
    return null;
  } catch {
    return null;
  }
}

/** Persist the user's locale choice so future visits are consistent. */
export function setStoredLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

/**
 * Read a previously stored market choice from localStorage. Returns `null` when
 * nothing is stored or the value is not a valid market.
 */
export function getStoredMarket(): Market | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(MARKET_STORAGE_KEY);
    if (value && isMarket(value)) return value;
    return null;
  } catch {
    return null;
  }
}

/** Persist the user's market choice so future visits are consistent. */
export function setStoredMarket(market: Market): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MARKET_STORAGE_KEY, market);
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

/**
 * Resolve the initial (locale, market) for a neutral entry point.
 *
 * Precedence (delegated to {@link resolveRedirectTarget}):
 * 1. Stored explicit user choice.
 * 2. Browser `navigator.languages` (mapped to Accept-Language).
 * 3. Default `fr-FR` / `FR`.
 */
export function detectLocale(): LocaleMarketPair {
  if (typeof window === "undefined") {
    return { locale: DEFAULT_LOCALE, market: DEFAULT_MARKET };
  }

  const storedLocale = getStoredLocale();
  const storedMarket = getStoredMarket();
  const acceptLanguage = window.navigator.languages?.join(",").trim() || undefined;

  return resolveRedirectTarget({
    ...(storedLocale ? { storedLocale } : {}),
    ...(storedMarket ? { storedMarket } : {}),
    ...(acceptLanguage ? { acceptLanguage } : {}),
  });
}

/**
 * Extract a valid locale from the first path segment of a pathname.
 *
 * Accepts both canonical locales (`fr-FR`, `en-US`) and short aliases
 * (`fr`, `us`), resolving aliases to their canonical locale. Returns `null`
 * when the first segment is not a locale or alias.
 */
export function parseLocaleFromPath(pathname: string): Locale | null {
  const segment = pathname.replace(/^\/+/, "").split("/")[0];
  if (!segment) return null;

  if (isLocale(segment)) return segment;

  const alias = LOCALE_MARKET_ALIASES[segment];
  if (alias) return alias.locale;

  return null;
}

/**
 * Ensure a pathname has a locale prefix. Locale-independent paths and paths
 * that already have a locale are returned unchanged; every other path receives
 * the detected (or default) locale.
 */
export function ensureLocalePrefix(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (
    LOCALE_INDEPENDENT_PATH_LANGUAGES[normalized] !== undefined ||
    parseLocaleFromPath(normalized)
  ) {
    return normalized;
  }

  const { locale } = detectLocale();
  return `/${locale}${normalized}`;
}
