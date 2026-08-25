# Bref. — component demo website

A standalone demo that exercises every component of the Bref subscriber-portal design system against mock data: a publisher back office and a client consultation surface with cited answers, saved memories, and a synchronized visualization pane.

## Run

```bash
npm install
npm run dev        # http://127.0.0.1:5173 → /fr/client/chat
```

Other scripts:

```bash
npm run typecheck  # tsc -b --noEmit (strict)
npm run check:i18n # fr/en key parity + every used key resolves
npm run build      # production build
```

The mock service lives behind one interface (`src/services`). It simulates latency, token streaming, retries and failures deterministically, and persists lightweight demo edits (source renames, subscribers, the single chat, memories, side-panel state and requested widths, visualization sizes, and locale) in `localStorage` under the `bref.` prefix. The command-palette action “Réinitialiser les données de démonstration” restores the seed.

The subscriber chat uses one compact Chat/Subscriptions/Memories page selector below 1536px. At 1536px and wider, the same mounted Subscriptions and Memories panels stay edge-anchored around a centered chat capped at 1440px. Each open panel starts at a 432px minimum (or the natural centered-chat gutter), can be resized to 960px, and keeps the center chat at least 480px wide; each requested width persists separately. Subscriptions list subscribed sources, let users enable or disable retrieval, and drill into source publications and issue details through breadcrumbs. Sidebar resize handles use a 12px hit target, with the 1px accent line activating immediately on hover, focus, or drag.

## Routes

| Route | View |
| --- | --- |
| `/` | Redirects to the stored locale (default `/fr/client/chat`) |
| `/:locale/client/chat` | One consultation: virtualized transcript, citations, Subscriptions side panel, Memories side panel, visualization pane |
| `/:locale/publisher?tab=sources\|publications\|documents\|subscribers` | Publisher workspace |
| `/:locale/publisher/issues/new` | Issue creation flow |
| `/:locale/publisher/settings/notifications` | Per-account notification email language |
| `/:locale/components` | Component gallery (acceptance surface) |

`fr-FR` is default; every UI string is translated (`Intl.DateTimeFormat`, `NumberFormat`). Editorial content stays French in both locales by design, as French titles would in an English interface.

## Inventory → files → demo

### 1. App shell & navigation

| # | Item | Files | Demo |
| --- | --- | --- | --- |
| 1 | App shell, workspace switcher, locale switcher, focus rings | `components/product/app-shell.tsx`, `command-palette.tsx`, `notification-bell.tsx`; ring token in `styles/theme.css` | Every page; gallery §01 |
| 2 | Breadcrumbs with truncation + `title` | `components/ui/breadcrumbs.tsx` | Publisher pages; gallery §01 |
| 3 | Command palette (⌘K/Ctrl+K) | `components/product/command-palette.tsx` on cmdk | Anywhere; gallery §01 |
| 4 | Tabs + segmented control | `components/ui/tabs.tsx` | Publisher tabs; shell switcher; gallery §01 |
| 5 | Skip link, landmarks, heading order | `app-shell.tsx`, pages | Tab into any page |

### 2. Data display

| # | Item | Files | Demo |
| --- | --- | --- | --- |
| 6 | Dense hairline table primitives, sticky header | `components/ui/table.tsx` | Gallery §02 |
| 7 | DataTable (TanStack Table): multi-sort, facets, global search, column visibility, tri-state selection, bulk bar, pagination, URL state | `components/product/data-table.tsx` | All product tables |
| 8a | SourcesTable (type badge, latest publication, read-only subscription) | `components/product/tables.tsx` | Publisher › Sources; demo-state control switches data/loading/empty/error |
| 8b | PublicationsTable (metrics, scheduled treatment, deletion notice, immutable dialog) | same | Publisher › Numéros |
| 8c | Subscriber subscriptions and source publications tables (delivered only) | `components/product/subscriber-subscriptions.tsx` | Subscriber chat › Subscriptions side panel, with source enablement, issue details, breadcrumbs, and independently persisted wide-mode width |
| 8d | DocumentsTable (PDF open via blob URL, upload sheet, missing-file error row) | same | Publisher › Documents |
| 8e | SubscribersTable (pause/resume, delete+undo, draft-add row with company combobox and email validation) | same | Publisher › Abonnés |
| 9 | Badge, Card, Separator, SectionHeader, MetaRow | `components/ui/atoms.tsx`, `states.tsx` | Gallery §02 |
| 10 | EmptyState / ErrorState | `components/ui/states.tsx` | Gallery §02; all tables |

### 3. Forms & input

