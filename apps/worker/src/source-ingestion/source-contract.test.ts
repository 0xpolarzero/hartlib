import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  discoverSource,
  ingestDiscoveredItem,
  makePublicSourceAdapter,
  type CanonicalDocument,
  type FetchResponse,
  type IngestedSourceItem,
  type PublicSourceId,
  type RawArtifact,
  type SourceAdapter,
} from "@brief/source-ingestion";
import {
  makeInMemoryPublicSourceIngestionRepository,
  type InMemoryPublicSourceIngestionState,
} from "./repository";

const makeState = (): InMemoryPublicSourceIngestionState => ({
  sources: new Map(),
  candidates: new Map(),
  items: new Map(),
  rawArtifacts: new Map(),
  documents: new Map(),
  runs: [],
});

const response = (url: string, body: string, mediaType: string): FetchResponse => ({
  url,
  status: 200,
  ok: true,
  headers: new Headers({ "content-type": mediaType }),
  text: async () => body,
});

const ingestAndStore = async (
  adapter: SourceAdapter,
  state: InMemoryPublicSourceIngestionState,
) => {
  const repository = makeInMemoryPublicSourceIngestionRepository(state);
  const discovery = await Effect.runPromise(
    discoverSource(adapter, { now: () => new Date("2026-07-07T10:00:00.000Z") }),
  );
  await Effect.runPromise(repository.recordDiscoveryResult(adapter.definition, discovery));
  if (discovery.status !== "fetched") {
    throw new Error("expected fetched discovery");
  }

  const ingested: IngestedSourceItem[] = [];
  for (const item of discovery.items) {
    await Effect.runPromise(repository.recordDiscoveredItem(item));
    const result = await Effect.runPromise(ingestDiscoveredItem(adapter, item));
    expect(result.status).toBe("ingested");
    if (result.status !== "ingested") {
      throw new Error(`expected ${item.canonicalUrl} to ingest`);
    }
    await Effect.runPromise(repository.storeIngestedItem(result));
    ingested.push(result);
  }

  return ingested;
};

const storedRawArtifacts = (state: InMemoryPublicSourceIngestionState): RawArtifact[] =>
  [...state.rawArtifacts.values()] as RawArtifact[];

const storedDocuments = (state: InMemoryPublicSourceIngestionState): CanonicalDocument[] =>
  [...state.documents.values()] as CanonicalDocument[];

