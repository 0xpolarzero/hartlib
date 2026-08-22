# Localization and Market Selection

## Purpose

Hartlib pairs UI locale with market. Locale sets UI language and formatting. Market sets source and content scope. The paired choice keeps language and source location aligned while leaving room to add more country pairs later.

## Supported Locales and Markets

- Locales (BCP 47): `fr-FR` (default), `en-US`.
- Markets (ISO 3166-1 alpha-2): `FR` (default), `US`.
- Default pair: `fr-FR` + `FR`. The MVP is French-first, per `design.spec.md` Initial Market.
- Document language (`<html lang>`) mirrors the active locale.

## Conceptual Model

- `locale`: UI language and formatting (dates, numbers, relative time). Controlled by `Intl` APIs and the `@hartlib/i18n` message catalogs.
- `market`: product and content scope. Controls default public-source selection. Country is first-class source metadata, not a UI category. The active market is always `DEFAULT_MARKET_FOR_LOCALE[locale]`.
- The locale and market are selected together: `fr-FR` always uses `FR` sources and `en-US` always uses `US` sources.

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

Internal state always uses the real codes. A pretty alias resolves to its matching locale and market pair; after parsing, normal route generation uses the canonical locale prefix.

Never auto-redirect away from an explicit locale URL. If a user opens `/en-US/client`, honor it.

## Redirect Precedence

For neutral entry points like `/` or `/demo` only, resolve the target in this order:

1. Stored locale choice (cookie or localStorage), with its market derived from the locale.
2. URL locale, if present and valid.
3. Browser `Accept-Language`.
4. Default to `fr-FR` + `FR`.

## Production Source Defaulting Rules

- Public sources carry `country` (Market) and `language` (Locale) metadata at the source-definition level.
- The French demo defaults to sources where `country === "FR"`. The US demo defaults to `country === "US"`.
- The live demo requests `GET /v1/public-sources?market=<FR|US>` on initial load and every market change. It renders only the response tagged for the currently selected market; a late response for the prior market is discarded and cannot leave stale sources or publications visible.
- Documents keep their own per-document `language`. Individual documents may vary.
- If a production user manually changes their selected sources, that selection is preserved across locale and market switches. The switcher does not clear manual selections. The live demo has no manual source selection; it uses the server-authorized set.

## Translation Catalog Ownership

- Catalogs live in `packages/i18n/src/locales/{fr-FR,en-US}.json`.
- Flat stable keys (for example, `nav.home`, `column.feed`).
- ICU MessageFormat for plurals and variables:

```
{count, plural, one {# source} other {# sources}}
```

- Localize dates (`Intl.DateTimeFormat(locale)`), numbers (`Intl.NumberFormat(locale)`), relative time, document-type labels, empty states, validation messages, table labels and columns, tooltips, and aria labels.
- AI chat chrome is localized in both catalogs: web-search toggle and each effective-policy reason (`deployment_unavailable`, `company_disabled`, `allowlist_unsupported`), clarification state, document/earlier-chat/saved-memory/web source-kind labels, the sources-read empty state, cited-source ordinal and read-but-uncited marker, the fixed five-stage rail and its six status labels, the saved-answer “Answer ready” row and its source-read/cited counts, context-fit failure guidance, memory-finalization failure, memory tombstone/revert actions and 30-day notice, resubmit state, provisional draft state, and terminal errors.
- Source display names, publication titles, summaries, and citation text are content, not chrome. They remain in their original language for now. The demo translates UI chrome only.
- The standalone English `GET /docs` page is not localized and is not mounted under `/fr-FR` or `/en-US`. Its field names remain exact: `LoadedTurn`, `plan-turn`, `documentId`, and `citationNamespace`.

## Transactional Email Locale

- Each client-company notification preference stores an independently selectable email locale constrained to `fr-FR` or `en-US`; when no preference row exists, it defaults to `fr-FR`.
- The notification settings UI reads and writes that locale with the three email opt-in categories. Changing the browser locale does not silently overwrite the saved email locale.
- The worker resolves the current saved locale, current primary email, and current opt-in immediately before the provider call. It does not rely on values snapshotted when the notification was enqueued.
- Internal email subjects, text, HTML, and link labels live in the same canonical JSON catalogs as UI chrome. Publisher titles and other content remain in their original language.
- Email platform links use the canonical localized production route: `/fr-FR/...` or `/en-US/...`.

## Locale and Market Switcher

- The navbar exposes one paired locale and market control. Selecting `fr-FR` selects `FR` sources; selecting `en-US` selects `US` sources.
- The options are always `Français — France` and `English — United States`, so each language appears in its own language.
- It switches to the same route in the other locale when possible.
- It persists the selected locale in localStorage. The market is derived from `DEFAULT_MARKET_FOR_LOCALE`, so stale or mismatched market values cannot be restored.
- Canonical locale routes and the `/fr` and `/us` aliases always resolve to their matching locale and market pair.
- It does not clear production user-selected sources after a manual change. No source-selection mutation exists in the live demo.

## Terminology

- The French UI term for a source subscription list or feed is **flux**. The English term is **feed**.
- Internal identifiers use `feed` and `Feed`.
