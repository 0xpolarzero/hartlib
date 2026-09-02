import type { Locale } from "@hartlib/i18n";
import {
  AppShell,
  Transcript,
  type AiRunActivityEvent,
  type ChatRunProjection,
  type ChatTranscriptMessage,
  type RunStages,
} from "@hartlib/ui";

import {
  failedChatUxRunFixture as failedFixture,
  successfulChatUxRunFixture as successfulFixture,
} from "./fixtures/chat-ux-run.fixture";

function stagesForActivities(activities: readonly AiRunActivityEvent[]): RunStages {
  const stages: RunStages = {
    understanding: "waiting",
    evidence: "waiting",
    preparing: "waiting",
    writing: "waiting",
    finishing: "waiting",
  };
  for (const activity of activities) stages[activity.stage] = activity.status;
  return stages;
}

const successfulMessages: readonly ChatTranscriptMessage[] = [
  {
    id: "chat-ux-success-user",
    author: "user",
    content: successfulFixture.question,
  },
  {
    id: "chat-ux-success-answer",
    author: "assistant",
    content: successfulFixture.answer,
    createdAt: successfulFixture.capturedAt,
    citations: successfulFixture.citations,
    sourcesRead: successfulFixture.sourcesRead,
  },
];

const failedActivities: readonly AiRunActivityEvent[] = failedFixture.run.activities;
const failedRunId = failedActivities.find((activity) => activity.runId !== undefined)?.runId;
if (failedRunId === undefined)
  throw new Error("The failed chat fixture requires a recorded run id");
const failedMessages: readonly ChatTranscriptMessage[] = [
  {
    id: "chat-ux-failed-user",
    author: "user",
    content: failedFixture.question,
  },
];
const failedRun: ChatRunProjection = {
  id: failedRunId,
  status: failedFixture.run.status,
  stages: stagesForActivities(failedActivities),
  attempt: Math.max(0, ...failedActivities.map((activity) => activity.attempt ?? 0)),
  activities: failedActivities,
  sourcesRead: failedFixture.sourcesRead,
};

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
          className="h-[32rem] min-h-0 overflow-hidden rounded-tiny border border-line bg-surface"
          aria-label="Completed captured chat"
        >
          <Transcript messages={successfulMessages} locale={locale} />
        </section>

        <section
          className="h-[40rem] min-h-0 overflow-hidden rounded-tiny border border-line bg-surface"
          aria-label="Failed captured chat"
        >
          <Transcript messages={failedMessages} run={failedRun} locale={locale} />
        </section>
      </div>
    </AppShell>
  );
}
