import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublicAiRunDebug } from "@hartlib/shared";
import { createDebugLoadFence, DebugDrawer } from "./debug-drawer";

describe("debug drawer", () => {
  it("stays closed while exposing an accessible diagnostics trigger", () => {
    const html = renderToStaticMarkup(<DebugDrawer runId="run-42" />);
    expect(html).toContain('aria-label="Show diagnostics"');
    expect(html).not.toContain("Debug details");
  });

  it("renders retained stopped data in the single drawer", () => {
    const html = renderToStaticMarkup(
      <DebugDrawer
        runId="run-42"
        data={
          {
            runId: "run-42",
            status: "stopped",
            startedAt: null,
            finishedAt: null,
            failedAt: null,
            stoppedAt: "2026-01-01T00:00:00.000Z",
            lastSequence: null,
            stages: (
              ["understanding", "evidence", "preparing", "writing", "finishing"] as const
            ).map((stage) => ({
              stage,
              status: "complete" as const,
              attempt: null,
              durationMs: null,
              sourceCount: null,
              resultCount: null,
              errorCode: null,
              errorCategory: null,
            })),
            history: [],
            sourceSummary: { read: 0, cited: 0, uncited: 0 },
            context: {
              compactionRan: null,
              consumers: 0,
              inputTokens: null,
              usableInputTokens: null,
            },
            memory: null,
            usage: null,
            terminalError: null,
          } satisfies PublicAiRunDebug
        }
        state="stopped"
      />,
    );
    expect(html).toContain('aria-label="Show diagnostics"');
  });
  it("fences an older deferred request when a newer run loads", async () => {
    const fence = createDebugLoadFence();
    let resolveOld!: (value: string) => void;
    const old = new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
    const oldToken = fence.begin();
    const newToken = fence.begin();
    resolveOld("old debug");
    await expect(old).resolves.toBe("old debug");
    expect(fence.isCurrent(oldToken, true)).toBe(false);
    expect(fence.isCurrent(newToken, true)).toBe(true);
    expect(fence.isCurrent(newToken, false)).toBe(false);
  });
});
