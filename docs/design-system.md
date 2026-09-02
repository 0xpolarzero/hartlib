# Hartlib Design System

## Visual direction

Hartlib uses the `ui-playground` pressroom design without a second visual
implementation. `ui-playground/src/styles/theme.css` is copied verbatim to
`packages/ui/src/styles/tokens.css`; reference component DOM, classes, and
responsive rules are canonical. The oxblood accent marks interaction,
citations, and intelligence states. The application ships light mode only.
The document response uses the matching standalone style.

## Tokens

The token names are stable and code-owned:

- paper: `--color-paper`, `--color-paper-deep`, and `--color-surface`;
- ink: `--color-ink`, `--color-ink-2`, and `--color-ink-3`;
- rules: `--color-line` and `--color-line-2`;
- signal: `--color-accent`, `--color-accent-deep`, and
  `--color-accent-soft`;
- state: `--color-ok`, `--color-warn`, and `--color-danger`; and
- type: display, reading, sans, and mono font families.

The smallest radius is `2px`. Focus uses a visible two-pixel accent outline.
Transitions are short and purposeful. Reduced-motion preferences disable
animation and smooth scrolling. Icons come from the installed Lucide family;
product code does not draw replacement SVGs.

## Type and layout

Fraunces handles display headings, Newsreader handles long reading text, IBM
Plex Sans handles controls and dense data, and IBM Plex Mono handles metadata
and citation labels. The shell keeps a sticky header, skip link, wordmark,
locale control, command palette, and notification affordance.

The workspace is responsive at 320, 390, 1024, 1535, 1536, and 1920 pixels.
Compact layouts use tabs. Large layouts use resizable subscriptions and
memories side panels with an empty visualization pane. The transcript uses
variable-height virtualization and a 48px near-bottom fence.

## Primitive set

`packages/ui/src/components/ui` is the only primitive family. It includes
atoms, button, breadcrumbs, combobox, command, confirming delete, controls,
datepicker, dialog, file upload, form field, inline editable field, input,
overlays, select, sheet, states, table, tabs, toast, and utility formatting.
Each primitive owns semantics, keyboard behavior, focus restoration, Escape,
scroll lock, reduced motion, and localized accessible labels.

Dialogs and sheets trap focus, restore it on close, and close on Escape unless
a nested menu or popover consumes the event. Menus, popovers, hover cards,
tooltips, and toasts use the correct roles and do not leak global listeners.
Tables expose loading, empty, no-match, error, retry, search, sort, facets,
selection, columns, and paging states. Datepicker controls expose a 42-cell
calendar grid with localized weekday order and keyboard navigation.

## Product presentation

The chat message component renders user and assistant anatomy, five ordered run
stages, six stage states, and one production activity disclosure for concrete
work such as queries, source reads, and retries. It also renders citations,
failures, stopped answers, delete, last-question edit, debug, optional
visualization Show, and the reference composer controls. Branch and collection
views stay absent.
Attachment and regenerate controls are active only when production supplies
their callbacks.

The visualization pane accepts prop-only versions, selection, restore, refresh,
download, fullscreen, loading, regenerating, highlight, association, and Show
callbacks. Its iframe uses `srcDoc` and `sandbox=""`. The reachable demo passes
zero versions and no association.

The reachable publisher composition accepts prop-only rows and callbacks and
renders the reference source, publication, document, subscriber, notification,
settings, and issue-wizard states. The web adapter supplies controlled local
demo state for UI-only publisher routes. Client subscriptions still use
authorized public sources from the API.
Subscription rows accept `public`, `invitation`, and `publisher` source kinds
for prop-only fixture states; the reachable demo still passes authorized public
sources only.

## Content and safety

Markdown renders prose, code, tables, and copy controls. Raw HTML and remote
images are disabled. Citations use strict server records with source keys,
ordinals, authorized quotes or a clear unavailable state, and secure document
targets. The document stylesheet keeps the exact CSP: inline styles, Google
Fonts styles, Google Fonts fonts, and data images only, plus `base-uri`,
`form-action`, and `frame-ancestors` set to `none`.
