# Hartlib Design System

## Concept: Pressroom

Editorial seriousness with one signal accent: the editor's red pencil. Newsrooms mark proofs in red; that red is the signature of the intelligence layer (citations, AI highlights, source-read metadata, the wordmark period). Everything else is ink-on-paper quiet. This is a reading + intelligence product, not a B2B dashboard.

Light mode only for MVP; dark mode deferred.

## Linear-informed Principles

Linear's discipline layered onto the Pressroom concept:

1. **Precision and restraint** — tight, intentional spacing; high information density without clutter. Applied to issue tables, chat surface, and layout rhythm. Every element earns its space.

2. **Type-led hierarchy** — clear type weight and size contrast rather than heavy borders or colored backgrounds for hierarchy. Hairline rules (`Separator` component, `border-rule`) are the divider system, not boxes.

3. **One-signal-accent** — oxblood (`--color-accent`) serves the same role as Linear's signal-blue: everything else quiet, one color carries the interaction and intelligence signal. Never introduce a second accent.

4. **Purposeful motion** — fast, purposeful transitions (100-200ms) on hover/active states only. No decorative animation. Staggered page-load entrance may be used sparingly for structured lists. Transform and opacity transitions only.

5. **Dense, scannable tables and lists** — compact row heights (32-36px), small-caps headers (11px uppercase tracked), hairline row dividers (`divide-y divide-rule`). Directly from Linear's data-heavy list approach.

6. **Micro-interactions** — keyboard-affordant focus rings (`--color-ring`, accent-tinted lower chroma), subtle hover states (opacity and color shifts), optimistic-feeling clicks via 100ms transitions.

## Color Tokens

All values in OKLCH. Neutrals tinted slightly cool (hue ~220 or ~60) for cohesion.

| Token                 | Value                    | Usage                                                             |
| --------------------- | ------------------------ | ----------------------------------------------------------------- |
| `--color-paper`       | `oklch(0.985 0.004 220)` | Card backgrounds, raised surfaces                                 |
| `--color-canvas`      | `oklch(0.975 0.005 220)` | App/page background                                               |
| `--color-surface`     | `oklch(0.96 0.006 220)`  | Subtle hover state backgrounds                                    |
| `--color-ink`         | `oklch(0.22 0.02 60)`    | Body text (warm near-black)                                       |
| `--color-muted`       | `oklch(0.45 0.02 60)`    | Secondary text, labels                                            |
| `--color-faint`       | `oklch(0.6 0.015 55)`    | Captions, tertiary text                                           |
| `--color-rule`        | `oklch(0.87 0.01 220)`   | Hairline dividers, borders                                        |
| `--color-accent`      | `oklch(0.52 0.14 28)`    | Editor's red: citations, highlights, active dots, wordmark period |
| `--color-accent-soft` | `oklch(0.8 0.04 28)`     | Selection highlights, subtle accent backgrounds                   |
| `--color-success`     | `oklch(0.5 0.12 160)`    | Active state, positive signals                                    |
| `--color-warning`     | `oklch(0.65 0.12 80)`    | Amber, attention-needed                                           |
| `--color-danger`      | `oklch(0.45 0.14 28)`    | Error, destructive action                                         |
| `--color-ring`        | `oklch(0.6 0.06 28)`     | Focus ring (accent-tinted, lower chroma)                          |

## Motion Tokens

| Token               | Value                             | Usage                          |
| ------------------- | --------------------------------- | ------------------------------ |
| `--ease-snappy`     | `cubic-bezier(0.23, 1, 0.32, 1)`  | Hover/active state transitions |
| `--ease-out`        | `cubic-bezier(0.23, 1, 0.32, 1)`  | Entrance/exit animations       |
| `--ease-in-out`     | `cubic-bezier(0.77, 0, 0.175, 1)` | On-screen movement             |
| `--ease-drawer`     | `cubic-bezier(0.32, 0.72, 0, 1)`  | Drawer-like sheet movement     |
| `--duration-fast`   | `100ms`                           | Hover states, color shifts     |
| `--duration-normal` | `200ms`                           | Moderate transitions           |

## Typography

### Font Roles

- **Fraunces** (serif, optical size axis) — Display / wordmark "hartlib."
  - Weights: 400, 500, 600
  - opsz: 9-144
- **Newsreader** (serif) — Long-form issue summaries, reading body text
  - Weights: 400, 500; Italics: 400, 500
- **IBM Plex Sans** (sans-serif) — UI labels, dense data, tables, navigation
  - Weights: 400, 500, 600
- **IBM Plex Mono** (monospace) — Citations, page refs, metadata, small tracked labels
  - Weights: 400, 500

