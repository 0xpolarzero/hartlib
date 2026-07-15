import { Effect } from "effect";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runPublicSourceIngestionBatch } from "../source-ingestion/orchestrator";
import {
  InMemoryPublicSourceIngestionRepositoryLayer,
  makeInMemoryPublicSourceIngestionRepository,
} from "../source-ingestion/repository";
import {
  makeE2ePublicSourceAdapters,
  type E2ePublicSourceCorpusItem,
} from "./public-source-corpus";

const corpus = [
  {
    sourceId: "e2e-fr-energie",
    displayName: "E2E Energie France",
    publisherName: "Observatoire Energie",
    documentId: "e2e-fr-solaire-raccordements",
    title: "France solaire: raccordements acceleres",
    canonicalUrl: "https://e2e.example/fr/solaire-raccordements",
    publishedAt: "2026-07-01T08:00:00.000Z",
    text: "Le solaire francais progresse grace a des raccordements regionaux plus rapides. ".repeat(
      4,
    ),
  },
] as const satisfies readonly E2ePublicSourceCorpusItem[];

describe("local E2E public-source connector", () => {
  it("uses the worker discovery, fetch, normalize, and persistence pipeline", async () => {
    const now = new Date("2026-07-04T08:00:00.000Z");
    const state = {
      sources: new Map(),
      candidates: new Map(),
      items: new Map(),
      rawArtifacts: new Map(),
      documents: new Map(),
      runs: [],
    };
    const repository = makeInMemoryPublicSourceIngestionRepository(state);

    const stats = await Effect.runPromise(
      runPublicSourceIngestionBatch(makeE2ePublicSourceAdapters(corpus, now), {
        mode: "backfill",
        now: () => now,
      }).pipe(Effect.provide(InMemoryPublicSourceIngestionRepositoryLayer(state))),
    );

    expect(stats).toEqual([
      {
        sourceId: "e2e-fr-energie",
        mode: "backfill",
        discoveredCount: 1,
        fetchedCount: 1,
        unchangedCount: 0,
        storedDocumentCount: 1,
        failedCount: 0,
      },
    ]);
    expect(repository).toBeDefined();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({
      sourceId: "e2e-fr-energie",
      status: "completed",
      stats: stats[0],
    });
    const document = [...state.documents.values()][0];
    expect(document).toEqual(
      expect.objectContaining({
        id: "e2e-fr-solaire-raccordements",
        externalId: "e2e-fr-solaire-raccordements",
        sourceId: "e2e-fr-energie",
        canonicalUrl: "https://e2e.example/fr/solaire-raccordements",
        contentHash: createHash("sha256").update(corpus[0]!.text).digest("hex"),
        textCharCount: corpus[0]!.text.length,
      }),
    );
  });
});
