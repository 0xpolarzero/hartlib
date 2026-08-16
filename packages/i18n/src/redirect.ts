import {
  DEFAULT_LOCALE,
  DEFAULT_MARKET,
  DEFAULT_MARKET_FOR_LOCALE,
  type Locale,
  type LocaleMarketPair,
  type Market,
  isLocale,
  isMarket,
} from "./types.js";

/**
 * Resolve a {@link Locale} from an HTTP `Accept-Language` header.
 *
 * Parses q-values, preserving the client's stated preference order, then maps
 * each tag to a supported locale: any tag starting with "fr" -> "fr-FR",
 * any tag starting with "en" -> "en-US". The first mappable tag wins.
 * Falls back to {@link DEFAULT_LOCALE} when nothing maps.
 */
export function resolveLocaleFromAcceptLanguage(header: string | undefined): Locale {
  if (!header) {
    return DEFAULT_LOCALE;
  }

  // Parse "en-US,en;q=0.9,fr-FR;q=0.8" into ordered { tag, q } entries.
  const entries = header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [tag, ...params] = part.split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.split("=")[1] ?? "") : 1;
      return { tag: (tag ?? "").trim().toLowerCase(), q: Number.isNaN(q) ? 1 : q };
    })
    // A q-value of 0 means "not acceptable"; exclude those tags entirely.
    .filter((entry) => entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of entries) {
    if (tag.startsWith("fr")) {
      return "fr-FR";
    }
    if (tag.startsWith("en")) {
      return "en-US";
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * Resolve a {@link Market} from an ISO 3166-1 alpha-2 country code.
 * Returns {@link DEFAULT_MARKET} for anything that isn't an explicit market.
 */
export function resolveMarketFromCountry(country: string | undefined): Market {
  if (!country) {
    return DEFAULT_MARKET;
  }
  const normalized = country.trim().toUpperCase();
  if (isMarket(normalized)) {
    return normalized;
  }
  return DEFAULT_MARKET;
}

export interface ResolveRedirectTargetArgs {
  /** A previously stored user choice (e.g. from cookie/localStorage). */
  storedLocale?: string;
  /** A locale present in the current URL, if any. */
  urlLocale?: string;
  /** The raw `Accept-Language` header value, if available. */
  acceptLanguage?: string;
}

/**
 * Apply the neutral-entry-point redirect precedence to pick a (locale, market):
 *
 * 1. Stored explicit user choice ({@link ResolveRedirectTargetArgs.storedLocale}).
 * 2. URL locale ({@link ResolveRedirectTargetArgs.urlLocale}), if it's a valid locale.
 * 3. Browser `Accept-Language` ({@link ResolveRedirectTargetArgs.acceptLanguage}).
 * 4. Default `fr-FR` / `FR`.
 *
 * The market always comes from the resolved locale. This keeps startup state
 * aligned with the paired locale and source-market selector.
 */
export function resolveRedirectTarget(args: ResolveRedirectTargetArgs): LocaleMarketPair {
  const { storedLocale, urlLocale, acceptLanguage } = args;

  let locale: Locale;

  if (storedLocale !== undefined && isLocale(storedLocale)) {
    locale = storedLocale;
  } else if (urlLocale !== undefined && isLocale(urlLocale)) {
    locale = urlLocale;
  } else {
    locale = resolveLocaleFromAcceptLanguage(acceptLanguage);
  }

  return { locale, market: DEFAULT_MARKET_FOR_LOCALE[locale] };
}
