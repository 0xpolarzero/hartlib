# Localization and Market Selection

## Contract

The demo supports `fr-FR` and `en-US`. Locale controls UI language, dates,
numbers, messages, and the HTML `lang` attribute. Market controls source
scope: `fr-FR` maps to `FR`, and `en-US` maps to `US`. The pair is selected as
one choice and stale market values are not restored independently.

Canonical paths use `/fr-FR/...` and `/en-US/...`. `/fr` and `/us` are the
accepted aliases and resolve to their canonical locale and market. Neutral root
resolves through the stored locale when valid, then the browser language, then
`fr-FR`. Unknown paths render the branded localized 404. `/docs` remains an
English-only route and is not localized.

## Catalogs

`packages/i18n/src/locales/en-US.json` and `fr-FR.json` have matching key sets.
They contain every live label, error, count, aria name, reset prompt, web
policy reason, run stage and status, citation state, memory action, source
state, dormant fixture label, and visualization label. Content such as source
names, issue titles, summaries, and citation text stays in its source language.

Dates and numbers use `Intl` for the active locale. Plural messages use ICU
MessageFormat. Code imports the catalog through `@hartlib/i18n`; no copied
reference dictionary ships.

## Market reads and mutations

The demo requests `GET /v1/public-sources?market=FR|US` on load and market
change. It renders only the response for the current market. A late response
for an older market is discarded. Disabled authorized rows remain visible.
Each toggle has its own pending state, generation fence, rollback, and visible
localized error.

## Browser state

The single storage registry owns local keys `hartlib:demo:locale`,
`hartlib:demo:manual-sources`, `hartlib:demo:layout`,
`hartlib:demo:web-choice`, and `hartlib:demo:pending-reset-operation`. It also
owns the session prefix `hartlib:demo:stream:` with schema version 5. Values
are validated, corrupt entries are removed, and unregistered keys are never
read or written. The reset controller fences writes, clears every registered
entry, aborts streams, resets route and panels, and reloads after committed
success.

## UI behavior

The locale control shows `Français — France` and `English — United States`.
Changing locale preserves source-toggle choices while deriving the matching
market. The command palette, composer, transcript, citation disclosure,
debug drawer, memories, source tables, overlays, and toasts use localized
labels and accessible names. Dictation does not persist audio.