### Type Scale

| Context          | Size             | Weight                | Face          |
| ---------------- | ---------------- | --------------------- | ------------- |
| Wordmark / H1    | 24px / 1.5rem    | 500                   | Fraunces      |
| H2               | 18px / 1.125rem  | 500                   | Fraunces      |
| H3               | 15px / 0.9375rem | 600                   | IBM Plex Sans |
| Body             | 14px / 0.875rem  | 400                   | Newsreader    |
| UI / Labels      | 13px / 0.8125rem | 500                   | IBM Plex Sans |
| Small / Captions | 12px / 0.75rem   | 400                   | IBM Plex Sans |
| Metadata         | 11px / 0.6875rem | 500                   | IBM Plex Mono |
| Table headers    | 11px / 0.6875rem | 500 uppercase tracked | IBM Plex Sans |

### Font Loading

Apps must load fonts via Google Fonts `<link>` in their `index.html`. Include the following in `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Newsreader:ital,wght@0,400;0,500;1,400;1,500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
  rel="stylesheet"
/>
```

## Component Contracts

### Button

Flat button, `rounded-sm` backed by `--radius` (`0.5px`). No drop shadows.

- **Variants**: `default` (ink fill, paper text), `secondary` (1px ink/15 border, no fill, light hover fill), `ghost` (muted text, underline-on-hover)
- **Sizes**: `default` (h-9, 14px), `sm` (h-7, 12px)
- **Props**: `variant`, `size`, `asChild` (Radix Slot), standard button HTML attributes
- **Behaviors**: 100ms transition on color/background/transform; 2px focus ring (`--color-ring`), offset 2px; `:active` state darkens by one step and scales to `0.97`

### Card

Minimal raised surface, `--radius` (`0.5px`) via `rounded-sm`, 1px rule border, paper background.

- `Card` — wrapper
- `CardHeader` — padded header section
- `CardTitle` — h3, 14px semibold
- `CardContent` — padded body section
- No `asChild`. Use as a plain container. Not for page-section wrappers (see usage rules).

### Badge

Small-caps tracked text pill, for state display only (e.g. Actif / Pause).

- **Variants**: `default` (neutral, rule border), `success` (green), `warning` (amber), `danger` (red)
- Pill shape (`rounded-full`), 11px uppercase tracking-wider, 1px border, light tinted background per variant

### Separator

Hairline divider backed by the Radix separator primitive. It uses a 1px background color (`--color-rule`) and has no margins by default; the consumer controls spacing.

### Table

Dense, hairline-ruled data table with optional sticky header.

| Component     | Element   | Role                                        |
| ------------- | --------- | ------------------------------------------- |
| `Table`       | `<table>` | Container, border-collapse                  |
| `TableHeader` | `<thead>` | Column headers, sticky optional             |
| `TableBody`   | `<tbody>` | Data rows, divided by hairline rules        |
| `TableRow`    | `<tr>`    | Row with hover highlight                    |
| `TableHead`   | `<th>`    | Cell, small-caps uppercase 11px, left-align |
| `TableCell`   | `<td>`    | Data cell, 14px ink text, 36px base height  |

Prop `stickyHeader={true}` on `TableHeader` enables sticky positioning with `z-10` and `bg-paper`. The table must be inside a scroll container with defined height for sticky to function.

### DataTable

TanStack Table renderer for dense product tables that share Pressroom header, sorting, and row chrome.

- `DataTable` — renders TanStack header groups, sortable headers, body rows, optional leading rows, row click behavior, hidden columns, responsive column/table classes, and custom cell rendering
- `SortableTableHead` — standalone sortable header cell used by `DataTable`
- Low-level sorting state, column definitions, row models, and domain cell content may be owned by reusable product components inside `@hartlib/ui`; consuming apps should prefer package-level product tables when they exist.

### Product Tables And Detail Components

Reusable product UI for the demo and MVP lives in `@hartlib/ui`, while apps keep routing, account switching, local demo persistence, and fixture-to-view-model mapping.

- `SourcesTable` — publisher source rows with subscriber counts, issue counts, and latest publication date
- `PublicationsTable` — publisher publication rows with metrics, scheduled-state treatment, and optional scheduled deletion
- `ClientPublicationsTable` — delivered publication rows without per-publication assistant-context controls; AI source selection is source-level in production and fixed to the authorized set in the live demo
- `PublicationDetail` — publication title, metadata, summary, scheduled-state treatment, document list, and editable scheduled-publication fields
- `DocumentsTable` — document title/description/PDF rows with optional inline editing and upload affordance; storage and PDF opening behavior stay in the consuming app through callbacks
- `SubscribersTable` — subscriber list, pause/resume/delete controls, and draft subscriber row with company combobox and email validation display
- `Breadcrumbs`, `SectionHeader`, `InlineEditableField`, `ConfirmingDeleteButton`, and `ScheduledPublicationIcon` are reusable support components used by these product surfaces. Breadcrumb publication titles truncate responsively with the full title available through the element title.

