import { lookup } from "node:dns/promises";

import { describe, expect, it } from "vitest";

import type { EffectiveWebPolicy } from "../runtime/types";
import { safeFetchPage } from "./safe-fetch";
import { searchTinyfishWeb } from "./tinyfish-search";

const enabledPolicy: EffectiveWebPolicy = {
  enabled: true,
  provider: "tinyfish",
  allowedDomains: ["example.com"],
};

describe.skipIf(process.env.WEB_BOUNDARY_LIVE_CONTRACT_TESTS !== "1")(
  "live DNS-pinned page transport",
  () => {
    it("performs an HTTPS request through the production resolver and pinned TLS transport", async () => {
      const page = await safeFetchPage("https://example.com/", {
        acceptedPolicy: enabledPolicy,
        loadCurrentPolicy: async () => enabledPolicy,
      });
      expect(page).toMatchObject({
        canonicalUrl: "https://example.com/",
        domain: "example.com",
        mediaType: "text/html",
        operation: { kind: "fetch", provider: "brief_fetch", outcome: "succeeded" },
      });
      expect(page.text.length).toBeGreaterThan(0);
    }, 15_000);

    it("connects through independently pinned public IPv4 and IPv6 answers", async () => {
      const addresses = await lookup("example.com", { all: true, verbatim: true });
      for (const family of [4, 6] as const) {
        const address = addresses.find((candidate) => candidate.family === family);
        expect(
          address,
          `example.com must expose an IPv${family} live-contract address`,
        ).toBeDefined();
        const page = await safeFetchPage("https://example.com/", {
          acceptedPolicy: enabledPolicy,
          loadCurrentPolicy: async () => enabledPolicy,
          resolve: async () => [address!],
        });
        expect(page.operation.outcome).toBe("succeeded");
      }
    }, 15_000);
  },
);

const tinyfishPolicy: EffectiveWebPolicy = {
  enabled: true,
  provider: "tinyfish",
  allowedDomains: ["docs.tinyfish.ai"],
};

describe.skipIf(
  process.env.RUN_TINYFISH_SEARCH_CONTRACT !== "1" ||
    (process.env.TINYFISH_API_KEY?.trim() ?? "") === "",
)("live Tinyfish Search boundary", () => {
  it("returns strictly decoded, site-scoped public discovery results", async () => {
    const response = await searchTinyfishWeb("Tinyfish Search API reference", 10, {
      apiKey: process.env.TINYFISH_API_KEY as string,
      locale: "en-US",
      market: "US",
      acceptedPolicy: tinyfishPolicy,
      loadCurrentPolicy: async () => tinyfishPolicy,
    });

    expect(response.operations).toEqual([
      expect.objectContaining({
        kind: "search",
        provider: "tinyfish",
        outcome: "succeeded",
      }),
    ]);
    expect(response.results.length).toBeGreaterThan(0);
    for (const result of response.results) {
      expect(result.url).toMatch(/^https:\/\//u);
      expect(
        result.domain === "docs.tinyfish.ai" || result.domain.endsWith(".docs.tinyfish.ai"),
      ).toBe(true);
      expect(result.providerRank).toBeGreaterThanOrEqual(1);
      expect("publishedAt" in result).toBe(false);
    }
  }, 15_000);
});
