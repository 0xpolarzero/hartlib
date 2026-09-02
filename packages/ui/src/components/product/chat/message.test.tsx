import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AssistantMessage, UserMessage } from "./message";
import type { RunHistorySnapshot } from "./types";

const completedRun: RunHistorySnapshot = {
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

describe("chat message anatomy", () => {
  it("shows stopped state and no regenerate affordance", () => {
    const html = renderToStaticMarkup(
      <AssistantMessage
        message={{ id: "m1", author: "assistant", content: "Partial", stopped: true }}
      />,
    );
    expect(html).toContain("This answer was stopped");
    expect(html).not.toContain("Regenerate");
  });

  it("retains a collapsed completed run before the saved answer", () => {
    const html = renderToStaticMarkup(
      <AssistantMessage
        message={{
          id: "m1",
          author: "assistant",
          content: "Saved answer",
          runId: "run-1",
          runStatus: "succeeded",
          runHistory: completedRun,
        }}
      />,
    );

    expect(html).toContain("Completed run");
    expect(html).toContain('aria-expanded="false"');
    expect(html.indexOf("Completed run")).toBeLessThan(html.indexOf("Saved answer"));
  });

  it("retains a collapsed failed run when no answer exists", () => {
    const html = renderToStaticMarkup(
      <UserMessage
        message={{
          id: "m1",
          author: "user",
          content: "Question",
          runId: "run-1",
          runStatus: "failed",
          runHistory: { ...completedRun, status: "failed" },
        }}
      />,
    );

    expect(html).toContain("Failed run");
    expect(html).toContain('aria-expanded="false"');
  });
});
