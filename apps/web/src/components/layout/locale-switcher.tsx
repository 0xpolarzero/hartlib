import {
  DEFAULT_MARKET_FOR_LOCALE,
  FormattedMessage,
  type Locale,
  LOCALES,
  useIntl,
  useLocale,
  useSetLocaleMarket,
} from "@brief/i18n";
import { cn } from "@brief/ui";

const LABEL_KEY: Record<Locale, string> = {
  "fr-FR": "localeSwitcher.frFR",
  "en-US": "localeSwitcher.enUS",
};

/**
 * Locale/market switcher for the app header. Lets the user switch between the
 * supported locales; the market is coupled to the chosen locale.
 */
export function LocaleSwitcher() {
  const locale = useLocale();
  const setLocaleMarket = useSetLocaleMarket();
  const intl = useIntl();

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value as Locale;
    setLocaleMarket({ locale: next, market: DEFAULT_MARKET_FOR_LOCALE[next] });
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
    </label>
  );
}
