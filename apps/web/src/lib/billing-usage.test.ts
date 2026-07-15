import type { AiUsageOverview } from "@brief/shared";
import { describe, expect, it } from "vitest";

import { memberAiUsageIsLimited } from "./billing-usage";

const usage = (overrides: Partial<AiUsageOverview> = {}): AiUsageOverview => ({
  status: "active",
  planTier: "team",
  pendingDowngradeTier: null,
  periodStart: "2026-07-01T00:00:00.000Z",
  periodEnd: "2026-08-01T00:00:00.000Z",
  companyMonthlyLimit: 100,
  companyUsedCredits: 20,
  availableCredits: 80,
  employees: [{ userId: "member", usedCredits: 20, monthlyLimit: 50 }],
  requests: [],
  ...overrides,
});

describe("memberAiUsageIsLimited", () => {
  it("keeps the request action hidden while every gate has capacity", () => {
    expect(memberAiUsageIsLimited(usage())).toBe(false);
  });

  it.each([
    ["inactive billing", usage({ status: "inactive" })],
    ["exhausted prepaid credits", usage({ availableCredits: 0 })],
    ["company limit", usage({ companyUsedCredits: 100 })],
    [
      "employee limit",
      usage({ employees: [{ userId: "member", usedCredits: 50, monthlyLimit: 50 }] }),
    ],
  ])("shows the request action at the exact %s gate", (_label, snapshot) => {
    expect(memberAiUsageIsLimited(snapshot)).toBe(true);
  });

  it("does not invent an employee limit when the member has none", () => {
    expect(
      memberAiUsageIsLimited(
        usage({ employees: [{ userId: "member", usedCredits: 9_999, monthlyLimit: null }] }),
      ),
    ).toBe(false);
  });
});