| # | Item | Files | Demo |
| --- | --- | --- | --- |
| 11 | Button (primary/secondary/ghost/destructive/link; pressed scale 0.97) | `components/ui/button.tsx` | Gallery §03 |
| 12 | Input, Textarea, Select, Combobox, Checkbox, Switch, RadioGroup, DatePicker, FormField | `ui/input.tsx`, `ui/select.tsx`, `ui/combobox.tsx`, `ui/controls.tsx`, `ui/datepicker.tsx`, `ui/form-field.tsx` | Gallery §03; issue flow; draft-add row |
| 13 | InlineEditableField (hover surface, large edit surface, Esc/Enter, save announcement) | `ui/inline-editable-field.tsx` | Sources names; gallery §03 |
| 14 | ConfirmingDeleteButton (two-step, undo toast) | `ui/confirming-delete-button.tsx` | Subscribers rows; memories; gallery §03 |
| 15 | FileUpload (drag-drop, PDF-only, progress, invalid-type error, object URL open) | `ui/file-upload.tsx` | Documents sheet; issue flow; gallery §03 |

### 4. Overlays & feedback

| # | Item | Files | Demo |
| --- | --- | --- | --- |
| 16 | Dialog, AlertDialog, Sheet, Popover, DropdownMenu, Tooltip, Toast (success/error/undo), Skeleton, HoverCard | `ui/dialog.tsx`, `ui/sheet.tsx`, `ui/overlays.tsx`, `ui/toast.tsx`, `ui/atoms.tsx` | Gallery §04; throughout |
| 17 | Focus management proof | Radix primitives inside `ui/dialog.tsx` / `ui/sheet.tsx` | Open any overlay: focus trapped, restored on close, Escape closes, scroll locked, `aria-modal` set |

### 5. Chat surface

| # | Item | Files | Demo |
| --- | --- | --- | --- |
| 18 | Virtualized transcript (TanStack Virtual, dynamic heights, anchoring, scroll-to-latest with unread count) | `chat/transcript.tsx` | One persistent chat; while streaming scrolled up |
| 19 | Message anatomy: compact user bubble; unframed assistant column with mono label | `chat/message.tsx` | The seeded exchange and later questions |
| 20 | Composer: auto-grow to 10 rows, then scrolls internally; Enter/Shift+Enter, send⇄Stop morph, attachment chip, web-search toggle, browser dictation with editable transcript | `chat/composer.tsx` | Chat footer; gallery §05 |
| 21 | Streaming: token SSE, progressive Markdown (Gfm tables, fenced code with highlight + copy), caret, stop/regenerate, optimistic placement | `chat/markdown.tsx`, `services/mock/engine.ts` | Send any scripted question |
| 22 | Run-stage rail: five stable slots, six statuses with glyph + text, polite announcements (never per-token) | `chat/run-rail.tsx`, live regions in `lib/announce.tsx` | While a run executes; gallery §05 |
| 23 | Failures: queued, retryable (`RUN-429`, Resubmit), non-retryable (`RUN-X500`) | `chat/message.tsx` (FailureBlock), engine scripts | One chat: « Analyse confidentielle du churn » and fatal scripted input |
| 24 | Citations: four kinds, highlighted claims open hover/focus previews below lg while margin cards remain at lg+, claim tinting, two-way hover sync, structure-preserving chips | `chat/citations.tsx`, `chat/markdown.tsx` | Growth/arbitration/renewal answers ≥1024 px wide |
| 25 | Sources-read disclosure (server order, read-not-cited marks, quote-unavailable state) | `chat/sources-disclosure.tsx` | Under each answer |
| 26 | Owner debug drawer: lazy-loaded normalized run projection | `chat/debug-drawer.tsx`, `debug-sheet.tsx`; trigger on messages with a run ID | Press `{}` on an answer with a run |
| 27 | Memory citations open exact revision | `citations.tsx` chip click → `memories-panel.tsx` | Arbitration answer, citation 4 |

Scripted questions in the one chat: growth (+ monthly follow-up revising the chart), arbitration (KPI strip + memory citation), renewal cohort (comparison table), churn (retryable failure then bar chart), and cartography (fatal). The seeded growth exchange loads directly on entry.
Wide-mode side-panel controls now use the same open/close action for Subscriptions and Memories, and chat content areas include overflow clipping for stable scrolling when panels resize.

The composer dictation control uses the browser's native `SpeechRecognition` (or `webkitSpeechRecognition`) and `navigator.mediaDevices.getUserMedia`. It inserts the result as editable composer text before Send, keeps microphone data local without storing or uploading audio, and shows a local error when either API is not available.

### 6. Memories

