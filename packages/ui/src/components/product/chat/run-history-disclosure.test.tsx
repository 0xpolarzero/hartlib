import type { PublicAiRunDebug } from "@hartlib/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RunHistoryDisclosure, runHistorySnapshotFromDebug } from "./run-history-disclosure";

const completedStages = ["understanding", "evidence", "preparing", "writing", "finishing"].map(
  (stage) => ({
    stage,
    status: "complete",
    attempt: 1,
    durationMs: null,
    sourceCount: null,
    resultCount: null,
    errorCode: null,
    errorCategory: null,
  }),
) as PublicAiRunDebug["stages"];

const debug: PublicAiRunDebug = {
  runId: "run-1",
  status: "succeeded",
  startedAt: "2026-09-02T17:00:00.000Z",
  finishedAt: "2026-09-02T17:01:00.000Z",
  failedAt: null,
  stoppedAt: null,
  lastSequence: 3,
  stages: completedStages,
  history: [
    {
      stage: "writing",
      topicId: null,
      code: "answer_generation",
      status: "complete",
      occurredAt: "2026-09-02T17:00:59.000Z",
      attempt: 1,
      durationMs: 900,
      sourceCount: null,
      resultCount: null,
      errorCode: null,
      errorCategory: null,
    },
  ],
  sourceSummary: { read: 2, cited: 2, uncited: 0 },
  context: { compactionRan: false, consumers: 1, inputTokens: 100, usableInputTokens: 1_000 },
  memory: null,
  usage: null,
  terminalError: null,
};

describe("terminal run history disclosure", () => {
  it("is a collapsed completed box by default", () => {
    const snapshot = runHistorySnapshotFromDebug(debug);
    expect(snapshot).not.toBeNull();
    const html = renderToStaticMarkup(
      <RunHistoryDisclosure runId="run-1" status="succeeded" snapshot={snapshot!} />,
    );

    expect(html).toContain("Completed run");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Answer generation");
  });

  it("projects safe debug history into run activity", () => {
    expect(runHistorySnapshotFromDebug(debug)).toMatchObject({
      status: "succeeded",
      stages: { finishing: "complete" },
      activities: [{ code: "answer_generation", status: "complete", durationMs: 900 }],
    });
  });
});
