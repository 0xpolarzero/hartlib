import {
  DEFAULT_MARKET_FOR_LOCALE,
  type Locale,
  type LocaleMarketPair,
  type Market,
  isLocale,
  isMarket,
  resolveRedirectTarget,
} from "@brief/i18n";

const LOCALE_STORAGE_KEY = "brief:demo:locale";
const MARKET_STORAGE_KEY = "brief:demo:market";
const MANUAL_SOURCES_STORAGE_KEY = "brief:demo:manual-sources";

export function getStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return value && isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function setStoredLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures; demo state stays in memory.
  }
}

export function getStoredMarket(): Market | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(MARKET_STORAGE_KEY);
    return value && isMarket(value) ? value : null;
  } catch {
    return null;
  }
}

export function setStoredMarket(market: Market): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MARKET_STORAGE_KEY, market);
  } catch {
    // Ignore storage failures; demo state stays in memory.
  }
}

export function setManualSourceSelection(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MANUAL_SOURCES_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Ignore storage failures; demo state stays in memory.
  }
}

export function getManualSourceSelection(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MANUAL_SOURCES_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearManualSourceSelection(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(MANUAL_SOURCES_STORAGE_KEY);
  } catch {
    // Ignore storage failures; demo state stays in memory.
  }
}

function readAcceptLanguage(): string | undefined {
  if (typeof navigator === "undefined" || !navigator.languages) return undefined;
  return navigator.languages.join(",");
}

/**
 * Resolve the initial (locale, market) pair once at app mount, when the URL has
 * no locale. Applies the neutral-entry-point precedence: stored choice wins,
 * otherwise the browser language, falling back to defaults.
 */
export function detectLocale(): LocaleMarketPair {
  const storedLocale = getStoredLocale();
  const storedMarket = getStoredMarket();
  const acceptLanguage = readAcceptLanguage();

  return resolveRedirectTarget({
    ...(storedLocale !== null ? { storedLocale } : {}),
    ...(storedMarket !== null ? { storedMarket } : {}),
    ...(acceptLanguage !== undefined ? { acceptLanguage } : {}),
  });
}

export const resolveDemoLocaleMarket = (
  explicitLocale: Locale | null,
  storedMarket: Market | null,
  detected: LocaleMarketPair,
  forcedMarket: Market | null = null,
): LocaleMarketPair =>
  explicitLocale === null
    ? detected
    : {
        locale: explicitLocale,
        market: forcedMarket ?? storedMarket ?? DEFAULT_MARKET_FOR_LOCALE[explicitLocale],
      };
