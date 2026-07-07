import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ingestDiscoveredItem } from "./ingest";
import { makePublicSourceAdapter } from "./registry";
import { publicSourceDefinitions } from "./source-catalog";
import type { PublicSourceId } from "./types";

const env =
  (
    globalThis as unknown as {
      readonly Bun?: { readonly env: Record<string, string | undefined> };
      readonly process?: { readonly env: Record<string, string | undefined> };
    }
  ).Bun?.env ??
  (
    globalThis as unknown as {
      readonly process?: { readonly env: Record<string, string | undefined> };
    }
  ).process?.env ??
  {};

const liveEnabled = env.PUBLIC_SOURCE_LIVE_CONTRACT_TESTS === "1";
const liveDescribe = liveEnabled ? describe : describe.skip;

const sampleSize = Number.parseInt(env.PUBLIC_SOURCE_LIVE_SAMPLE_SIZE ?? "3", 10);

const sourceExpectations = {
  service_public: {
    minTextChars: 250,
    rawBodyIncludes: "<html",
    metadataKey: "xmlUrl",
  },
  bofip_impots: {
    minTextChars: 250,
    rawBodyIncludes: "<",
    metadataKey: "externalId",
  },
  tresor: {
    minTextChars: 250,
    rawBodyIncludes: "<",
    metadataKey: "embeddedFeedContent",
  },
  assemblee_nationale: {
    minTextChars: 250,
    rawBodyIncludes: "<",
    metadataKey: "fetchedContentUrl",
  },
} as const satisfies Record<
  PublicSourceId,
  {
    readonly minTextChars: number;
    readonly rawBodyIncludes: string;
    readonly metadataKey: string;
  }
>;

liveDescribe("live public source contracts", () => {
  it.each(publicSourceDefinitions)(
    "$id provides current official content that can be fetched, normalized, and stored",
    async (definition) => {
      const adapter = makePublicSourceAdapter(definition.id);
      const discovery = await Effect.runPromise(adapter.discover());

      expect(discovery.status).toBe("fetched");
      if (discovery.status !== "fetched") {
        throw new Error(`${definition.id} returned not_modified without local validators`);
      }
      expect(discovery.items.length).toBeGreaterThan(0);

      const sampled = discovery.items.slice(0, sampleSize);
      expect(sampled.length).toBeGreaterThan(0);

      for (const item of sampled) {
        const result = await Effect.runPromise(ingestDiscoveredItem(adapter, item));
        expect(result.status).toBe("ingested");
        if (result.status !== "ingested") {
          throw new Error(`${definition.id} failed to ingest ${item.canonicalUrl}`);
        }

        const expectation = sourceExpectations[definition.id];
        expect(result.raw.body).toContain(expectation.rawBodyIncludes);
        expect(result.raw.mediaType.toLowerCase()).toMatch(/html|pdf/u);
        expect(result.document.textCharCount).toBeGreaterThanOrEqual(expectation.minTextChars);
        expect(result.document.text).not.toMatch(
          /\b(this website requires js enabled|enable javascript and cookies|security verification|captcha|access denied)\b/iu,
        );
        expect(result.document.contentHash).toMatch(/^[a-f0-9]{64}$/);
        expect(result.document.rawArtifactKey).toBe(
          `${definition.id}/${result.document.contentHash}`,
        );
        expect(result.document.sourceMetadata).toHaveProperty(expectation.metadataKey);
        expect(result.document.sourceMetadata).toMatchObject({
          ingestionMethod: definition.ingestionMethod,
          contentFormats: definition.contentFormats,
        });
      }
    },
    120_000,
  );
});
