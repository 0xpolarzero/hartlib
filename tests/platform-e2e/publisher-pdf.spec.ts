import { expect, test, type Response as PlaywrightResponse } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  makeE2ePublisherPdfClientOnly,
  readE2ePublisherPdfState,
  seedE2ePublisherDocumentCitation,
} from "../e2e/db";

const clientCompanyId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const fixturePath = fileURLToPath(
  new URL("../../apps/demo/public/demo/pdfs/atlas-energy-2026-05-market.pdf", import.meta.url),
);
const fixtureBytes = readFileSync(fixturePath);
const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
const documentTitle = "Atlas energy market PDF";
const objectStoreBaseUrl = process.env.BRIEF_E2E_OBJECT_STORE_BASE_URL ?? "http://127.0.0.1:43113";

const requiredWorkerJobsCompleted = (): boolean => {
  const state = readE2ePublisherPdfState();
  const requiredKinds = new Set([
    "extract_pdf_text",
    "normalize_searchable_text",
    "update_ai_indexing_status",
  ]);
  return (
    state.issue?.indexingStatus === "ready" &&
    state.documents.length === 1 &&
    state.documents[0]?.currentVersionId !== null &&
    state.documents[0]?.extractionCount === 1 &&
    [...requiredKinds].every((kind) =>
      state.jobs.some((job) => job.kind === kind && job.status === "completed"),
    )
  );
};

const publicationCompleted = (): boolean => {
  const state = readE2ePublisherPdfState();
  return (
    state.issue?.status === "published" &&
    state.issue.publishedAt !== null &&
    state.deliveryCount === 1 &&
    state.jobs.some((job) => job.kind === "publish_scheduled_issue" && job.status === "completed")
  );
};

const signedStorageResponse = (response: PlaywrightResponse): boolean => {
  if (response.request().method() !== "GET") return false;
  const url = new URL(response.url());
  return (
    response.url().startsWith(`${objectStoreBaseUrl}/`) &&
    url.pathname.startsWith("/brief-e2e/publisher-issues/") &&
    url.pathname.endsWith(".pdf")
  );
};

