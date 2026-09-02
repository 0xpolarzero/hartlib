import { useState } from "react";
import type { Locale } from "@hartlib/i18n";
import {
  AppShell,
  RunActivity,
  type AiRunActivityEvent,
  type PublicSourceRecord,
  type RunActivityProps,
} from "@hartlib/ui";

const stateIds = [
  "started",
  "planning",
  "searching",
  "reading",
  "writing",
  "retrying",
  "complete",
] as const;
type StateId = (typeof stateIds)[number];
type ShowcaseState = RunActivityProps & { selector: string };

const waitingStages = {
  understanding: "waiting",
  evidence: "waiting",
  preparing: "waiting",
  writing: "waiting",
  finishing: "waiting",
} as const;

const questionRunning: AiRunActivityEvent = {
  type: "activity",
  stage: "understanding",
  code: "request_understanding",
  status: "running",
  runId: "showcase",
  attempt: 1,
  occurredAt: "2026-05-12T10:00:00.000Z",
};
const questionComplete: AiRunActivityEvent = {
  ...questionRunning,
  status: "complete",
  durationMs: 184,
};
const internalSearch: AiRunActivityEvent = {
  type: "activity",
  stage: "evidence",
  code: "internal_sources",
  status: "complete",
  runId: "showcase",
  attempt: 1,
  occurredAt: "2026-05-12T10:00:00.184Z",
  resultCount: 2,
  detail: {
    kind: "internal_queries",
    ordinal: 1,
    plan: "final",
    action: "search",
    queries: [
      {
        purpose: "Find current obligations and their start dates",
        targets: [
          {
            kind: "documents",
            filters: {
              sourceNames: ["European Commission", "EUR-Lex"],
              languages: ["en"],
            },
          },
        ],
        all: [{ text: "general-purpose AI", mode: "phrase" }],
        anyOf: [
          [
            { text: "obligations", mode: "term" },
            { text: "duties", mode: "term" },
          ],
        ],
        not: [],
        order: "relevance",
      },
    ],
  },
};
const webSearchRunning: AiRunActivityEvent = {
  type: "activity",
  stage: "evidence",
  code: "web_research",
  status: "running",
  runId: "showcase",
  attempt: 1,
  occurredAt: "2026-05-12T10:00:00.420Z",
  detail: {
    kind: "web_search",
    ordinal: 1,
    query: "site:digital-strategy.ec.europa.eu AI Act GPAI obligations timeline",
  },
};
const webSearchComplete: AiRunActivityEvent = {
  ...webSearchRunning,
  status: "complete",
  resultCount: 5,
  detail: {
    kind: "web_search",
    ordinal: 1,
    query: "site:digital-strategy.ec.europa.eu AI Act GPAI obligations timeline",
    resultCount: 5,
  },
};
const webFetchComplete: AiRunActivityEvent = {
  type: "activity",
  stage: "evidence",
  code: "web_research",
  status: "complete",
  runId: "showcase",
  attempt: 1,
  occurredAt: "2026-05-12T10:00:01.082Z",
  detail: {
    kind: "web_fetch",
    ordinal: 1,
    url: "https://digital-strategy.ec.europa.eu/en/policies/rules-general-purpose-ai-models-gpai",
    title: "Rules for general-purpose AI models",
    domain: "digital-strategy.ec.europa.eu",
    capturedAt: "2026-05-12T10:00:01.082Z",
  },
};
const contextComplete: AiRunActivityEvent = {
  type: "activity",
  stage: "preparing",
  code: "context_preparation",
  status: "complete",
  runId: "showcase",
  attempt: 1,
  occurredAt: "2026-05-12T10:00:01.291Z",
  durationMs: 209,
  sourceCount: 1,
};
const answerRunning: AiRunActivityEvent = {
  type: "activity",
  stage: "writing",
  code: "answer_generation",
  status: "running",
  runId: "showcase",
  attempt: 1,
  occurredAt: "2026-05-12T10:00:01.302Z",
};
const retryingSearch: AiRunActivityEvent = {
  ...webSearchRunning,
  status: "retrying",
  attempt: 2,
  errorCategory: "provider_transport",
  errorCode: "provider_timeout",
  errorMessage: "The web search provider timed out.",
};
const answerComplete: AiRunActivityEvent = {
  ...answerRunning,
  status: "complete",
  durationMs: 1_438,
};
const finalComplete: AiRunActivityEvent = {
  type: "activity",
  stage: "finishing",
  code: "finalization",
  status: "complete",
  runId: "showcase",
  attempt: 1,
  occurredAt: "2026-05-12T10:00:02.740Z",
  durationMs: 94,
};
const source: PublicSourceRecord = {
  kind: "web",
  sourceKey: "web:commission-gpai",
  label: "European Commission",
  tokenCount: 812,
  topicIds: ["t1"],
  title: "Rules for general-purpose AI models",
  domain: "digital-strategy.ec.europa.eu",
  url: "https://digital-strategy.ec.europa.eu/en/policies/rules-general-purpose-ai-models-gpai",
  capturedAt: "2026-05-12T10:00:01.082Z",
  quote: "General-purpose AI model obligations apply according to the dates set by the AI Act.",
  ranges: [],
};

