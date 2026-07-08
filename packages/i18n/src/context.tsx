import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import {
  FormattedDate,
  FormattedMessage,
  FormattedNumber,
  FormattedRelativeTime,
  FormattedTime,
  IntlProvider,
  useIntl,
} from "react-intl";

import {
  DEFAULT_LOCALE,
  type Locale,
  type LocaleMarketPair,
  type Market,
  type Messages,
  isLocale,
  isMarket,
} from "./types.js";

// Re-export react-intl primitives so apps import i18n helpers from one place.
export {
  FormattedDate,
  FormattedMessage,
  FormattedNumber,
  FormattedRelativeTime,
  FormattedTime,
  useIntl,
};

import frFR from "./locales/fr-FR.json";
import enUS from "./locales/en-US.json";

/** Catalogs keyed by locale. Indexing with a `Locale` is always safe. */
const catalogs: Record<Locale, Messages> = {
  "fr-FR": frFR,
  "en-US": enUS,
};

interface LocaleMarketContextValue {
  locale: Locale;
  market: Market;
  setLocaleMarket: (next: LocaleMarketPair) => void;
}

const LocaleMarketContext = createContext<LocaleMarketContextValue | null>(null);

export interface I18nProviderProps {
  locale: Locale;
  market: Market;
  /** Called when a consumer requests a new (locale, market) pair. */
  onChangeLocaleMarket?: (next: LocaleMarketPair) => void;
  children: ReactNode;
}

/**
 * Top-level i18n provider. Wraps `react-intl`'s `IntlProvider` and exposes the
 * current (locale, market) pair plus a setter via {@link LocaleMarketContext}.
 *
 * The `onChangeLocaleMarket` callback is the integration seam: it is invoked
 * with the requested pair, and the app layer is responsible for persisting the
 * choice and navigating/redirecting.
 */
export function I18nProvider({
  locale,
  market,
  onChangeLocaleMarket,
  children,
}: I18nProviderProps): ReactNode {
  const setLocaleMarket = useCallback(
    (next: LocaleMarketPair) => {
      if (!isLocale(next.locale) || !isMarket(next.market)) {
        return;
      }
      onChangeLocaleMarket?.(next);
    },
    [onChangeLocaleMarket],
  );

  const contextValue = useMemo<LocaleMarketContextValue>(
    () => ({ locale, market, setLocaleMarket }),
    [locale, market, setLocaleMarket],
  );

  return (
    <LocaleMarketContext.Provider value={contextValue}>
      <IntlProvider locale={locale} defaultLocale={DEFAULT_LOCALE} messages={catalogs[locale]}>
        {children}
      </IntlProvider>
    </LocaleMarketContext.Provider>
  );
}

function useLocaleMarketContext(): LocaleMarketContextValue {
  const value = useContext(LocaleMarketContext);
  if (value === null) {
    throw new Error(
      "i18n hooks must be used within an <I18nProvider>. Wrap your component tree with <I18nProvider>.",
    );
  }
  return value;
}

/** Current UI language. */
export function useLocale(): Locale {
  return useLocaleMarketContext().locale;
}

/** Current market (source-scope). */
export function useMarket(): Market {
  return useLocaleMarketContext().market;
}

/** Current (locale, market) pair. */
export function useLocaleMarket(): LocaleMarketPair {
  const { locale, market } = useLocaleMarketContext();
  return useMemo<LocaleMarketPair>(() => ({ locale, market }), [locale, market]);
}

/** Setter that requests a new (locale, market) pair. */
export function useSetLocaleMarket(): (next: LocaleMarketPair) => void {
  return useLocaleMarketContext().setLocaleMarket;
}