test("publisher uploads a real PDF and the delivered client opens the exact signed bytes", async ({
  page,
}) => {
  expect(fixtureBytes.subarray(0, 5).toString()).toBe("%PDF-");
  const initial = readE2ePublisherPdfState();
  expect(initial.publisherAccessActive).toBe(true);
  expect(initial.issue).toMatchObject({ status: "draft", indexingStatus: "pending" });
  expect(initial.documents).toEqual([]);

  await page.goto(
    `/en-US/publisher/${initial.fixture.publisherCompanyId}/issues/${initial.fixture.issueId}`,
  );
  await expect(
    page.getByRole("heading", { name: initial.fixture.issueTitle, exact: true }),
  ).toBeVisible();

  await page.locator("#publisher-document-title").fill(documentTitle);
  await page.locator("#publisher-document-file").setInputFiles(fixturePath);
  const uploadResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/v1/publisher-issues/${initial.fixture.issueId}/documents`),
  );
  await page.getByRole("button", { name: "Add a document" }).click();
  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status()).toBe(201);
  await expect(page.getByText(documentTitle, { exact: true })).toBeVisible();

  await expect
    .poll(requiredWorkerJobsCompleted, { timeout: 60_000, intervals: [250, 500, 1_000] })
    .toBe(true);
  const extracted = readE2ePublisherPdfState();
  expect(extracted.documents[0]).toMatchObject({
    originalFileName: "atlas-energy-2026-05-market.pdf",
    byteSize: fixtureBytes.byteLength,
    sha256Hex: fixtureSha256,
    extractionCount: 1,
    currentVersionId: expect.any(String),
  });
  expect(
    extracted.jobs.filter((job) =>
      ["extract_pdf_text", "normalize_searchable_text", "update_ai_indexing_status"].includes(
        job.kind,
      ),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "extract_pdf_text", status: "completed", lastError: null }),
      expect.objectContaining({
        kind: "normalize_searchable_text",
        status: "completed",
        lastError: null,
      }),
      expect.objectContaining({
        kind: "update_ai_indexing_status",
        status: "completed",
        lastError: null,
      }),
    ]),
  );

  const publicationResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/v1/publisher-issues/${initial.fixture.issueId}/publish`),
  );
  await page.getByRole("button", { name: "Publish now" }).click();
  const publicationResponse = await publicationResponsePromise;
  expect(publicationResponse.status()).toBe(202);
  await expect
    .poll(publicationCompleted, { timeout: 60_000, intervals: [250, 500, 1_000] })
    .toBe(true);

  const published = readE2ePublisherPdfState();
  expect(published.issue).toMatchObject({ status: "published", indexingStatus: "ready" });
  expect(published.deliveryCount).toBe(1);

  // The demo identity performed the publisher upload. Remove that accepted
  // membership before the read so the content route can succeed only through
  // the delivered-client grant exercised below.
  makeE2ePublisherPdfClientOnly();
  expect(readE2ePublisherPdfState().publisherAccessActive).toBe(false);

  await page.goto(`/en-US/client/${clientCompanyId}`);
  const deliveredIssue = page.getByRole("heading", {
    name: initial.fixture.issueTitle,
    exact: true,
  });
  await expect(deliveredIssue).toBeVisible();
  const archiveItem = deliveredIssue.locator("xpath=ancestor::article");

  const contentPath = `/v1/issues/${initial.fixture.issueId}/documents/${published.documents[0]!.id}/content`;
  const redirectResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === contentPath &&
      response.status() === 302,
  );
  const signedResponses: Array<import("@playwright/test").Response> = [];
  const trackSignedResponse = (response: import("@playwright/test").Response) => {
    if (signedStorageResponse(response)) signedResponses.push(response);
  };
  page.context().on("response", trackSignedResponse);
  const storageResponsePromise = page.waitForResponse(signedStorageResponse);
  const popupPromise = page.waitForEvent("popup");
  await archiveItem.getByRole("button", { name: "Open PDF" }).click();
  const [popup, redirectResponse, storageResponse] = await Promise.all([
    popupPromise,
    redirectResponsePromise,
    storageResponsePromise,
  ]);

  expect(redirectResponse.headers()["cache-control"]).toBe("private, no-store");
  expect(redirectResponse.headers()["referrer-policy"]).toBe("no-referrer");
  expect(redirectResponse.request().redirectedTo()?.url()).toBe(storageResponse.url());
  expect(storageResponse.request().redirectedFrom()?.url()).toBe(redirectResponse.url());

  const signedUrl = new URL(storageResponse.url());
  expect(signedUrl.searchParams.get("X-Amz-Expires")).toBe("300");
  expect(signedUrl.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u);
  expect(signedUrl.searchParams.get("X-Amz-Credential")).toContain("brief-e2e-access-key");
  expect(signedUrl.searchParams.get("response-content-type")).toBe("application/pdf");
  expect(signedUrl.searchParams.get("response-content-disposition")).toBe(
    'inline; filename="atlas-energy-2026-05-market.pdf"',
  );
  const unsignedUrl = new URL(signedUrl);
  unsignedUrl.searchParams.delete("X-Amz-Signature");
  const tamperedUrl = new URL(signedUrl);
  tamperedUrl.searchParams.set("response-content-type", "text/html");
  const wrongCredentialUrl = new URL(signedUrl);
  wrongCredentialUrl.searchParams.set(
    "X-Amz-Credential",
    wrongCredentialUrl.searchParams
      .get("X-Amz-Credential")!
      .replace("brief-e2e-access-key", "wrong-access-key"),
  );
  for (const rejected of [
    await fetch(unsignedUrl),
    await fetch(tamperedUrl),
    await fetch(wrongCredentialUrl),
    await fetch(signedUrl, { method: "HEAD" }),
  ]) {
    expect(rejected.status).toBe(403);
    expect(await rejected.text()).toBe("");
  }
  expect(storageResponse.status()).toBe(200);
  expect(storageResponse.headers()["content-type"]).toBe("application/pdf");
  expect(storageResponse.headers()["cache-control"]).toBe("private, no-store");
  expect(await storageResponse.body()).toEqual(fixtureBytes);
  // Headless Chromium can leave the popup URL reported as about:blank for its
  // built-in PDF viewer. The second exact signed-object response proves that
  // the already-authorized popup navigation was issued and completed.
  await expect.poll(() => signedResponses.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const popupResponse = signedResponses.at(-1)!;
  expect(popupResponse.status()).toBe(200);
  expect(popupResponse.headers()["content-type"]).toBe("application/pdf");
  expect(popup.isClosed()).toBe(false);
  page.context().off("response", trackSignedResponse);
  await popup.close();

  const citation = seedE2ePublisherDocumentCitation();
  expect(citation.citationUrl).toBe(contentPath);
  await page.goto(`/en-US/chat/${citation.chatId}`);
  const citationLink = page.getByTestId("citation-reference").filter({ hasText: documentTitle });
  await expect(citationLink).toHaveAttribute("href", contentPath);

  // The stack intentionally runs on loopback HTTP, where the production
  // browser transport refuses to originate a Clerk bearer. Proxy only this
  // initial API hop with a representative bearer; the browser still owns the
  // resulting cross-origin redirect, which must not forward that header.
  const clerkBearer = "Bearer e2e-clerk-session-token";
  let apiHopAuthorization: string | null = null;
  await page.route(`**${contentPath}`, async (route) => {
    const apiHopHeaders = { ...route.request().headers(), authorization: clerkBearer };
    apiHopAuthorization = apiHopHeaders.authorization;
    const response = await route.fetch({
      headers: apiHopHeaders,
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  });

  const citationRedirectPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === contentPath &&
      response.status() === 302,
  );
  const citationSignedResponses: PlaywrightResponse[] = [];
  const trackCitationSignedResponse = (response: PlaywrightResponse) => {
    if (signedStorageResponse(response)) citationSignedResponses.push(response);
  };
  page.context().on("response", trackCitationSignedResponse);
  const citationStoragePromise = page.waitForResponse(signedStorageResponse);
  const citationPopupPromise = page.waitForEvent("popup");
  await citationLink.click();
  const [citationPopup, citationRedirect, citationStorage] = await Promise.all([
    citationPopupPromise,
    citationRedirectPromise,
    citationStoragePromise,
  ]);

  expect(citationRedirect.headers()["cache-control"]).toBe("private, no-store");
  expect(citationRedirect.headers()["referrer-policy"]).toBe("no-referrer");
  expect(apiHopAuthorization).toBe(clerkBearer);
  expect(citationRedirect.request().redirectedTo()?.url()).toBe(citationStorage.url());
  expect(citationStorage.status()).toBe(200);
  expect(citationStorage.headers()["content-type"]).toBe("application/pdf");
  expect(citationStorage.headers()["x-brief-e2e-authorization-received"]).toBe("absent");
  expect(citationStorage.request().headers()["authorization"]).toBeUndefined();
  expect(citationStorage.request().headers()["referer"]).toBeUndefined();
  expect(await citationStorage.body()).toEqual(fixtureBytes);
  await expect
    .poll(() => citationSignedResponses.length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2);
  for (const response of citationSignedResponses) {
    expect(response.headers()["x-brief-e2e-authorization-received"]).toBe("absent");
    expect(response.request().headers()["authorization"]).toBeUndefined();
    expect(response.request().headers()["referer"]).toBeUndefined();
  }
  expect(citationPopup.isClosed()).toBe(false);
  page.context().off("response", trackCitationSignedResponse);
  await citationPopup.close();
});