### Hosted Document Opening

Archive rows distinguish the official source URL from the platform-hosted artifact. The official URL is a separate external link. Hosted PDFs open only after an authorized response has been verified as `application/pdf`; the API-authorized final signed redirect URL is used when present, and a temporary blob URL is revoked for a direct PDF response. Hosted HTML navigates directly to the API content response so its restrictive CSP and opaque sandbox remain authoritative. Product UI must never copy hosted HTML into a creator-origin blob, `srcdoc`, or unsandboxed application DOM.

### Chat

Reusable chat transcript primitives for client AI conversations.

- `ChatBubble` — renders compact right-aligned user bubbles and an unframed left assistant answer column with type-led hierarchy, hairlines, and accessible author ownership; the assistant does not use a border, fill, rounded card, or bot icon as its main identity signal
- `ChatRunOutcome` — renders queued/running state or the durable localized failed-run code beneath its user message, with resubmit only when `retryable` is true
- `VirtualizedChatTranscript` — renders long chat histories with TanStack Virtual, variable-height measurement, overscan, and optional scroll-to-latest behavior
- `ChatSourcesRead` — renders the separate closed-by-default direct/topic answer-context source disclosure for an assistant message; it preserves source identity/order, repeats the inline citation ordinal for cited sources, renders a server-authorized supporting quote only for cited records, uses one generic unavailable quote state, marks read-but-uncited sources without an ordinal, and never receives selector previews, compaction-group/source-tool inputs, synthesis packets, or omitted candidates
- `ChatDebugDetails` — renders the owner-only closed-by-default safe run projection after an explicit open; it lazy-loads bounded stage history, counts, timestamps, usage, and normalized failure fields, and never receives prompts, queries, answer/source text, ranges, provider payloads, credentials, Smithers state, or hidden source identity data
- `ChatWebSearchToggle` — explicit per-message web-search choice driven by the shared effective-policy union, with its typed localized disabled reason
- Message data stays owned by the consuming app; reusable transcript primitives accept a discriminated message union: user messages carry `{ id, author: "user", content, run }` with the durable public run outcome, while assistant messages carry `{ id, author: "assistant", content, citations, sourcesRead }`, may carry the owner-only `runId`, and may carry a provisional activity projection. A provisional assistant message shows one fixed five-slot rail from run start, with stable labels and positions for Understanding, Evidence, Preparing, Writing, and Finishing; one quiet 1px rule connects the markers and only completed segments fill with the oxblood accent, while waiting, running, complete, retrying, failed, and skipped states use both a visible glyph and an accessible text label, and future slots stay muted. The rail appears before streamed answer text. A saved answer replaces the rail with an unboxed localized completion row that reports only the saved source-read and cited counts; its closed-by-default source disclosure remains available below. Cited source rows may show the exact server-authorized quote or one generic unavailable state. The owner-only debug disclosure loads only after keyboard or pointer opening, stays closed by default, and may show only the safe activity history, counts, timing, context fit/compaction, memory-write outcome, usage totals, timestamps, and replay cursor. It never exposes prompts, queries, source text or ranges, provider payloads, credentials, Smithers state, or restricted content. The transcript keeps streaming growth at the bottom only while the viewer is near the bottom and shows an accessible Jump to latest control after the viewer scrolls away. They do not know about Smithers tasks, fanout topic packets, or raw context plans.
- Citation renderers support document, earlier-chat, saved-memory, and web source kinds. Earlier-chat citations target a transcript message, memory citations open the exact owner-only revision view in the memories panel, and document/web citations use authorized or canonical links.

- On `lg` and wider viewports the assistant answer renders as block rows: cited claims sit in the text column and their sources sit in a 13rem left gutter aligned to the first block that cites them. Each margin card repeats the citation ordinal, the source label, and the supporting quote clamped to six lines; a source already carded earlier in the answer keeps its inline chip only. Below `lg` the gutter disappears and presentation matches the classic inline layout.
- The claim a citation supports is highlighted with a low-opacity accent tint on the text run between the previous marker (or block start) and the marker. Hovering or focusing a span or its margin card raises both to the full accent treatment. Spans wrap paragraph text only; headings, lists, quotes, tables, fences, and indented code keep chips without wrapping so their Markdown structure stays intact.

