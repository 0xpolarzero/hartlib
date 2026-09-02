import type { Locale } from "@hartlib/i18n";
import {
  AppShell,
  AssistantMessage,
  RunActivity,
  UserMessage,
  type AiRunActivityEvent,
  type RunStageId,
  type RunStages,
} from "@hartlib/ui";

import {
  failedChatUxRunFixture as failedFixture,
  successfulChatUxRunFixture as successfulFixture,
} from "./fixtures/chat-ux-run.fixture";

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

const failedActivities: readonly AiRunActivityEvent[] = failedFixture.run.activities;
const failedStages = stagesForActivities(failedActivities);
const failedAttempt = Math.max(0, ...failedActivities.map((activity) => activity.attempt ?? 0));

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
      <div className="mx-auto grid w-full min-w-0 max-w-3xl gap-8 pb-12">
        <section
          className="grid min-w-0 gap-6 rounded-tiny border border-line bg-surface p-3 sm:p-6"
          aria-label="Completed captured chat"
        >
          <UserMessage
            message={{
              id: "chat-ux-success-user",
              author: "user",
              content: successfulFixture.question,
            }}
            locale={locale}
          />
          <AssistantMessage
            message={{
              id: "chat-ux-success-answer",
              author: "assistant",
              content: successfulFixture.answer,
              createdAt: successfulFixture.capturedAt,
              citations: successfulFixture.citations,
              sourcesRead: successfulFixture.sourcesRead,
            }}
            locale={locale}
          />
        </section>

        <section
          className="grid min-w-0 gap-6 rounded-tiny border border-line bg-surface p-3 sm:p-6"
          aria-label="Failed captured chat"
        >
          <UserMessage
            message={{
              id: "chat-ux-failed-user",
              author: "user",
              content: failedFixture.question,
            }}
            locale={locale}
          />
          <RunActivity
            status={failedFixture.run.status}
            stages={failedStages}
            attempt={failedAttempt}
            activities={failedFixture.run.activities}
            sourcesRead={failedFixture.sourcesRead}
            locale={locale}
          />
        </section>
      </div>
    </AppShell>
  );
}
