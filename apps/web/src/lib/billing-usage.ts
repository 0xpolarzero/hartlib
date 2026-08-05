import type { AiUsageOverview } from "@hartlib/shared";

export const memberAiUsageIsLimited = (usage: AiUsageOverview): boolean => {
  const employee = usage.employees[0];
  return (
    (usage.status !== "active" && usage.status !== "trialing") ||
    usage.availableCredits <= 0 ||
    (usage.companyMonthlyLimit !== null && usage.companyUsedCredits >= usage.companyMonthlyLimit) ||
    (employee !== undefined &&
      employee.monthlyLimit !== null &&
      employee.usedCredits >= employee.monthlyLimit)
  );
};
