## Design Context

### Users

- **Primary**: Executives and politicians reading in the early morning (5-7am). Need signal, not noise. Time-poor. Skimming-first reading behavior.
- **Secondary**: Press and newsroom professionals producing briefings. Need reliable delivery, clear editorial workflow, trust in the AI's source attribution.
- **Duality**: The audience has two hats: the editorial producer (publisher) and the time-sensitive consumer (client). The design must serve both without confusing them.

### Brand Personality

serious, editorial, precise

### Aesthetic Direction

- **Concept**: Pressroom — editorial seriousness meets digital precision.
- **Color**: Cool-tinted near-white paper backgrounds (`--color-paper`, `--color-canvas`), warm near-black ink text (`--color-ink`), single oxblood accent (`--color-accent`, the editor's red pencil). Light-first (dark mode deferred).
- **Typography**: Fraunces (display/wordmark), Newsreader (reading body), IBM Plex Sans (UI/tables), IBM Plex Mono (metadata/citations). No Inter/Roboto/Arial.
- **Shapes**: Small radii (4px default, `rounded-sm`), no drop shadows, hairline rules (`border-rule`, `divide-rule`) as primary divider system.
- **Positive reference**: Linear.app. Adopt their precision, restraint, type-led hierarchy, dense tables, purposeful motion — adapted to an editorial-light (not dark) context instead of a B2B dashboard.
- **Anti-references**: Generic B2B dashboards (card-grid layouts, heavy sidebars, big rounded corners, progress bars, gradient accents), beige/sand/cream themes, purple-on-white AI aesthetic, Inter/Roboto defaults, glossy or glassmorphic UI, decorative SVG illustrations, marketing-style hero sections, floating gradient orbs.

### Design Principles

1. **Editorial clarity before visual flourish** — If it does not help the user read or find information faster, do not add it. Every element must earn its place.

2. **One signal, rest quiet** — Oxblood carries the interaction and intelligence signal. Everything else is ink-on-paper. Never introduce a competing accent. The editor's red pencil is the only color that communicates state or action.

3. **Information density with precision** — Tight spacing, small-caps headers, hairline dividers. Respect the user's time by showing more signal per viewport. Prefer dense tables over paginated lists.

4. **Purposeful motion** — Fast transitions (100-200ms) on interactive states. No decorative animation. Motion must answer a question (what changed, where to click). Use `transform` and `opacity` only.

5. **Typographic hierarchy over container hierarchy** — Use type weight, size, and spacing before reaching for borders, backgrounds, containers, or cards. The page should work without its box model visible.
