import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { fr } from "./fr";
import { en } from "./en";

export type Locale = "fr" | "en";
export const LOCALES: Locale[] = ["fr", "en"];
export const DEFAULT_LOCALE: Locale = "fr";

export type Dict = Record<string, string>;

const DICTS: Record<Locale, Dict> = { fr, en };

type I18n = {
  locale: Locale;
  /** Translate a key with optional {param} interpolation. Missing keys fall
   *  back to fr, then to the key itself (and warn once in dev). */
  t: (key: string, params?: Record<string, string | number>) => string;
  setLocale: (locale: Locale) => void;
};

const I18nContext = createContext<I18n | null>(null);

const warned = new Set<string>();

function lookup(dict: Dict, key: string, params?: Record<string, string | number>): string {
  let value = dict[key];
  if (value == null) {
    if (import.meta.env.DEV && !warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing key: ${key}`);
    }
    value = fr[key] ?? key;
  }
  if (params) {
    for (const [name, raw] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(raw));
    }
  }
  return value;
}

export function I18nProvider({
  locale,
  onLocaleChange,
  children,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  children: ReactNode;
}) {
  useEffect(() => {
    document.documentElement.lang = locale === "fr" ? "fr-FR" : "en-US";
    document.title =
      locale === "fr" ? "Bref. — Portail des abonnés" : "Bref. — Subscriber portal";
  }, [locale]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => lookup(DICTS[locale], key, params),
    [locale],
  );

  const value = useMemo<I18n>(
    () => ({ locale, t, setLocale: onLocaleChange }),
    [locale, t, onLocaleChange],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
