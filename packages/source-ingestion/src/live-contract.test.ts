import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ingestDiscoveredItem } from "./ingest";
import { makePublicSourceAdapter } from "./registry";
import { publicSourceDefinitions } from "./source-catalog";
import type { DiscoveredItem, IngestedSourceItem, PublicSourceId, SourceAdapter } from "./types";

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

const parsedSampleSize = Number.parseInt(env.PUBLIC_SOURCE_LIVE_SAMPLE_SIZE ?? "3", 10);
const sampleSize = Number.isSafeInteger(parsedSampleSize)
  ? Math.min(Math.max(parsedSampleSize, 1), 10)
  : 3;
const LIVE_SAMPLE_SCAN_MAX = 50;

/**
 * Live feeds can put an official landing page or an empty PDF before useful
 * documents. Scan a bounded prefix and count only fully ingested documents
 * that satisfy the contract's 250-character requirement.
 */
const liveSampleScanLimit = (requestedSize: number): number =>
  Math.min(LIVE_SAMPLE_SCAN_MAX, Math.max(requestedSize, requestedSize * 4));

const collectValidLiveSamples = async (
  adapter: SourceAdapter,
  items: readonly DiscoveredItem[],
  requestedSize: number,
): Promise<readonly IngestedSourceItem[]> => {
  const samples: IngestedSourceItem[] = [];
  const scanLimit = Math.min(items.length, liveSampleScanLimit(requestedSize));
  for (let index = 0; index < scanLimit && samples.length < requestedSize; index += 1) {
    const item = items[index]!;
    try {
      const result = await Effect.runPromise(ingestDiscoveredItem(adapter, item));
      if (result.status === "ingested" && result.document.textCharCount >= 250) {
        samples.push(result);
      }
    } catch {
      // A failed/empty/short official representation is not a successful
      // sample. Continue through the bounded discovery prefix.
    }
  }
  return samples;
};

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

describe("bounded live source sampling", () => {
  it.each([
    [1, 4],
    [3, 12],
    [20, 50],
  ])("caps a requested sample size of %i at %i scanned items", (requested, expected) => {
    expect(liveSampleScanLimit(requested)).toBe(expected);
  });
});

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

      const sampled = await collectValidLiveSamples(adapter, discovery.items, sampleSize);
      expect(sampled).toHaveLength(sampleSize);

      for (const result of sampled) {
        const expectation = sourceExpectations[definition.id];
        const baseMediaType = result.raw.mediaType.split(";", 1)[0]?.trim().toLowerCase();
        expect(["text/html", "application/pdf"]).toContain(baseMediaType);
        if (baseMediaType === "application/pdf") {
          expect(result.raw.body).toBe("");
          expect(result.raw.bodyBytes?.subarray(0, 5)).toEqual(new TextEncoder().encode("%PDF-"));
        } else {
          expect(result.raw.body).toContain(expectation.rawBodyIncludes);
          expect(result.raw.bodyBytes).toBeUndefined();
        }
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
