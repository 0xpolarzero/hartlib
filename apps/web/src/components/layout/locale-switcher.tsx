import {
  FormattedMessage,
  type Locale,
  LOCALES,
  MARKETS,
  useIntl,
  useLocale,
  useMarket,
  useSetLocaleMarket,
} from "@hartlib/i18n";
import { cn } from "@hartlib/ui";

const LABEL_KEY: Record<Locale, string> = {
  "fr-FR": "localeSwitcher.frFR",
  "en-US": "localeSwitcher.enUS",
};

/**
 * Locale/market switcher for the app header. Lets the user switch between the
 * supported locales and source markets independently.
 */
export function LocaleSwitcher() {
  const locale = useLocale();
  const market = useMarket();
  const setLocaleMarket = useSetLocaleMarket();
  const intl = useIntl();

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value as Locale;
    setLocaleMarket({ locale: next, market });
  }

  const label = intl.formatMessage({ id: "localeSwitcher.label" });

  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={locale}
        onChange={handleChange}
        className={cn(
          "h-8 rounded-sm border border-rule bg-paper px-2 text-sm text-ink",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {LOCALES.map((value) => (
          <option key={value} value={value}>
            <FormattedMessage id={LABEL_KEY[value]} />
          </option>
        ))}
      </select>
      <select
        aria-label={intl.formatMessage({ id: "marketSwitcher.label" })}
        value={market}
        onChange={(event) =>
          setLocaleMarket({ locale, market: event.target.value as (typeof MARKETS)[number] })
        }
        className={cn(
          "h-8 rounded-sm border border-rule bg-paper px-2 text-sm text-ink",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {MARKETS.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </label>
  );
}
