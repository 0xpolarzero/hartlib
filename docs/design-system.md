# Brief Design System

## Concept: Pressroom

Editorial seriousness with one signal accent: the editor's red pencil. Newsrooms mark proofs in red; that red is the signature of the intelligence layer (citations, AI highlights, source-read metadata, the wordmark period). Everything else is ink-on-paper quiet. This is a reading + intelligence product, not a B2B dashboard.

Light mode only for MVP; dark mode deferred.

## Linear-informed Principles

Linear's discipline layered onto the Pressroom concept:

1. **Precision and restraint** — tight, intentional spacing; high information density without clutter. Applied to issue tables, chat surface, and layout rhythm. Every element earns its space.

2. **Type-led hierarchy** — clear type weight and size contrast rather than heavy borders or colored backgrounds for hierarchy. Hairline rules (Rule component, `border-rule`) are the divider system, not boxes.

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

| Token               | Value                              | Usage                          |
| ------------------- | ---------------------------------- | ------------------------------ |
| `--ease-snappy`     | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Hover/active state transitions |
| `--ease-out`        | `cubic-bezier(0.16, 1, 0.3, 1)`    | Entrance/exit animations       |
| `--duration-fast`   | `100ms`                            | Hover states, color shifts     |
| `--duration-normal` | `200ms`                            | Moderate transitions           |

## Typography

### Font Roles

- **Fraunces** (serif, optical size axis) — Display / wordmark "brief."
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
- **Behaviors**: 100ms transition on color/background; 2px focus ring (`--color-ring`), offset 2px; `:active` state darkens by one step

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

### Rule

Hairline divider. Renders as `<hr>` with no border, 1px background color (`--color-rule`). No margins by default; consumer controls vertical spacing.

### Table

Dense, hairline-ruled data table with optional sticky header.

| Component     | Element   | Role                                        |
| ------------- | --------- | ------------------------------------------- |
| `Table`       | `<table>` | Container, border-collapse                  |
| `TableHeader` | `<thead>` | Column headers, sticky optional             |
| `TableBody`   | `<tbody>` | Data rows, divided by hairline rules        |
| `TableRow`    | `<tr>`    | Row with hover highlight                    |
| `TableHead`   | `<th>`    | Cell, small-caps uppercase 11px, left-align |
| `TableCell`   | `<td>`    | Data cell, 14px ink text                    |

Prop `stickyHeader={true}` on `TableHeader` enables sticky positioning with `z-10` and `bg-paper`. The table must be inside a scroll container with defined height for sticky to function.

### DataTable

TanStack Table renderer for dense product tables that share Pressroom header, sorting, and row chrome while keeping domain-specific cells in the consuming app.

- `DataTable` — renders TanStack header groups, sortable headers, body rows, optional leading rows, row click behavior, hidden columns, and custom cell rendering
- `SortableTableHead` — standalone sortable header cell used by `DataTable`
- Sorting state, column definitions, row models, and domain cell content remain owned by the feature

### ArtifactFrame

Renders HTML content on a paper surface inside a sandboxed iframe. Used for reading issue documents and AI-generated artifacts.

- Paper background (`--color-paper`), 1px rule border, `rounded-sm` backed by `--radius`
- Title bar in bottom-bordered strip, 11px uppercase tracked label
- Crop-mark corner detail: tiny L-shaped rule at top-right (print "datadrop" metaphor)
- Sandboxed iframe with CSP: `default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'`
- Props: `title: string`, `html: string` (raw HTML), `className?: string`

## Usage Rules

1. **One accent** — oxblood (`--color-accent`) is the only signal color. Do not introduce a second accent. Use it sparingly: citations, AI source marks, the wordmark period, active state dots, selected highlights.

2. **No card-in-card** — Page sections are full-width bands or unframed layouts. Cards are for individual repeated items (issues, documents, chat messages). Do not nest cards.

3. **Hairline rules over borders** — Prefer `Rule` component or `border-rule` / `divide-y divide-rule` over heavy box borders. Dividers create structure without visual weight.

4. **Type-led layout** — Establish hierarchy through type weight and size, not colored backgrounds or decorative cards. Heavy borders should feel suspect.

5. **Avoid B2B dashboard tropes** — No card grids, big rounded corners (>8px), progress bars with gradients or heavy sidebars. This is a reading product for executives and editors.

6. **Spacing rhythm** — Use 4px increments (Tailwind spacing scale). Keep rows compact: 28-36px for UI elements, 40-48px for content paragraphs. Prefer consistent padding over varied spacing.

7. **Typography inheritance** — Set `font-family` on `body` via `--font-sans` (IBM Plex Sans) for UI surfaces. Use `font-serif` (Newsreader) for reading body text and `font-display` (Fraunces) for headings/wordmark. Use `font-mono` (IBM Plex Mono) for citations and metadata.

## Package Exports

The `@brief/ui` package exports:

- `@brief/ui` — all components and utilities (TypeScript entrypoint)
- `@brief/ui/styles` — Tailwind v4 `@theme` tokens CSS file (import via `@import "@brief/ui/styles"` in app CSS after `@import "tailwindcss"`)

## Shadcn/UI Component Patterns

`@brief/ui` uses [shadcn/ui](https://ui.shadcn.com/) component patterns (source-copied, adapted to Pressroom tokens) with Radix UI primitives. This provides accessible, composable primitives while maintaining the Pressroom design language.

### Component Inventory

| Component | Radix Primitive                 | Notes                                                                                                                 |
| --------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Button    | — (uses `@radix-ui/react-slot`) | 6 variants: default, secondary, destructive, outline, ghost, link                                                     |
| Card      | —                               | Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter                                     |
| Badge     | —                               | 6 variants: default, secondary, destructive, outline, success, warning                                                |
| Table     | —                               | Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption; stickyHeader on TableHeader |
| DataTable | TanStack Table                  | Shared renderer for sortable dense product tables; feature code supplies columns, sorting state, and cell content     |
| Separator | `@radix-ui/react-separator`     | Replaces the hand-written Rule; Rule exported as alias for backward compat                                            |
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

Apps import components from `@brief/ui` and styles from `@brief/ui/styles`:

```css
@import "tailwindcss";
@import "@brief/ui/styles";
```
