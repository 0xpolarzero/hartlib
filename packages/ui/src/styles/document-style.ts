/**
 * Inline form of the standalone document stylesheet for the static docs
 * response. It uses the same visual tokens as the application stylesheet.
 */
export const standaloneDocumentCss = `
@import url("https://fonts.googleapis.com/css2?family=Fraunces:wght@400;500&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap");
:root {
  color-scheme: light;
  --color-paper: #faf8f3;
  --color-paper-deep: #f0ece2;
  --color-surface: #fffdf9;
  --color-ink: #211d16;
  --color-ink-2: #5c5546;
  --color-ink-3: #8a8272;
  --color-line: #e3ddd0;
  --color-line-2: #cfc7b4;
  --color-accent: #9d2235;
  --color-accent-deep: #7c1626;
  --color-accent-soft: #f3dfe2;
  --color-ok: #23694a;
  --color-warn: #8a5a12;
  --color-danger: #a02c22;
  --font-display: "Fraunces", Georgia, "Times New Roman", serif;
  --font-read: "Newsreader", Georgia, "Times New Roman", serif;
  --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --radius-tiny: 2px;
}
*, *::before, *::after { box-sizing: border-box; }
html, body {
  min-height: 100%;
  margin: 0;
  background: var(--color-paper);
  color: var(--color-ink);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
body { -webkit-text-size-adjust: 100%; }
main {
  max-width: 68rem;
  margin: 0 auto;
  padding: 3rem 1.25rem 6rem;
}
h1, h2, h3 {
  color: var(--color-ink);
  font-family: var(--font-display);
  font-weight: 500;
  line-height: 1.15;
  letter-spacing: -0.02em;
}
h1 {
  margin: 0 0 0.5rem;
  font-size: clamp(2rem, 4vw, 3.4rem);
}
h2 {
  margin: 3rem 0 1rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--color-line);
  font-size: clamp(1.4rem, 2.5vw, 1.85rem);
}
h3 { margin: 1.5rem 0 0.5rem; font-size: 1.15rem; }
p, li { max-width: 70ch; color: var(--color-ink); }
p { margin: 0.75rem 0; }
ul, ol { padding-left: 1.4rem; }
li { margin: 0.3rem 0; }
a {
  color: var(--color-accent);
  text-underline-offset: 3px;
}
a:hover { color: var(--color-accent-deep); }
code, kbd, samp {
  border: 1px solid var(--color-line-2);
  border-radius: var(--radius-tiny);
  background: var(--color-paper-deep);
  padding: 0.1rem 0.3rem;
  font-family: var(--font-mono);
  font-size: 0.86em;
  overflow-wrap: anywhere;
}
pre {
  overflow: visible;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 1rem 0;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-tiny);
  background: var(--color-paper-deep);
  padding: 1rem 1.1rem;
  font: 0.82rem/1.55 var(--font-mono);
}
pre code { border: 0; background: transparent; padding: 0; }
.lede {
  margin: 0 0 1.5rem;
  color: var(--color-ink-2);
  font-size: 1.15rem;
}
.meta { margin-bottom: 2rem; color: var(--color-ink-2); font-size: 0.88rem; }
.pill, .badge {
  display: inline-block;
  border: 1px solid var(--color-line-2);
  border-radius: var(--radius-tiny);
  background: var(--color-paper-deep);
  color: var(--color-ink-2);
  padding: 0.1rem 0.4rem;
  font-size: 0.78rem;
  vertical-align: middle;
}
.badge {
  padding: 0.1rem 0.45rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.badge.term { border-color: var(--color-danger); color: var(--color-danger); }
.term { color: var(--color-danger); font-weight: 500; }
.ok { color: var(--color-ok); font-weight: 500; }
.warn { color: var(--color-warn); font-weight: 500; }
strong { font-weight: 600; }
hr { margin: 2.5rem 0; border: 0; border-top: 1px solid var(--color-line); }
.toc {
  margin: 1.5rem 0 2.5rem;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-tiny);
  background: var(--color-paper-deep);
  padding: 1rem 1.25rem 1rem 2.25rem;
}
.toc ol { margin: 0; }
.toc a { text-decoration: none; }
.toc a:hover { text-decoration: underline; }
table {
  table-layout: fixed;
  width: 100%;
  margin: 1rem 0 1.5rem;
  border-collapse: collapse;
  font-size: 0.9rem;
}
th, td {
  min-width: 0;
  padding: 0.55rem 0.65rem;
  border-bottom: 1px solid var(--color-line);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
  word-break: break-word;
}
th {
  background: var(--color-paper-deep);
  color: var(--color-ink-2);
  font-size: 0.74rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: normal;
}
td code { white-space: normal; overflow-wrap: anywhere; }
.footer { margin-top: 3rem; color: var(--color-ink-2); font-size: 0.82rem; }
.lifecycle { display: grid; gap: 1rem; margin: 1rem 0 1.5rem; }
.lifecycle-caption { margin: 0; color: var(--color-ink-2); font-size: 0.92rem; }
.lifecycle-rail {
  border: 1px solid var(--color-line);
  border-top: 3px solid var(--color-accent);
  border-radius: var(--radius-tiny);
  background: var(--color-paper-deep);
  padding: 1rem;
}
.lifecycle-rail.output { border-top-color: var(--color-ok); }
.lifecycle-rail-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  color: var(--color-ink-2);
  font-size: 0.74rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.lifecycle-rail-title strong {
  color: var(--color-ink);
  font-size: 0.98rem;
  letter-spacing: normal;
  text-transform: none;
}
.lifecycle-track {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 0.5rem;
  align-items: stretch;
}
.lifecycle-card {
  min-width: 0;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-tiny);
  background: var(--color-surface);
  padding: 0.9rem;
}
.lifecycle-step {
  display: inline-grid;
  width: 1.5rem;
  height: 1.5rem;
  place-items: center;
  border-radius: var(--radius-tiny);
  background: var(--color-accent);
  color: var(--color-paper);
  font-size: 0.74rem;
  font-weight: 600;
}
.lifecycle-rail.output .lifecycle-step { background: var(--color-ok); }
.lifecycle-card h3 { margin: 0.7rem 0 0.25rem; font-size: 1rem; }
.lifecycle-card p { margin: 0; color: var(--color-ink-2); font-size: 0.88rem; }
.lifecycle-card code { display: block; margin-top: 0.65rem; overflow-wrap: anywhere; white-space: normal; }
.lifecycle-arrow {
  display: grid;
  min-width: 1.25rem;
  place-items: center;
  color: var(--color-accent);
  font-size: 1.35rem;
  font-weight: 500;
}
.lifecycle-rail.output .lifecycle-arrow { color: var(--color-ok); }
@media (max-width: 760px) {
  main { padding-top: 2rem; }
  table {
    display: block;
    width: 100%;
  }
  table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }
  table tbody,
  table tr {
    display: block;
    width: 100%;
  }
  table tr {
    margin-bottom: 1rem;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-tiny);
    background: var(--color-surface);
    padding: 0.45rem 0.7rem;
  }
  table td {
    display: grid;
    grid-template-columns: minmax(6.5rem, 34%) minmax(0, 1fr);
    gap: 0.65rem;
    min-width: 0;
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--color-line);
  }
  table td:last-child { border-bottom: 0; }
  table td::before {
    color: var(--color-ink-2);
    font-size: 0.68rem;
    font-weight: 500;
    letter-spacing: 0.06em;
    line-height: 1.35;
    text-transform: uppercase;
  }
  h2#http + p + table tbody td:nth-child(1)::before { content: "Method & path"; }
  h2#http + p + table tbody td:nth-child(2)::before { content: "Scope"; }
  h2#http + p + table tbody td:nth-child(3)::before { content: "Request"; }
  h2#http + p + table tbody td:nth-child(4)::before { content: "Success"; }
  h2#http + p + table tbody td:nth-child(5)::before { content: "Notable errors"; }
  h2#events + p + table tbody td:nth-child(1)::before { content: "Type"; }
  h2#events + p + table tbody td:nth-child(2)::before { content: "Payload"; }
  h2#events + p + table tbody td:nth-child(3)::before { content: "When emitted"; }
  h2#events + p + table tbody td:nth-child(4)::before { content: "Terminal?"; }
  h2#tables + table tbody td:nth-child(1)::before { content: "Table"; }
  h2#tables + table tbody td:nth-child(2)::before { content: "Role"; }
  .lifecycle-rail-title { display: block; }
  .lifecycle-rail-title span { display: block; margin-top: 0.25rem; }
  .lifecycle-track { grid-template-columns: 1fr; }
  .lifecycle-arrow { min-height: 1.25rem; transform: rotate(90deg); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
}
`;
