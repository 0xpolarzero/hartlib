import enUS from "./locales/en-US.json";
import frFR from "./locales/fr-FR.json";
import type { Locale, Messages } from "./types.js";

/** Canonical UI and transactional-email catalogs keyed by supported locale. */
export const catalogs: Record<Locale, Messages> = {
  "fr-FR": frFR,
  "en-US": enUS,
};

/** Resolve static catalog text outside a React Intl provider. */
export const messageForLocale = (locale: Locale, id: keyof Messages): string =>
  String(catalogs[locale][id]);
