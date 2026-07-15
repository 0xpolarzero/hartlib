import { EXPORT_ARCHIVE_MEDIA_TYPE } from "@brief/shared/export-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPublisherIssue,
  createPublisherCompanyExport,
  createPublisherCompanyOnboarding,
  createPublisherSubscription,
  createAiUsageRequest,
  createBillingCheckout,
  createBillingPortal,
  changeClientMonthlyPlan,
  createClientCompanyExport,
  createUserChatsExport,
  deletePublisherDocument,
  deletePublisherIssue,
  getIssueDetail,
  getCurrentUserWorkspaces,
  getNotificationPreferences,
  getPlatformOperations,
  getClientAiUsage,
  getClientWebPolicy,
  getProductExport,
  getPublisherAiPullMetrics,
  inviteClientMember,
  invitePublisherMember,
  invitePublisherClientAccess,
  listActiveRestrictedSupportGrants,
  listClientArchive,
  listClientMembers,
  listCompanyDeletionRequests,
  listNotifications,
  listPublisherIssues,
  listPublisherClientAccesses,
  listPublisherMembers,
  listPublisherSubscriptions,
  markNotificationRead,
  openRestrictedSupportGrantContent,
  openProductExportDownload,
  pausePublisherClientAccess,
  publishPublisherIssue,
  removePlatformIssueRestriction,
  restrictPlatformIssue,
  resolveAiUsageRequest,
  requestCompanyDeletion,
  schedulePublisherIssue,
  updatePublisherIssue,
  updateNotificationPreferences,
  updateClientMember,
  updateClientWebPolicy,
  updateCompanyAiLimit,
  updateEmployeeAiLimit,
  updatePublisherMember,
  deleteClientMember,
  deletePublisherMember,
  setClientMemberSubscriptionGrant,
  uploadPublisherDocument,
} from "./platform-api";
import { setApiTokenProvider } from "./api-auth";

const subscription = {
  id: "subscription-1",
  publisherCompanyId: "company-1",
  name: "Regulatory Brief",
  deliveryEnabled: true,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
} as const;

const issue = {
  id: "issue-1",
  subscriptionId: subscription.id,
  title: "Week 28",
  status: "draft",
  publicationAt: null,
  publishedAt: null,
  historical: false,
  indexingStatus: "pending",
  indexingErrorCode: null,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
} as const;

const redirectedResponse = (body: BodyInit, mediaType: string): Response => {
  const response = new Response(body, { status: 200, headers: { "content-type": mediaType } });
  Object.defineProperty(response, "redirected", { value: true });
  return response;
};

const testUstarArchive = (): ArrayBuffer => {
  const archive = new Uint8Array(2048);
  archive.set(new TextEncoder().encode("ustar"), 257);
  return Uint8Array.from(archive).buffer;
};

