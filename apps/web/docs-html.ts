// @brief/web — static English-only chat reference served at /docs.
// served verbatim by the docs() Vite plugin and by the web bootstrap/router
// fallback. Every path stays outside the localized application layout, so the
// page has no fr/en locale switch.
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
    @media (prefers-color-scheme: dark) {
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
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main {
    max-width: 880px;
    margin: 0 auto;
    padding: 40px 24px 96px;
  }
  h1, h2, h3 { line-height: 1.25; }
  h1 {
    font-size: 2.1rem;
    margin: 0 0 8px;
    letter-spacing: -0.01em;
  }
  h2 {
    font-size: 1.35rem;
    margin: 2.4rem 0 0.6rem;
    padding-top: 1.6rem;
    border-top: 1px solid var(--rule);
    letter-spacing: -0.01em;
  }
  h3 { font-size: 1.05rem; margin: 1.4rem 0 0.4rem; }
  p, li { color: var(--fg); }
  p { margin: 0.6rem 0; }
  ul, ol { padding-left: 1.4rem; }
  li { margin: 0.25rem 0; }
  code, kbd, samp {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.92em;
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 4px;
  }
  pre {
    background: var(--code-bg);
    padding: 14px 16px;
    border-radius: 8px;
    overflow-x: auto;
    border: 1px solid var(--rule);
    font-size: 0.86rem;
    line-height: 1.5;
  }
  pre code { background: none; padding: 0; }
  .lede { font-size: 1.1rem; color: var(--muted); margin: 0 0 1.4rem; }
  .meta { color: var(--muted); font-size: 0.85rem; margin-bottom: 2rem; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.8rem 0 1.2rem;
    font-size: 0.9rem;
    display: block;
    overflow-x: auto;
  }
  th, td {
    text-align: left;
    vertical-align: top;
    padding: 8px 10px;
    border-bottom: 1px solid var(--rule);
  }
  th { font-weight: 600; background: var(--code-bg); white-space: nowrap; }
  td code { white-space: nowrap; }
  .term { color: var(--term); font-weight: 600; }
  .ok { color: var(--ok); font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .badge {
    display: inline-block;
    font-size: 0.72rem;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 10px;
    border: 1px solid var(--rule);
    color: var(--muted);
    letter-spacing: 0.02em;
    text-transform: uppercase;
    vertical-align: middle;
  }
  .badge.term { color: var(--term); border-color: var(--term); }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 2.4rem 0; }
  .toc {
    background: var(--code-bg);
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 14px 18px 14px 32px;
    margin: 1.4rem 0 2rem;
    font-size: 0.92rem;
  }
  .toc ol { margin: 0; }
  .toc a { color: var(--accent); text-decoration: none; }
  .toc a:hover { text-decoration: underline; }
  a { color: var(--accent); }
  .pill {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 0.8rem;
    background: var(--code-bg);
    border: 1px solid var(--rule);
    color: var(--muted);
  }
  strong { font-weight: 600; }
  .footer { color: var(--muted); font-size: 0.82rem; margin-top: 3rem; }
</style>
</head>
<body>
<main>
  <h1>How chat works</h1>
  <p class="lede">A precise trace of a Brief chat turn, from HTTP request to streamed response.</p>
  <p class="meta">
    <span class="pill">GET /docs</span>
    <span class="pill">English</span>
    <span class="pill">Reference</span>
  </p>

  <p>
    A chat turn is a <strong>durable, asynchronous, streaming pipeline</strong>.
    The HTTP API that receives the user's message and the worker that runs the
    model never talk to each other directly. They communicate only through
    Postgres tables. The API writes a user message, an immutable accepted-run
    scope, and a job in one transaction; the worker claims the job, drives the
    AI, and appends events to a durable buffer; the API polls that buffer and
    streams it to the client over Server-Sent Events.
  </p>
  <p>
    Acceptance freezes the full server-derived scope for this run: the user,
    chat, company, exact source and access IDs, memory mode and revision IDs,
    provider and model identities, requested and effective web state, and the
    canonical domain allowlist. Later membership, grant, source-setting,
    memory, provider, or web-policy changes do not alter this run's execution
    scope; they affect later runs. Current chat reads and streams still check
    the viewer's current chat and membership access. Delivered publication
    access is historical, but client viewers also need an unrevoked current
    company membership and the exact recipient recorded at delivery. A
    membership revocation denies that client viewer without changing the historical
    row. Current subscription, grant, source-setting, and policy changes do not
    revoke an earlier delivery, and a later grant does not unlock one.
  </p>

  <div class="toc">
    <ol>
      <li><a href="#lifecycle">Lifecycle at a glance</a></li>
      <li><a href="#send">Step 1 — Send a message</a></li>
      <li><a href="#stream">Step 2 — Open the stream</a></li>
      <li><a href="#worker">Step 3 — Worker picks up the job</a></li>
      <li><a href="#workflow">Step 4 — The AI workflow</a></li>
      <li><a href="#finalize">Step 5 — Finalize</a></li>
      <li><a href="#http">HTTP surface</a></li>
      <li><a href="#events">Event protocol</a></li>
      <li><a href="#sse">SSE framing</a></li>
      <li><a href="#authz">Authorization on the stream</a></li>
      <li><a href="#tables">Database tables</a></li>
      <li><a href="#cross">Cross-cutting guarantees</a></li>
    </ol>
  </div>

  <h2 id="lifecycle">Lifecycle at a glance</h2>
  <pre><code>Client            API (Bun)                         Postgres                 Worker (Bun)
  │                  │                                  │                         │
  │ POST /chats/:id/messages                                          │
  │ ────────────────►│                  │                 │                         │
  │                  │  advisory locks  │                 │                         │
  │                  │  authz + credits │                 │                         │
  │                  │  web policy      │                 │                         │
  │                  │  conflict check  │                 │                         │
  │                  │  ───────────────►│ BEGIN           │                         │
  │                  │                  │ insert chat_messages (user)              │
  │                  │                  │ insert ai_runs (immutable accepted scope) │
  │                  │                  │ insert jobs ('ai_chat_run')   COMMIT     │
  │  ◄───────────────│  202 Accepted   │                 │                         │
  │      run.id + streamPath                                           │
  │                  │                                                            │
  │ GET /ai-runs/:runId/stream                                        │
  │ ────────────────►│  authz handshake│                 │                         │
  │  ◄───────────────│  200 text/event-stream (poll loop)│                         │
  │                  │                                                            │
  │                  │                                   ◄──── claim job (SKIP LOCKED)
  │                  │                                   │  bind smithers_run_id   │
  │                  │                                   │  run ai-chat workflow   │
  │                  │                  │  append run_started, context_ready,      │
  │                  │                  │  answer_started, text_delta*, usage*,    │
  │                  │                  │  memory_updated, usage(run), done|error  │
  │                  │  poll events    │                 │                         │
  │  ◄───────────────│  SSE frames     │ (every poll checks current viewer access) │
  │  … id:N event:text_delta data:{"delta":"…"}                         │         │
  │  ◄───────────────│  id:M event:done data:{"assistantMessageId":"…"}           │
  │                  │ close stream                                                    │
</code></pre>
  <p>
    The single correlation key across the whole flow is <code>run.id</code>. It
    appears in the <code>streamPath</code>, in every SSE frame (as the owning
    row of each event), in the worker's job payload, and in the persisted
    assistant message. There is no server-side session.
  </p>

  <h2 id="send">Step 1 — Send a message</h2>
  <p>
    The client <code>POST</code>s a <code>SendChatMessageRequest</code> to
    <code>/v1/chats/:chatId/messages</code> (or <code>/v1/chat/messages</code>
    in demo mode). The request body is:
  </p>
  <pre><code>{
  "text": "What changed in Q3?",
  "locale": "en-US" | "fr-FR",
  "market": "US" | "FR",
  "webSearchEnabled": true
}
</code></pre>
  <p>
    The handler runs <code>createUserMessageAndRun</code> in a single
    transaction. The transaction acquires its transaction-scoped advisory
    locks <em>in this order</em> — <code>brief:user-memory:&lt;userId&gt;</code>
    first, then (for demo chats) <code>brief:demo-chat:&lt;userId&gt;</code>
    during provisioning, then <code>brief:client-members:&lt;companyId&gt;</code>,
    then <code>brief:ai-chat:&lt;chatId&gt;</code> — runs all the gating checks,
    and only then writes rows. Production chats take three locks; demo chats
    take four, with the demo-chat lock provisioning the row before the gates.
  </p>
  <p>Inside the transaction, in order:</p>
  <ol>
    <li><strong>Build the acceptance scope.</strong> While the acceptance locks are held, Brief resolves the caller, chat, company, exact source and access IDs, memory mode and revision IDs, provider and model identities, and requested/effective web state. The server intersects request fields with current entitlements and defaults; the client cannot add IDs or supply snapshot fields. Otherwise: <code>403 forbidden</code>.</li>
    <li><strong>Credit preflight.</strong> In demo mode credits are not enforced. In production the check fails closed with <code>credit_conversion_undefined</code> → <code>402</code> until the turn-to-credit conversion is approved. Runs <em>before</em> any row is written.</li>
    <li><strong>Save requested and effective web state.</strong> Brief records the approved provider, transport, requested/effective web state, and canonical domain allowlist in the immutable acceptance scope. If the caller requested web research but the saved policy is disabled: <code>403 web_research_unavailable</code> with the reason.</li>
    <li><strong>Active-run conflict.</strong> There may be at most one active run per chat and at most one active run per initiating user across all their chats (enforced structurally by two partial unique indexes). If either is violated: <code>409 active_ai_run</code> with <code>conflictScope: "chat" | "user"</code>.</li>
    <li><strong>Insert three rows:</strong>
      <ul>
        <li><code>chat_messages</code> with <code>author = 'user'</code>;</li>
        <li><code>ai_runs</code> carrying <code>user_message_id</code>, locale/market, and the immutable <code>acceptance_scope</code>;</li>
        <li><code>jobs</code> with <code>kind = 'ai_chat_run'</code>, <code>payload = { aiRunId }</code>, <code>unique_key = 'ai_chat_run:&lt;runId&gt;'</code>, priority 100.</li>
      </ul>
    </li>
  </ol>
  <p>
    On success the API returns <code>202 Accepted</code> with a
    <code>SendChatMessageAccepted</code> body:
  </p>
  <pre><code>{
  "message": { "id": "…", "author": "user", "content": "…", "createdAt": "…" },
  "run":     { "id": "run_…", "status": "queued", "streamPath": "/v1/ai-runs/run_…/stream" }
}
</code></pre>
  <p>
    The race where two concurrent enqueues both pass the conflict check and
    collide on the partial unique index is recovered: the API catches the
    Postgres unique violation, reloads the conflicting active run, and returns
    the same <code>409</code>.
  </p>

  <h2 id="stream">Step 2 — Open the stream</h2>
  <p>
    The client immediately opens <code>GET /v1/ai-runs/:runId/stream</code>
    (the path returned as <code>run.streamPath</code>). The request may carry
    a resume cursor in either the <code>Last-Event-ID</code> header or the
    <code>?afterSeq</code> query parameter; both are decimal integers
    (<code>afterSeq</code> accepts 0; <code>Last-Event-ID</code> must be ≥ 1),
    and the larger one wins.
  </p>
  <p>The route does three things:</p>
  <ol>
    <li><strong>Resolve the run</strong> via <code>readRunStreamContext</code>; if the run, chat, or company is missing or soft-deleted → <code>404 not_found</code>.</li>
    <li><strong>Authorization handshake.</strong> A single SQL query returns <code>{ authorized, terminal, replayableTerminal, events }</code>.
      <ul>
        <li><code>authorized = false</code> → <code>404 not_found</code> (never <code>403</code>, to avoid disclosing existence).</li>
        <li><code>authorized &amp;&amp; terminal &amp;&amp; !replayableTerminal</code> → <code>410 terminal_event_unavailable</code> — the run is over and no <code>done</code>/<code>error</code> row exists at <code>seq &gt; afterSeq</code> (either the client's cursor is already at/after the terminal event, or the terminal row has been reaped by retention).</li>
        <li>Otherwise the stream opens.</li>
      </ul>
    </li>
    <li><strong>Enter <code>incrementalSse</code></strong>, a <code>ReadableStream</code> polling loop with one timer: every <code>pollMs</code> it queries for new events. <code>keepAliveMs</code> is a write-idle threshold checked once per tick — if no bytes have been sent for that long, a comment line is emitted before the next poll is scheduled.</li>
  </ol>
  <p>On every tick the loop:</p>
  <ul>
    <li>checks the authenticated viewer's current chat and membership access; this viewer check may end stream access, but it does not reauthorize the run's saved sources, memory revisions, provider, or web policy;</li>
    <li>writes each new event as an SSE frame and advances <code>afterSeq</code>;</li>
    <li>closes after a <code>done</code> or <code>error</code> frame;</li>
    <li>silently closes (no frame emitted) if the run has become terminal, no <code>done</code>/<code>error</code> row is replayable past the cursor, <em>and</em> no events are pending;</li>
    <li>writes <code>: keep-alive</code> when no data has been sent for <code>keepAliveMs</code>;</li>
    <li>closes on client abort (<code>request.signal</code>) or stream cancel.</li>
  </ul>
  <p>
    The server disables Bun's per-request idle timeout for this URL, so a long
    model run cannot be killed by the framework while the client waits for the
    first token.
  </p>

  <h2 id="worker">Step 3 — Worker picks up the job</h2>
  <p>
    One or more worker processes each run a tick loop on a fixed interval.
    Each tick is:
  </p>
  <ol>
    <li><strong>Claim</strong> the next job under <code>pg_advisory_xact_lock('brief:jobs:claim')</code>. Stale leases (a worker that crashed mid-job) are reaped first; <code>ai_chat_run</code> rows are always sent back to <code>retrying</code>, never terminal-failed at the queue layer. The claim itself is <code>UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)</code> ordered by <code>priority desc, available_at asc, created_at asc</code>.</li>
    <li><strong>Heartbeat race.</strong> The handler runs racing against a heartbeat loop that refreshes <code>locked_at</code> every ~⅓ of the lock timeout. Whichever finishes first wins; the heartbeat dies when the handler returns.</li>
    <li><strong>Dispatch.</strong> <code>kind === 'ai_chat_run'</code> → <code>handleAiChatRunJob</code>.</li>
    <li><strong>Mark completed or failed.</strong> On thrown error the job is marked failed (re-queued with exponential backoff for <code>ai_chat_run</code>); otherwise marked completed.</li>
  </ol>
  <p>
    <code>handleAiChatRunJob</code> opens by loading the run's terminal state.
    If the run is already finished or failed, the handler skips the workflow
    but still performs durable cleanup — it deletes the run's Smithers rows
    (re-checking the fence) when a <code>smithers_run_id</code> is bound, then
    returns <code>completed</code>. Otherwise it binds
    <code>ai_runs.smithers_run_id = 'ai-chat:&lt;runId&gt;'</code> as an
    idempotency fence (a mismatch propagates as
    <code>AiRunSmithersRunIdMismatch</code>), then runs the AI workflow under a
    shared advisory lock used to serialize schema migrations against producers.
  </p>
  <p>
    Worker shutdown is safe: if the abort signal fires, Smithers state is
    <em>retained</em> so the next claim resumes the workflow in place; the job
    is marked failed and the queue hands it to another worker.
  </p>

  <h2 id="workflow">Step 4 — The AI workflow</h2>
  <p>
    The AI run is a <strong>Smithers workflow</strong> named <code>ai-chat</code>
    — a durable, resume-capable task graph. Most tasks call a method on a
    single operations object (<code>CanonicalWorkflowOperations</code>) that
    owns the database, the LLM client, and the web research boundary; the rest
    route or validate outputs from earlier tasks.
  </p>
  <h3>What <code>load-turn</code> carries</h3>
  <p>
    <code>load-turn</code> validates the saved scope and returns a small
    coordination value:
  </p>
  <pre><code>LoadedTurn = {
  aiRunId, chatId, initiatingUserId, userMessageId, userMessage,
  locale, market, currentDate,
  citationNamespace,
  acceptanceScope
}</code></pre>
  <p>
    The acceptance scope contains the IDs and provider/web choices fixed when
    the API accepted the message. It is an authorization boundary, not a cache
    of database rows. <code>load-turn</code> does not preload conversation
    bodies, memories, source metadata, document text, hashes, or policy rows.
    Each task loads only the rows it needs, restricted by the saved IDs.
    Brief code owns those queries; models see only their declared inputs and
    tool results. Later setting changes affect later runs, not this one.
  </p>
  <p>
    <code>citationNamespace</code> is a fresh random run-local namespace that
    stays stable across retries and replay. Code combines it with a stable
    evidence ordinal to form keys such as
    <code>k_cn_x7Q2M6F8N4V3J9P5T1X6Cg_1</code>. It is not proof that a claim has
    support and does not stop a model from typing a citation-shaped string.
    The final parser accepts a key only when the current run's exact source map
    contains it; an invented or copied key has no matching evidence and fails
    validation.
  </p>
  <p>The graph is:</p>
  <pre><code>Sequence
├─ load-turn                markAiRunStarted  →  emits run_started
├─ Parallel turn-lanes
│  ├─ memory-extract        background memory revision extraction
│  └─ AnswerLane (Sequence)
│     ├─ resolve-conversation   clarify | continue
│     ├─ Branch
│     │  ├─ clarify            ask a disambiguation question
│     │  └─ Sequence
│     │     ├─ plan-execution          single | fanout
│     │     ├─ normalize-execution-plan
│     │     └─ Branch
│     │        ├─ single  Parallel(retrieve-internal | select-memories | retrieve-web)
│     │        │          → assemble → measure → [reduce loop] → freeze
│     │        │          → answerDirect  (streamed)
│     │        └─ fanout  per-topic retrieve → topic-answer → synthesize (streamed)
│     └─ answer-select        assertFinalSourceMap on ok
└─ finalize                 finalizeAiRun  →  emits memory_updated, usage(run), done | error
</code></pre>
  <h3>Answer modes</h3>
  <p>
    The <code>mode</code> field on <code>context_ready</code> and
    <code>answer_started</code> events discriminates the three answer lanes:
  </p>
  <ul>
    <li><strong><code>clarification</code></strong> — the turn is ambiguous; the model asks one clarifying question. No retrieval runs. The question itself is emitted as a single <code>text_delta</code>.</li>
    <li><strong><code>single</code></strong> — one retrieval pass (internal documents, user memories, and optionally web) assembles a single context window; the model answers directly against it.</li>
    <li><strong><code>synthesis</code></strong> — the planner splits the turn into two or three topics; each topic gets its own retrieval and answer; a final synthesis pass merges them.</li>
  </ul>
  <p>
    On the very first turn of a chat, <code>resolve-conversation</code>
    short-circuits to <code>continue</code> without an LLM call.
  </p>
  <h3>Retrieval</h3>
  <ul>
    <li><strong>Internal documents</strong> — ranked search over public-source documents (Postgres <code>websearch_to_tsquery</code> with language-aware regconfig, <code>ts_rank_cd</code> × recency decay, content-hash dedup), plus publisher documents and prior chat messages, gathered by a bounded tool loop with <code>search_internal</code> / <code>inspect_internal</code> tools.</li>
    <li><strong>Memories</strong> — selected by a tool loop from the exact memory revision IDs in the immutable acceptance scope; later edits do not change this run.</li>
    <li><strong>Web</strong> — only when the saved <code>webRequested</code>/<code>webEnabled</code> state allows it. Backed by Tinyfish search and a sandboxed fetch; usage is recorded per call.</li>
  </ul>
  <h3>Context budget</h3>
  <p>
    Assembled candidates are measured against the model's context window. If
    the assembly is too large, a bounded reduction loop runs
    <code>planReduction</code> → <code>measureReduction</code> until the context
    fits or the iteration cap is reached. If it cannot fit, the run fails with
    <code>context_plan_unfit</code>.
  </p>
  <h3>Streaming the answer</h3>
  <p>
    <code>answerDirect</code> (single) and <code>synthesize</code> (fanout) call
    the LLM through a streaming boundary. Before the first provider request
    fires, the worker appends <code>context_ready</code> then
    <code>answer_started</code>. Each streamed token chunk appends a
    <code>text_delta</code> event with a deterministic
    <code>emission_key</code> keyed by task, attempt, and chunk index — so a
    resumed workflow replays identically without duplicating frames.
  </p>

  <h2 id="finalize">Step 5 — Finalize</h2>
  <p>
    <code>finalizeAiRun</code> is the single transaction that commits the run.
    It is the only writer of the assistant message and the only setter of
    <code>ai_runs.finished_at</code>. In order, inside one transaction:
  </p>
  <ol>
    <li>Take the run row <code>FOR UPDATE</code> under the same execution-scope advisory locks used at enqueue, and verify <code>smithers_run_id</code> still matches.</li>
    <li>Short-circuit if the run is already terminal (idempotent replay).</li>
    <li>If the answer cites publisher documents, acquire each cited issue's restriction lane (<code>brief:publisher-issue:&lt;issueId&gt;</code>) in sorted order.</li>
    <li>Validate the durable observation trail — every provider request that contributed tokens must have a matching <code>provider_request_measurement</code>; the memory extraction artifact digest must match its producer observation.</li>
    <li><strong>Validate the saved scope and exact evidence.</strong> Brief checks the immutable acceptance scope plus exact document, version, hash, locator, range, memory-revision, quotation, usage, and provider identities. These source-integrity checks prove that saved evidence is unchanged; they do not reauthorize current access. Ordinary setting changes do not turn an accepted answer into a failure. Account deletion, purge, retention, legal or security restriction, and exact identity mismatch remain exceptional denials.</li>
    <li>Apply memory proposals after scope and integrity validation. Emit <code>memory_updated</code>.</li>
    <li>Aggregate all per-request model and web usage; emit one run-scope <code>usage</code> event.</li>
    <li>On failure: set <code>failed_at</code>, <code>error_code</code>, <code>retryable</code>, and emit a terminal <code>error</code> event.</li>
    <li>On success: insert the <code>chat_messages</code> row with <code>author = 'assistant'</code> and <code>assistant_ai_run_id</code>; persist citation rows; set <code>ai_runs.assistant_message_id</code> and <code>finished_at</code>; emit a terminal <code>done</code> event carrying the new assistant message id.</li>
  </ol>
  <p>
    The <code>error</code> path is shared: a handler-side workflow failure
    (Smithers ended <code>failed</code>/<code>cancelled</code>, or an unexpected
    throw) calls <code>failAiRun</code>, which takes the same locks, aggregates
    usage, sets <code>failed_at</code>, and emits the terminal
    <code>error</code> event.
  </p>

  <h2 id="http">HTTP surface</h2>
  <p>All routes require an authenticated identity; 401 bodies are <code>{ "error": "unauthorized" }</code>.</p>
  <table>
    <thead><tr><th>Method &amp; path</th><th>Scope</th><th>Request</th><th>Success</th><th>Notable errors</th></tr></thead>
    <tbody>
      <tr>
        <td><code>GET /v1/chat</code></td>
        <td>demo mode only</td>
        <td>—</td>
        <td><code>200 GetChatResponse</code></td>
        <td><code>404</code> when not in demo mode</td>
      </tr>
      <tr>
        <td><code>POST /v1/chat/messages</code></td>
        <td>demo mode only</td>
        <td><code>SendChatMessageRequest</code> (≤ 64 KiB JSON)</td>
        <td><code>202 SendChatMessageAccepted</code></td>
        <td><code>403 forbidden</code>; <code>403 web_research_unavailable</code>; <code>409 active_ai_run</code>; <code>404</code> when not in demo mode (credits are not enforced in demo mode)</td>
      </tr>
      <tr>
        <td><code>GET /v1/chats/:chatId</code></td>
        <td>always on</td>
        <td>—</td>
        <td><code>200 GetChatResponse</code></td>
        <td><code>404 not_found</code> (includes authorization failure)</td>
      </tr>
      <tr>
        <td><code>POST /v1/chats/:chatId/messages</code></td>
        <td>always on</td>
        <td><code>SendChatMessageRequest</code> (≤ 64 KiB JSON)</td>
        <td><code>202 SendChatMessageAccepted</code></td>
        <td><code>402</code>; <code>403 forbidden</code>; <code>403 web_research_unavailable</code>; <code>409 active_ai_run</code></td>
      </tr>
      <tr>
        <td><code>GET /v1/ai-runs/:runId/stream</code></td>
        <td>always on</td>
        <td>optional <code>Last-Event-ID</code> header / <code>?afterSeq</code> query</td>
        <td><code>200 text/event-stream</code></td>
        <td><code>404 not_found</code> (missing run or <code>!authorized</code>); <code>410 terminal_event_unavailable</code></td>
      </tr>
    </tbody>
  </table>
  <p>
    <strong>Contract rejections</strong> (applied before the handler runs) are
    route-specific. The two message POST routes return
    <code>{ "error": "invalid_body" }</code>,
    <code>{ "error": "request_too_large" }</code> (413),
    <code>{ "error": "invalid_query" }</code>, or
    <code>{ "error": "invalid_headers" }</code>. The SSE stream route uses the
    same <code>code</code>-keyed rejection shapes but has no 413 path because
    it takes no request body.
    The two GET-chat routes declare no rejection mapping. Contract validation
    runs before the demo-mode gate, so a malformed non-demo request fails with
    <code>400</code>/<code>413</code> rather than the documented <code>404</code>.
  </p>
  <h3>Key schemas</h3>
  <ul>
    <li><code>SendChatMessageRequest</code> — <code>{ text, locale, market, webSearchEnabled }</code>; <code>text</code> must contain non-whitespace.</li>
    <li><code>SendChatMessageAccepted</code> — <code>{ message, run }</code>; <code>run.status</code> is always <code>"queued"</code>; <code>run.streamPath</code> is URL-encoded.</li>
    <li><code>GetChatResponse</code> — <code>{ chat, messages[], effectiveWebPolicy, activeRun, canWrite }</code>; <code>activeRun</code> is the run with neither <code>finished_at</code> nor <code>failed_at</code>.</li>
    <li><code>ActiveAiRunConflict</code> — <code>{ code: "active_ai_run", conflictScope: "chat" | "user", activeRun }</code>.</li>
    <li><code>EffectiveWebPolicy</code> — either <code>{ enabled: false, reason, allowlistActive }</code> or <code>{ enabled: true, provider: "tinyfish", allowedDomains: string[] | null }</code>.</li>
  </ul>

  <h2 id="events">Event protocol</h2>
  <p>
    Every frame's <code>event:</code> line is the event's <code>type</code>, and
    its <code>data:</code> line is <code>JSON.stringify(event)</code>. Events
    are persisted to <code>ai_run_events</code> with a monotonic
    <code>seq</code> and a unique <code>emission_key</code> per run, so the
    ordering below is what a client will observe.
  </p>
  <table>
    <thead><tr><th><code>type</code></th><th>Payload</th><th>When emitted</th><th>Terminal?</th></tr></thead>
    <tbody>
      <tr>
        <td><code>run_started</code></td>
        <td><em>(none)</em></td>
        <td>Worker picked up the run; also stamps <code>ai_runs.started_at</code>.</td>
        <td><span class="badge">no</span></td>
      </tr>
      <tr>
        <td><code>context_ready</code></td>
        <td><code>mode</code>, <code>reductionRan</code>, <code>sourcesRead[]</code>, <code>consumers[]</code></td>
        <td>Emitted before the answer phase. For <code>single</code>/<code>synthesis</code> the context is frozen and about to be sent to the model; for <code>clarification</code> the question has already been produced and no answer request follows that event. <code>mode ∈ {clarification, single, synthesis}</code>; <code>consumers</code> describes per-consumer token budgets.</td>
        <td><span class="badge">no</span></td>
      </tr>
      <tr>
        <td><code>answer_started</code></td>
        <td><code>mode</code>, <code>attempt</code></td>
        <td>Beginning of an answer attempt (clarification, single, or synthesis).</td>
        <td><span class="badge">no</span></td>
      </tr>
      <tr>
        <td><code>text_delta</code></td>
        <td><code>delta</code></td>
        <td>One streamed assistant text chunk. Clarification emits exactly one with the question.</td>
        <td><span class="badge">no</span></td>
      </tr>
      <tr>
        <td><code>memory_updated</code></td>
        <td><code>created</code>, <code>updated</code>, <code>discarded</code></td>
        <td>Emitted at finalize after memory proposals are applied, on both the success path and the controlled answer-failure path inside the same transaction (handler-side failures that bypass <code>finalizeAiRun</code> emit only <code>usage</code> and <code>error</code>). The memory extractor runs regardless of chat memory mode, so counts reflect whatever proposals the extractor produced and the applier accepted.</td>
        <td><span class="badge">no</span></td>
      </tr>
      <tr>
        <td><code>usage</code> <span class="badge">model / request</span></td>
        <td><code>scope:"request"</code>, <code>kind:"model"</code>, <code>role</code>, <code>attempt</code>, <code>inputTokens</code>, <code>outputTokens</code>, <code>cachedTokens</code>, <code>reasoningTokens</code>, <code>totalTokens</code></td>
        <td>Once per model provider request.</td>
        <td><span class="badge">no</span></td>
      </tr>
      <tr>
        <td><code>usage</code> <span class="badge">web / request</span></td>
        <td><code>scope:"request"</code>, <code>kind ∈ {web_search, web_fetch}</code>, <code>attempt</code>, <code>status</code>, <code>resultCount</code>, <code>responseBytes</code>, <code>billedUnits | null</code></td>
        <td>Once per web search or fetch call.</td>
        <td><span class="badge">no</span></td>
      </tr>
      <tr>
        <td><code>usage</code> <span class="badge">run</span></td>
        <td><code>scope:"run"</code>, aggregate <code>model {…, requestCount}</code> and <code>web {searchCount, fetchCount, responseBytes, billedUnits | null}</code></td>
        <td>End-of-run totals, just before the terminal event.</td>
        <td><span class="badge">no</span></td>
      </tr>
      <tr>
        <td class="ok"><code>done</code></td>
        <td><code>assistantMessageId</code></td>
        <td>Run succeeded; the assistant message is persisted.</td>
        <td><span class="badge term">yes — closes the stream</span></td>
      </tr>
      <tr>
        <td class="term"><code>error</code></td>
        <td><code>code</code>, <code>retryable</code></td>
        <td>Run failed; <code>code</code> mirrors <code>ai_runs.error_code</code>, <code>retryable</code> mirrors <code>ai_runs.retryable</code>.</td>
        <td><span class="badge term">yes — closes the stream</span></td>
      </tr>
    </tbody>
  </table>
  <p>
    The three <code>usage</code> variants share the discriminator
    <code>type: "usage"</code> but are distinct struct members of the union —
    discriminate further on <code>scope</code> (and <code>kind</code> for
    request-scope). Treat <code>usage</code> as accounting, not as a sequencing
    signal: request-scope events interleave throughout the run.
  </p>
  <p>
    Typical ordering: <code>run_started</code> → <code>context_ready</code> →
    <code>answer_started</code> → <code>text_delta</code>×N (with
    <code>usage</code> interleaved) → <code>memory_updated</code> →
    <code>usage</code> (run) → <code>done</code> | <code>error</code>.
  </p>

  <h2 id="sse">SSE framing</h2>
  <p>Response headers:</p>
  <pre><code>content-type:      text/event-stream; charset=utf-8
cache-control:     no-cache
connection:        keep-alive
x-accel-buffering: no
</code></pre>
  <p>Each event frame (blank line terminator required):</p>
  <pre><code>id: 7
event: text_delta
data: {"type":"text_delta","delta":"Q3 "}

</code></pre>
  <p>
    The <code>id:</code> field is the event's <code>seq</code>. A browser's
    built-in <code>EventSource</code> automatically sends the last received id
    back as <code>Last-Event-ID</code> on reconnect, so resume is strict: the
    client receives every event with <code>seq</code> greater than the last one
    it saw.
  </p>
  <p>When the connection is idle for <code>keepAliveMs</code>, the server emits a comment line:</p>
  <pre><code>: keep-alive

</code></pre>
  <p>
    Comment lines start with <code>:</code> and are ignored by browsers but
    keep proxies and the OS from closing the connection.
  </p>
  <p>
    The stream closes after the terminal <code>done</code> or
    <code>error</code> frame. On reconnect, the API returns <code>410
    terminal_event_unavailable</code> whenever the run is terminal and no
    <code>done</code>/<code>error</code> row exists at
    <code>seq &gt; afterSeq</code> — either because the client's cursor is
    already at or past the terminal event, or because the terminal row has
    been reaped by retention. The client should refresh state via
    <code>GET /v1/chats/:chatId</code>.
  </p>

  <h2 id="authz">Authorization on the stream</h2>
  <p>
    <code>ai_run_events</code> is an append-only buffer between the worker
    (producer) and the API (consumer). On <em>every</em> poll — not just the
    handshake — the API runs a single SQL query that returns the next batch of
    events <em>and</em> checks that the authenticated viewer may still see the
    chat and its stream. This viewer check is separate from the run's frozen
    source scope: it may end the viewer's stream access, but it never
    reauthorizes saved sources, memory revisions, provider settings, or web
    policy. The query folds together:
  </p>
  <ul>
    <li><strong>Identity &amp; membership</strong> — caller and chat creator exist and are not soft-deleted; an active membership links caller to chat's company; organization id matches.</li>
    <li><strong>Accepted source scope</strong> — the run's immutable source and access IDs, exact memory revisions, provider values, web state, and domain allowlist remain the only inputs for retrieval and finalization. Current grants, source settings, memory heads, provider settings, and web policy do not replace them.</li>
    <li><strong>Exact evidence integrity</strong> — every saved document, version, hash, range, memory revision, and web quotation must match its immutable stored identity. A mismatch fails closed; it is not a current-access recheck.</li>
    <li><strong>Historical publication delivery</strong> — a client-company viewer needs an unrevoked current company membership and the exact delivery-recipient record captured at delivery. Membership revocation denies that viewer without changing the historical row. Ordinary subscription, grant, source-setting, or policy changes neither revoke a delivered issue for a current historical recipient nor grant it to a new viewer; publisher-owned views use the current publisher lane, and account deletion, purge, retention, legal, and security restrictions remain explicit denials.</li>
    <li><strong>Ownership or sharing</strong> — caller is the chat owner, or the chat is shared with memory disabled.</li>
  </ul>
  <p>
    The query also computes <code>terminal</code> (from
    <code>ai_runs.finished_at</code> / <code>failed_at</code>) and
    <code>replayableTerminal</code> (a <code>done</code> or <code>error</code>
    event exists with <code>seq &gt; afterSeq</code>). The combination drives
    the handshake outcomes in Step 2.
  </p>

  <h2 id="tables">Database tables</h2>
  <table>
    <thead><tr><th>Table</th><th>Role</th></tr></thead>
    <tbody>
      <tr><td><code>chats</code></td><td>A conversation owned by a user under a company. Carries <code>memory_mode</code> and <code>shared_at</code>.</td></tr>
      <tr><td><code>chat_messages</code></td><td>User and assistant turns. The assistant row is linked back to its <code>ai_runs</code> row 1:1.</td></tr>
      <tr><td><code>ai_runs</code></td><td>One run per user message; the coordination root. Holds the immutable acceptance scope, terminal timestamps, <code>smithers_run_id</code>, and a per-run <code>next_event_seq</code> counter.</td></tr>
      <tr><td><code>ai_run_events</code></td><td><strong>Durable event buffer.</strong> Append-only, <code>seq</code>-ordered, idempotent on <code>emission_key</code>. The SSE source.</td></tr>
      <tr><td><code>jobs</code></td><td>Transactional work queue. <code>ai_chat_run</code> rows are always retryable at the queue layer.</td></tr>
      <tr><td><code>ai_source_exposures</code></td><td>Per-provider-request record of every source shown to the model. Preserves the accepted evidence history for audit.</td></tr>
      <tr><td><code>ai_run_usage</code></td><td>Per provider-request model token accounting.</td></tr>
      <tr><td><code>ai_external_tool_usage</code></td><td>Per web search/fetch accounting.</td></tr>
      <tr><td><code>ai_observations</code></td><td>Deterministic, replay-safe observations: conversation resolution, retrieval manifests, context measurements, memory extraction result, citations.</td></tr>
      <tr><td><code>assistant_message_sources</code> / <code>…​_source_uses</code></td><td>Durable citations attached to the assistant message.</td></tr>
      <tr><td><code>user_memories</code> / <code>user_memory_revisions</code></td><td>Long-term memory; revisions are append-only (<code>create</code>/<code>update</code>/<code>delete</code>/<code>revert</code>).</td></tr>
      <tr><td><code>client_companies</code></td><td>Tenant; soft-deleted via <code>recovery_deleted_at</code> / <code>purged_at</code>.</td></tr>
      <tr><td><code>client_company_memberships</code></td><td>Links a user to a company; deactivated via <code>revoked_at</code> / <code>revoked_by_user_id</code> (no recovery/purge columns).</td></tr>
      <tr><td><code>client_company_ai_settings</code></td><td>Per-company web toggle and optional domain allowlist.</td></tr>
      <tr><td><code>chat_subscription_sources</code> / <code>client_employee_subscription_grants</code> / <code>client_subscription_accesses</code></td><td>The subscription wiring that gates publisher-document access.</td></tr>
      <tr><td><code>public_source_documents</code>, <code>publisher_issues</code>, <code>publisher_subscriptions</code>, <code>brief_documents</code>, <code>issue_deliveries</code></td><td>Immutable document identities and historical delivery records used for evidence and publication access.</td></tr>
      <tr><td><code>platform_users</code></td><td>User identities; soft-deleted via <code>recovery_deleted_at</code> / <code>purged_at</code>.</td></tr>
    </tbody>
  </table>

  <h2 id="cross">Cross-cutting guarantees</h2>
  <h3>Idempotency &amp; replay safety</h3>
  <ul>
    <li>Every mutating worker write keys on a deterministic identifier: <code>ai_run_events.emission_key</code>, the exposure coordinate unique, the usage coordinate unique, <code>ai_observations.observation_key</code>. For observations, exposures, and usage rows, a replay with the same key returns the prior row unchanged and hard-fails as a replay conflict if any field differs; raw event appends simply return the prior event for an occupied <code>emission_key</code> without comparing fields.</li>
    <li>Once a run is terminal, <code>appendAiRunEvent</code> refuses any event whose <code>emission_key</code> is not <code>"terminal"</code> (that key is unique, so there is at most one terminal event per run).</li>
    <li>The workflow is resume-capable: Smithers rehydrates completed tasks from durable storage and only re-runs what is incomplete.</li>
  </ul>
  <h3>Lock discipline</h3>
  <p>Transaction-scoped <code>pg_advisory_xact_lock</code> keys, acquired in a fixed order to avoid deadlocks:</p>
  <ul>
    <li><code>brief:user-memory:&lt;userId&gt;</code> — enqueue path.</li>
    <li><code>brief:demo-chat:&lt;userId&gt;</code> — demo chat provisioning.</li>
    <li><code>brief:client-members:&lt;companyId&gt;</code> — membership stability.</li>
    <li><code>brief:ai-chat:&lt;chatId&gt;</code> — per-chat serialization (backs the one-active-run invariant).</li>
    <li><code>brief:publisher-issue:&lt;issueId&gt;</code> — per-issue restriction lane, acquired in sorted order during finalization when the answer cites publisher documents.</li>
    <li><code>brief:jobs:claim</code> — single-writer job claim.</li>
  </ul>
  <p>Run-row <code>FOR UPDATE</code> is taken in a uniform order to avoid the FK KEY-SHARE → FOR UPDATE deadlock.</p>
  <h3>One active run</h3>
  <p>
    Enforced structurally by two partial unique indexes — one active run per
    chat, one active run per initiating user across all chats.
    <code>findActiveRunConflict</code> surfaces the violator as a
    <code>409</code> with the conflict scope; the enqueue path converts the
    unique-violation race into the same <code>409</code>.
  </p>
  <h3>Retries</h3>
  <ul>
    <li><strong>Queue layer</strong> — <code>ai_chat_run</code> is always retryable; a crashed worker's lease is reaped and the row returns to <code>retrying</code> with exponential backoff.</li>
    <li><strong>Workflow layer</strong> — every task has bounded retries with a shared retry policy; the reduction loop is iteration-capped; tool loops are turn-capped and force a terminal tool on the final turn.</li>
    <li><strong>Terminal boundary</strong> — only <code>finalizeAiRun</code> / <code>failAiRun</code> may set <code>finished_at</code> / <code>failed_at</code> and emit <code>done</code> / <code>error</code>; both are guarded by <code>smithers_run_id</code> match and execution-scope invariants.</li>
  </ul>
  <h3>Web policy lifecycle</h3>
  <p>
    Brief saves the requested and effective web state, provider identity, and
    canonical domain allowlist in the immutable acceptance scope. It gates
    <code>403 web_research_unavailable</code> at acceptance when the caller asks
    for disabled web research. Every later web operation uses those saved
    values; redirect, DNS, transport, quotation, and exact-evidence checks are
    safety or integrity checks, not live policy rechecks.
  </p>

  <hr>
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
</main>
</body>
</html>`;
