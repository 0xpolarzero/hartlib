# Prompt: Component Demo Website — paste this entire document into a fresh agent

You are building a standalone demo website whose only job is to demonstrate, with mock data, every UI component listed below. You have no prior knowledge of any existing codebase. Build everything from scratch, be original in composition, and hold yourself to a best-in-class bar for UI craft, interaction quality, and accessibility. The result will be reviewed as the reference implementation for a production component library, so completeness and state coverage matter more than feature depth.

## 1. Product context (fictional, for mock data)

The product is a subscriber portal for publishers of professional briefings, confidential letters, and specialist subscription publications (think French B2B newsletters). Two views:

- **Publisher view**: manage subscription sources, issues (scheduled publications), documents (PDFs), and subscribers.
- **Client view**: browse delivered publications and query the delivered archive through an AI chat that answers with inline citations, shows which sources were read, keeps saved memories, and drives a live visualization pane beside the conversation.

All data is mocked client-side. Seed it with realistic French professional-publishing content: source names like "Lettre Juridique Sociale", company names, issue titles, publication dates, subscriber counts, plausible briefing excerpts. Content must read as real editorial material, not lorem ipsum.

## 2. Art direction

An editorial reading product for executives — not a SaaS dashboard. Original layout, but obey these rules:

- **Color**: define your own palette as Tailwind v4 `@theme` tokens: quiet paper-like neutrals plus ONE restrained signal accent you choose, reserved for citations, active states, selection highlights, and small marks. Every text/background pairing must meet WCAG AA contrast.
- **Type**: Fraunces for display/wordmark, Newsreader for reading body text, IBM Plex Sans for UI/labels/tables, IBM Plex Mono for citations/metadata; load via Google Fonts `<link>`. Choose the size scale yourself, staying in a dense-editorial register (roughly 14px body, roughly 11px tracked small-caps table headers).
- **Structure through type and hairlines**, not boxes: 1px rules as dividers, very low border radius throughout, flat surfaces, no drop shadows, no card-in-card, no gradient progress bars, no heavy sidebars. Dense rows: roughly 32-36px table rows, 4px spacing rhythm.
- **Motion**: transform/opacity only, 100ms hover transitions, 200ms entrances, snappy easing `cubic-bezier(0.23, 1, 0.32, 1)`, no decorative animation, honor `prefers-reduced-motion`.
- Do not imitate the chrome of ChatGPT, Claude, Perplexity, or v0. Compose your own layout.

## 3. Stack constraints

- Vite + React 19 + TypeScript (strict) + Tailwind v4.
- shadcn/ui-style source-copied components over Radix primitives (no unstyled headless surprises).
- TanStack Table (data grid logic), TanStack Virtual (long lists), TanStack Router (file-less route tree), react-resizable-panels (split panes).
- Rendering and icons: react-markdown + remark-gfm (streamed Markdown), lucide-react (icons), class-variance-authority + clsx + tailwind-merge (variant utilities), ECharts (available for any app-owned charts outside the sandboxed canvas).
- No backend. A thin deterministic mock service simulates API latency, SSE streaming, and failures; isolate it behind an interface so a real API can replace it.
- Persist lightweight demo edits (inline edits, panel sizes, locale) in `localStorage`.
- Routes: `/fr/...` and `/en/...` prefixes, fr-FR default, full i18n of all strings via Intl (`Intl.DateTimeFormat`, `NumberFormat`). Locale switcher in the shell.

## 4. Required component inventory

Build every item. Each must exist as a reusable component and appear in a demo with ALL relevant states (default, hover, focus-visible, active, disabled, loading/skeleton, empty, error).

### 4.1 App shell and navigation
1. App shell: top bar, workspace/view switcher (publisher ↔ client), locale switcher, theme-safe focus rings.
2. Breadcrumbs with responsive truncation (full title via `title`) using real route paths.
3. Command palette (⌘K / Ctrl+K): fuzzy search over pages and actions, full keyboard operation, ARIA combobox pattern.
4. Tabs and a segmented control.
5. Skip-to-content link, correct landmarks, heading hierarchy per page.