describe("publisher workspace API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiTokenProvider(async () => null);
  });

  it("decodes canonical publisher descriptors and sends exact create bodies", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ subscriptions: [subscription] }))
      .mockResolvedValueOnce(Response.json({ subscription }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ issues: [issue] }))
      .mockResolvedValueOnce(Response.json({ issue }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ issue }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ status: "published" }))
      .mockResolvedValueOnce(
        Response.json(
          { status: "scheduled", publicationAt: "2026-07-11T00:00:00.000Z" },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            document: {
              id: "document-1",
              issueId: issue.id,
              title: "Main PDF",
              originalFileName: "main.pdf",
              mediaType: "application/pdf",
              byteSize: 3,
              sha256Hex: "a".repeat(64),
              createdAt: issue.createdAt,
            },
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPublisherSubscriptions("company /1")).resolves.toEqual([subscription]);
    await createPublisherSubscription("company /1", { name: subscription.name });
    await expect(listPublisherIssues("subscription /1")).resolves.toEqual([issue]);
    await createPublisherIssue("subscription /1", {
      title: issue.title,
      publicationAt: null,
      historical: false,
    });
    await updatePublisherIssue("issue /1", "Updated title");
    await deletePublisherIssue("issue /1");
    await publishPublisherIssue("issue /1");
    await schedulePublisherIssue("issue /1", "2026-07-11T00:00:00.000Z");
    await uploadPublisherDocument("issue /1", {
      title: "Main PDF",
      file: new File([new Uint8Array([1, 2, 3])], "main.pdf", { type: "application/pdf" }),
      idempotencyKey: "upload-key-12345678",
    });
    await deletePublisherDocument("issue /1", "document /1");

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/v1/publisher-companies/company%20%2F1/subscriptions",
      "/v1/publisher-companies/company%20%2F1/subscriptions",
      "/v1/publisher-subscriptions/subscription%20%2F1/issues",
      "/v1/publisher-subscriptions/subscription%20%2F1/issues",
      "/v1/publisher-issues/issue%20%2F1",
      "/v1/publisher-issues/issue%20%2F1",
      "/v1/publisher-issues/issue%20%2F1/publish",
      "/v1/publisher-issues/issue%20%2F1/schedule",
      "/v1/publisher-issues/issue%20%2F1/documents",
      "/v1/publisher-issues/issue%20%2F1/documents/document%20%2F1",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      name: subscription.name,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      title: issue.title,
      publicationAt: null,
      historical: false,
    });
    expect(fetchMock.mock.calls[5]?.[1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[6]?.[1]?.body).toBeUndefined();
    const uploadHeaders = new Headers(fetchMock.mock.calls[8]?.[1]?.headers);
    expect(uploadHeaders.get("content-type")).toBe("application/pdf");
    expect(uploadHeaders.get("idempotency-key")).toBe("upload-key-12345678");
    expect(uploadHeaders.get("x-brief-title")).toBe("Main PDF");
    expect(uploadHeaders.get("x-file-name")).toBe("main.pdf");
    expect(fetchMock.mock.calls[9]?.[1]?.body).toBeUndefined();
  });

  it("rejects malformed response descriptors at the boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ subscriptions: [{ id: 1 }] })),
    );
    await expect(listPublisherSubscriptions("company-1")).rejects.toBeDefined();
  });

  it("uses canonical archive offset cursors and exact notification preference bodies", async () => {
    const archiveSubscriptionId = "123e4567-e89b-12d3-a456-426614174002";
    const archiveItem = {
      sourceKind: "publisher",
      issueId: issue.id,
      subscriptionId: subscription.id,
      subscriptionName: subscription.name,
      publisherName: "Publisher",
      issueTitle: issue.title,
      publicationAt: "2026-07-10T00:00:00.000Z",
      deliveredAt: "2026-07-10T00:01:00.000Z",
      documentId: "document-1",
      documentTitle: "Main PDF",
      snippet: "matched text",
      contentPath: `/v1/issues/${issue.id}/documents/document-1/content`,
      mediaType: "application/pdf",
      canonicalUrl: null,
    } as const;
    const notification = {
      id: "notification-1",
      kind: "issue_published",
      issueId: issue.id,
      accessId: "access-1",
      createdAt: issue.createdAt,
      readAt: null,
    } as const;
    const preferences = {
      locale: "en-US",
      emailIssuePublished: true,
      emailDeliveryReminders: true,
      emailUsageLimits: false,
    } as const;
    const document = {
      id: archiveItem.documentId,
      issueId: issue.id,
      title: archiveItem.documentTitle,
      originalFileName: "main.pdf",
      mediaType: "application/pdf",
      byteSize: 3,
      sha256Hex: "a".repeat(64),
      createdAt: issue.createdAt,
    } as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ items: [archiveItem], nextCursor: "MjU=" }))
      .mockResolvedValueOnce(
        Response.json({
          issue: {
            ...issue,
            status: "published",
            publicationAt: archiveItem.publicationAt,
            publishedAt: archiveItem.publicationAt,
            indexingStatus: "ready",
          },
          documents: [document],
        }),
      )
      .mockResolvedValueOnce(Response.json({ notifications: [notification], nextCursor: null }))
      .mockResolvedValueOnce(Response.json({ status: "read", readAt: issue.createdAt }))
      .mockResolvedValueOnce(Response.json({ preferences }))
      .mockResolvedValueOnce(Response.json({ preferences }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listClientArchive("company /1", {
        query: "  regulation  ",
        source: { kind: "publisher", subscriptionId: archiveSubscriptionId },
        cursor: "MjU=",
        limit: 50,
      }),
    ).resolves.toEqual({ items: [archiveItem], nextCursor: "MjU=" });
    await expect(getIssueDetail("issue /1")).resolves.toMatchObject({ documents: [document] });
    await expect(listNotifications("company /1")).resolves.toEqual({
      notifications: [notification],
      nextCursor: null,
    });
    await markNotificationRead("notification /1");
    await expect(getNotificationPreferences("company /1")).resolves.toEqual(preferences);
    await updateNotificationPreferences("company /1", preferences);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/v1/client-companies/company%20%2F1/archive?limit=50&q=regulation&sourceKind=publisher&sourceId=${archiveSubscriptionId}&cursor=MjU%3D`,
    );
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toEqual(preferences);
  });

  it("discovers every accepted publisher and client workspace", async () => {
    const response = {
      publisherWorkspaces: [
        {
          kind: "publisher",
          companyId: "publisher-1",
          companyName: "Publisher One",
          role: "manager",
          landingPath: "/publisher/publisher-1",
        },
      ],
      clientWorkspaces: [
        {
          kind: "client",
          companyId: "client-1",
          companyName: "Client One",
          role: "admin",
          landingPath: "/client/client-1",
        },
      ],
    } as const;
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCurrentUserWorkspaces()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/me/workspaces",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });
});

describe("platform operations API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setApiTokenProvider(async () => null);
  });

  it("decodes content-free issue operations and sends exact restriction mutations", async () => {
    const operations = {
      role: "security",
      overview: {
        publisherCompanies: 1,
        clientCompanies: 2,
        subscriptions: 3,
        currentAccesses: 4,
        issues: 5,
        notificationFailures: 6,
        aiRuns: 7,
        modelInputTokens: 8,
        modelOutputTokens: 9,
        webOperations: 10,
        creditsConsumed: 11,
      },
      publishedIssues: [
        {
          issueId: "issue-1",
          publisherCompanyId: "publisher-1",
          subscriptionId: "subscription-1",
          publishedAt: "2026-07-10T10:00:00.000Z",
          indexingStatus: "ready",
          indexingErrorCode: null,
          restrictedAt: null,
          restrictedReason: null,
        },
      ],
    } as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json(operations))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPlatformOperations()).resolves.toEqual(operations);
    await restrictPlatformIssue("issue /1", "Confirmed security containment");
    await removePlatformIssueRestriction("issue /1");

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/v1/platform/operations",
      "/v1/platform/issues/issue%20%2F1/restriction",
      "/v1/platform/issues/issue%20%2F1/restriction",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      reason: "Confirmed security containment",
    });
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("DELETE");
  });

  it("lists active grants without content and opens content only through the audited endpoint", async () => {
    const grants = {
      grants: [
        {
          id: "grant-1",
          reason: "Customer support request",
          scopeKind: "publisher_text",
          scopeId: "version-1",
          expiresAt: "2026-07-10T12:00:00.000Z",
          customerApprovalReference: "ticket-42",
          approvalSkippedReason: null,
        },
      ],
    } as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json(grants))
      .mockResolvedValueOnce(
        Response.json({
          accessLogId: "log-1",
          scopeKind: "publisher_text",
          content: {
            id: "version-1",
            language: "en",
            canonicalText: "restricted content",
            pageRanges: [],
          },
        }),
      );
    const replace = vi.fn();
    const close = vi.fn();
    const target = { opener: {} as unknown, location: { replace }, close };
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      open: vi.fn(() => target),
      setTimeout: vi.fn(),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:scoped-support-content");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    await expect(listActiveRestrictedSupportGrants()).resolves.toEqual(grants);
    await openRestrictedSupportGrantContent("grant /1");

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/v1/platform/support/grants",
      "/v1/platform/support/grants/grant%20%2F1/content",
    ]);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("x-request-id")).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    expect(replace).toHaveBeenCalledWith("blob:scoped-support-content");
    expect(close).not.toHaveBeenCalled();
  });

  it("does not access restricted content when the explicit view cannot be opened", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { open: vi.fn(() => null) });

    await expect(openRestrictedSupportGrantContent("grant-1")).rejects.toMatchObject({
      code: "support_content_popup_blocked",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("workspace team API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiTokenProvider(async () => null);
  });

  it("uses email-first invitations and exact publisher/client access contracts", async () => {
    const publisherMember = {
      userId: "publisher-user",
      role: "manager",
      invitedEmail: "publisher@example.com",
      acceptedAt: "2026-07-10T10:00:00.000Z",
      subscriptionIds: ["subscription-1"],
    } as const;
    const publisherInvitation = {
      id: "publisher-invitation-1",
      email: "next-publisher@example.com",
      role: "member",
      subscriptionIds: ["subscription-1"],
      state: "pending",
      expiresAt: "2026-07-17T10:00:00.000Z",
      createdAt: "2026-07-10T10:00:00.000Z",
    } as const;
    const clientMember = {
      userId: "client-user",
      role: "member",
      subscriptionAccessIds: ["access-1"],
    } as const;
    const clientInvitation = {
      id: "client-invitation-1",
      email: "next-client@example.com",
      role: "admin",
      subscriptionAccessIds: ["access-1"],
      state: "pending",
      expiresAt: "2026-07-17T10:00:00.000Z",
      createdAt: "2026-07-10T10:00:00.000Z",
    } as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json({ members: [publisherMember], invitations: [publisherInvitation] }),
      )
      .mockResolvedValueOnce(Response.json({ invitation: publisherInvitation }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ status: "updated" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ members: [clientMember], invitations: [clientInvitation] }),
      )
      .mockResolvedValueOnce(Response.json({ invitation: clientInvitation }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ status: "updated" }))
      .mockResolvedValueOnce(Response.json({ status: "granted" }, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPublisherMembers("publisher /1")).resolves.toEqual({
      members: [publisherMember],
      invitations: [publisherInvitation],
    });
    await invitePublisherMember("publisher /1", {
      email: publisherInvitation.email,
      role: publisherInvitation.role,
      subscriptionIds: publisherInvitation.subscriptionIds,
    });
    await updatePublisherMember("publisher /1", publisherMember.userId, {
      role: "admin",
      subscriptionIds: [],
    });
    await deletePublisherMember("publisher /1", publisherMember.userId);
    await expect(listClientMembers("client /1")).resolves.toEqual({
      members: [clientMember],
      invitations: [clientInvitation],
    });
    await inviteClientMember("client /1", {
      email: clientInvitation.email,
      role: clientInvitation.role,
      subscriptionAccessIds: clientInvitation.subscriptionAccessIds,
    });
    await updateClientMember("client /1", clientMember.userId, "admin");
    await setClientMemberSubscriptionGrant("client /1", clientMember.userId, "access /1", true);
    await setClientMemberSubscriptionGrant("client /1", clientMember.userId, "access /1", false);
    await deleteClientMember("client /1", clientMember.userId);

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/v1/publisher-companies/publisher%20%2F1/members",
      "/v1/publisher-companies/publisher%20%2F1/members",
      "/v1/publisher-companies/publisher%20%2F1/members/publisher-user",
      "/v1/publisher-companies/publisher%20%2F1/members/publisher-user",
      "/v1/client-companies/client%20%2F1/members",
      "/v1/client-companies/client%20%2F1/members",
      "/v1/client-companies/client%20%2F1/members/client-user",
      "/v1/client-companies/client%20%2F1/members/client-user/subscription-grants",
      "/v1/client-companies/client%20%2F1/members/client-user/subscription-grants/access%20%2F1",
      "/v1/client-companies/client%20%2F1/members/client-user",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      email: publisherInvitation.email,
      role: "member",
      subscriptionIds: ["subscription-1"],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toEqual({
      email: clientInvitation.email,
      role: "admin",
      subscriptionAccessIds: ["access-1"],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[7]?.[1]?.body))).toEqual({
      accessId: "access /1",
    });
    expect(fetchMock.mock.calls[8]?.[1]?.body).toBeUndefined();
  });
});

describe("client AI billing API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiTokenProvider(async () => null);
  });

  it("decodes usage and sends exact checkout, limit, and request contracts", async () => {
    const request = {
      id: "request-1",
      userId: "client-user",
      requestedCredits: 500,
      reason: "Quarterly archive review",
      status: "pending",
      createdAt: "2026-07-10T10:00:00.000Z",
      resolvedAt: null,
    } as const;
    const usage = {
      status: "active",
      planTier: "team",
      pendingDowngradeTier: null,
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
      companyMonthlyLimit: 5000,
      companyUsedCredits: 1200,
      availableCredits: 8800,
      employees: [{ userId: "client-user", usedCredits: 1200, monthlyLimit: 2000 }],
      requests: [request],
    } as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ usage }))
      .mockResolvedValueOnce(
        Response.json({ url: "https://checkout.stripe.test/monthly" }, { status: 201 }),
      )
      .mockResolvedValueOnce(
        Response.json({ url: "https://checkout.stripe.test/additional" }, { status: 201 }),
      )
      .mockResolvedValueOnce(
        Response.json({ url: "https://billing.stripe.test/portal" }, { status: 201 }),
      )
      .mockResolvedValueOnce(Response.json({ status: "updated" }))
      .mockResolvedValueOnce(Response.json({ status: "updated" }))
      .mockResolvedValueOnce(Response.json({ request }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ status: "approved" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getClientAiUsage("client /1")).resolves.toEqual(usage);
    await expect(
      createBillingCheckout("client /1", {
        kind: "monthly",
        planTier: "team",
        idempotencyKey: "checkout-web-monthly",
      }),
    ).resolves.toBe("https://checkout.stripe.test/monthly");
    await createBillingCheckout("client /1", {
      kind: "additional",
      credits: 2500,
      idempotencyKey: "checkout-web-additional",
    });
    await expect(createBillingPortal("client /1")).resolves.toBe(
      "https://billing.stripe.test/portal",
    );
    await updateCompanyAiLimit("client /1", null);
    await updateEmployeeAiLimit("client /1", "user /1", 2000);
    await createAiUsageRequest("client /1", {
      requestedCredits: request.requestedCredits,
      reason: request.reason,
    });
    await resolveAiUsageRequest("client /1", "request /1", "approved");

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/v1/client-companies/client%20%2F1/ai-usage",
      "/v1/client-companies/client%20%2F1/billing/checkout",
      "/v1/client-companies/client%20%2F1/billing/checkout",
      "/v1/client-companies/client%20%2F1/billing/portal",
      "/v1/client-companies/client%20%2F1/ai-limit",
      "/v1/client-companies/client%20%2F1/members/user%20%2F1/ai-limit",
      "/v1/client-companies/client%20%2F1/ai-usage-requests",
      "/v1/client-companies/client%20%2F1/ai-usage-requests/request%20%2F1/resolve",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      kind: "monthly",
      planTier: "team",
      idempotencyKey: "checkout-web-monthly",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      kind: "additional",
      credits: 2500,
      idempotencyKey: "checkout-web-additional",
    });
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      companyMonthlyLimit: null,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toEqual({ monthlyLimit: 2000 });
    expect(JSON.parse(String(fetchMock.mock.calls[7]?.[1]?.body))).toEqual({
      decision: "approved",
    });
  });

  it("rejects non-HTTPS billing navigation returned by the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ url: "http://attacker.test/checkout" }, { status: 201 })),
    );
    await expect(
      createBillingCheckout("client-1", {
        kind: "monthly",
        planTier: "light",
        idempotencyKey: "checkout-web-invalid-url",
      }),
    ).rejects.toMatchObject({ code: "billing_navigation_invalid" });
  });

  it("sends an exact idempotent plan-change contract and decodes its discriminated outcome", async () => {
    const change = {
      status: "downgrade_scheduled",
      previousTier: "intensive",
      planTier: "team",
      effectiveAt: "2026-08-01T00:00:00.000Z",
    } as const;
    const fetchMock = vi.fn(async () => Response.json({ change }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      changeClientMonthlyPlan("client /1", {
        planTier: "team",
        idempotencyKey: "monthly-plan-0001",
      }),
    ).resolves.toEqual(change);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/client-companies/client%20%2F1/billing/plan-change",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ planTier: "team", idempotencyKey: "monthly-plan-0001" }),
      }),
    );

    await expect(
      changeClientMonthlyPlan("client-1", {
        planTier: "light",
        idempotencyKey: "short",
      }),
    ).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("client company export API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setApiTokenProvider(async () => null);
  });

  it("creates, polls, and explicitly downloads an authorized company export", async () => {
    const queued = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      scopeKind: "client_company",
      scopeId: "123e4567-e89b-12d3-a456-426614174001",
      status: "queued",
      createdAt: "2026-07-10T10:00:00.000Z",
      completedAt: null,
      expiresAt: null,
      errorCode: null,
      downloadPath: null,
    } as const;
    const completed = {
      ...queued,
      status: "completed",
      completedAt: "2026-07-10T10:01:00.000Z",
      expiresAt: "2026-07-11T10:01:00.000Z",
      downloadPath: `/v1/exports/${queued.id}/download`,
    } as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ export: queued, duplicate: false }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ export: completed }))
      .mockResolvedValueOnce(redirectedResponse(testUstarArchive(), EXPORT_ARCHIVE_MEDIA_TYPE));
    const replace = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      open: vi.fn(() => ({ opener: {}, location: { replace }, close: vi.fn() })),
      setTimeout: vi.fn(),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:company-export");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    await expect(
      createClientCompanyExport(queued.scopeId, "export-request-00000001"),
    ).resolves.toEqual(queued);
    await expect(getProductExport(queued.id)).resolves.toEqual(completed);
    await openProductExportDownload(completed.downloadPath);

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/v1/exports",
      `/v1/exports/${queued.id}`,
      completed.downloadPath,
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      scopeKind: "client_company",
      scopeId: queued.scopeId,
      idempotencyKey: "export-request-00000001",
    });
    expect(replace).toHaveBeenCalledWith("blob:company-export");
  });

  it("rejects an untrusted export download path before opening a window", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    await expect(openProductExportDownload("https://attacker.test/export")).rejects.toMatchObject({
      code: "export_download_path_invalid",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("requests a personal chat export without exposing a user ID", async () => {
    const request = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      scopeKind: "user_chats",
      scopeId: "me",
      status: "queued",
      createdAt: "2026-07-10T10:00:00.000Z",
      completedAt: null,
      expiresAt: null,
      errorCode: null,
      downloadPath: null,
    } as const;
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => Response.json({ export: request, duplicate: false }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createUserChatsExport("user-chat-export:00000001")).resolves.toEqual(request);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      scopeKind: "user_chats",
      scopeId: "me",
      idempotencyKey: "user-chat-export:00000001",
    });
  });
});

describe("client company settings API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiTokenProvider(async () => null);
  });

  it("reads and updates canonical web policy and request-only company deletion", async () => {
    const policy = { enabled: false, allowedDomains: ["example.com"] } as const;
    const normalizedPolicy = {
      enabled: true,
      allowedDomains: ["example.com", "public-authority.eu"],
    } as const;
    const deletion = {
      id: "deletion-1",
      status: "requested",
      requestedAt: "2026-07-10T10:00:00.000Z",
      resolvedAt: null,
    } as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ settings: policy }))
      .mockResolvedValueOnce(Response.json({ settings: normalizedPolicy }))
      .mockResolvedValueOnce(Response.json({ requests: [] }))
      .mockResolvedValueOnce(Response.json({ requests: [deletion] }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getClientWebPolicy("client /1")).resolves.toEqual(policy);
    await expect(
      updateClientWebPolicy("client /1", {
        enabled: true,
        allowedDomains: ["PUBLIC-AUTHORITY.EU.", "example.com"],
      }),
    ).resolves.toEqual(normalizedPolicy);
    await expect(listCompanyDeletionRequests("client /1")).resolves.toEqual([]);
    await expect(
      requestCompanyDeletion("client /1", {
        reason: "Company is ending its Brief account",
        idempotencyKey: "company-deletion:00000001",
      }),
    ).resolves.toEqual([deletion]);

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/v1/client-companies/client%20%2F1/web-policy",
      "/v1/client-companies/client%20%2F1/web-policy",
      "/v1/client-companies/client%20%2F1/deletion-requests",
      "/v1/client-companies/client%20%2F1/deletion-requests",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      enabled: true,
      allowedDomains: ["PUBLIC-AUTHORITY.EU.", "example.com"],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      reason: "Company is ending its Brief account",
      idempotencyKey: "company-deletion:00000001",
    });
  });

  it("rejects malformed policy state at the decoding boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ settings: { enabled: "yes", allowedDomains: null } })),
    );
    await expect(getClientWebPolicy("client-1")).rejects.toBeDefined();
  });
});

describe("publisher client lifecycle and aggregate metrics API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiTokenProvider(async () => null);
  });

  it("uses exact invite, pause, and content-free pull metric contracts", async () => {
    const access = {
      id: "access-1",
      subscriptionId: "subscription-1",
      clientCompanyId: "client-1",
      clientCompanyName: "Client One",
      state: "active",
      firstAdminEmail: "admin@client.test",
      employeeCount: 3,
      invitedAt: "2026-07-01T10:00:00.000Z",
      acceptedAt: "2026-07-01T11:00:00.000Z",
      subscribedAt: "2026-07-01T11:00:00.000Z",
      deliveryEndAt: null,
    } as const;
    const metrics = [
      {
        issueId: "issue-1",
        documentId: "document-1",
        runPullCount: 4,
        visibleTokenCount: 1200,
      },
    ] as const;
    const issueTotals = [{ issueId: "issue-1", runPullCount: 3 }] as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ accesses: [access] }))
      .mockResolvedValueOnce(Response.json({ access, duplicate: false }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({
          status: "ending",
          deliveryEndAt: "2026-08-01T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(Response.json({ metrics, issueTotals }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPublisherClientAccesses("subscription /1")).resolves.toEqual([access]);
    await invitePublisherClientAccess("subscription /1", {
      clientCompanyName: access.clientCompanyName,
      firstAdminEmail: access.firstAdminEmail,
      idempotencyKey: "publisher-client:00000001",
    });
    await expect(pausePublisherClientAccess("access /1", null)).resolves.toBe(
      "2026-08-01T00:00:00.000Z",
    );
    await expect(getPublisherAiPullMetrics("subscription /1")).resolves.toEqual({
      metrics,
      issueTotals,
    });

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/v1/publisher-subscriptions/subscription%20%2F1/client-accesses",
      "/v1/publisher-subscriptions/subscription%20%2F1/client-accesses",
      "/v1/client-subscription-accesses/access%20%2F1/pause",
      "/v1/publisher-subscriptions/subscription%20%2F1/ai-pull-metrics",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      clientCompanyName: "Client One",
      firstAdminEmail: "admin@client.test",
      idempotencyKey: "publisher-client:00000001",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      deliveryEndAt: null,
    });
  });
});

describe("publisher onboarding and export API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiTokenProvider(async () => null);
  });

  it("uses idempotent platform onboarding and publisher export contracts", async () => {
    const onboarding = {
      companyId: "123e4567-e89b-12d3-a456-426614174001",
      companyName: "Publisher One",
      firstAdminEmail: "admin@publisher.test",
      invitationState: "pending",
    } as const;
    const exportRequest = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      scopeKind: "publisher_company",
      scopeId: onboarding.companyId,
      status: "queued",
      createdAt: "2026-07-10T10:00:00.000Z",
      completedAt: null,
      expiresAt: null,
      errorCode: null,
      downloadPath: null,
    } as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ onboarding, duplicate: false }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ export: exportRequest, duplicate: false }, { status: 202 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createPublisherCompanyOnboarding({
        companyName: onboarding.companyName,
        firstAdminEmail: onboarding.firstAdminEmail,
        idempotencyKey: "publisher-onboarding:00000001",
      }),
    ).resolves.toEqual(onboarding);
    await expect(
      createPublisherCompanyExport(onboarding.companyId, "publisher-export:00000001"),
    ).resolves.toEqual(exportRequest);

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/v1/platform/publisher-companies",
      "/v1/exports",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      companyName: "Publisher One",
      firstAdminEmail: "admin@publisher.test",
      idempotencyKey: "publisher-onboarding:00000001",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      scopeKind: "publisher_company",
      scopeId: onboarding.companyId,
      idempotencyKey: "publisher-export:00000001",
    });
  });
});
