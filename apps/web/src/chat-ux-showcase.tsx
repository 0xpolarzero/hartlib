import type { Locale } from "@hartlib/i18n";
import {
  AppShell,
  RunActivity,
  SourcesDisclosure,
  type AiRunActivityEvent,
  type RunStageId,
  type RunStages,
} from "@hartlib/ui";

import { chatUxRunFixture as fixture } from "./fixtures/chat-ux-run.fixture";
const STAGE_ORDER: readonly RunStageId[] = [
  "understanding",
  "evidence",
  "preparing",
  "writing",
  "finishing",
];

function stagesForActivities(activities: readonly AiRunActivityEvent[]): RunStages {
  const stages: RunStages = {
    understanding: "waiting",
    evidence: "waiting",
    preparing: "waiting",
    writing: "waiting",
    finishing: "waiting",
  };
  const latestByAction = new Map<string, AiRunActivityEvent>();
  for (const activity of activities) {
    const detailKey = activity.detail
      ? `${activity.detail.kind}:${activity.detail.ordinal}`
      : "phase";
    latestByAction.set(
      `${activity.stage}:${activity.topicId ?? "run"}:${activity.code}:${detailKey}`,
      activity,
    );
  }
  for (const stage of STAGE_ORDER) {
    const events = [...latestByAction.values()].filter((activity) => activity.stage === stage);
    if (events.length === 0) continue;
    if (events.some((activity) => activity.status === "failed")) stages[stage] = "failed";
    else if (events.some((activity) => activity.status === "retrying")) stages[stage] = "retrying";
    else if (events.some((activity) => activity.status === "running")) stages[stage] = "running";
    else if (
      events.every((activity) => activity.status === "complete" || activity.status === "skipped")
    ) {
      stages[stage] = "complete";
    }
  }
  return stages;
}

const capturedStages = stagesForActivities(fixture.run.activities);
const providerCallCount = fixture.providerServices.length;

export function ChatUxShowcasePage({ locale }: { locale: Locale }) {
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
            Live provider fixture
          </p>
          <h1 className="font-display text-3xl leading-tight text-ink sm:text-4xl">
            Recorded run activity
          </h1>
          <p className="max-w-2xl font-reading text-[16px] leading-relaxed text-ink-2">
            This snapshot came from the full chat stack after internal retrieval and live web
            research selected the answer context.
          </p>
          <p className="font-mono text-[10px] text-ink-3">
            {fixture.capturedAt} · {providerCallCount} model calls · {fixture.sourcesRead.length}{" "}
            sources
          </p>
        </header>

        <section className="grid min-w-0 gap-4" aria-labelledby="fixture-title">
          <div>
            <p className="font-mono text-[10px] tracking-[0.12em] text-ink-3 uppercase">
              Captured request
            </p>
            <h2 id="fixture-title" className="mt-1 font-display text-2xl text-ink">
              Internal and web evidence
            </h2>
          </div>

          <div className="min-w-0 rounded-tiny border border-line bg-surface p-3 sm:p-6">
            <div className="ml-auto max-w-[52ch] rounded-tiny border border-line bg-paper-deep px-3 py-2">
              <p className="font-sans text-[13px] leading-relaxed text-ink">{fixture.question}</p>
            </div>

            <article className="mt-6 grid max-w-2xl gap-3" aria-label="Captured assistant run">
              <header className="flex items-center gap-2">
                <p className="font-mono text-[10px] tracking-[0.12em] text-ink-2 uppercase">
                  Hartlib · recorded run
                </p>
                <span aria-hidden="true" className="h-px flex-1 bg-line" />
              </header>
              <RunActivity
                status={fixture.run.status}
                stages={capturedStages}
                attempt={Math.max(
                  0,
                  ...fixture.run.activities.map((activity) => activity.attempt ?? 0),
                )}
                activities={fixture.run.activities}
                sourcesRead={fixture.sourcesRead}
                locale={locale}
              />
              <p className="text-[12px] leading-relaxed text-ink-2">
                Captured after context preparation. Answer generation had started; the capture then
                stopped the run without saving an answer.
              </p>
              <SourcesDisclosure
                sources={fixture.sourcesRead}
                citations={fixture.citations}
                answerId="chat-ux-live-fixture"
                defaultOpen
                locale={locale}
              />
            </article>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
