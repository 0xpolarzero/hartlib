import type frFR from "./locales/fr-FR.json";

/**
 * Locale and market primitives are owned by `@brief/shared` so that backend
 * packages (source-ingestion, worker, api) can use them without depending on
 * React or this i18n package. Re-export them here so frontend code has a
 * single import surface for everything i18n-related.
 */
export {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_FOR_MARKET,
  DEFAULT_MARKET,
  DEFAULT_MARKET_FOR_LOCALE,
  LOCALES,
  MARKETS,
  isLocale,
  isMarket,
} from "@brief/shared";
export type { Locale, Market } from "@brief/shared";

/**
 * A resolved (locale, market) pair.
 */
export type LocaleMarketPair = {
  locale: import("@brief/shared").Locale;
  market: import("@brief/shared").Market;
};

/**
 * Map of canonical demo aliases (short slugs) -> (locale, market) pair.
 * Used to produce prettier demo URLs (e.g. "/demo/us", "/demo/fr").
 */
export const LOCALE_MARKET_ALIASES: Record<string, LocaleMarketPair> = {
  fr: { locale: "fr-FR", market: "FR" },
  us: { locale: "en-US", market: "US" },
};

/**
 * Flat map of translation key -> ICU message string.
 * The keys are derived from the French (reference) catalog so that the
 * available message ids are statically known.
 */
export type Messages = typeof frFR;

/**
 * The value to set on `<html lang>`. react-intl accepts the full locale tag,
 * so the locale itself is the correct document language.
 */
export function htmlLang(locale: import("@brief/shared").Locale): string {
  return locale;
}
