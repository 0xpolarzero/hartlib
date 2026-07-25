// @brief/web — static English-only chat reference served at /docs.
// Served verbatim by the docs() Vite plugin and the web bootstrap/router
// fallback. Every path stays outside the localized application layout, so the
// page has no fr/en locale switch.
//
// Editorial structure (two-tier):
//   - Main read: a short narrative that follows one chat turn end to end.
//   - Reference appendix: exact routes, payloads, events, predicates, locks,
//     and tables, folded into native <details> sections for lookup.
//
// Keep in sync with the code paths in:
//   packages/backend-domain/src/chat-runtime.ts
//   apps/api/src/domain/chat.ts
//   apps/worker/src/jobs/*
//   apps/worker/src/ai/workflow/{ai-chat.tsx,operations.ts}
//   apps/worker/src/ai/product-state/*
//   packages/shared/src/chat.ts
export const DOCS_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brief — How chat works</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1f2c;
    --muted: #5b6478;
    --rule: #e3e7ef;
    --code-bg: #f5f7fb;
    --accent: #2b5bd7;
    --term: #b03a1f;
    --ok: #1f7a3a;
    --warn: #8a5a00;
    --measure: 70ch;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1218;
      --fg: #e6e9f2;
      --muted: #9aa3b8;
      --rule: #232a39;
      --code-bg: #161b26;
      --accent: #8aa9ff;
      --term: #ff9b7a;
      --ok: #6ee08a;
      --warn: #e7c180;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body {
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: clamp(1rem, 0.97rem + 0.13vw, 1.0625rem);
    line-height: 1.65;
    -webkit-text-size-adjust: 100%;
  }
  main {
    width: min(100% - 2rem, 72rem);
    margin: 0 auto;
    padding: clamp(2rem, 5vw, 3.5rem) 0 6rem;
  }
  .wrap { padding: 0 1.25rem; }
  .measure, .toc, .ladder, .timeline, .callout, table, pre, dl.refs {
    max-width: var(--measure);
    margin-left: 0; margin-right: 0;
  }

  h1, h2, h3 { line-height: 1.2; letter-spacing: -0.015em; }
  h1 { font-size: clamp(1.9rem, 4.5vw, 2.6rem); margin: 0 0 0.5rem; }
  h2 {
    font-size: clamp(1.35rem, 2.6vw, 1.7rem);
    margin: 2.6rem 0 0.9rem;
    padding-top: 1.4rem;
    border-top: 1px solid var(--rule);
  }
  h3 { font-size: 1.08rem; margin: 1.4rem 0 0.4rem; }
  p { margin: 0.7rem 0; }
  ul, ol { padding-left: 1.3rem; margin: 0.6rem 0; }
  li { margin: 0.3rem 0; }
  li::marker { color: var(--muted); }
  strong { font-weight: 600; }

  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.88em;
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 4px;
    overflow-wrap: anywhere;
  }
  pre {
    background: var(--code-bg);
    padding: 13px 15px;
    border-radius: 8px;
    overflow-x: auto;
    border: 1px solid var(--rule);
    font-size: 0.82rem;
    line-height: 1.5;
  }
  pre code { background: none; padding: 0; font-size: inherit; }

  .lede { font-size: 1.12rem; color: var(--muted); margin: 0.4rem 0 0; }
  .meta { color: var(--muted); font-size: 0.82rem; margin: 0.8rem 0 2rem; }
  .pill {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 0.72rem;
    background: var(--code-bg);
    border: 1px solid var(--rule);
    color: var(--muted);
    margin-right: 4px;
  }

  .toc {
    background: var(--code-bg);
    border: 1px solid var(--rule);
    border-radius: 10px;
    padding: 12px 18px;
    margin: 1.2rem 0 0.4rem;
    font-size: 0.92rem;
  }
  .toc ul { list-style: none; padding-left: 0; margin: 0.3rem 0; }
  .toc > ul > li { margin: 0.45rem 0; font-weight: 600; }
  .toc ul ul { padding-left: 1.1rem; font-weight: 400; margin-top: 0.25rem; }
  .toc a { color: var(--accent); text-decoration: none; }
  .toc a:hover { text-decoration: underline; }
  .toc-label { color: var(--muted); font-size: 0.74rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; }

  /* Callouts: restrained left rule, label carries meaning. */
  .callout {
    margin: 1.3rem 0;
    padding: 0.2rem 0 0.2rem 1rem;
    border-left: 3px solid var(--rule);
  }
  .callout--key { border-left-color: var(--accent); }
  .callout--one { border-left-color: var(--fg); }
  .callout--gotcha { border-left-color: var(--warn); }
  .callout--example { border-left-color: var(--ok); }
  .callout__label {
    display: block;
    margin-bottom: 0.3rem;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .callout--key .callout__label { color: var(--accent); }
  .callout--one .callout__label { color: var(--fg); }
  .callout--gotcha .callout__label { color: var(--warn); }
  .callout--example .callout__label { color: var(--ok); }
  .callout p { margin: 0.3rem 0; }
  .callout p + p { margin-top: 0.6rem; }

  /* Lifecycle step ladder. */
  .ladder { list-style: none; padding: 0; margin: 1.4rem 0; }
  .ladder__step {
    position: relative;
    display: grid;
    grid-template-columns: 2.1rem minmax(0, 1fr);
    gap: 1rem;
    padding-bottom: 1.4rem;
  }
  .ladder__step:last-child { padding-bottom: 0; }
  .ladder__step:not(:last-child)::after {
    content: "";
    position: absolute;
    top: 2.4rem; bottom: 0.2rem; left: 1rem;
    border-left: 1px solid var(--rule);
  }
  .ladder__num {
    position: relative; z-index: 1;
    display: grid; width: 2.1rem; height: 2.1rem;
    place-items: center;
    border: 1px solid var(--rule);
    border-radius: 50%;
    background: var(--bg);
    color: var(--accent);
    font-size: 0.82rem; font-weight: 700;
  }
  .ladder__actor {
    display: block; margin-bottom: 0.25rem;
    color: var(--muted);
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .ladder__body p { margin: 0.25rem 0; color: var(--fg); }
  .ladder__facts { margin: 0.5rem 0 0; font-size: 0.85rem; color: var(--muted); }

  /* Event timeline. */
  .timeline { list-style: none; padding: 0; margin: 1.3rem 0; }
  .ev {
    position: relative;
    display: grid;
    grid-template-columns: 1rem minmax(9rem, 13rem) minmax(0, 1fr);
    gap: 0 0.9rem;
    padding-bottom: 1.1rem;
  }
  .ev::before {
    content: "";
    position: absolute;
    top: 0.5rem; left: 0.22rem;
    width: 0.5rem; height: 0.5rem;
    border: 2px solid var(--accent);
    border-radius: 50%;
    background: var(--bg);
  }
  .ev:not(:last-child)::after {
    content: "";
    position: absolute;
    top: 1.1rem; bottom: 0; left: 0.46rem;
    border-left: 1px solid var(--rule);
  }
  .ev__name { grid-column: 2; align-self: start; }
  .ev__body { grid-column: 3; min-width: 0; color: var(--muted); font-size: 0.92rem; }
  .ev--repeat::before { border-style: double; }
  .ev--terminal::before { border-color: var(--term); background: var(--term); }
  .ev--terminal .ev__name { color: var(--term); font-weight: 600; }

  /* Identity card for the traced example. */
  .ids {
    background: var(--code-bg);
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 10px 14px;
    margin: 1rem 0;
    font-size: 0.82rem;
  }
  .ids dt { color: var(--muted); font-weight: 600; }
  .ids dd { margin: 0 0 0.3rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }

  /* Reference appendix: native <details>. */
  h2.reference-h { border-top: 2px solid var(--fg); padding-top: 1.6rem; margin-top: 3rem; }
  details {
    max-width: var(--measure);
    margin: 0.7rem 0;
    padding: 0.7rem 1rem;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--bg);
  }
  details > summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 0.98rem;
    list-style: none;
  }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before {
    content: "▸";
    display: inline-block;
    margin-right: 0.5rem;
    color: var(--muted);
    transition: transform 0.15s;
  }
  details[open] > summary::before { transform: rotate(90deg); }
  details[open] > summary { margin-bottom: 0.7rem; }
  details > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
  details table { font-size: 0.86rem; margin: 0.5rem 0 1rem; }
  details dl { margin: 0.5rem 0; }
  details dt { font-weight: 600; margin-top: 0.5rem; }
  details dd { margin: 0.15rem 0 0.3rem 1rem; color: var(--muted); }

  table { border-collapse: collapse; width: 100%; margin: 0.8rem 0 1.2rem; display: block; overflow-x: auto; }
  th, td { text-align: left; vertical-align: top; padding: 7px 9px; border-bottom: 1px solid var(--rule); }
  th { background: var(--code-bg); font-weight: 600; white-space: nowrap; }

  .badge {
    display: inline-block; font-size: 0.68rem; font-weight: 700;
    padding: 1px 7px; border-radius: 9px;
    border: 1px solid var(--rule); color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.03em; vertical-align: middle;
  }
  .badge--term { color: var(--term); border-color: var(--term); }

  a { color: var(--accent); }
  .footer { color: var(--muted); font-size: 0.82rem; margin-top: 2.5rem; max-width: var(--measure); }
  [id] { scroll-margin-top: 1.5rem; }

  /* Model-task cards — roles and task lanes in the workflow. */
  .agent { max-width: var(--measure); margin: 1.2rem 0; padding: 0.9rem 1.1rem; border: 1px solid var(--rule); border-radius: 8px; background: var(--code-bg); }
  .agent__head { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
  .agent__name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.95rem; font-weight: 700; color: var(--fg); }
  .agent__role { color: var(--muted); font-size: 0.85rem; }
  .agent__job { margin: 0 0 0.5rem; font-size: 0.95rem; }
  .agent dl { margin: 0.3rem 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.15rem 0.8rem; }
  .agent dt { color: var(--muted); font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .agent dd { margin: 0; font-size: 0.88rem; }
  .agent dd code { font-size: 0.82rem; overflow-wrap: anywhere; }
  .agent .ex { margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px dashed var(--rule); font-size: 0.85rem; color: var(--muted); }
  .agent .ex strong { color: var(--ok); }

  @media (max-width: 42rem) {
    main { padding-top: 1.5rem; }
    .ev { grid-template-columns: 1rem minmax(0, 1fr); }
    .ev__name { grid-column: 2; }
    .ev__body { grid-column: 2; margin-top: 0.25rem; }
    .ladder__step { grid-template-columns: 1.9rem minmax(0, 1fr); gap: 0.75rem; }
    .ladder__num { width: 1.9rem; height: 1.9rem; }
    .ladder__step:not(:last-child)::after { top: 2.2rem; left: 0.9rem; }
  }
</style>
</head>
<body>
<main>
<div class="wrap">

  <p class="meta">
    <span class="pill">GET /docs</span>
    <span class="pill">English</span>
    <span class="pill">Reference</span>
  </p>

  <h1>Inside the workflow</h1>

  <p class="lede">
    A chat turn is a background job. This page shows the public contract in
    order: the request and immutable scope are saved, the turn is planned,
    scoped evidence is retrieved, context is fitted, an answer is produced,
    and the result is saved.
  </p>

  <nav class="toc" aria-label="Contents">
    <span class="toc-label">Main read</span>
    <ul>
      <li><a href="#flow">The six steps</a></li>
      <li><a href="#state">The loaded turn</a></li>
      <li><a href="#graph">The workflow graph</a></li>
      <li><a href="#evidence">Evidence and citations</a></li>
      <li><a href="#access">Access and final save</a></li>
    </ul>
    <span class="toc-label">Reference appendix</span>
    <ul>
      <li><a href="#reference">Exact specs (collapsible)</a></li>
    </ul>
  </nav>

  <!-- ============ MAIN READ ============ -->

  <section id="flow">
  <h2>The six steps</h2>
  <div class="ladder">
    <div class="ladder__step"><span class="ladder__num">1</span><div><strong>Save the request and scope.</strong><p>The API intersects client requests with server entitlements and defaults, then saves the user message, complete immutable run scope, run, and queue job.</p></div></div>
    <div class="ladder__step"><span class="ladder__num">2</span><div><strong>Plan the turn.</strong><p><code>plan-turn</code> runs on every turn, including the first. It reads current prior turns, resolves references, selects useful prior turn IDs, validates those IDs, and returns <code>clarify</code>, <code>single</code>, or <code>fanout</code>.</p></div></div>
    <div class="ladder__step"><span class="ladder__num">3</span><div><strong>Retrieve scoped evidence.</strong><p>Internal documents and older chat, saved memory, and web research use separate tool boundaries. Brief code searches only IDs and policy values in the saved scope.</p></div></div>
    <div class="ladder__step"><span class="ladder__num">4</span><div><strong>Build and fit context.</strong><p>Code binds exact evidence identities, renders the provider request, counts it with the registered tokenizer, and records any explicit keep, range, or omit decision.</p></div></div>
    <div class="ladder__step"><span class="ladder__num">5</span><div><strong>Answer.</strong><p>The direct, topic, or synthesis answer receives the frozen request and has no retrieval tools. Only the final answer or clarification is user-visible.</p></div></div>
    <div class="ladder__step"><span class="ladder__num">6</span><div><strong>Save.</strong><p>One transaction validates the saved scope and exact evidence identities, then stores the source map and uses, memory changes, usage, assistant message, terminal event, and final status.</p></div></div>
  </div>
  </section>

  <section id="state">
  <h2>The loaded turn</h2>
  <p><code>load-turn</code> returns stable run and request data plus the validated immutable acceptance scope. It does not preload conversation bodies, memory inventories, source metadata, extraction rows, hashes, or policy bodies.</p>
  <pre><code>LoadedTurn = {
  aiRunId, chatId, initiatingUserId, userMessageId,
  userMessage, locale, market, currentDate,
  webRequested,
  memoryMode,                 // "private_owner" | "disabled"
  citationNamespace,          // ^cn_[A-Za-z0-9_-]{22}$
  acceptanceScope             // user/chat/company, exact IDs, memory revisions,
                              // web state, provider/models, and allowlist
}</code></pre>
  <p>The server creates a random per-answer <code>citationNamespace</code> for citation handles when it accepts the request. A local handle is <code>k_&lt;citationNamespace&gt;_&lt;positive-decimal-ordinal&gt;</code>. The namespace scopes handles only; it never proves a claim or grants access.</p>
  </section>

  <section id="graph">
  <h2>The workflow graph</h2>
  <p>After the request is saved, <code>plan-turn</code> is the first model task on every turn. Only after a valid result does the workflow mount the parallel <code>AnswerLane</code> and memory lane. Clarification runs inside <code>AnswerLane</code>, schedules no retrieval or answer request, and still joins the required memory extraction before final save; single and fanout branches retrieve separate domains, fit context, answer, and join at one final save.</p>
  <pre><code>load-turn → plan-turn
             └─ Parallel (after valid plan-turn)
                  ├─ AnswerLane
                  │    ├─ clarify → clarification result (no retrieval or answer request)
                  │    ├─ single  → internal || memory || web → fit → answer
                  │    └─ fanout  → per-topic internal || memory || web → fit → packets → synthesis
                  └─ memory-extract
finalize    → scope + exact-integrity validation → one atomic save</code></pre>
  <div class="callout callout--key">
    <span class="callout__label">Key idea · code-owned model roles</span>
    <p>
      The fast and main roles remain code-owned model settings. Retrieval and
      context work use the fast role; direct, topic, and synthesis answers use
      the main role. Only clarification and final answer text become
      <code>text_delta</code> the client sees.
    </p>
  </div>
  </section>

  <section id="evidence">
  <h2>Evidence and citations</h2>
  <p>Internal, memory, and web retrieval stay separate. Server code owns the immutable accepted search scope and the narrow lookup for a user-named source; no broad source list enters provider input. Metadata-only search and lookup results create no exposure or evidence record. Any preview or snippet that contains document content follows one kind-specific binding: public evidence binds the model-visible <code>documentId</code> to the exact public document row, immutable version identity, hash, source scope, and ranges, with no extraction ID; publisher evidence additionally binds <code>documentId</code> to the exact publisher extraction row and required one-to-one version relation, with the same immutable version, hash, source scope, and ranges. Extraction identity stays internal and never enters model input, provider tool results, or the public API. Brief creates an internal exposure-proof sidecar from the exact normalized request and execution coordinates, checks it against the known content and tokenizer, and stores it with the measurement; it is never serialized into provider messages or counted as request bytes. Memory evidence keeps the exact revision; web evidence keeps the exact normalized quotation and canonical URL.</p>
  <p>Ready publisher PDFs and extracted text are immutable: their stored PDF identity, object key, metadata, extracted pages, canonical text, content hash, ranges, and active extraction binding do not change. Normal writes cannot replace the PDF, add a competing extraction, move the current binding, or delete ready content; only an explicit fenced retention or legal-purge action can remove the complete record. That sole purge path acquires the sorted canonical hold-scope advisory locks first, then row-locks issue → document → version → extraction, rechecks holds and ready state, and deletes the complete tuple atomically.</p>
  <p>Code assigns local citation handles from <code>citationNamespace</code> and a numeric evidence-manifest order. A matching namespace alone never validates a claim; the handle must resolve to exact evidence in the current source map.</p>
  </section>

  <section id="access">
  <h2>Access and final save</h2>
  <p>At acceptance, Brief freezes the full server-derived scope: the user, chat, and company, exact source and access IDs, memory mode and revisions, provider and model identities, requested and effective web state, and the canonical domain allowlist. Later membership, grant, source-setting, memory, provider, or web-policy changes affect later accepted runs only.</p>
  <p>Brief validates exact document, version, hash, locator, range, memory-revision, and quotation identities before provider use and inside the final save transaction. These source-integrity checks prove that the saved evidence is unchanged; they do not reauthorize current access. The final transaction applies memory changes, records usage, stores the assistant message and source map, and emits <code>done</code> or <code>error</code> atomically.</p>
  <p>Delivered publication access is historical: raw issue content uses the exact delivery-recipient record captured at delivery. Ordinary subscription, grant, source-setting, or policy changes do not revoke a publication already delivered to that recipient, and a later grant does not unlock an earlier delivery. Account deletion, purge, retention, legal or security restriction, and exact identity mismatch remain exceptional denials.</p>
  </section>

  <h3 id="retrieval-lane">The retrieval lane (A / B / W in parallel)</h3>
  <p>For <code>single</code>, internal, memory, and web retrieval stay separate. For <code>fanout</code>, each topic has the same separate boundaries.</p>

  <div class="agent">
    <div class="agent__head"><span class="agent__name">A · retrieve-internal</span><span class="agent__role">fast · toolLoop</span></div>
    <p class="agent__job">Find the smallest ranked set of relevant internal documents and older chat messages.</p>
    <dl>
      <dt>Input</dt><dd><code>{ question, relevantTurnIds, locale, market, currentDate, toolBounds }</code>; Brief reads only the saved acceptance scope at each operation</dd>
      <dt>Tools</dt><dd><code>search_internal(query, cursor?)</code> → ranked docs/messages (Postgres <code>websearch_to_tsquery</code>, recency decay); <code>lookup_named_source(name)</code> → a strict code-minted lookup reference plus narrow matches inside the saved scope (an unauthorized name and no match look the same); <code>inspect_internal(reference)</code> → peek a document range or message; <code>emit_internal_manifest</code> (terminal)</dd>
      <dt>Output</dt><dd><code>{ entries: [ document-reference | chat-reference ] }</code>. A strict document reference is <code>{ kind:"document", documentId, purpose, ranges?: [{ charStart, charEnd }] }</code>; the optional ranges are exact inspected UTF-16 spans. The lookup result is <code>{ found: boolean, lookupRef: string /* ^lr_[A-Za-z0-9_-]{32}$ */ }</code>; code mints and stores that one-use reference for this task only. A later <code>search_internal</code> consumes it once to scope the search to the exact saved IDs. Code then accepts only references returned by that scoped lookup or search, validates exact immutable identity, and rejects repeats. Invented, stale, foreign, or consumed references fail closed; omitting <code>lookupRef</code> keeps the default search over the full saved scope. For a public document, Brief binds the model-visible ID to the exact public document row, immutable version, hash, source scope, and ranges with no extraction ID. For publisher content, it additionally binds the ID to the exact extraction row and required one-to-one version relation. A chat reference is <code>{ kind:"chat_message", messageId, purpose }</code>. Unknown keys fail.</dd>
    </dl>
    <p class="ex"><strong>Acme:</strong> searches <code>acme revenue guidance Q3</code> → inspects the Q3 shareholder report → selects ranges covering the guidance change.</p>
  </div>

  <div class="agent">
    <div class="agent__head"><span class="agent__name">B · select-memories</span><span class="agent__role">fast · structured | toolLoop</span></div>
    <p class="agent__job">Pick the active saved-memory revisions relevant to this question.</p>
    <dl>
      <dt>Gate</dt><dd>If <code>memoryMode === "disabled"</code>, no memory content is exposed.</dd>
      <dt>Input</dt><dd><code>{ question }</code> plus bounded current results from <code>search_memories</code> / <code>inspect_memory</code>; no preloaded inventory</dd>
      <dt>Output</dt><dd><code>{ entries: [{ memoryId, memoryRevisionId }] }</code></dd>
    </dl>
    <p class="ex"><strong>Acme:</strong> no relevant memories → <code>{ entries: [] }</code></p>
  </div>

  <div class="agent">
    <div class="agent__head"><span class="agent__name">W · retrieve-web</span><span class="agent__role">fast · toolLoop</span></div>
    <p class="agent__job">Discover public pages and select verbatim quotations — only when the question asks for current/public info.</p>
    <dl>
      <dt>Gate</dt><dd>Web retrieval is allowed only when <code>webRequested</code> is true and the saved acceptance policy is enabled. A valid enabled path may return an empty result.</dd>
      <dt>Input</dt><dd><code>{ question, locale, market, policy, toolBounds: { maximumSearches, maximumFetches, … } }</code></dd>
      <dt>Tools</dt><dd><code>web_search(query, cursor?)</code> (Tinyfish, allowlist-enforced); <code>web_fetch(url)</code> → bounded page text; <code>emit_web_evidence</code> (terminal)</dd>
      <dt>Output</dt><dd><code>{ entries: [{ url, title, domain, quote, publishedAt?, capturedAt, purpose }] }</code> — every <code>quote</code> is verbatim from a fetched page</dd>
    </dl>
    <p class="ex"><strong>Acme:</strong> searches Acme Q3 guidance → fetches <code>investors.acme.com/news/q3-2025-results</code> → quotes the guidance figure.</p>
  </div>

  <h3 id="reduction-agent">Context reducer (only if the context is too big)</h3>
  <div class="agent">
    <div class="agent__head"><span class="agent__name">O · reduce-plan</span><span class="agent__role">fast · toolLoop</span> <span class="agent__role">+ reduce-measure (code, no model)</span></div>
    <p class="agent__job">Produce a keep / range / omit plan that fits the token budget.</p>
    <dl>
      <dt>Runs when</dt><dd>Measured <code>status === "needs_reduction"</code> (see <a href="#context">How the context window is built</a>).</dd>
      <dt>Input</dt><dd><code>{ question, allowance, mandatoryInputCost, overage, candidates: [{ id, kind, label, purpose, rank, renderedTokenCount }], priorValidationFeedback, toolBounds }</code> — <code>allowance = usable − mandatory</code>, <code>overage = input − usable</code>; compact metadata, not source bodies</dd>
      <dt>Tools</dt><dd><code>inspect_candidate(id, range?)</code>; <code>search_within_candidate(id, terms, cursor?)</code>; <code>measure_plan(decisions)</code> (trial-fit); <code>emit_context_plan</code> (terminal)</dd>
      <dt>Output</dt><dd><code>{ decisions: [{ id, action: "keep"|"range"|"omit", reason, ranges? }] }</code> — every candidate appears once. Then <strong>reduce-measure</strong> (code) applies the decisions, rebuilds from the original ledgers, and re-measures; the loop repeats until <code>ready</code> or the iteration cap.</dd>
    </dl>
    <p class="ex"><strong>Acme:</strong> context fits as-is → reduction loop does not run. <strong>If retrieval had returned several long reports:</strong> reduce-plan keeps the guidance ranges, omits boilerplate (recording each omission as a gap), trial-fits with <code>measure_plan</code>, and reduce-measure confirms <code>ready</code>.</p>
  </div>

  <h3 id="memory-extract">Memory extractor (parallel after plan-turn)</h3>
  <div class="agent">
    <div class="agent__head"><span class="agent__name">memory-extract</span><span class="agent__role">fast · structured | toolLoop</span></div>
    <p class="agent__job">From the current user message only, propose durable memory creates or updates.</p>
    <dl>
      <dt>Input</dt><dd><code>{ currentUserMessage }</code> plus bounded saved-scope memory search results</dd>
      <dt>Tools</dt><dd><code>emit_memory_proposals</code> (direct); <code>search_memories</code>, <code>inspect_memory</code>, <code>emit_memory_proposals</code> (tool mode)</dd>
      <dt>Output</dt><dd><code>{ proposals: [{ kind, content, targetMemoryId? }] }</code> — applied at finalize; <code>[]</code> is normal</dd>
    </dl>
    <p class="ex"><strong>Acme:</strong> the question expresses no durable preference → <code>{ proposals: [] }</code></p>
  </div>

  <h3 id="answer-agents">The answer tasks</h3>
  <div class="agent">
    <div class="agent__head"><span class="agent__name">answerDirect</span><span class="agent__role">main · stream</span></div>
    <p class="agent__job">Write the final single-route answer, grounded in the frozen context.</p>
    <dl>
      <dt>Input</dt><dd>The frozen <code>context.request</code> unchanged (system = <code>DirectAnswerPrompt</code>, user = <code>{ locale, originalMessage, question, selectedConversation, evidence, gaps }</code>)</dd>
      <dt>Tools</dt><dd>None — ordinary streamed text with <code>[[cite:k_…]]</code> citation markers</dd>
      <dt>Output</dt><dd>Streamed answer text. Before the first token: <code>context_ready</code> + <code>answer_started</code>; then one <code>text_delta</code> per chunk.</dd>
    </dl>
    <p class="ex"><strong>Acme:</strong> streams "Acme raised its full-year revenue guidance from $5.0–$5.1B to $5.2–$5.3B… [[cite:k_…_1,k_…_2]]"</p>
  </div>

  <div class="agent">
    <div class="agent__head"><span class="agent__name">answerTopic</span><span class="agent__role">main · structured</span></div>
    <p class="agent__job">Produce one grounded packet for one fanout topic (no cross-topic synthesis).</p>
    <dl>
      <dt>Input</dt><dd>Same shape as direct, plus <code>topicId</code>; only this topic's evidence</dd>
      <dt>Tools</dt><dd><code>emit_topic_packet</code> (terminal)</dd>
      <dt>Output</dt><dd><code>{ topicId, status: "answered"|"partial", claims: [{ text, sourceKeys[] }], gaps[] }</code></dd>
    </dl>
  </div>

  <div class="agent">
    <div class="agent__head"><span class="agent__name">synthesize</span><span class="agent__role">main · stream</span></div>
    <p class="agent__job">Combine the ordered topic packets into the final streamed answer.</p>
    <dl>
      <dt>Input</dt><dd>System = <code>SynthesisPrompt</code>; user = <code>{ locale, originalMessage, selectedConversation, packets[] }</code> — for evidence it sees <strong>packets only</strong> (claims + source keys + gaps), plus the original message and selected conversation; never the raw source bodies</dd>
      <dt>Tools</dt><dd>None — streamed text recombining packet claims</dd>
      <dt>Output</dt><dd>Streamed synthesis text (same event pattern as <code>answerDirect</code> with <code>mode: "synthesis"</code>)</dd>
    </dl>
  </div>

  <section id="context">
  <h2>How the context window is built</h2>
  <p>
    This is the core of the answer lane: turning separate retrieval results into
    the single prompt the answer model sees. Four steps —
    <strong>assemble → measure → (reduce) → freeze</strong>.
  </p>

  <h3>1 · Assemble</h3>
  <p>
    <code>assembleContext</code> turns the internal / memory / web references
    into concrete <code>AnswerCandidate</code> objects (document ranges, chat
    messages, memory text, web quotes), mints a <code>sourceKey</code>
    (<code>k_&lt;citationNamespace&gt;_&lt;ordinal&gt;</code>) for each — the
    ordinal comes from a deterministic candidate order, never task completion
    order, so the same evidence keeps the same key across retries; for fanout,
    identities are merged into one global set before topics use them.
    It deduplicates and ranks the candidates. Assembly emits only the authorized,
    hydrated, ordered candidates, provisional locators, a source map, the
    selected conversation, and the gaps. It does not render or count the answer
    request, compute marginal costs, or persist the complete measurement. The
    output is a <code>ContextAssembly</code> for the measure task.
  </p>

  <h3>2 · Measure</h3>
  <p>
    The <code>measureContext</code> task reads that assembly, renders every
    candidate into a <code>&lt;source&gt;</code> block, builds the actual answer
    request (system prompt + JSON user input), and counts tokens exactly with
    the model's tokenizer. It owns the complete measurement, including every
    marginal cost, and persists the initial routing state. In words:
    <strong>reserve space for the answer, then compare the full input against
    what remains</strong>. If even the empty request does not fit, the run fails;
    if the full request fits, it is ready; otherwise it needs reduction. The
    exact formula:
  </p>
  <pre><code>inputTokens         = countRequestTokens(full request)
usableInputTokens   = min(aiMainInputMaxTokens, contextWindow - requestedOutputTokens)
mandatoryInputTokens = countRequestTokens(request with empty evidence + empty conversation)

status = mandatoryInputTokens > usableInputTokens        ? "failed"          // doesn't fit even empty
       : inputTokens          <= usableInputTokens       ? "ready"           // fits as-is
       : /* otherwise */                                  "needs_reduction"  // too big, must reduce</code></pre>
  <p>
    The measurement also records the <strong>marginal token cost</strong> of
    each source and each conversation entry (so the reducer knows the price of
    each piece), and produces a <strong>consumer</strong> descriptor:
    <code>{ consumer: "direct" | "topic", topicId?, inputTokens, requestedOutputTokens, usableInputTokens }</code>
    (the topic form carries <code>topicId</code>).
  </p>

  <h3>3 · Reduce (only if <code>needs_reduction</code>)</h3>
  <p>
    The <strong>reduction task</strong> (above) receives compact candidate
    metadata — for <em>both</em> the selected conversation entries and the
    evidence candidates — plus the allowance and the overage. It inspects
    candidates as needed, trial-fits a plan with <code>measure_plan</code>, and
    emits a terminal <code>keep / range / omit</code> decision for every
    candidate (only documents may use <code>range</code>).
    <code>applyDecisions</code> then rebuilds the context from the
    <em>original</em> ledgers (so a correction iteration can restore an item a
    prior plan omitted) and re-measures. The loop repeats until
    <code>ready</code> or the iteration cap (<code>aiContextReductionMaxIterations</code>).
  </p>

  <h3>4 · Freeze</h3>
  <p>
    <code>freezeContext</code> is a final validation: it re-counts the stored
    request, checks every source's exact immutable identity and integrity, converts any unresolved
    <code>needs_reduction</code> to <code>failed</code> (<code>context_plan_unfit</code>),
    and returns the frozen <code>ContextState</code> whose
    <code>request</code> the answer task will stream verbatim.
  </p>

  <div class="callout callout--key">
    <span class="callout__label">Key idea · what the answer model literally sees</span>
    <p>
      The <code>evidence</code> field is a single string of rendered source
      blocks inside the JSON user message — not a separate attachment:
    </p>
    <pre><code>{ locale, originalMessage, question, selectedConversation, evidence, gaps }

// evidence is rendered as one block per source, joined by blank lines:
&lt;source key="k_&lt;citationNamespace&gt;_1" kind="document" label="Acme Q3 report"&gt;
…selected document range text…
&lt;/source&gt;

&lt;source key="k_&lt;citationNamespace&gt;_2" kind="web" label="Acme Q3 earnings"&gt;
…verbatim quote…
&lt;/source&gt;</code></pre>
    <p>
      Only the keys in those headers are valid <code>[[cite:]]</code> targets.
      For evidence, synthesis sees <strong>packets rather than source
      bodies</strong> — but it still receives the original message and selected
      conversation.
    </p>
  </div>

  <h3>Fanout budget</h3>
  <p>
    For <code>fanout</code>, <code>allocateFanout</code> reserves synthesis
    space up front. <code>F</code> = the token cost of the synthesis skeleton
    (prompt + message + conversation + <code>N</code> empty packet shells);
    <code>Us = min(aiMainInputMaxTokens, contextWindow - aiMainOutputMaxTokens)</code>;
    each topic packet gets output cap <code>P = min(aiMainOutputMaxTokens, model.maximumOutputTokens, floor((Us - F) / N))</code>.
    Allocation fails (<code>synthesis_budget_mismatch</code>) if <code>P</code>
    is too small to fit even a minimal partial packet.
  </p>
  </section>

  <section id="paths">
  <h2>Answer paths</h2>
  <dl class="refs">
    <dt><code>clarification</code></dt>
    <dd><code>plan-turn</code> found an ambiguity. <strong>No retrieval follows.</strong> The clarification question is saved as the answer.</dd>
    <dt><code>single</code></dt>
    <dd>One retrieval pass (internal + memory + web in parallel) → assemble → measure → [reduce] → freeze → <code>answerDirect</code> streams the answer. The common case.</dd>
    <dt><code>synthesis</code> (from <code>fanout</code>)</dt>
    <dd><code>plan-turn</code> selected independently answerable topics. Each topic runs separate retrieval → context → packet work. Then <code>synthesize</code> streams the final answer from the ordered packets only.</dd>
  </dl>
  <p>
    The <code>mode</code> field on <code>context_ready</code> and
    <code>answer_started</code> tells the client which path produced the stream.
  </p>
  </section>

  <section id="finalize">
  <h2>Commit the outcome</h2>
    <p>
      After both lanes finish, the <code>finalize</code> task runs
      <code>finalizeAiRun</code> — one transaction that turns the provisional
      answer into the permanent result.
    </p>
    <ol>
      <li>lock the run and verify the Smithers binding;</li>
      <li>consume exactly one terminal <code>turn_plan</code> observation and validate complete coordinate-bound bijections among each consumed provider output's measurement, usage row, source exposures, and exposure attestations; retry rows remain unconsumed history, with one unmatched terminal measurement allowed only for a failed or aborted attempt with no provider output; missing, extra, conflicting, or foreign records fail closed;</li>
      <li><strong>validate</strong> the complete final evidence set in the source map (not only the cited items) against the saved scope and exact immutable identities;</li>
      <li>apply memory proposals and aggregate exact usage;</li>
      <li><strong>success:</strong> save the assistant message, source map, memory changes, usage, terminal status, and <code>done</code> event atomically.</li>
    </ol>
    <p>
      <strong>Failure:</strong> a controlled failure inside the transaction
      sets <code>failed_at</code> and emits <code>error</code> (after
      <code>memory_updated</code> + <code>usage</code>). A handler-side crash
      that bypasses finalize uses <code>failAiRun</code>, which emits
      <code>usage</code> + <code>error</code> without <code>memory_updated</code>.
      The client's stream observes the terminal event and closes.
    </p>
    <div class="callout callout--gotcha">
      <span class="callout__label">Why it is safe · observations &amp; exposures</span>
      <p>
        While workflow tasks run, every plan, manifest, measurement, packet, and
        citation is recorded as a durable <strong>observation</strong> bound to
        its exact task attempt; every piece of protected content shown to a
        model is recorded as a <strong>source exposure</strong> bound to the
        exact provider request. Finalize validates the observation + usage
        trail, and every stream poll checks only the authenticated viewer's
        run and chat access; the saved acceptance scope remains fixed while the
        run executes.
        answer. Finalize consumes exactly one terminal <code>turn_plan</code>
        and rejects missing, extra, conflicting, or foreign measurement,
        usage, exposure, or attestation rows before any product write.
      </p>
    </div>
    <p>
      The round-trip mechanics (how the message reaches the worker, and how the
      client streams events over SSE) are in the reference appendix below.
    </p>
  </section>

  <!-- ============ REFERENCE APPENDIX ============ -->

  <h2 id="reference" class="reference-h">Reference appendix</h2>
  <p class="measure">
    Exact contracts for implementation and troubleshooting. Not required for
    the main read — expand any section on demand.
  </p>

  <details id="ref-http">
    <summary>HTTP API — routes, schemas, status codes</summary>
    <p>The standalone English <code>GET /docs</code> page is public and needs no authentication. Development and preview serve these exact HTML bytes directly; production emits <code>docs/index.html</code>. A static-host shell fallback may serve the same bytes for <code>/docs</code> or <code>/docs/</code> without starting authentication or observability. Localized paths such as <code>/en-US/docs</code> and <code>/fr-FR/docs</code> are not docs routes. The chat API routes below require an authenticated identity; <code>401</code> bodies are <code>{ "error": "unauthorized" }</code>.</p>
    <table>
      <thead><tr><th>Method &amp; path</th><th>Scope</th><th>Request</th><th>Success</th><th>Notable errors</th></tr></thead>
      <tbody>
        <tr><td><code>GET /v1/chat</code></td><td>demo only</td><td>—</td><td><code>200 GetChatResponse</code></td><td><code>404</code> outside demo</td></tr>
        <tr><td><code>POST /v1/chat/messages</code></td><td>demo only</td><td><code>SendChatMessageRequest</code> (≤ 64 KiB)</td><td><code>202 SendChatMessageAccepted</code></td><td><code>403 forbidden</code>; <code>403 web_research_unavailable</code>; <code>409 active_ai_run</code>; <code>404</code> outside demo (credits not enforced in demo)</td></tr>
        <tr><td><code>GET /v1/chats/:chatId</code></td><td>always on</td><td>—</td><td><code>200 GetChatResponse</code></td><td><code>404 not_found</code> (includes authz failure)</td></tr>
        <tr><td><code>POST /v1/chats/:chatId/messages</code></td><td>always on</td><td><code>SendChatMessageRequest</code> (≤ 64 KiB)</td><td><code>202 SendChatMessageAccepted</code></td><td><code>402</code>; <code>403 forbidden</code>; <code>403 web_research_unavailable</code>; <code>409 active_ai_run</code></td></tr>
        <tr><td><code>GET /v1/ai-runs/:runId/stream</code></td><td>always on</td><td>optional <code>Last-Event-ID</code> / <code>?afterSeq</code></td><td><code>200 text/event-stream</code></td><td><code>404 not_found</code> (missing or unauthorized); <code>410 terminal_event_unavailable</code></td></tr>
      </tbody>
    </table>
    <h4>Request schemas</h4>
    <dl>
      <dt><code>SendChatMessageRequest</code></dt>
      <dd><code>{ text, locale ∈ {fr-FR, en-US}, market ∈ {FR, US}, webSearchEnabled }</code>; <code>text</code> must contain non-whitespace.</dd>
      <dt><code>SendChatMessageAccepted</code></dt>
      <dd><code>{ message, run }</code>; <code>run.status</code> is always <code>"queued"</code>; <code>run.streamPath</code> is URL-encoded.</dd>
      <dt><code>GetChatResponse</code></dt>
      <dd><code>{ chat, messages[], effectiveWebPolicy, activeRun, canWrite }</code>; <code>activeRun</code> is the run with neither <code>finished_at</code> nor <code>failed_at</code>.</dd>
      <dt><code>ActiveAiRunConflict</code></dt>
      <dd><code>{ code: "active_ai_run", conflictScope: "chat" | "user", activeRun }</code>.</dd>
      <dt><code>EffectiveWebPolicy</code></dt>
      <dd>Either <code>{ enabled: false, reason, allowlistActive }</code> or <code>{ enabled: true, provider: "tinyfish", allowedDomains: string[] | null }</code>. Disabled reasons: <code>deployment_unavailable</code>, <code>company_disabled</code>, <code>allowlist_unsupported</code>. Enabled requires the company toggle on, Tinyfish available, and any configured allowlist non-empty, provider-supported, and within the per-run domain-filter cap.</dd>
    </dl>
    <h4>Contract rejections (before the handler runs)</h4>
    <p>Route-specific. The two message <code>POST</code> routes return <code>{ "error": … }</code> bodies: <code>invalid_body</code> (400), <code>request_too_large</code> (413), and <code>invalid_query</code> (400) — they declare no header schema, so <code>invalid_headers</code> is unreachable for them. The SSE stream route uses the same shapes keyed on <code>code</code> instead of <code>error</code>, and can also return <code>invalid_headers</code> for a malformed <code>Last-Event-ID</code>; it has no 413 path (it takes no body). The two <code>GET</code> chat routes declare no rejection mapping. Contract validation runs before the demo-mode gate, so a malformed non-demo request fails with <code>400</code>/<code>413</code> rather than the documented <code>404</code>.</p>
  </details>

  <details id="ref-events">
    <summary>Events &amp; SSE — full payload table, framing, cursors</summary>
    <p>The <code>event:</code> line is the event's <code>type</code>; <code>data:</code> is <code>JSON.stringify(event)</code>; <code>id:</code> is the row's <code>seq</code>. Events are stored in <code>ai_run_events</code> with a monotonic <code>seq</code> and a unique <code>emission_key</code> per run.</p>
    <table>
      <thead><tr><th><code>type</code></th><th>Payload</th><th>When emitted</th><th>Terminal?</th></tr></thead>
      <tbody>
        <tr><td><code>run_started</code></td><td>(none)</td><td>Worker picked up the run; also stamps <code>ai_runs.started_at</code>.</td><td><span class="badge">no</span></td></tr>
        <tr><td><code>context_ready</code></td><td><code>mode</code>, <code>reductionRan</code>, <code>sourcesRead[]</code>, <code>consumers[]</code></td><td>Before the answer phase. For single/synthesis the context is frozen and about to go to the model; for clarification the question is already produced and no answer request follows.</td><td><span class="badge">no</span></td></tr>
        <tr><td><code>answer_started</code></td><td><code>mode</code>, <code>attempt</code></td><td>Start of an answer attempt.</td><td><span class="badge">no</span></td></tr>
        <tr><td><code>text_delta</code></td><td><code>delta</code></td><td>One streamed text chunk. Clarification emits exactly one (the question).</td><td><span class="badge">no</span></td></tr>
        <tr><td><code>memory_updated</code></td><td><code>created</code>, <code>updated</code>, <code>discarded</code></td><td>At finalize, on both success and controlled-failure paths inside the finalize transaction. Handler-side failures that bypass finalize emit only <code>usage</code> + <code>error</code>. The memory extractor runs regardless of chat memory mode.</td><td><span class="badge">no</span></td></tr>
        <tr><td><code>usage</code> <span class="badge">model · request</span></td><td><code>scope:"request"</code>, <code>kind:"model"</code>, <code>role</code>, <code>attempt</code>, <code>inputTokens</code>, <code>outputTokens</code>, <code>cachedTokens</code>, <code>reasoningTokens</code>, <code>totalTokens</code></td><td>Per completed model response (or error response carrying known usage; aborted requests emit none).</td><td><span class="badge">no</span></td></tr>
        <tr><td><code>usage</code> <span class="badge">web · request</span></td><td><code>scope:"request"</code>, <code>kind ∈ {web_search, web_fetch}</code>, <code>attempt</code>, <code>status</code>, <code>resultCount</code>, <code>responseBytes</code>, <code>billedUnits | null</code></td><td>Per underlying external web operation (one logical search may fan out into several).</td><td><span class="badge">no</span></td></tr>
        <tr><td><code>usage</code> <span class="badge">run</span></td><td><code>scope:"run"</code>, aggregate <code>model {…, requestCount}</code> and <code>web {searchCount, fetchCount, responseBytes, billedUnits | null}</code></td><td>End-of-run totals, just before the terminal event.</td><td><span class="badge">no</span></td></tr>
        <tr><td class="ev--terminal"><code>done</code></td><td><code>assistantMessageId</code></td><td>Run succeeded; the assistant message is persisted.</td><td><span class="badge badge--term">yes — closes stream</span></td></tr>
        <tr><td class="ev--terminal"><code>error</code></td><td><code>code</code>, <code>retryable</code></td><td>Run failed; <code>code</code> mirrors <code>ai_runs.error_code</code>.</td><td><span class="badge badge--term">yes — closes stream</span></td></tr>
      </tbody>
    </table>
    <h4>SSE framing</h4>
    <pre><code>content-type:      text/event-stream; charset=utf-8
cache-control:     no-cache
connection:        keep-alive
x-accel-buffering: no</code></pre>
    <p>Each frame (blank line terminator required):</p>
    <pre><code>id: 7
event: text_delta
data: {"type":"text_delta","delta":"Q3 "}

</code></pre>
    <p>When idle for <code>keepAliveMs</code>, the server emits a comment line:</p>
    <pre><code>: keep-alive

</code></pre>
    <h4>Resume cursors</h4>
    <p><code>afterSeq</code> (query) accepts <code>0</code>; <code>Last-Event-ID</code> (header) must be <code>≥ 1</code>; both are decimal integers and the larger wins. <code>410 terminal_event_unavailable</code> is returned when the run is terminal and no <code>done</code>/<code>error</code> row exists at <code>seq &gt; afterSeq</code> — either because the cursor is already at/after it, or because the row was reaped by retention. If the run becomes terminal mid-stream with no replayable terminal event and no pending events, the stream closes silently.</p>
    <h4>Stream lifecycle</h4>
    <p><code>readRunStreamContext</code> returns <code>404</code> for a missing/deleted run scope. The handshake returns <code>{ authorized, terminal, replayableTerminal, events }</code>: unauthorized → <code>404</code>, terminal without a replayable terminal event → <code>410</code>, otherwise open SSE. <code>incrementalSse</code> schedules exactly one next poll after each tick completes; request abort or stream cancel clears that timer and closes the stream.</p>
  </details>

  <details id="ref-authz">
    <summary>Authorization — enqueue, finalize, and viewer predicates</summary>
    <p>Acceptance freezes one complete server-derived scope. Finalization validates that scope and exact evidence identities. Stream handshake and polls check only the authenticated viewer against the run and chat.</p>
    <h4>At enqueue (write path)</h4>
    <ul>
      <li>Chat owned by caller; <code>chats.deleted_at is null</code>; company and creator not recovery/purge-deleted.</li>
      <li>Membership active; organization id matches when provided.</li>
      <li>Every wired subscription source backed by a non-revoked grant on an access in <code>active</code>, <code>ending</code>, or <code>paused</code>.</li>
      <li>Captured under the advisory locks so the accepted scope cannot race a membership or grant change.</li>
    </ul>
    <h4>At finalize (single transaction)</h4>
    <p>The final transaction validates the run's immutable scope, exact source identities, document version/hash/locator/range data, memory revisions, web quotations, usage, and idempotency records. Later setting changes affect later runs only and do not discard an accepted answer.</p>
    <h4>On the stream (every poll)</h4>
    <ul>
      <li><strong>Identity &amp; membership</strong> — caller and chat/run pairing must match, and the caller and company must not be deleted or purged.</li>
      <li><strong>Run scope</strong> — retrieval and provider work use only the immutable IDs, memory revisions, provider values, web state, and domains saved at acceptance.</li>
      <li><strong>Document provenance</strong> — every document the model saw must resolve through the saved source identity and exact immutable version/hash/range tuple. Partial or tampered provenance is rejected.</li>
      <li><strong>Memory gating</strong> — the saved memory mode and exact revision IDs govern the run; later memory edits do not change it.</li>
      <li><strong>Web policy</strong> — the saved provider, enabled state, and allowlist govern every search, fetch, and redirect. Network safety checks remain in force.</li>
      <li><strong>Ownership or sharing</strong> — caller is the chat owner, or the chat is shared with memory disabled.</li>
    </ul>
    <p>Viewer authorization failure maps to <code>404</code> (never <code>403</code>) to avoid disclosing the run's existence.</p>
  </details>

  <details id="ref-workflow">
    <summary>Workflow map — task graph, retrieval, modes</summary>
    <p>The worker runs a resumable Smithers workflow named <code>ai-chat</code>. Tasks either call a method on a single operations object or route/validate outputs from earlier tasks. Shape:</p>
    <pre><code>load-turn                 → emits run_started
└─ plan-turn                clarify | single | fanout
   └─ Parallel (after valid plan-turn)
      ├─ AnswerLane
      │  ├─ Branch
      │  │  ├─ clarify      ask a disambiguating question (no retrieval or answer request)
      │  │  ├─ single       retrieve (internal | memories | web) →
      │  │  │                assemble → measure → [reduce loop] → freeze →
      │  │  │                answerDirect (streamed)
      │  │  └─ fanout       per-topic retrieve → answer →
      │  │                   synthesize (streamed)
      │  └─ answer-select   validate source map on ok
      └─ memory-extract     background memory revision extraction
finalize                   → emits memory_updated, usage(run), done | error</code></pre>
    <h4>Answer modes</h4>
    <dl>
      <dt><code>clarification</code></dt><dd>The turn is ambiguous; the model asks one clarifying question. No retrieval or answer request runs.</dd>
      <dt><code>single</code></dt><dd>One retrieval pass assembles one context window; the model answers directly against it.</dd>
      <dt><code>synthesis</code></dt><dd><code>plan-turn</code> selects independently answerable topics; each gets its own retrieval and answer; a final pass merges them.</dd>
    </dl>
    <p><code>plan-turn</code> runs first on the first and every later turn. Memory extraction starts only after its valid result and runs as the sibling lane of <code>AnswerLane</code> for every mode. Clarification is the <code>AnswerLane</code> branch that schedules no retrieval or answer request; finalization still waits for memory extraction.</p>
    <h4>Retrieval</h4>
    <ul>
      <li><strong>Internal documents</strong> — ranked search over public-source documents (Postgres <code>websearch_to_tsquery</code>, language-aware regconfig, <code>ts_rank_cd</code> × recency decay, content-hash dedup), plus publisher documents and prior chat messages.</li>
      <li><strong>Memories</strong> — selected from the exact memory revisions captured in the immutable acceptance scope; later memory edits do not change an accepted run.</li>
      <li><strong>Web</strong> — only when <code>webSearchEnabled</code> and the effective policy allows it; backed by Tinyfish search and a restricted fetcher.</li>
    </ul>
    <h4>Context budget</h4>
    <p>If the assembled context exceeds the model window, a bounded reduction loop narrows it (up to a fixed iteration cap). If it still cannot fit, the run fails with <code>context_plan_unfit</code>.</p>
    <h4>Worker job lifecycle</h4>
    <ul>
      <li><strong>Claim</strong> — under <code>brief:jobs:claim</code>, stale leases are reaped first; eligible jobs are claimed by <code>priority DESC, available_at ASC, created_at ASC</code> using <code>FOR UPDATE SKIP LOCKED</code>.</li>
      <li><strong>Heartbeat race</strong> — the handler races a heartbeat loop that refreshes <code>locked_at</code> about every ⅓ of the lock timeout; whichever finishes first cancels the other.</li>
      <li><strong>Smithers fence</strong> — the handler derives <code>smithers_run_id = "ai-chat:&lt;runId&gt;"</code>; any different non-null value fails closed before execution, and cleanup rechecks the same fence while locking the run row.</li>
      <li><strong>Already terminal</strong> — if the run is already finished/failed, the handler skips the workflow but fenced-deletes any bound Smithers rows and returns the job completed.</li>
      <li><strong>Worker abort</strong> — cancellation reaches the Smithers task, Pi request, web operation, and database effect; an aborted request cannot write late deltas or usage. On shutdown/abort, Smithers rows are retained (so the next claim resumes); the always-retryable job is marked failed and re-queued.</li>
    </ul>
    <h4>Finalization order (single transaction)</h4>
    <p>Execution/run locks and Smithers fence → consume exactly one terminal <code>turn_plan</code> and validate complete coordinate-bound measurement/usage/exposure/attestation bijections for every consumed provider output (retry rows remain unconsumed history; missing, extra, conflicting, or foreign records fail closed) → validate the immutable scope and exact final evidence set → apply memory changes and aggregate usage → save the assistant message, source map, terminal status, and <code>done</code>, or save the controlled failure and <code>error</code> atomically. Handler-side workflow failures (Smithers ended <code>failed</code>/<code>cancelled</code>, or an unexpected throw) use <code>failAiRun</code>, which aggregates usage and emits <code>error</code> without <code>memory_updated</code>.</p>
  </details>

  <details id="ref-state">
    <summary>Durable state &amp; recovery — tables, locks, retries</summary>
    <h4>Tables and their roles</h4>
    <dl class="refs">
      <dt><code>chats</code></dt><dd>A conversation owned by a user under a company. Carries <code>memory_mode</code> and <code>shared_at</code>.</dd>
      <dt><code>chat_messages</code></dt><dd>User and assistant turns; the assistant row links 1:1 to its <code>ai_runs</code> row.</dd>
      <dt><code>ai_runs</code></dt><dd>The coordination root. Holds one immutable acceptance scope, terminal timestamps, <code>smithers_run_id</code>, and a per-run <code>next_event_seq</code> counter.</dd>
      <dt><code>ai_run_events</code></dt><dd>The durable event buffer between worker (producer) and API (consumer). Append-only, <code>seq</code>-ordered, idempotent on <code>emission_key</code>.</dd>
      <dt><code>jobs</code></dt><dd>Transactional work queue. <code>ai_chat_run</code> rows are always retryable at the queue layer.</dd>
      <dt><code>ai_source_exposures</code></dt><dd>Per-provider-request record of every source shown to the model. It supports audit and exact evidence validation, not per-poll source authorization.</dd>
      <dt><code>ai_run_usage</code> / <code>ai_external_tool_usage</code></dt><dd>Per-request model / web token accounting.</dd>
      <dt><code>ai_observations</code></dt><dd>Deterministic, replay-safe observations: the strict turn plan, retrieval manifests, context measurements, memory extraction result, and citations.</dd>
      <dt><code>assistant_message_sources</code> / <code>…source_uses</code></dt><dd>Durable citations attached to the assistant message.</dd>
      <dt><code>user_memories</code> / <code>user_memory_revisions</code></dt><dd>Long-term memory; revisions are append-only (<code>create</code>/<code>update</code>/<code>delete</code>/<code>revert</code>).</dd>
      <dt><code>client_companies</code></dt><dd>Tenant; soft-deleted via <code>recovery_deleted_at</code> / <code>purged_at</code>.</dd>
      <dt><code>client_company_memberships</code></dt><dd>Links a user to a company; deactivated via <code>revoked_at</code> / <code>revoked_by_user_id</code> (no recovery/purge columns).</dd>
      <dt><code>client_company_ai_settings</code></dt><dd>Per-company web toggle and optional domain allowlist.</dd>
      <dt><code>chat_subscription_sources</code> / <code>client_employee_subscription_grants</code> / <code>client_subscription_accesses</code></dt><dd>The subscription wiring that gates publisher-document access.</dd>
      <dt><code>public_source_documents</code>, <code>publisher_issues</code>, <code>publisher_subscriptions</code>, <code>brief_documents</code>, <code>issue_deliveries</code></dt><dd>The document provenance graph consulted at authorization time.</dd>
      <dt><code>platform_users</code></dt><dd>User identities; soft-deleted via <code>recovery_deleted_at</code> / <code>purged_at</code>.</dd>
    </dl>
    <h4>Advisory locks (transaction-scoped, fixed order)</h4>
    <ul>
      <li><code>brief:user-memory:&lt;userId&gt;</code> — enqueue path.</li>
      <li><code>brief:demo-chat:&lt;userId&gt;</code> — demo chat provisioning.</li>
      <li><code>brief:client-members:&lt;companyId&gt;</code> — membership stability.</li>
      <li><code>brief:ai-chat:&lt;chatId&gt;</code> — per-chat serialization (backs the one-active-run invariant).</li>
      <li><code>brief:publisher-issue:&lt;issueId&gt;</code> — per-issue restriction lane, acquired in sorted order during finalization when the answer cites publisher documents.</li>
      <li><code>brief:jobs:claim</code> — single-writer job claim.</li>
    </ul>
    <p>Run-row <code>FOR UPDATE</code> is taken in a uniform order to avoid the FK <code>KEY SHARE → FOR UPDATE</code> deadlock.</p>
    <h4>One active run</h4>
    <p>Two partial unique indexes enforce it: <code>ai_runs_active_chat_key</code> (one active run per chat) and <code>ai_runs_active_initiating_user_key</code> (one per user across chats). <code>findActiveRunConflict</code> surfaces the violator as <code>409</code> with <code>conflictScope</code>; the enqueue path converts a unique-violation race into the same <code>409</code>.</p>
    <h4>Idempotency &amp; replay</h4>
    <p>Every mutating worker write keys on a deterministic identifier (<code>ai_run_events.emission_key</code>, the exposure coordinate, the usage coordinate, <code>ai_observations.observation_key</code>). For observations, exposures, and usage, a replay with the same key returns the prior row and hard-fails as a replay conflict if any field differs; raw event appends simply return the prior event for an occupied <code>emission_key</code> without comparing fields. Once a run is terminal, <code>appendAiRunEvent</code> refuses any event whose <code>emission_key</code> is not <code>"terminal"</code> (that key is unique, so at most one terminal event per run).</p>
    <h4>Retries</h4>
    <ul>
      <li><strong>Queue layer</strong> — <code>ai_chat_run</code> is always retryable; an expired lease is reaped and made immediately eligible again (<code>available_at = now()</code>); a handled failure returns to <code>retrying</code> with exponential backoff.</li>
      <li><strong>Workflow layer</strong> — every task has bounded retries; the reduction loop is iteration-capped; tool loops are turn-capped.</li>
      <li><strong>Terminal boundary</strong> — only <code>finalizeAiRun</code> / <code>failAiRun</code> may set <code>finished_at</code> / <code>failed_at</code> and emit <code>done</code> / <code>error</code>; both are guarded by <code>smithers_run_id</code> match and execution-scope invariants.</li>
    </ul>
  </details>

  <p class="footer">
    Reference derived from the current code paths in
    <code>packages/backend-domain/src/chat-runtime.ts</code>,
    <code>apps/api/src/domain/chat.ts</code>,
    <code>apps/worker/src/jobs/*</code>,
    <code>apps/worker/src/ai/workflow/ai-chat.tsx</code>,
    <code>apps/worker/src/ai/workflow/operations.ts</code>,
    <code>apps/worker/src/ai/product-state/*</code>, and
    <code>packages/shared/src/chat.ts</code>. English-only by design.
  </p>

</div>
</main>
</body>
</html>`;