## Usage Rules

1. **One accent** — oxblood (`--color-accent`) is the only signal color. Do not introduce a second accent. Use it sparingly: citations, AI source marks, the wordmark period, active state dots, selected highlights.

2. **No card-in-card** — Page sections are full-width bands or unframed layouts. Cards are for individual repeated items (issues, documents, chat messages). Do not nest cards.

3. **Hairline rules over borders** — Prefer `Separator` or `border-rule` / `divide-y divide-rule` over heavy box borders. Dividers create structure without visual weight.

4. **Type-led layout** — Establish hierarchy through type weight and size, not colored backgrounds or decorative cards. Heavy borders should feel suspect.

5. **Avoid B2B dashboard tropes** — No card grids, big rounded corners (>8px), progress bars with gradients or heavy sidebars. This is a reading product for executives and editors.

6. **Spacing rhythm** — Use 4px increments (Tailwind spacing scale). Keep rows compact: 28-36px for UI elements, 40-48px for content paragraphs. Prefer consistent padding over varied spacing.

7. **Typography inheritance** — Set `font-family` on `body` via `--font-sans` (IBM Plex Sans) for UI surfaces. Use `font-serif` (Newsreader) for reading body text and `font-display` (Fraunces) for headings/wordmark. Use `font-mono` (IBM Plex Mono) for citations and metadata.

## Package Exports

The `@hartlib/ui` package exports:

- `@hartlib/ui` — all components and utilities (TypeScript entrypoint)
- `@hartlib/ui/styles` — Tailwind v4 `@theme` tokens CSS file (import via `@import "@hartlib/ui/styles"` in app CSS after `@import "tailwindcss"`)

## Shadcn/UI Component Patterns

`@hartlib/ui` uses [shadcn/ui](https://ui.shadcn.com/) component patterns (source-copied, adapted to Pressroom tokens) with Radix UI primitives. This provides accessible, composable primitives while maintaining the Pressroom design language.

### Component Inventory

| Component | Radix Primitive                 | Notes                                                                                                                 |
| --------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Button    | — (uses `@radix-ui/react-slot`) | 6 variants: default, secondary, destructive, outline, ghost, link                                                     |
| Card      | —                               | Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter                                     |
| Badge     | —                               | 6 variants: default, secondary, destructive, outline, success, warning                                                |
| Table     | —                               | Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption; stickyHeader on TableHeader |
| DataTable | TanStack Table                  | Shared renderer for sortable dense product tables; feature code supplies columns, sorting state, and cell content     |
| Separator | `@radix-ui/react-separator`     | Canonical hairline divider primitive                                                                                  |
| Tabs      | `@radix-ui/react-tabs`          | Tabs, TabsList, TabsTrigger, TabsContent; replaces hand-rolled switcher patterns                                      |
| Input     | —                               | Styled text input using `--radius`                                                                                    |
| Label     | `@radix-ui/react-label`         | Associated with inputs via peer targeting                                                                             |
| Textarea  | —                               | Same styling as Input                                                                                                 |
| Tooltip   | `@radix-ui/react-tooltip`       | TooltipProvider, Tooltip, TooltipTrigger, TooltipContent                                                              |

### Token Mapping Decisions

| shadcn token             | Pressroom mapping                    | Reason                                                 |
| ------------------------ | ------------------------------------ | ------------------------------------------------------ |
| `bg-muted`               | `bg-surface` (replaced in source)    | `--color-muted` is a text gray, not a bg               |
| `text-muted-foreground`  | `text-muted`                         | Maps to the existing Pressroom muted text              |
| `hover:bg-accent`        | `hover:bg-surface` (replaced)        | `--color-accent` is oxblood signal red, not a hover bg |
| `bg-accent`              | `bg-surface` (replaced)              | Same reason — accent is red, not a bg color            |
| `text-accent-foreground` | `text-ink` (replaced)                | Accent foreground uses ink instead of accent           |
| `bg-primary`             | kept as-is (`ink`)                   | Maps correctly to shadcn's primary bg                  |
| `bg-secondary`           | kept as-is (`surface`)               | Maps correctly                                         |
| `bg-destructive`         | kept as-is (`danger`)                | Maps correctly                                         |
| `border-border`          | kept as-is (`--color-border` = rule) | Maps correctly                                         |
| `rounded-md/lg`          | `rounded-sm`                         | Pressroom base radius is `--radius` (`0.5px`)          |

### Usage

Apps import components from `@hartlib/ui` and styles from `@hartlib/ui/styles`:

```css
@import "tailwindcss";
@import "@hartlib/ui/styles";
```
