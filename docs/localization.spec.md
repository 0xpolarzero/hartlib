# Localization and Market Selection

## Purpose

Brief separates UI locale from market. Locale is UI language and formatting. Market is source and content scope. They default together but remain technically independent. This separation supports scaling from France to more countries.

## Supported Locales and Markets

- Locales (BCP 47): `fr-FR` (default), `en-US`.
- Markets (ISO 3166-1 alpha-2): `FR` (default), `US`.
- Default pair: `fr-FR` + `FR`. The MVP is French-first, per `design.spec.md` Initial Market.
- Document language (`<html lang>`) mirrors the active locale.

## Conceptual Model

- `locale`: UI language and formatting (dates, numbers, relative time). Controlled by `Intl` APIs and the `@brief/i18n` message catalogs.
- `market`: product and content scope. Controls default public-source selection. Country is first-class source metadata, not a UI category.
- A French-speaking user in the US may use the `fr-FR` UI with `US` market sources, or vice versa. They default together, but the user can decouple them.

## Routing

Localized URL prefixes:

```
/fr-FR/...
/en-US/...
```

Optional pretty aliases for public demo entry:

```
/fr -> fr-FR + FR
/us -> en-US + US
```

Internal state always uses the real codes.

Never auto-redirect away from an explicit locale URL. If a user opens `/en-US/client`, honor it.

## Redirect Precedence

For neutral entry points like `/` or `/demo` only, resolve the target in this order:

1. Stored user choice (cookie or localStorage).
2. URL locale, if present and valid.
3. Browser `Accept-Language`.
4. Optional country signal, if available.
5. Default to `fr-FR` + `FR`.

## Source Defaulting Rules

- Public sources carry `country` (Market) and `language` (Locale) metadata at the source-definition level.
- The French demo defaults to sources where `country === "FR"`. The US demo defaults to `country === "US"`.
- Documents keep their own per-document `language`. Individual documents may vary.
- If the user manually changes their selected sources, that selection is preserved across locale and market switches. The switcher does not clear manual selections.

## Translation Catalog Ownership

- Catalogs live in `packages/i18n/src/locales/{fr-FR,en-US}.json`.
- Flat stable keys (for example, `nav.home`, `column.feed`).
- ICU MessageFormat for plurals and variables:

```
{count, plural, one {# source} other {# sources}}
```

- Localize dates (`Intl.DateTimeFormat(locale)`), numbers (`Intl.NumberFormat(locale)`), relative time, document-type labels, empty states, validation messages, table labels and columns, tooltips, and aria labels.
- Source display names, publication titles, summaries, and citation text are content, not chrome. They remain in their original language for now. The demo translates UI chrome only.

## Locale and Market Switcher

- The navbar dropdown switches both UI language and default market filters together, while remaining technically decoupled.
- It switches to the same route in the other locale when possible.
- It persists the choice in localStorage.
- It does not clear user-selected sources after a manual change.

## Terminology

- The French UI term for a source subscription list or feed is **flux** (formerly fil). The English term is **feed**.
- Internal identifiers use `feed` and `Feed`.
