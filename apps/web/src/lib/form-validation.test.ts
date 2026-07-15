import { describe, expect, it } from "vitest";

import {
  validateArchiveQuery,
  validateEmailAddress,
  validatePublisherOnboarding,
  validateSubscriptionName,
} from "./form-validation";

describe("typed product form validation", () => {
  it("enforces the exact archive query boundary", () => {
    expect(validateArchiveQuery("x".repeat(500))).toBeUndefined();
    expect(validateArchiveQuery("x".repeat(501))).toBe("archive_query_too_long");
  });

  it("normalizes subscription-name significance without accepting blank values", () => {
    expect(validateSubscriptionName(" Regulatory Brief ")).toBeUndefined();
    expect(validateSubscriptionName(" \n ")).toBe("subscription_name_invalid");
    expect(validateSubscriptionName("x".repeat(201))).toBe("subscription_name_invalid");
  });

  it.each(["admin@example.com", "First.Last+workspace@sub.example.co.uk"])(
    "accepts a bounded email address: %s",
    (email) => {
      expect(validateEmailAddress(email)).toBeUndefined();
    },
  );

  it.each(["", "admin", "@example.com", "admin@example", "a @example.com", "a@@example.com"])(
    "rejects an invalid email address: %s",
    (email) => expect(validateEmailAddress(email)).toBe("email_invalid"),
  );

  it("validates publisher onboarding as one typed form invariant", () => {
    expect(
      validatePublisherOnboarding({
        companyName: "Official Publisher",
        firstAdminEmail: "admin@example.com",
      }),
    ).toBeUndefined();
    expect(
      validatePublisherOnboarding({ companyName: "  ", firstAdminEmail: "admin@example.com" }),
    ).toBe("publisher_company_name_invalid");
    expect(
      validatePublisherOnboarding({ companyName: "Publisher", firstAdminEmail: "invalid" }),
    ).toBe("email_invalid");
  });
});
