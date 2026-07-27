import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate";
import { InvalidQuerySpecError } from "./compile-query-spec";
import {
  findNormalizedSubstringRanges,
  normalizeAndCaseFold,
  normalizeWithOriginalSpans,
} from "./exact-text";
import { peekDocument, previewFromImmutableText, searchDocuments } from "./retrieval";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isolatedDatabaseName = `brief_retrieval_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

const authorizedSourceAccess = {
  kind: "sourceIds",
  sourceIds: ["ret-fr-a", "ret-fr-b", "ret-us"],
} as const;
const baseOptions = {
  access: authorizedSourceAccess,
  maxLimit: 20,
  recencyHalfLifeDays: 14,
  now,
} as const;

const stagFrText =
  "La stagflation menace la reprise selon plusieurs économistes qui observent la hausse simultanée du chômage et des prix à la consommation.";
const peekText = "0123456789".repeat(40);
const dirigeableText =
  "Le dirigeable stratosphérique français réussit son premier vol d'essai longue durée au-dessus des Landes.";
const repeatedHeadlineText =
  "Needle first signal appears in the opening paragraph with enough context for a useful headline fragment. " +
  "filler ".repeat(30) +
  "Needle second signal appears in the closing paragraph with enough context for another useful headline fragment.";
const unicodeHeadlineText =
  "😀 " +
  "prefix ".repeat(30) +
  "needle match follows supplementary characters with enough surrounding words for a stable preview fragment.";
const unmappableHeadlineText =
  "This body deliberately contains a run event whose indexed stem matches the requested form. " +
  "The fixture keeps enough stable source content to pass the readable-document invariant.";

const sourceDatabaseUrl = () => {
  if (databaseUrl === undefined) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  }

  return databaseUrl;
};

const adminDatabaseUrl = () => {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
};

const isolatedDatabaseUrl = () => {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = `/${isolatedDatabaseName}`;
  return url.toString();
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

describe("immutable text normalization", () => {
  it("fails closed at a blocked Hangul trailing-jamo boundary", () => {
    const text = "가\u0327\u11a8";
    const mapped = normalizeWithOriginalSpans(text);

    expect(mapped.text).toBe(normalizeAndCaseFold(text));
    expect(mapped.text).toBe("가\u0327\u11a8");
    expect(findNormalizedSubstringRanges(text, ["각", "각\u0327"])).toEqual([]);
    expect(findNormalizedSubstringRanges(text, ["가"])).toEqual([{ charStart: 0, charEnd: 1 }]);
  });

  it("does not cross a blocked combining-mark boundary", () => {
    const text = "a\u0323\u0301";
    const mapped = normalizeWithOriginalSpans(text);

    expect(mapped.text).toBe(normalizeAndCaseFold(text));
    expect(mapped.text).toBe("ạ\u0301");
    expect(findNormalizedSubstringRanges(text, ["á"])).toEqual([]);
    expect(findNormalizedSubstringRanges(text, ["ạ"])).toEqual([{ charStart: 0, charEnd: 2 }]);
  });

  it("maps compatibility compositions and supplementary UTF-16 spans exactly", () => {
    const text = "😀 \u09cc";
    const mapped = normalizeWithOriginalSpans(text);

    expect(mapped.text).toBe(normalizeAndCaseFold(text));
    expect(findNormalizedSubstringRanges(text, ["😀"])).toEqual([{ charStart: 0, charEnd: 2 }]);
    expect(findNormalizedSubstringRanges(text, ["\u09cc"])).toEqual([{ charStart: 3, charEnd: 4 }]);
    expect(previewFromImmutableText("😀 ﬃ", "ffi", 100)).toEqual({
      snippet: "ﬃ",
      ranges: [{ charStart: 3, charEnd: 4 }],
    });
    expect(previewFromImmutableText("😀 prefix", undefined, 1)).toBeNull();
    expect(previewFromImmutableText("😀 prefix", undefined, 2)).toEqual({
      snippet: "😀",
      ranges: [{ charStart: 0, charEnd: 2 }],
    });
  });

  it("rejects ill-formed queries and keeps valid supplementary matches on UTF-16 boundaries", () => {
    const text = "x😀 needle";
    expect(findNormalizedSubstringRanges(text, ["\ud83d"])).toEqual([]);
    expect(findNormalizedSubstringRanges(text, ["\ude00"])).toEqual([]);
    expect(findNormalizedSubstringRanges(text, ["😀"])).toEqual([{ charStart: 1, charEnd: 3 }]);
    expect(previewFromImmutableText(text, "needle\ud800", 100)).toBeNull();
    expect(previewFromImmutableText(text, "needle", 100)).toEqual({
      snippet: "needle",
      ranges: [{ charStart: 4, charEnd: 10 }],
    });
  });

  it("keeps attached combining marks in preview search terms", () => {
    const text = "prefix e\u0301 suffix";

    expect(previewFromImmutableText(text, "e\u0301", 100)).toEqual({
      snippet: "e\u0301",
      ranges: [{ charStart: 7, charEnd: 9 }],
    });
    expect(previewFromImmutableText(text, "é", 100)).toEqual({
      snippet: "e\u0301",
      ranges: [{ charStart: 7, charEnd: 9 }],
    });
    expect(previewFromImmutableText("a\u0323\u0301", "á", 100)).toBeNull();
    expect(previewFromImmutableText("가\u0327\u11a8", "각\u0327", 100)).toBeNull();
  });
});

function runDb<A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-retrieval-test",
        }),
      ),
    ),
  );
}

type SourceFixture = {
  readonly sourceId: string;
  readonly displayName: string;
  readonly publisherName: string;
  readonly discoveryUrl: string;
  readonly country: string;
  readonly language: string;
};

type DocumentFixture = {
  readonly documentId: string;
  readonly sourceId: string;
  readonly language: string;
  readonly title: string;
  readonly text: string;
  readonly publishedAt: Date;
  readonly documentType: string;
  readonly contentHash: string;
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const sourceFixtures: ReadonlyArray<SourceFixture> = [
  {
    sourceId: "ret-fr-a",
    displayName: "Retrieval FR A",
    publisherName: "Retrieval FR A",
    discoveryUrl: "https://retrieval.example/fr-a",
    country: "FR",
    language: "fr-FR",
  },
  {
    sourceId: "ret-fr-b",
    displayName: "Retrieval FR B",
    publisherName: "Retrieval FR B",
    discoveryUrl: "https://retrieval.example/fr-b",
    country: "FR",
    language: "fr-FR",
  },
  {
    sourceId: "ret-us",
    displayName: "Retrieval US",
    publisherName: "Retrieval US",
    discoveryUrl: "https://retrieval.example/us",
    country: "US",
    language: "en-US",
  },
];

const documentFixtures: ReadonlyArray<DocumentFixture> = [
  {
    documentId: "ret-doc-stag-fr",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Note sur la stagflation",
    text: stagFrText,
    publishedAt: daysAgo(2),
    documentType: "article",
    contentHash: "ret-h-01",
  },
  {
    documentId: "ret-doc-stag-fr-b",
    sourceId: "ret-fr-b",
    language: "fr",
    title: "Rapport trimestriel sur les prix",
    text: "Le rapport décrit un scénario de stagflation durable pour la zone euro avec des salaires réels en baisse continue.",
    publishedAt: daysAgo(10),
    documentType: "report",
    contentHash: "ret-h-02",
  },
  {
    documentId: "ret-doc-stag-en",
    sourceId: "ret-us",
    language: "en-US",
    title: "Stagflation outlook",
    text: "Analysts warn that stagflation risks are rising as growth slows while consumer prices keep climbing across major economies.",
    publishedAt: daysAgo(3),
    documentType: "article",
    contentHash: "ret-h-03",
  },
  {
    documentId: "ret-doc-pv-fr",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Le solaire photovoltaïque en plaine",
    text: "Les installations photovoltaïques progressent dans les zones rurales grâce aux nouveaux appels d'offres régionaux.",
    publishedAt: daysAgo(4),
    documentType: "article",
    contentHash: "ret-h-04",
  },
  {
    documentId: "ret-doc-pv-frfr",
    sourceId: "ret-fr-a",
    language: "fr-FR",
    title: "Cadastre solaire photovoltaïque",
    text: "Le cadastre recense le potentiel photovoltaïque de chaque toiture de la métropole pour orienter les investissements.",
    publishedAt: daysAgo(5),
    documentType: "article",
    contentHash: "ret-h-05",
  },
  {
    documentId: "ret-doc-pv-frca",
    sourceId: "ret-fr-b",
    language: "fr-CA",
    title: "Programme photovoltaïque québécois",
    text: "Le programme soutient le déploiement photovoltaïque résidentiel dans les municipalités du Québec avec des subventions bonifiées.",
    publishedAt: daysAgo(6),
    documentType: "article",
    contentHash: "ret-h-06",
  },
  {
    documentId: "ret-doc-pv-en",
    sourceId: "ret-us",
    language: "en-US",
    title: "Photovoltaïque partnership announced",
    text: "The joint venture will build photovoltaïque module factories across three states next year to supply utility developers.",
    publishedAt: daysAgo(4),
    documentType: "article",
    contentHash: "ret-h-07",
  },
  {
    documentId: "ret-doc-geo-old",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Bilan de la géothermie profonde",
    text: "La géothermie profonde alimente désormais trois réseaux de chaleur urbains en Île-de-France selon le dernier bilan public.",
    publishedAt: daysAgo(60),
    documentType: "article",
    contentHash: "ret-h-08",
  },
  {
    documentId: "ret-doc-geo-mid",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Forages de géothermie en Alsace",
    text: "Les nouveaux forages de géothermie alsaciens relancent le débat public sur la sismicité induite dans la vallée du Rhin.",
    publishedAt: daysAgo(30),
    documentType: "article",
    contentHash: "ret-h-09",
  },
  {
    documentId: "ret-doc-geo-new",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Géothermie de surface pour les écoles",
    text: "La géothermie de surface équipe une dizaine de groupes scolaires pilotes cette rentrée dans plusieurs académies volontaires.",
    publishedAt: daysAgo(5),
    documentType: "article",
    contentHash: "ret-h-10",
  },
  {
    documentId: "ret-doc-sem-title",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Le sémaphore maritime restauré",
    text: "La tour de guet du littoral breton rouvre après deux ans de travaux de restauration menés par la commune.",
    publishedAt: daysAgo(40),
    documentType: "article",
    contentHash: "ret-h-11",
  },
  {
    documentId: "ret-doc-sem-body",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Signalisation côtière renforcée",
    text: "Un sémaphore modernisé complète le dispositif de surveillance du littoral atlantique pour la saison estivale.",
    publishedAt: daysAgo(1),
    documentType: "article",
    contentHash: "ret-h-12",
  },
  {
    documentId: "ret-doc-dir-a",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Le dirigeable stratosphérique décolle",
    text: dirigeableText,
    publishedAt: daysAgo(3),
    documentType: "article",
    contentHash: "ret-h-dup",
  },
  {
    documentId: "ret-doc-dir-b",
    sourceId: "ret-fr-b",
    language: "fr",
    title: "Le dirigeable stratosphérique décolle",
    text: dirigeableText,
    publishedAt: daysAgo(1),
    documentType: "article",
    contentHash: "ret-h-dup",
  },
  {
    documentId: "ret-doc-peek",
    sourceId: "ret-fr-a",
    language: "fr",
    title: "Document de référence",
    text: peekText,
    publishedAt: daysAgo(1),
    documentType: "article",
    contentHash: "ret-h-15",
  },
  {
    documentId: "ret-doc-repeated-headline",
    sourceId: "ret-us",
    language: "en-US",
    title: "Repeated headline terms",
    text: repeatedHeadlineText,
    publishedAt: daysAgo(1),
    documentType: "article",
    contentHash: "ret-h-16",
  },
  {
    documentId: "ret-doc-unicode-headline",
    sourceId: "ret-us",
    language: "en-US",
    title: "Unicode headline terms",
    text: unicodeHeadlineText,
    publishedAt: daysAgo(1),
    documentType: "article",
    contentHash: "ret-h-17",
  },
  {
    documentId: "ret-doc-unmappable-headline",
    sourceId: "ret-us",
    language: "en-US",
    title: "Unmappable headline fixture",
    text: unmappableHeadlineText,
    publishedAt: daysAgo(1),
    documentType: "article",
    contentHash: "ret-h-18",
  },
].map((fixture) => ({ ...fixture, contentHash: sha256(fixture.text) }));

const sortedDocumentIds = (previews: ReadonlyArray<{ readonly documentId: string }>) =>
  previews.map((preview) => preview.documentId).sort();

const orderedDocumentIds = (previews: ReadonlyArray<{ readonly documentId: string }>) =>
  previews.map((preview) => preview.documentId);

const artifactIdForIndex = (index: number) =>
  `eeeeeeee-0000-0000-0000-${String(index).padStart(12, "0")}`;

const artifactBodyHashForIndex = (index: number) => `ret-bh-${String(index).padStart(2, "0")}`;

describe.skipIf(!isBun || !databaseUrl)("retrieval over postgres fts", () => {
  beforeAll(async () => {
    await runDb(
      adminDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly exists: boolean }>`
          select exists(
            select 1 from pg_database where datname = ${isolatedDatabaseName}
          ) as exists
        `;

        if (rows[0]?.exists !== true) {
          yield* sql.unsafe(`create database ${quoteIdentifier(isolatedDatabaseName)}`);
        }
      }),
    );

    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        yield* runMigrations;
      }),
    );

    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;

        yield* sql`
          delete from public_sources
          where source_id in ('ret-fr-a', 'ret-fr-b', 'ret-us')
        `;

        for (const source of sourceFixtures) {
          yield* sql`
            insert into public_sources (
              source_id,
              display_name,
              publisher_name,
              description,
              ingestion_method,
              discovery_url,
              average_chars_per_item,
              country,
              language
            )
            values (
              ${source.sourceId},
              ${source.displayName},
              ${source.publisherName},
              ${"retrieval fixtures"},
              ${"rss"},
              ${source.discoveryUrl},
              ${1000},
              ${source.country},
              ${source.language}
            )
          `;
        }

        for (const [index, document] of documentFixtures.entries()) {
          const fixtureIndex = index + 1;
          const artifactId = artifactIdForIndex(fixtureIndex);
          const canonicalUrl = `https://retrieval.example/docs/${document.documentId}`;

          yield* sql`
            insert into public_source_raw_artifacts (
              id,
              source_id,
              canonical_url,
              fetched_at,
              media_type,
              body,
              body_hash
            )
            values (
              ${artifactId},
              ${document.sourceId},
              ${canonicalUrl},
              now(),
              ${"text/html"},
              ${"body"},
              ${artifactBodyHashForIndex(fixtureIndex)}
            )
          `;

          yield* sql`
            insert into public_source_documents (
              document_id,
              source_id,
              raw_artifact_id,
              canonical_url,
              external_id,
              title,
              text,
              language,
              published_at,
              discovered_at,
              fetched_at,
              document_type,
              content_hash,
              text_char_count
            )
            values (
              ${document.documentId},
              ${document.sourceId},
              ${artifactId},
              ${canonicalUrl},
              ${null},
              ${document.title},
              ${document.text},
              ${document.language},
              ${document.publishedAt},
              ${document.publishedAt},
              ${document.publishedAt},
              ${document.documentType},
              ${document.contentHash},
              ${document.text.length}
            )
          `;
        }
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await runDb(
      adminDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = ${isolatedDatabaseName}
            and pid <> pg_backend_pid()
        `;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(isolatedDatabaseName)}`);
      }),
    );
  }, 60_000);

  it(
    "unions both language configurations when languages is absent",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const previews = yield* searchDocuments({ terms: "stagflation" }, baseOptions);

          expect(sortedDocumentIds(previews)).toEqual([
            "ret-doc-stag-en",
            "ret-doc-stag-fr",
            "ret-doc-stag-fr-b",
          ]);
          expect([...new Set(previews.map((preview) => preview.sourceId))].sort()).toEqual([
            "public:ret-fr-a",
            "public:ret-fr-b",
            "public:ret-us",
          ]);
          expect(previews.every((preview) => preview.kind === "public_source")).toBe(true);
        }),
      );
    },
  );

  it("filters languages by primary subtag", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const frenchPreviews = yield* searchDocuments(
          { terms: "photovoltaïque", languages: ["fr-FR"] },
          baseOptions,
        );
        expect(sortedDocumentIds(frenchPreviews)).toEqual([
          "ret-doc-pv-fr",
          "ret-doc-pv-frca",
          "ret-doc-pv-frfr",
        ]);

        const englishPreviews = yield* searchDocuments(
          { terms: "photovoltaïque", languages: ["en-US"] },
          baseOptions,
        );
        expect(orderedDocumentIds(englishPreviews)).toEqual(["ret-doc-pv-en"]);
      }),
    );
  });

  it("applies published date filters", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const newerPreviews = yield* searchDocuments(
          {
            terms: "géothermie",
            publishedAfter: daysAgo(20).toISOString(),
          },
          baseOptions,
        );
        expect(orderedDocumentIds(newerPreviews)).toEqual(["ret-doc-geo-new"]);

        const olderPreviews = yield* searchDocuments(
          {
            terms: "géothermie",
            publishedBefore: daysAgo(45).toISOString(),
          },
          baseOptions,
        );
        expect(orderedDocumentIds(olderPreviews)).toEqual(["ret-doc-geo-old"]);

        const middlePreviews = yield* searchDocuments(
          {
            terms: "géothermie",
            publishedAfter: daysAgo(45).toISOString(),
            publishedBefore: daysAgo(20).toISOString(),
          },
          baseOptions,
        );
        expect(orderedDocumentIds(middlePreviews)).toEqual(["ret-doc-geo-mid"]);
      }),
    );
  });

  it("applies source, country and document type filters", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sourcePreviews = yield* searchDocuments(
          { terms: "stagflation", sourceIds: ["ret-fr-a"] },
          baseOptions,
        );
        expect(orderedDocumentIds(sourcePreviews)).toEqual(["ret-doc-stag-fr"]);

        const countryPreviews = yield* searchDocuments(
          { terms: "stagflation", countries: ["US"] },
          baseOptions,
        );
        expect(orderedDocumentIds(countryPreviews)).toEqual(["ret-doc-stag-en"]);

        const typePreviews = yield* searchDocuments(
          { terms: "stagflation", documentTypes: ["report"] },
          baseOptions,
        );
        expect(orderedDocumentIds(typePreviews)).toEqual(["ret-doc-stag-fr-b"]);
      }),
    );
  });

  it("ranks by weighted relevance and recency decay", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const flatDecayPreviews = yield* searchDocuments(
          { terms: "sémaphore" },
          { ...baseOptions, recencyHalfLifeDays: 10_000 },
        );
        expect(orderedDocumentIds(flatDecayPreviews)).toEqual(["ret-doc-sem-body"]);

        const steepDecayPreviews = yield* searchDocuments(
          { terms: "sémaphore" },
          { ...baseOptions, recencyHalfLifeDays: 5 },
        );
        expect(orderedDocumentIds(steepDecayPreviews)).toEqual(["ret-doc-sem-body"]);

        const recencyPreviews = yield* searchDocuments(
          { terms: "sémaphore", orderBy: "recency" },
          baseOptions,
        );
        expect(orderedDocumentIds(recencyPreviews)).toEqual(["ret-doc-sem-body"]);
      }),
    );
  });

  it("collapses exact duplicates on content_hash", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const previews = yield* searchDocuments({ terms: "dirigeable" }, baseOptions);

        expect(orderedDocumentIds(previews)).toEqual(["ret-doc-dir-b"]);
      }),
    );
  });

  it("caps limit by maxLimit", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const cappedByOptions = yield* searchDocuments(
          { terms: "stagflation" },
          { ...baseOptions, maxLimit: 2 },
        );
        expect(cappedByOptions).toHaveLength(2);

        const cappedBySpec = yield* searchDocuments(
          { terms: "stagflation", limit: 1 },
          baseOptions,
        );
        expect(cappedBySpec).toHaveLength(1);

        const cappedByMax = yield* searchDocuments(
          { terms: "stagflation", limit: 999 },
          { ...baseOptions, maxLimit: 2 },
        );
        expect(cappedByMax).toHaveLength(2);
      }),
    );
  });

  it("returns spec-shaped previews with snippet", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const previews = yield* searchDocuments(
          { terms: "stagflation", languages: ["fr-FR"] },
          baseOptions,
        );
        const preview = previews.find((candidate) => candidate.documentId === "ret-doc-stag-fr");

        if (preview === undefined) {
          throw new Error("Missing ret-doc-stag-fr preview");
        }

        expect(preview.title).toBe("Note sur la stagflation");
        expect(preview.sourceDisplayName).toBe("Retrieval FR A");
        expect(preview.language).toBe("fr");
        expect(preview.documentType).toBe("article");
        expect(preview.textCharCount).toBe(stagFrText.length);
        expect(preview.publishedAt).toBeInstanceOf(Date);
        expect(preview.snippet).toEqual(expect.any(String));
        expect(preview.snippet.length).toBeGreaterThan(0);
        expect(preview.snippet.length).toBeLessThanOrEqual(300);
        expect(preview.snippet.toLowerCase()).toContain("stagflation");
        expect(preview.previewRanges).toEqual([
          expect.objectContaining({ charStart: expect.any(Number), charEnd: expect.any(Number) }),
        ]);
        expect(
          preview.previewRanges
            .map((range) => preview.text.slice(range.charStart, range.charEnd))
            .join("\n…\n"),
        ).toBe(preview.snippet);
        expect(Object.keys(preview)).not.toContain("text");
      }),
    );
  });

  it(
    "maps repeated multi-fragment headlines to exact UTF-16 source spans",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const previews = yield* searchDocuments(
            { terms: "needle", languages: ["en-US"], sourceIds: ["ret-us"] },
            baseOptions,
          );
          const preview = previews.find(
            (candidate) => candidate.documentId === "ret-doc-repeated-headline",
          );
          if (preview === undefined) throw new Error("Missing repeated-headline preview");
          const firstStart = repeatedHeadlineText.indexOf("Needle");
          const secondStart = repeatedHeadlineText.lastIndexOf("Needle");
          expect(preview.previewRanges).toEqual([
            { charStart: firstStart, charEnd: firstStart + "Needle".length },
            { charStart: secondStart, charEnd: secondStart + "Needle".length },
          ]);
          for (const [index, range] of preview.previewRanges.entries()) {
            expect(range.charStart).toBeGreaterThanOrEqual(0);
            expect(range.charEnd).toBeLessThanOrEqual(preview.text.length);
            expect(range.charEnd).toBeGreaterThan(range.charStart);
            if (index > 0) {
              expect(range.charStart).toBeGreaterThanOrEqual(
                preview.previewRanges[index - 1]!.charEnd,
              );
            }
            expect(preview.text.slice(range.charStart, range.charEnd)).toBe(
              preview.snippet.split("\n…\n")[index],
            );
            expect(preview.text.slice(range.charStart, range.charEnd).toLowerCase()).toContain(
              "needle",
            );
          }
        }),
      );
    },
  );

  it("keeps supplementary-character offsets in UTF-16 units", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const previews = yield* searchDocuments(
          { terms: "needle", languages: ["en-US"], sourceIds: ["ret-us"] },
          baseOptions,
        );
        const preview = previews.find(
          (candidate) => candidate.documentId === "ret-doc-unicode-headline",
        );
        if (preview === undefined) throw new Error("Missing unicode-headline preview");
        const firstRange = preview.previewRanges[0];
        if (firstRange === undefined) throw new Error("Missing unicode preview range");
        const expectedStart = unicodeHeadlineText.indexOf("needle");
        expect(firstRange).toEqual({
          charStart: expectedStart,
          charEnd: expectedStart + "needle".length,
        });
        expect(preview.text.slice(firstRange.charStart, firstRange.charEnd)).toBe(preview.snippet);
        expect(preview.text.slice(0, 2)).toBe("😀");
      }),
    );
  });

  it(
    "fails closed when a database hit has no exact immutable-text occurrence",
    { timeout: 60_000 },
    async () => {
      await runDb(
        isolatedDatabaseUrl(),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const hits = yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from public_source_documents
            where document_id = 'ret-doc-unmappable-headline'
              and search_vector @@ websearch_to_tsquery('english', 'running')
          `;
          expect(hits[0]?.count).toBe(1);
          const previews = yield* searchDocuments(
            { terms: "running", languages: ["en-US"], sourceIds: ["ret-us"] },
            baseOptions,
          );
          expect(previews).toEqual([]);
        }),
      );
    },
  );

  it("derives access from the caller", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const usOnlyPreviews = yield* searchDocuments(
          { terms: "stagflation" },
          {
            ...baseOptions,
            access: { kind: "sourceIds", sourceIds: ["ret-us"] },
          },
        );
        expect(orderedDocumentIds(usOnlyPreviews)).toEqual(["ret-doc-stag-en"]);

        const noSourcePreviews = yield* searchDocuments(
          { terms: "stagflation" },
          {
            ...baseOptions,
            access: { kind: "sourceIds", sourceIds: [] },
          },
        );
        expect(noSourcePreviews).toEqual([]);

        const allSourcePreviews = yield* searchDocuments(
          { terms: "stagflation" },
          {
            ...baseOptions,
            access: authorizedSourceAccess,
          },
        );
        expect(sortedDocumentIds(allSourcePreviews)).toEqual([
          "ret-doc-stag-en",
          "ret-doc-stag-fr",
          "ret-doc-stag-fr-b",
        ]);
      }),
    );
  });

  it("hostile terms cannot escape parameterization", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const hostileTermsResult = yield* searchDocuments(
          { terms: "'; drop table public_source_documents; --" },
          baseOptions,
        );
        expect(Array.isArray(hostileTermsResult)).toBe(true);

        const documentTableRows = yield* sql<{
          readonly name: string | null;
        }>`
            select to_regclass('public.public_source_documents')::text as name
          `;
        expect(documentTableRows[0]?.name).not.toBeNull();

        const hostileLanguageResult = yield* searchDocuments(
          {
            terms: "stagflation",
            languages: ["fr'; drop table jobs; --"],
          },
          baseOptions,
        );
        expect(hostileLanguageResult).toEqual([]);

        const jobsTableRows = yield* sql<{ readonly name: string | null }>`
            select to_regclass('public.jobs')::text as name
          `;
        expect(jobsTableRows[0]?.name).not.toBeNull();
      }),
    );
  });

  it("fails with InvalidQuerySpecError on empty terms", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const failure = yield* Effect.flip(searchDocuments({ terms: "   " }, baseOptions));

        expect(failure).toBeInstanceOf(InvalidQuerySpecError);
      }),
    );
  });

  it("peeks verbatim slices with bounds", { timeout: 60_000 }, async () => {
    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const exactSlice = yield* peekDocument("ret-doc-peek", 10, 25, {
          access: authorizedSourceAccess,
        });
        expect(exactSlice).toEqual({
          documentId: "ret-doc-peek",
          text: peekText.slice(10, 35),
          offsetChars: 10,
          lengthChars: 25,
          textCharCount: 400,
        });

        const defaultSlice = yield* peekDocument("ret-doc-peek", undefined, undefined, {
          access: authorizedSourceAccess,
          defaultLengthChars: 50,
        });
        expect(defaultSlice?.text).toBe(peekText.slice(0, 50));
        expect(defaultSlice?.lengthChars).toBe(50);

        const maxSlice = yield* peekDocument("ret-doc-peek", 0, 500, {
          access: authorizedSourceAccess,
          maxLengthChars: 100,
        });
        expect(maxSlice?.lengthChars).toBe(100);
        expect(maxSlice?.text).toBe(peekText.slice(0, 100));

        const outOfBoundsSlice = yield* peekDocument("ret-doc-peek", 1000, 50, {
          access: authorizedSourceAccess,
        });
        expect(outOfBoundsSlice?.text).toBe("");
        expect(outOfBoundsSlice?.lengthChars).toBe(0);
        expect(outOfBoundsSlice?.offsetChars).toBe(400);

        const hugeOffsetSlice = yield* peekDocument("ret-doc-peek", Number.MAX_SAFE_INTEGER, 50, {
          access: authorizedSourceAccess,
        });
        expect(hugeOffsetSlice?.text).toBe("");
        expect(hugeOffsetSlice?.lengthChars).toBe(0);
        expect(hugeOffsetSlice?.offsetChars).toBe(400);

        const missingDocument = yield* peekDocument("ret-doc-missing", undefined, undefined, {
          access: authorizedSourceAccess,
        });
        expect(missingDocument).toBeNull();

        const inaccessibleDocument = yield* peekDocument("ret-doc-peek", undefined, undefined, {
          access: { kind: "sourceIds", sourceIds: ["ret-us"] },
        });
        expect(inaccessibleDocument).toBeNull();
      }),
    );
  });
});
