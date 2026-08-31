import {
  DEFAULT_MARKET_FOR_LOCALE,
  type Locale,
  type LocaleMarketPair,
  type Market,
  isLocale,
  resolveRedirectTarget,
} from "@hartlib/i18n";
import { DEMO_STORAGE_KEYS, readDemoStorage, writeDemoStorage } from "./storage-registry";

export function getStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const value = readDemoStorage("local", DEMO_STORAGE_KEYS.locale);
    return value && isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function setStoredLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  try {
    writeDemoStorage("local", DEMO_STORAGE_KEYS.locale, locale);
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
  const acceptLanguage = readAcceptLanguage();

  return resolveRedirectTarget({
    ...(storedLocale !== null ? { storedLocale } : {}),
    ...(acceptLanguage !== undefined ? { acceptLanguage } : {}),
  });
}

export const resolveDemoLocaleMarket = (
  explicitLocale: Locale | null,
  detected: LocaleMarketPair,
  forcedMarket: Market | null = null,
): LocaleMarketPair =>
  explicitLocale === null
    ? { locale: detected.locale, market: DEFAULT_MARKET_FOR_LOCALE[detected.locale] }
    : {
        locale: explicitLocale,
        market:
          forcedMarket === DEFAULT_MARKET_FOR_LOCALE[explicitLocale]
            ? forcedMarket
            : DEFAULT_MARKET_FOR_LOCALE[explicitLocale],
      };
