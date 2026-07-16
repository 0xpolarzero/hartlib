import { describe, expect, it } from "vitest";

import {
  EVALUATION_SMITHERS_HEARTBEAT_STALE_MS,
  evaluationCaseResumeAction,
  evaluationSmithersRunDisposition,
} from "./pipeline";
import type { SmithersRunSummary } from "../smithers-interop";

const run = (overrides: Partial<SmithersRunSummary> = {}): SmithersRunSummary => ({
  runId: "ai-evaluation-general-planner:session:case",
  status: "running",
  heartbeatAtMs: 1_000,
  runtimeOwnerId: "owner:1",
  finishedAtMs: null,
  ...overrides,
});

describe("evaluation Smithers reconciliation", () => {
  it("distinguishes an active owner from a crash-resumable run", () => {
    expect(evaluationSmithersRunDisposition(run(), 1_000 + 1_000)).toBe("active");
    expect(
      evaluationSmithersRunDisposition(
        run({ heartbeatAtMs: 1_000 }),
        1_000 + EVALUATION_SMITHERS_HEARTBEAT_STALE_MS + 1,
      ),
    ).toBe("resumable");
    expect(evaluationSmithersRunDisposition(run({ heartbeatAtMs: null }), 1_000)).toBe("resumable");
  });

  it("treats terminal output and absent state as distinct recovery boundaries", () => {
    expect(
      evaluationSmithersRunDisposition(
        run({ status: "finished", heartbeatAtMs: null, finishedAtMs: 2_000 }),
      ),
    ).toBe("terminal");
    expect(evaluationSmithersRunDisposition(null)).toBe("missing");
    expect(evaluationSmithersRunDisposition(run({ status: "unknown" }))).toBe("irrecoverable");
  });

  it("keeps Smithers retryable terminal statuses resumable", () => {
    expect(evaluationSmithersRunDisposition(run({ status: "failed" }))).toBe("resumable");
    expect(evaluationSmithersRunDisposition(run({ status: "cancelled" }))).toBe("resumable");
  });

  it("keeps terminal evidence sealing idempotent on a replay", () => {
    expect(evaluationCaseResumeAction("specialized", true, false)).toBe("seal_evidence");
    expect(evaluationCaseResumeAction("general_planner", true, true)).toBe("seal_evidence");
    expect(evaluationCaseResumeAction("general_planner", true, false)).toBe("resume_workflow");
  });
});
