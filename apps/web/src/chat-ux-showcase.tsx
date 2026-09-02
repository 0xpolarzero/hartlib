import type { Locale } from "@hartlib/i18n";
import {
  AppShell,
  Transcript,
  type AiRunActivityEvent,
  type ChatTranscriptMessage,
  type RunStages,
  type RunHistorySnapshot,
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
const successfulRunHistory: RunHistorySnapshot = {
  status: "succeeded",
  stages: {
    understanding: "complete",
    evidence: "complete",
    preparing: "complete",
    writing: "complete",
    finishing: "complete",
  },
  activities: [],
};

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
    runId: "chat-ux-success-run",
    runStatus: "succeeded",
    runHistory: successfulRunHistory,
    sourcesRead: successfulFixture.sourcesRead,
  },
];

const failedActivities: readonly AiRunActivityEvent[] = failedFixture.run.activities;
const failedRunId = failedActivities.find((activity) => activity.runId !== undefined)?.runId;
if (failedRunId === undefined)
  throw new Error("The failed chat fixture requires a recorded run id");
const failedRunHistory: RunHistorySnapshot = {
  status: "failed",
  stages: stagesForActivities(failedActivities),
  activities: failedActivities,
};
const failedMessages: readonly ChatTranscriptMessage[] = [
  {
    id: "chat-ux-failed-user",
    author: "user",
    content: failedFixture.question,
    runId: failedRunId,
    runStatus: "failed",
    runHistory: failedRunHistory,
  },
];

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
          <Transcript messages={failedMessages} locale={locale} />
        </section>
      </div>
    </AppShell>
  );
}
