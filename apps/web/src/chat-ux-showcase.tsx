import { useState } from "react";
import type { Locale } from "@hartlib/i18n";
import { AppShell, RunActivity, type RunActivityEvent, type RunActivityProps } from "@hartlib/ui";

const stateIds = [
  "started",
  "searching",
  "reading",
  "preparing",
  "writing",
  "retrying",
  "complete",
] as const;

type StateId = (typeof stateIds)[number];
type ShowcaseState = RunActivityProps & {
  selector: string;
  answer?: string;
};

const queries = [
  '"EU AI Act" general-purpose AI transparency duties 2026',
  "site:digital-strategy.ec.europa.eu AI Act GPAI code of practice timeline",
] as const;

const sources = [
  {
    title: "European Commission · General-purpose AI models",
    meta: "Official guidance · updated 1 Aug 2025",
    status: "Read",
  },
  {
    title: "Regulation (EU) 2024/1689 · Article 53",
    meta: "EUR-Lex · primary law",
    status: "Reading",
  },
  {
    title: "GPAI Code of Practice",
    meta: "European Commission · July 2025",
    status: "Queued",
  },
] as const;

const waitingStages = {
  understanding: "waiting",
  evidence: "waiting",
  preparing: "waiting",
  writing: "waiting",
  finishing: "waiting",
} as const;

const planDone: RunActivityEvent = {
  stage: "understanding",
  label: "Plan ready",
  detail: "Check the law, the Commission timeline, and the voluntary code.",
  tone: "done",
};
const searchDone: RunActivityEvent = {
  stage: "evidence",
  label: "Queries",
  detail: "The exact searches sent to the provider.",
  tone: "done",
  queries,
};
const sourcesDone: RunActivityEvent = {
  stage: "evidence",
  label: "Sources",
  detail: "All three official sources were read.",
  tone: "done",
  sources: sources.map((source) => ({ ...source, status: "Read" })),
};
const prepareDone: RunActivityEvent = {
  stage: "preparing",
  label: "Evidence checked",
  detail: "Separated duties already in force from later enforcement dates.",
  tone: "done",
};
const writingDone: RunActivityEvent = {
  stage: "writing",
  label: "Answer written",
  detail: "Led with current duties, then stated the dates and exceptions.",
  tone: "done",
};

const states: Record<StateId, ShowcaseState> = {
  started: {
    selector: "Start",
    status: "running",
    title: "Planning",
    meta: "Just started",
    current: "Breaking the question into facts to check",
    stages: { ...waitingStages, understanding: "running" },
    events: [
      {
        stage: "understanding",
        label: "Question received",
        detail: "Find the current EU AI Act duties for general-purpose AI providers.",
        tone: "active",
      },
    ],
  },
  searching: {
    selector: "Search",
    status: "running",
    title: "Searching",
    meta: "2 queries",
    current: `Searching ${queries[0]}`,
    stages: { ...waitingStages, understanding: "complete", evidence: "running" },
    events: [planDone, { ...searchDone, tone: "active" }],
  },
  reading: {
    selector: "Read",
    status: "running",
    title: "Reading",
    meta: "1 of 3 sources",
    current: "Reading Article 53 duties and effective dates",
    stages: { ...waitingStages, understanding: "complete", evidence: "running" },
    events: [
      planDone,
      searchDone,
      {
        stage: "evidence",
        label: "Sources",
        detail: "Opened in this order.",
        tone: "active",
        sources,
      },
    ],
  },
  preparing: {
    selector: "Prepare",
    status: "running",
    title: "Preparing",
    meta: "3 sources checked",
    current: "Comparing the legal text with the Commission timeline",
    stages: {
      ...waitingStages,
      understanding: "complete",
      evidence: "complete",
      preparing: "running",
    },
    events: [
      planDone,
      searchDone,
      sourcesDone,
      {
        stage: "preparing",
        label: "Cross-checking",
        detail: "Separating duties already in force from later enforcement dates.",
        tone: "active",
      },
    ],
  },
  writing: {
    selector: "Write",
    status: "streaming",
    title: "Writing",
    meta: "Answer started",
    current: "Writing the short answer and placing citations",
    stages: {
      ...waitingStages,
      understanding: "complete",
      evidence: "complete",
      preparing: "complete",
      writing: "running",
    },
    events: [
      planDone,
      searchDone,
      sourcesDone,
      prepareDone,
      {
        stage: "writing",
        label: "Drafting",
        detail: "Lead with the current duties, then state the dates and exceptions.",
        tone: "active",
      },
    ],
    answer:
      "Providers of general-purpose AI models must keep technical documentation, give downstream providers enough information to use the model safely, and maintain a copyright policy…",
  },
  retrying: {
    selector: "Retry",
    status: "error",
    title: "Search paused",
    meta: "Retry 2 of 3",
    attempt: 2,
    current: "The Commission search timed out. Retrying with a narrower query",
    stages: { ...waitingStages, understanding: "complete", evidence: "retrying" },
    events: [
      planDone,
      {
        stage: "evidence",
        label: "First query complete",
        detail: "The legal text is available.",
        tone: "done",
        queries: [queries[0]],
      },
      {
        stage: "evidence",
        label: "Search timed out",
        detail: "No result was lost. The next try uses the official Commission domain.",
        tone: "warning",
        queries: [queries[1]],
      },
      {
        stage: "evidence",
        label: "Retrying now",
        detail: "Attempt 2 of 3.",
        tone: "active",
      },
    ],
  },
  complete: {
    selector: "Done",
    status: "succeeded",
    title: "Done",
    meta: "3 sources · 2 queries · 18s",
    current: "Answer complete",
    stages: {
      understanding: "complete",
      evidence: "complete",
      preparing: "complete",
      writing: "complete",
      finishing: "complete",
    },
    events: [
      planDone,
      searchDone,
      sourcesDone,
      prepareDone,
      writingDone,
      {
        stage: "finishing",
        label: "Checks complete",
        detail: "Citations placed and dates checked.",
        tone: "done",
      },
    ],
  },
};

