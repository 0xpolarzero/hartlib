import { describe, expect, it, vi } from "vitest";

import { canonicalizeSourceCanonicalUrl, makeSourcePolicyFetcher } from "./source-url-policy";
import type { FetchResponse, PublicSourceDefinition } from "./types";

const definition = {
  id: "assemblee_nationale",
  displayName: "Assemblée nationale",
  publisherName: "Assemblée nationale",
  description: "Official documents",
  country: "FR",
  language: "fr-FR",
  ingestionMethod: "official_document",
  discoveryUrl: "https://feed.example.test/rss",
  canonicalUrlOrigins: ["https://www.example.test"],
  fetchOrigins: ["https://feed.example.test", "https://www.example.test"],
  contentFormats: ["html"],
  averageCharsPerItem: 100,
} as const satisfies PublicSourceDefinition;

const response = (url: string, status: number, location?: string): FetchResponse => ({
  url,
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(location ? { location } : {}),
  text: async () => "body",
});

describe("source URL policy", () => {
  it("accepts only exact configured canonical origins", () => {
    expect(canonicalizeSourceCanonicalUrl(definition, "https://www.example.test/doc")).toBe(
      "https://www.example.test/doc",
    );
    expect(canonicalizeSourceCanonicalUrl(definition, "https://evil.example.test/doc")).toBeNull();
    expect(
      canonicalizeSourceCanonicalUrl(definition, "https://www.example.test.evil/doc"),
    ).toBeNull();
  });

  it("authorizes every redirect before following it", async () => {
    let redirectBodyCancelled = false;
    const redirectResponse = {
      ...response("https://feed.example.test/rss", 302, "https://www.example.test/doc"),
      body: new ReadableStream<Uint8Array>({
        cancel() {
          redirectBodyCancelled = true;
        },
      }),
    } satisfies FetchResponse;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse)
      .mockResolvedValueOnce(response("https://www.example.test/doc", 200));
    const secured = makeSourcePolicyFetcher(definition, fetcher);

    await expect(secured("https://feed.example.test/rss")).resolves.toMatchObject({ status: 200 });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://feed.example.test/rss",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://www.example.test/doc",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(redirectBodyCancelled).toBe(true);
  });

  it("does not contact an unconfigured redirect target", async () => {
    let redirectBodyCancelled = false;
    const fetcher = vi.fn().mockResolvedValueOnce({
      ...response("https://feed.example.test/rss", 302, "https://127.0.0.1/metadata"),
      body: new ReadableStream<Uint8Array>({
        cancel() {
          redirectBodyCancelled = true;
        },
      }),
    } satisfies FetchResponse);
    const secured = makeSourcePolicyFetcher(definition, fetcher);

    await expect(secured("https://feed.example.test/rss")).rejects.toThrow(
      "outside the configured HTTPS origins",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(redirectBodyCancelled).toBe(true);
  });

  it("rejects an auto-following custom fetcher's disallowed final URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(response("https://evil.example.test/doc", 200));
    const secured = makeSourcePolicyFetcher(definition, fetcher);

    await expect(secured("https://feed.example.test/rss")).rejects.toThrow(
      "outside the configured HTTPS origins",
    );
  });

  it("rejects an auto-following custom fetcher that omits its final URL", async () => {
    let bodyCancelled = false;
    const fetcher = vi.fn().mockResolvedValue({
      ...response("", 200),
      body: new ReadableStream<Uint8Array>({
        cancel() {
          bodyCancelled = true;
        },
      }),
    } satisfies FetchResponse);
    const secured = makeSourcePolicyFetcher(definition, fetcher);

    await expect(secured("https://feed.example.test/rss")).rejects.toThrow("omitted its final URL");
    expect(bodyCancelled).toBe(true);
  });
});
