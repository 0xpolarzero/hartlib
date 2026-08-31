import { describe, expect, it } from "vitest";

import { incrementalSse, type ActiveDemoSessionChecker, type AiRunEventPoller } from "./chat";
import type { ApiDatabaseLayer as ApiDatabaseLayerType } from "../database";

describe("incremental SSE session fencing", () => {
  it("closes the stream on the next poll after the demo session is revoked", async () => {
    let checks = 0;
    let polls = 0;
    const isSessionActive: ActiveDemoSessionChecker = async () => {
      checks += 1;
      return checks === 1;
    };
    const readAuthorizedAiRunEventsAfter: AiRunEventPoller = async () => {
      polls += 1;
      return { authorized: true, events: [], terminal: false, replayableTerminal: false };
    };
    const response = incrementalSse({
      request: new Request("http://hartlib.test/v1/ai-runs/run-1/stream"),
      runId: "run-1",
      userId: "visitor-1",
      afterSeq: 0,
      pollMs: 1,
      keepAliveMs: 60_000,
      databaseLayer: undefined as unknown as ApiDatabaseLayerType,
      readAuthorizedAiRunEventsAfter,
      isSessionActive,
    });

    const reader = response.body!.getReader();
    const result = await reader.read();
    expect(result.done).toBe(true);
    expect(checks).toBe(2);
    expect(polls).toBe(1);
  });
});