| # | Item | Files | Demo |
| --- | --- | --- | --- |
| 28 | Panel: content, origin turn, timestamps, tombstone, 30-day history, per-revision Revert, empty state | `chat/memories-panel.tsx`, `pages/client-chat.tsx` | Right side panel, closed by default, independently persisted with a wide-mode pointer/keyboard resize handle using a 12px hit target and an immediate accent line |

### 7. Visualization companion

| # | Item | Files | Demo |
| --- | --- | --- | --- |
| 29 | Split panes (react-resizable-panels): arrow keys resize, Home/End collapse, sizes persist; wider chat/visual resize hit area with a thin divider; tabs below lg | `pages/client-chat.tsx` | Drag/focus the divider |
| 30 | Sandboxed iframe (`sandbox=""`, no scripts, titled), hand-rolled SVG documents | `chat/viz-pane.tsx`, `services/mock/visuals.ts` | Any visual answer |
| 31 | Sync on completion, shimmer during regeneration, previous version retained, edge pulse + “Show” | `viz-pane.tsx`, store highlight keys | Send a visual question |
| 32 | Version rail: scrub, Restore (appends version), Refresh (jittered data), Fullscreen dialog, Download `.html` | `viz-pane.tsx` | Version rail above the canvas |
| 33 | Four+ scripted demos incl. follow-up revision | `services/mock/scripts.ts`, `content.ts` | One chat; each question keeps its own visual version |

### 8. Publisher workflows

| # | Item | Files | Demo |
| --- | --- | --- | --- |
| 34 | Issue creation: validated metadata → upload → preview → schedule/publish; scheduled badges; immutable published issues | `pages/publisher-issue-new.tsx` | Route `publisher/issues/new` |
| 35 | Notifications: publish toast + bell dropdown + settings page with per-account email language | `notification-bell.tsx`, `pages/publisher-notifications.tsx` | Publish an issue; bell; settings route |

### 9. Gallery

| # | Item | Files | Demo |
| --- | --- | --- | --- |
| 36 | Indexed gallery with state matrices and prop notes | `pages/gallery.tsx` | Route `/:locale/components` |

## Accessibility (WCAG 2.2 AA)

- **Contrast** — verified pairs on paper `#faf8f3`: ink `#211d16` ≈ 14.9:1 · muted `#5c5546` ≈ 6.9:1 · accent `#9d2235` ≈ 7.3:1 · ok `#23694a` ≈ 5.7:1 · warn `#8a5a12` ≈ 5.3:1 · danger `#a02c22` ≈ 6.9:1 · white-on-accent ≈ 7.7:1. Faint `#8a8272` is decorative/graphical only (≥3:1), never body text.
- **Focus** — single `:focus-visible` accent-ring token globally; inverted variant on ink fills; every interactive target ≥24 px.
- **Keyboard** — palette (⌘K, arrows, Enter), table sort buttons (`aria-sort`, Enter toggles, Shift+Enter multi-sort), faceted filters, column menu, pagination, inline fields (Enter commit / Escape cancel), date picker (arrows, PageUp/Down, Home/End), wide sidebar handles (16px arrows, Home to reset), resizable divider (arrows resize, Home/End collapse — WCAG 2.2 Dragging alternative), version rail, two-step delete.
- **Live regions** — one persistent polite `role=status` region announces run start, stage changes and completion (“Réponse terminée — N source(s) citée(s)”); one `role=alert` region announces failures. Nothing is announced per token. Success toasts are `role=status`, errors `role=alert`.
- **Reduced motion** — media query collapses animation/transition durations to near zero.
- **Tables** — `th[scope=col]`, sortable headers expose `aria-sort`, skeleton rows `aria-hidden`.
- **Iframe** — `sandbox=""`, no same-origin, `title` from the generating question.
- **Screen readers** — verified with the macOS Accessibility Inspector accessibility tree walk (landmarks, labels, `aria-sort`, combobox pattern on palette/combobox, `aria-expanded` disclosures, dialog `role=dialog` + labelled titles). A VoiceOver/NVDA pass was not run by this agent; expected behavior per region strategy above — stage changes and completion polite, failures assertive, nothing per token.

## Known deviations

1. **Editorial content is French in both locales** — deliberate; UI chrome is fully translated.
2. **VoiceOver/NVDA manual pass not executed** — automated build (tsc strict), i18n parity script, and an in-browser structural walk were used instead; SR instructions above.
3. **Virtualization applies to the transcript** (the only list exceeding ~50 rendered items); tables paginate instead.
4. **Visual documents use hand-rolled SVG**, not CDN ECharts, because the sandboxed iframe blocks scripts — allowed by the brief (“or draw hand-rolled SVG”).
5. **Demo-state controls** (data/loading/empty/error) sit in each publisher table toolbar so reviewers can reach every state honestly without waiting for a real outage.
