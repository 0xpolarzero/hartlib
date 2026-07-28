import { EXPORT_ARCHIVE_MEDIA_TYPE } from "@brief/shared/export-contract";
import { describe, expect, it, vi } from "vitest";

import { createPlatformApiClient } from "./platform-client";
import type { Fetch } from "./transport";

const redirectedExport = (contentType: string): Response => {
  const archive = new Uint8Array(2048);
  archive.set(new TextEncoder().encode("ustar"), 257);
  const response = new Response(Uint8Array.from(archive).buffer, {
    status: 200,
    headers: { "content-type": contentType },
  });
  Object.defineProperty(response, "redirected", { value: true });
  return response;
};

describe("platform export download contract", () => {
  it("requests and accepts only the canonical deterministic ustar representation", async () => {
    const responses = [
      redirectedExport(EXPORT_ARCHIVE_MEDIA_TYPE),
      redirectedExport("application/zip"),
    ];
    const fetch = vi.fn<Fetch>(async () => responses.shift()!);
    const client = createPlatformApiClient({ fetch });
    const downloadPath = "/v1/exports/123e4567-e89b-42d3-a456-426614174000/download";

    const response = await client.getProductExportDownload(downloadPath);
    expect(response.headers.get("content-type")).toBe(EXPORT_ARCHIVE_MEDIA_TYPE);
    expect(new TextDecoder().decode((await response.arrayBuffer()).slice(257, 262))).toBe("ustar");
    const requestHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("accept")).toBe(EXPORT_ARCHIVE_MEDIA_TYPE);
    await expect(client.getProductExportDownload(downloadPath)).rejects.toMatchObject({
      code: "invalid_response_media_type",
    });
  });
});

describe("notification preference contract", () => {
  it("round-trips the independently selected email locale", async () => {
    const preferences = {
      locale: "en-US",
      emailIssuePublished: true,
      emailDeliveryReminders: false,
      emailUsageLimits: true,
    } as const;
    const fetch = vi.fn<Fetch>(async () => Response.json({ preferences }));
    const client = createPlatformApiClient({ fetch });

    await expect(client.updateNotificationPreferences("company-1", preferences)).resolves.toEqual(
      preferences,
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(preferences);
  });

  it("rejects an unsupported locale returned by the API", async () => {
    const fetch = vi.fn<Fetch>(async () =>
      Response.json({
        preferences: {
          locale: "de-DE",
          emailIssuePublished: true,
          emailDeliveryReminders: true,
          emailUsageLimits: true,
        },
      }),
    );
    const client = createPlatformApiClient({ fetch });
    await expect(client.getNotificationPreferences("company-1")).rejects.toMatchObject({
      code: "invalid_response_body",
    });
  });
});

describe("publisher issue detail contract", () => {
  it("uses the publisher issue route", async () => {
    const issue = {
      id: "issue-1",
      subscriptionId: "subscription-1",
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
    const fetch = vi.fn<Fetch>(async () => Response.json({ issue, documents: [] }));
    const client = createPlatformApiClient({ fetch });

    await expect(client.getPublisherIssue("issue /1")).resolves.toEqual({
      issue,
      documents: [],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("/v1/publisher-issues/issue%20%2F1");
  });
});
