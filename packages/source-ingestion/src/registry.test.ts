import { describe, expect, it } from "vitest";
import { makeAllPublicSourceAdapters, makePublicSourceAdapter } from "./registry";
import { publicSourceDefinitions } from "./source-catalog";

describe("public source registry", () => {
  it("builds one adapter for every reliable marketplace source", () => {
    const adapters = makeAllPublicSourceAdapters();

    expect(adapters.map((adapter) => adapter.definition.id)).toEqual(
      publicSourceDefinitions.map((definition) => definition.id),
    );
    expect(adapters).toHaveLength(7);
  });

  it("uses a dataset-backed adapter for BOFiP", () => {
    const adapter = makePublicSourceAdapter("bofip_impots");

    expect(adapter.definition.ingestionMethod).toBe("opendata_dataset");
    expect(adapter.definition.discoveryUrl).toContain("bofip.impots.gouv.fr");
    expect(adapter.definition.contentUrl).toContain("data.economie.gouv.fr");
  });

  it("registers both documented Service-Public RSS feeds", () => {
    const adapter = makePublicSourceAdapter("service_public_rss");

    expect(adapter.definition.discoveryUrls).toEqual([
      "https://www.service-public.fr/abonnements/rss/actu-actualites-particuliers.rss",
      "https://www.service-public.fr/abonnements/rss/actu-actu-pro.rss",
    ]);
  });

  it("uses the official working Assemblee nationale document feed", () => {
    const adapter = makePublicSourceAdapter("assemblee_nationale");

    expect(adapter.definition.discoveryUrl).toBe(
      "https://www2.assemblee-nationale.fr/feeds/detail/documents-parlementaires",
    );
  });

  it("only registers reliable RSS, Atom, or official dataset sources", () => {
    expect(
      publicSourceDefinitions.every((definition) =>
        ["rss", "atom", "opendata_dataset"].includes(definition.ingestionMethod),
      ),
    ).toBe(true);
    expect(publicSourceDefinitions.map((definition) => definition.id)).not.toContain(
      "education_gouv",
    );
    expect(publicSourceDefinitions.map((definition) => definition.id)).not.toContain(
      "cour_de_cassation",
    );
    expect(publicSourceDefinitions.map((definition) => definition.id)).not.toContain(
      "banque_de_france",
    );
    expect(publicSourceDefinitions.map((definition) => definition.id)).not.toContain(
      "vie_publique",
    );
    expect(publicSourceDefinitions.map((definition) => definition.id)).not.toContain(
      "travail_emploi",
    );
  });
});
