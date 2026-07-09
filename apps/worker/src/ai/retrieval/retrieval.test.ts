import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate";
import { InvalidQuerySpecError } from "./compile-query-spec";
import { peekDocument, searchDocuments } from "./retrieval";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isolatedDatabaseName = `brief_retrieval_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

const allPublicAccess = { kind: "allPublicSources" } as const;
const baseOptions = {
  access: allPublicAccess,
  maxLimit: 20,
  recencyHalfLifeDays: 14,
  now,
} as const;

const stagFrText =
  "La stagflation menace la reprise selon plusieurs économistes qui observent la hausse simultanée du chômage et des prix à la consommation.";
const peekText = "0123456789".repeat(40);
const dirigeableText =
  "Le dirigeable stratosphérique français réussit son premier vol d'essai longue durée au-dessus des Landes.";

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
];

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
        expect(orderedDocumentIds(flatDecayPreviews)).toEqual([
          "ret-doc-sem-title",
          "ret-doc-sem-body",
        ]);

        const steepDecayPreviews = yield* searchDocuments(
          { terms: "sémaphore" },
          { ...baseOptions, recencyHalfLifeDays: 5 },
        );
        expect(orderedDocumentIds(steepDecayPreviews)).toEqual([
          "ret-doc-sem-body",
          "ret-doc-sem-title",
        ]);

        const recencyPreviews = yield* searchDocuments(
          { terms: "sémaphore", orderBy: "recency" },
          baseOptions,
        );
        expect(orderedDocumentIds(recencyPreviews)).toEqual([
          "ret-doc-sem-body",
          "ret-doc-sem-title",
        ]);
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
        expect(preview.estimatedTokens).toBe(Math.ceil(stagFrText.length / 4));
        expect(preview.publishedAt).toBeInstanceOf(Date);
        expect(preview.snippet).toEqual(expect.any(String));
        expect(preview.snippet.length).toBeGreaterThan(0);
        expect(preview.snippet.length).toBeLessThanOrEqual(300);
        expect(preview.snippet).toContain("<b>");
        expect(preview.snippet.toLowerCase()).toContain("stagflation");
        expect(Object.keys(preview)).not.toContain("text");
      }),
    );
  });

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
            access: allPublicAccess,
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
          access: allPublicAccess,
        });
        expect(exactSlice).toEqual({
          documentId: "ret-doc-peek",
          text: peekText.slice(10, 35),
          offsetChars: 10,
          lengthChars: 25,
          textCharCount: 400,
        });

        const defaultSlice = yield* peekDocument("ret-doc-peek", undefined, undefined, {
          access: allPublicAccess,
          defaultLengthChars: 50,
        });
        expect(defaultSlice?.text).toBe(peekText.slice(0, 50));
        expect(defaultSlice?.lengthChars).toBe(50);

        const maxSlice = yield* peekDocument("ret-doc-peek", 0, 500, {
          access: allPublicAccess,
          maxLengthChars: 100,
        });
        expect(maxSlice?.lengthChars).toBe(100);
        expect(maxSlice?.text).toBe(peekText.slice(0, 100));

        const outOfBoundsSlice = yield* peekDocument("ret-doc-peek", 1000, 50, {
          access: allPublicAccess,
        });
        expect(outOfBoundsSlice?.text).toBe("");
        expect(outOfBoundsSlice?.lengthChars).toBe(0);
        expect(outOfBoundsSlice?.offsetChars).toBe(400);

        const missingDocument = yield* peekDocument("ret-doc-missing", undefined, undefined, {
          access: allPublicAccess,
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