### 4.2 Data display
6. Table primitives: dense hairline table, small-caps 11px tracked headers, sticky header option inside a scroll container.
7. DataTable (TanStack): sortable multi-column headers, faceted filters, global search, column visibility menu, row selection with header checkbox tri-state, bulk-action bar, pagination, URL-synced state.
8. Four product tables built on it:
   - SourcesTable (name, invitation-vs-public type badge, latest publication date, read-only subscription state),
   - PublicationsTable (metrics, scheduled-state treatment, scheduled-deletion notice),
   - ClientPublicationsTable (delivered rows only),
   - DocumentsTable (title, description, PDF open action, upload affordance, missing-file error row),
   - SubscribersTable (pause/resume/delete with confirm, draft-add row with searchable company combobox and email validation display).
   Each with loading skeleton, honest empty state, and error state.
9. Badge (state pill: neutral/success/warning/danger), Card, Separator (hairline), SectionHeader, metadata/key-value rows.
10. EmptyState and ErrorState components with illustration-free typographic treatment, optional action button.

### 4.3 Forms and input
11. Button (variants: primary ink fill, secondary outlined, ghost underline-on-hover, destructive, link; sizes; pressed scale 0.97).
12. Input, Textarea, Select, searchable Combobox (ARIA pattern, async-filtered options), Checkbox, Switch, RadioGroup, DatePicker (schedules a publication), FormField with label, description, and three validation states.
13. InlineEditableField: visually quiet at rest, subtle surface + rule on hover, clear focused state; long fields expand to a large edit surface on focus; Escape cancels, Enter commits (Shift+Enter newline); announces save via toast/live region.
14. ConfirmingDeleteButton: two-step confirm inline, then destructive action with undo toast.
15. FileUpload: drag-drop + picker, accepts PDF only, shows progress, invalid-type error, uploaded row opens via object URL.

### 4.4 Overlays and feedback
16. Dialog, AlertDialog (confirm flows), Sheet/drawer (mobile nav, memories, details), Popover, DropdownMenu, Tooltip (keyboard-triggerable), Toast system (success/error/undo), Skeleton, HoverCard (source preview on citation hover).
17. Focus management proof: focus trapped and restored for dialog/sheet/drawer, Escape closes, scroll locked, `aria-modal` correct.

### 4.5 Chat surface (the centerpiece)
18. Thread list sidebar: conversations with rename (inline), delete (confirm), search filter, active state, share action opening a share dialog (pick colleagues, permission note).
19. Virtualized transcript (TanStack Virtual, variable heights, overscan, stable scroll anchoring during streams, scroll-to-latest button with unread count).
20. Message anatomy: user messages as compact right-aligned bubbles; assistant answers as an UNFRAMED left column — typography and hairlines carry hierarchy, NO card border/fill and NO bot avatar; a small mono label marks authorship.
21. Composer: auto-growing textarea, Enter sends / Shift+Enter newline, send button morphs to Stop while streaming, attachment chip, per-message WebSearchToggle switch with typed localized disabled reason, character counter.
22. Streaming: simulated token-by-token SSE with adjustable speed. Render streamed Markdown progressively (headings, lists, blockquotes, links, tables, fenced code with syntax highlighting and copy button) with zero layout shift and a caret. Support stop, regenerate, and optimistic user message placement.
23. Run-stage rail: while an answer runs, show ONE fixed five-slot rail before the text — Understanding, Evidence, Preparing, Writing, Finishing — connected by a quiet 1px rule; slots fill with the accent when completed; states waiting/running/complete/retrying/failed/skipped each get a glyph AND text; stable positions (no reflow). Announce stage changes and completion through polite live regions — never announce every token.
24. Failure states: queued, retryable failed run showing a durable localized error code beneath the user message with a Resubmit action; non-retryable variant too.
25. Citation system (full treatment):
    - Inline ordinal chips for four kinds: document, web, saved memory, earlier-chat message.
    - On `lg`+ screens render answers in blocks: claims sit in the text column, cited sources appear as margin cards in a ~13rem gutter aligned to the first block citing them — each card repeats the ordinal, source label, and supporting quote clamped to six lines; a source already carded keeps only its inline chip afterward.
    - The claim span between markers carries a low-opacity accent tint; hovering or focusing either the span or its margin card raises BOTH to full accent treatment.
    - Chips attach WITHOUT wrapping spans on headings, lists, quotes, tables, and code fences (structure stays intact).
    - Below `lg`: classic inline presentation, gutter hidden.