describe("public source storage contracts", () => {
  it("stores Service-Public readable HTML artifacts and documents for both audiences", async () => {
    const articleXml = (
      id: string,
      audience: "particuliers" | "professionnels",
    ) => `<?xml version="1.0"?>
      <Actualite xmlns:dc="http://purl.org/dc/elements/1.1/" ID="${id}" type="bref" datePremiereMiseEnLigne="2026-07-01" spUrl="https://www.service-public.gouv.fr/${audience}/actualites/${id}">
        <dc:title>${id} official update</dc:title>
        <dc:description>Official XML summary.</dc:description>
        <Introduction><![CDATA[<p>Official XML summary.</p>]]></Introduction>
        <Texte><![CDATA[<p>Official XML body stored from DILA open data.</p>]]></Texte>
      </Actualite>`;
    const fetcher = async (url: string): Promise<FetchResponse> => {
      if (url.endsWith("/part/") || url.endsWith("/pro/")) {
        return response(
          url,
          '<html><body><a href="xml/actualites/">xml/actualites/</a></body></html>',
          "text/html",
        );
      }
      if (url.endsWith("/part/xml/actualites/")) {
        return response(
          url,
          '<html><body><a href="A00001.xml">A00001.xml</a></body></html>',
          "text/html",
        );
      }
      if (url.endsWith("/pro/xml/actualites/")) {
        return response(
          url,
          '<html><body><a href="A00002.xml">A00002.xml</a></body></html>',
          "text/html",
        );
      }
      if (url.endsWith("A00001.xml")) {
        return response(url, articleXml("A00001", "particuliers"), "application/xml");
      }
      return response(url, articleXml("A00002", "professionnels"), "application/xml");
    };

    const state = makeState();
    const ingested = await ingestAndStore(
      makePublicSourceAdapter("service_public", { fetcher }),
      state,
    );

    expect(ingested).toHaveLength(2);
    expect(storedRawArtifacts(state).map((raw) => raw.mediaType)).toEqual([
      "text/html",
      "text/html",
    ]);
    expect(storedRawArtifacts(state).map((raw) => raw.body)).toEqual([
      expect.stringContaining("Official XML body stored from DILA open data."),
      expect.stringContaining("Official XML body stored from DILA open data."),
    ]);
    expect(storedDocuments(state)).toHaveLength(2);
    expect(storedDocuments(state).map((document) => document.sourceMetadata.xmlUrl)).toEqual([
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/xml/actualites/A00001.xml",
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/pro/xml/actualites/A00002.xml",
    ]);
  });

  it.each([
    {
      sourceId: "bofip_impots",
      expectedText:
        "TVA Official BOFiP doctrine update with complete readable fiscal guidance text that is long enough to satisfy the publication storage invariant.",
      expectedRawBody:
        "<section><h1>TVA</h1><p>Official BOFiP doctrine update with complete readable fiscal guidance text that is long enough to satisfy the publication storage invariant.</p></section>",
      fetcher: async (url: string): Promise<FetchResponse> =>
        response(
          url,
          JSON.stringify({
            results: [
              {
                type: "Actualite",
                titre: "TVA - Mise a jour",
                debut_de_validite: "2026-07-01",
                serie: "TVA",
                division: "BASE",
                identifiant_juridique: "BOI-TVA-BASE-10",
                permalien: "https://bofip.impots.gouv.fr/bofip/123",
                contenu_html:
                  "<section><h1>TVA</h1><p>Official BOFiP doctrine update with complete readable fiscal guidance text that is long enough to satisfy the publication storage invariant.</p></section>",
              },
            ],
          }),
          "application/json",
        ),
    },
    {
      sourceId: "assemblee_nationale",
      expectedText:
        "N° 3044 Official Assemblee nationale document HTML body with enough readable parliamentary content to prove storage uses the document artifact.",
      expectedRawBody:
        "<html><main><h1>N° 3044</h1><p>Official Assemblee nationale document HTML body with enough readable parliamentary content to prove storage uses the document artifact.</p></main></html>",
      fetcher: async (url: string): Promise<FetchResponse> => {
        if (url.endsWith("documents-parlementaires")) {
          return response(
            url,
            `<?xml version="1.0"?>
            <rss><channel><item>
              <title>Proposition de loi, n° 3044</title>
              <link>https://www.assemblee-nationale.fr/dyn/old/17/propositions/pion3044.asp</link>
              <guid>pion3044</guid>
            </item></channel></rss>`,
            "application/rss+xml",
          );
        }
        if (url.endsWith("pion3044.asp")) {
          return response(
            "https://www.assemblee-nationale.fr/dyn/17/textes/l17b3044_proposition-loi",
            '<main><p>Landing page shell.</p><a href="/dyn/opendata/PIONANR5L17B3044.html">HTML</a></main>',
            "text/html",
          );
        }
        return response(
          url,
          "<html><main><h1>N° 3044</h1><p>Official Assemblee nationale document HTML body with enough readable parliamentary content to prove storage uses the document artifact.</p></main></html>",
          "text/html",
        );
      },
    },
  ] satisfies Array<{
    readonly sourceId: Exclude<PublicSourceId, "service_public">;
    readonly expectedText: string;
    readonly expectedRawBody: string;
    readonly fetcher: (url: string) => Promise<FetchResponse>;
  }>)("stores official artifacts and documents for $sourceId", async (contract) => {
    const state = makeState();
    const ingested = await ingestAndStore(
      makePublicSourceAdapter(contract.sourceId, { fetcher: contract.fetcher }),
      state,
    );

    expect(ingested).toHaveLength(1);
    expect(storedRawArtifacts(state)[0]).toMatchObject({
      sourceId: contract.sourceId,
      body: contract.expectedRawBody,
    });
    expect(storedRawArtifacts(state)[0]?.mediaType.toLowerCase()).toMatch(/html|pdf/u);
    expect(storedDocuments(state)[0]).toMatchObject({
      sourceId: contract.sourceId,
      text: contract.expectedText,
    });
    expect(storedDocuments(state)[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