function StateSelector({
  value,
  onChange,
}: {
  value: StateId;
  onChange: (value: StateId) => void;
}) {
  return (
    <div
      className="flex gap-1 overflow-x-auto border-b border-line pb-2"
      aria-label="Preview state"
    >
      {stateIds.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={`shrink-0 rounded-tiny border px-2.5 py-1.5 font-mono text-[10px] uppercase transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            value === id
              ? "border-ink bg-ink text-paper"
              : "border-line bg-paper text-ink-2 hover:border-ink"
          }`}
        >
          {states[id].selector}
        </button>
      ))}
    </div>
  );
}

export function ChatUxShowcasePage({ locale }: { locale: Locale }) {
  const [selected, setSelected] = useState<StateId>("searching");
  const state = states[selected];
  const prefix = `/${locale}`;

  return (
    <AppShell
      locale={locale}
      initialView="client"
      clientSubnav={[
        { id: "chat", label: "Chat", href: `${prefix}/client/chat` },
        { id: "chat-ux", label: "Chat UX", href: `${prefix}/chat-ux`, active: true },
      ]}
      onLocaleChange={(next) => window.location.assign(`/${next}/chat-ux`)}
    >
      <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-8 pb-12">
        <header className="grid gap-2 border-b border-line pb-5">
          <p className="font-mono text-[10px] tracking-[0.14em] text-accent uppercase">
            Temporary review page
          </p>
          <h1 className="font-display text-3xl leading-tight text-ink sm:text-4xl">
            Show the work, not just the stage
          </h1>
          <p className="max-w-2xl font-reading text-[16px] leading-relaxed text-ink-2">
            Keep progress quiet and compact. Show the current action at once. Keep queries, sources,
            and retries one click away.
          </p>
        </header>

        <section className="grid min-w-0 gap-4" aria-labelledby="conversation-preview-title">
          <div>
            <p className="font-mono text-[10px] tracking-[0.12em] text-ink-3 uppercase">
              In context
            </p>
            <h2 id="conversation-preview-title" className="mt-1 font-display text-2xl text-ink">
              One answer, every state
            </h2>
          </div>
          <StateSelector value={selected} onChange={setSelected} />
          <div className="min-w-0 rounded-tiny border border-line bg-surface p-3 sm:p-6">
            <div className="ml-auto max-w-[42ch] rounded-tiny border border-line bg-paper-deep px-3 py-2">
              <p className="font-sans text-[13px] leading-relaxed text-ink">
                What duties apply to general-purpose AI providers under the EU AI Act now?
              </p>
            </div>
            <article className="mt-6 grid max-w-2xl gap-3" aria-label="Assistant answer preview">
              <header className="flex items-center gap-2">
                <p className="font-mono text-[10px] tracking-[0.12em] text-ink-2 uppercase">
                  Hartlib · now
                </p>
                <span aria-hidden="true" className="h-px flex-1 bg-line" />
              </header>
              <RunActivity key={selected} {...state} />
              {state.answer && (
                <p className="font-reading text-[15px] leading-7 text-ink">
                  {state.answer}
                  <span
                    aria-hidden="true"
                    className="ml-0.5 inline-block h-4 w-px animate-pulse-soft bg-accent"
                  />
                </p>
              )}
              {selected === "complete" && (
                <p className="font-reading text-[15px] leading-7 text-ink">
                  Providers must keep technical documentation, share enough information with
                  downstream providers, maintain a copyright policy, and publish a training-content
                  summary. The first GPAI duties have applied since 2 August 2025.
                </p>
              )}
            </article>
          </div>
        </section>

        <section className="grid min-w-0 gap-4" aria-labelledby="state-sheet-title">
          <div>
            <p className="font-mono text-[10px] tracking-[0.12em] text-ink-3 uppercase">
              State sheet
            </p>
            <h2 id="state-sheet-title" className="mt-1 font-display text-2xl text-ink">
              Side-by-side checks
            </h2>
          </div>
          <div className="grid min-w-0 items-start gap-3 md:grid-cols-2">
            {stateIds.map((id) => (
              <div key={id} className={`min-w-0 ${id === "complete" ? "md:col-span-2" : ""}`}>
                <p className="mb-1.5 font-mono text-[9px] tracking-[0.12em] text-ink-3 uppercase">
                  {states[id].selector}
                </p>
                <RunActivity {...states[id]} compact />
              </div>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