26. "Sources read" disclosure per assistant message: closed by default; opens to a list preserving server order — cited sources with ordinals and a supporting quote, read-but-uncited sources marked distinctly, one generic "quote unavailable" state.
27. Owner-only debug drawer per answer: lazy-loaded bounded run projection (stage history, counts, timestamps, token usage, normalized failure fields) — visibly labeled internal, never prompts or raw payloads.
28. Memory citations: clicking one opens the exact revision view inside the memories panel.

### 4.6 Memories panel
29. Panel (sheet or dedicated route) listing saved memories with content, origin turn, timestamps; tombstone action (soft delete, struck-through row); a 30-day reversible history timeline; per-entry Revert appending a revision; empty state.

### 4.7 Visualization companion — canvas beside the chat (required, novel)
30. Split layout: transcript left, visualization pane right, separated by a keyboard-accessible resizable divider (react-resizable-panels: arrow keys resize, Home/End collapse, size persists). Below `lg`, the pane becomes a tab or bottom sheet instead.
31. Content renders model-generated HTML/SVG (charts: bar, line, comparison table, KPI strip) inside a SANDBOXED IFRAME (`sandbox` attribute, no same-origin access, titled for a11y). Generated documents may load ECharts from a CDN or draw hand-rolled SVG.
32. Sync behavior: after each completed answer the pane updates to reflect it (e.g., a comparison answer produces a comparison chart; a trend answer a line chart). During regeneration show a shimmer; keep the previous visual until the new one is ready. When an answer references the visual, briefly highlight the pane edge and offer "Show".
33. Version rail: every update creates a version; scrub/restore previous versions; Refresh, Fullscreen (dialog), and Download (.html) actions.
34. Provide at least four scripted conversation demos that exercise different visuals, including one where a follow-up message revises the same visual.

### 4.8 Publisher workflow demos
35. Issue creation flow: create issue (metadata form with validation) → upload documents → preview → schedule (DatePicker) or publish immediately; scheduled-state badges; published issues become immutable with an explanatory state.
36. Notifications: publish triggers a toast plus a notification bell dropdown listing delivered issues; notification settings page with per-account email language select.

### 4.9 Component gallery
37. A `/components` route: indexed gallery of every component above, grouped by section, each shown in its full state matrix, with prop notes. This route is the acceptance surface — reviewers will walk it.

## 5. Accessibility requirements (WCAG 2.2 AA, verified)

- Contrast AA everywhere including muted text and placeholder states; document any exception.
- Every interactive element: visible focus (`:focus-visible` ring token), ≥24px target, operable by keyboard alone, sensible tab order.
- Live-region strategy: `role=status` (polite) for run stages, streaming completion, saves; `role=alert` for failures; nothing announced per-token; test with VoiceOver or NVDA and describe the result in the README.
- Resizable divider and all drag interactions have keyboard alternatives (WCAG 2.2Dragging).
- Reduced-motion media query disables nonessential animation.
- `lang` attribute switches with locale; iframe has `title`; dialogs labeled; tables use proper `th`/`scope`; sort buttons expose `aria-sort`.

## 6. Quality bar

- Zero layout shift during streaming and image/font load; virtualized where lists exceed ~50 items; memoized markdown rendering.
- Every string translated (fr-FR complete first, en-US parity); dates/numbers localized.
- Honest empty states for: no ingested public sources, empty archive, no notifications, no memories, failed load.
- Code organization mirrors a real component library: `src/components/ui/*` primitives, `src/components/product/*` composed components, barrel exports; a README table mapping every inventory item → file(s) → demo route.

## 7. Acceptance checklist (self-verify before finishing)

Run `npm install && npm run dev` cleanly. Then confirm:

1. All 37 numbered items exist and are reachable from the gallery route.
2. A scripted "golden path" works end-to-end: send message → run rail animates five stages → answer streams with Markdown table and ≥3 citations → margin gutter appears on desktop → sources-read disclosure lists them → canvas updates to a chart → version rail shows two versions.
3. A scripted failure path: stream fails mid-run → retryable error code → Resubmit recovers.
4. Keyboard-only walkthrough: navigate shell, open palette, sort/filter a table, edit inline field, run golden path, resize canvas pane, restore a version — no mouse.
5. Screen-reader pass on the chat flow described in §5.
6. fr-FR ↔ en-US switch leaves zero untranslated strings on visited pages.
7. No console errors or warnings (React key/a11y lint clean).

State in your final report: how to run the app, the route map, and any deviations from this brief with reasons.
