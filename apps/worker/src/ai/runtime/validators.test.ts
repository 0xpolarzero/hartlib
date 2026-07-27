import { describe, expect, it } from "vitest";

import { validatePlanTurn, AgentOutputValidationError } from "./validators";

describe("plan-turn validation", () => {
  it("accepts clarify and single results", () => {
    expect(validatePlanTurn({ mode: "clarify", question: "Which report?" }, [], 3)).toEqual({
      mode: "clarify",
      question: "Which report?",
    });
    expect(
      validatePlanTurn(
        { mode: "single", question: "Summarize it", relevantTurnIds: ["t1"] },
        ["t1"],
        3,
      ),
    ).toEqual({ mode: "single", question: "Summarize it", relevantTurnIds: ["t1"] });
  });

  it("normalizes fanout topic ids and rejects foreign or duplicate turns", () => {
    expect(
      validatePlanTurn(
        {
          mode: "fanout",
          question: "Compare them",
          topics: [
            { question: "A", relevantTurnIds: ["t1"] },
            { question: "B", relevantTurnIds: ["t2"] },
          ],
        },
        ["t1", "t2"],
        3,
      ),
    ).toMatchObject({ mode: "fanout", topics: [{ topicId: "t1" }, { topicId: "t2" }] });
    expect(() =>
      validatePlanTurn({ mode: "single", question: "x", relevantTurnIds: ["x"] }, ["t1"], 3),
    ).toThrow(AgentOutputValidationError);
    expect(() =>
      validatePlanTurn({ mode: "single", question: "x", relevantTurnIds: ["t1", "t1"] }, ["t1"], 3),
    ).toThrow(AgentOutputValidationError);
  });
});