const states: Record<StateId, ShowcaseState> = {
  started: {
    selector: "Started",
    status: "running",
    stages: { ...waitingStages, understanding: "running" },
    activities: [questionRunning],
  },
  planning: {
    selector: "Plan",
    status: "running",
    stages: { ...waitingStages, understanding: "complete", evidence: "running" },
    activities: [questionComplete, internalSearch],
  },
  searching: {
    selector: "Search",
    status: "running",
    stages: { ...waitingStages, understanding: "complete", evidence: "running" },
    activities: [questionComplete, internalSearch, webSearchRunning],
  },
  reading: {
    selector: "Sources",
    status: "running",
    stages: { ...waitingStages, understanding: "complete", evidence: "running" },
    activities: [questionComplete, internalSearch, webSearchComplete, webFetchComplete],
    sourcesRead: [source],
  },
  writing: {
    selector: "Write",
    status: "running",
    stages: {
      ...waitingStages,
      understanding: "complete",
      evidence: "complete",
      preparing: "complete",
      writing: "running",
    },
    activities: [
      questionComplete,
      internalSearch,
      webSearchComplete,
      webFetchComplete,
      contextComplete,
      answerRunning,
    ],
    sourcesRead: [source],
  },
  retrying: {
    selector: "Retry",
    status: "running",
    attempt: 2,
    stages: { ...waitingStages, understanding: "complete", evidence: "retrying" },
    activities: [questionComplete, internalSearch, retryingSearch],
  },
  complete: {
    selector: "Complete",
    status: "succeeded",
    stages: {
      understanding: "complete",
      evidence: "complete",
      preparing: "complete",
      writing: "complete",
      finishing: "complete",
    },
    activities: [
      questionComplete,
      internalSearch,
      webSearchComplete,
      webFetchComplete,
      contextComplete,
      answerComplete,
      finalComplete,
    ],
    sourcesRead: [source],
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
      className="flex min-w-0 gap-1 overflow-x-auto border-b border-line"
      role="tablist"
      aria-label="Activity state"
    >
      {stateIds.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={id === value}
          onClick={() => onChange(id)}
          className={`min-h-9 shrink-0 border-b-2 px-3 font-mono text-[10px] tracking-wide uppercase ${
            id === value ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink"
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
            Recorded run activity
          </h1>
          <p className="max-w-2xl font-reading text-[16px] leading-relaxed text-ink-2">
            The component renders strict worker events: actions, exact queries, source identities,
            counts, times, and errors.
          </p>
        </header>

        <section className="grid min-w-0 gap-4" aria-labelledby="conversation-preview-title">
          <div>
            <p className="font-mono text-[10px] tracking-[0.12em] text-ink-3 uppercase">
              Selected state
            </p>
            <h2 id="conversation-preview-title" className="mt-1 font-display text-2xl text-ink">
              Run detail
            </h2>
          </div>
          <StateSelector value={selected} onChange={setSelected} />
          <div className="min-w-0 rounded-tiny border border-line bg-surface p-3 sm:p-6">
            <article className="grid max-w-2xl gap-3" aria-label="Activity preview">
              <RunActivity key={selected} {...states[selected]} />
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
