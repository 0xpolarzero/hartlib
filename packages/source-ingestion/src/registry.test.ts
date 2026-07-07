import { describe, expect, it } from "vitest";
import { makeAllPublicSourceAdapters, makePublicSourceAdapter } from "./registry";
import { publicSourceDefinitions } from "./source-catalog";

describe("public source registry", () => {
  it("builds one adapter for every reliable marketplace source", () => {
    const adapters = makeAllPublicSourceAdapters();

    expect(adapters.map((adapter) => adapter.definition.id)).toEqual(
      publicSourceDefinitions.map((definition) => definition.id),
    );
    expect(adapters).toHaveLength(3);
  });

  it("uses a dataset-backed adapter for BOFiP", () => {
    const adapter = makePublicSourceAdapter("bofip_impots");

    expect(adapter.definition.ingestionMethod).toBe("json_dataset");
    expect(adapter.definition.discoveryUrl).toContain("data.economie.gouv.fr");
    expect(adapter.definition.contentUrl).toContain("data.economie.gouv.fr");
  });

  it("registers both documented Service-Public XML open-data feeds", () => {
    const adapter = makePublicSourceAdapter("service_public");

    expect(adapter.definition.discoveryUrls).toEqual([
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/",
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/pro/",
    ]);
    expect(adapter.definition.discoveryUrls?.every((url) => !url.endsWith(".xml"))).toBe(true);
  });

  it("uses the official working Assemblee nationale document feed", () => {
    const adapter = makePublicSourceAdapter("assemblee_nationale");

    expect(adapter.definition.discoveryUrl).toBe(
      "https://www2.assemblee-nationale.fr/feeds/detail/documents-parlementaires",
    );
  });

  it("only registers sources with official structured or document content", () => {
    expect(
      publicSourceDefinitions.every((definition) =>
        ["atom_feed", "json_dataset", "xml_dataset", "official_document"].includes(
          definition.ingestionMethod,
        ),
      ),
    ).toBe(true);
    expect(publicSourceDefinitions.map((definition) => definition.id)).not.toContain("info_gouv");
    expect(publicSourceDefinitions.map((definition) => definition.id)).not.toContain("senat_press");
    expect(publicSourceDefinitions.map((definition) => definition.id)).not.toContain(
      "conseil_etat_actualites",
    );
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
    expect(publicSourceDefinitions.map((definition) => definition.id)).not.toContain("tresor");
  });
});
