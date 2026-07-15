import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ChangeMonthlyPlanRequest,
  ChangeMonthlyPlanResponse,
  CreateBillingCheckoutRequest,
  CreateExportRequest,
  CurrentUserWorkspacesResponse,
  ExportRequestDescriptor,
  InvitePublisherClientAccessRequest,
  NotificationPreferences,
  PausePublisherClientAccessRequest,
  UpdateClientWebPolicyRequest,
} from "./platform";

describe("platform public schemas", () => {
  it("requires an exact supported locale in notification preferences", () => {
    expect(
      Schema.decodeUnknownSync(NotificationPreferences, { onExcessProperty: "error" })({
        locale: "en-US",
        emailIssuePublished: true,
        emailDeliveryReminders: false,
        emailUsageLimits: true,
      }),
    ).toEqual({
      locale: "en-US",
      emailIssuePublished: true,
      emailDeliveryReminders: false,
      emailUsageLimits: true,
    });
    for (const candidate of [undefined, "en", "de-DE"]) {
      expect(() =>
        Schema.decodeUnknownSync(NotificationPreferences, { onExcessProperty: "error" })({
          ...(candidate === undefined ? {} : { locale: candidate }),
          emailIssuePublished: true,
          emailDeliveryReminders: true,
          emailUsageLimits: true,
        }),
      ).toThrow();
    }
  });

  it("decodes the exact supported export scopes", () => {
    expect(
      Schema.decodeUnknownSync(CreateExportRequest)({
        scopeKind: "user_chats",
        scopeId: "me",
        idempotencyKey: "export-request-0001",
      }),
    ).toEqual({
      scopeKind: "user_chats",
      scopeId: "me",
      idempotencyKey: "export-request-0001",
    });
    expect(() =>
      Schema.decodeUnknownSync(CreateExportRequest)({
        scopeKind: "all_data",
        scopeId: "user-1",
        idempotencyKey: "export-request-0001",
      }),
    ).toThrow();
  });

  it("keeps download availability explicit and nullable", () => {
    expect(
      Schema.decodeUnknownSync(ExportRequestDescriptor)({
        id: "export-1",
        scopeKind: "client_company",
        scopeId: "company-1",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        expiresAt: "2026-01-02T00:01:00.000Z",
        errorCode: null,
        downloadPath: "/v1/exports/export-1/download",
      }).downloadPath,
    ).toBe("/v1/exports/export-1/download");
  });

  it("keeps billing checkout branches disjoint", () => {
    expect(
      Schema.decodeUnknownSync(CreateBillingCheckoutRequest)({
        kind: "monthly",
        planTier: "team",
        idempotencyKey: "checkout-0001",
      }),
    ).toEqual({ kind: "monthly", planTier: "team", idempotencyKey: "checkout-0001" });
    expect(() =>
      Schema.decodeUnknownSync(CreateBillingCheckoutRequest, { onExcessProperty: "error" })({
        kind: "monthly",
        planTier: "team",
        idempotencyKey: "checkout-0001",
        credits: 100,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateBillingCheckoutRequest, { onExcessProperty: "error" })({
        kind: "additional",
        credits: 100,
        idempotencyKey: "checkout-0001",
        planTier: "team",
      }),
    ).toThrow();
  });

  it("enforces bounded plan-change keys and discriminated effective dates", () => {
    expect(
      Schema.decodeUnknownSync(ChangeMonthlyPlanRequest)({
        planTier: "intensive",
        idempotencyKey: "plan-change-0001",
      }),
    ).toEqual({ planTier: "intensive", idempotencyKey: "plan-change-0001" });
    for (const idempotencyKey of ["short", "contains spaces", "x".repeat(181)]) {
      expect(() =>
        Schema.decodeUnknownSync(ChangeMonthlyPlanRequest)({ planTier: "team", idempotencyKey }),
      ).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(ChangeMonthlyPlanResponse)({
        change: {
          status: "unchanged",
          previousTier: "team",
          planTier: "team",
          effectiveAt: "2026-07-10T00:00:00.000Z",
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ChangeMonthlyPlanResponse)({
        change: {
          status: "upgraded",
          previousTier: "team",
          planTier: "intensive",
          effectiveAt: null,
        },
      }),
    ).toThrow();
  });

  it("decodes workspace discovery without content or implicit access", () => {
    expect(
      Schema.decodeUnknownSync(CurrentUserWorkspacesResponse)({
        publisherWorkspaces: [
          {
            kind: "publisher",
            companyId: "publisher-1",
            companyName: "Publisher",
            role: "manager",
            landingPath: "/publishers/publisher-1",
          },
        ],
        clientWorkspaces: [
          {
            kind: "client",
            companyId: "client-1",
            companyName: "Client",
            role: "member",
            landingPath: "/clients/client-1",
          },
        ],
      }).clientWorkspaces[0]?.role,
    ).toBe("member");
  });

  it("rejects extra fields from security-sensitive lifecycle requests", () => {
    expect(() =>
      Schema.decodeUnknownSync(InvitePublisherClientAccessRequest, {
        onExcessProperty: "error",
      })({
        clientCompanyName: "Client",
        firstAdminEmail: "admin@example.com",
        idempotencyKey: "client-access-0001",
        subscriptionId: "caller-must-not-select",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PausePublisherClientAccessRequest, {
        onExcessProperty: "error",
      })({ deliveryEndAt: null, state: "paused" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(UpdateClientWebPolicyRequest, {
        onExcessProperty: "error",
      })({ enabled: false, allowedDomains: null, provider: "tinyfish" }),
    ).toThrow();
  });
});
