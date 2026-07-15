import type { PublicSourceDefinition } from "./types";

export const publicSourceDefinitions = [
  {
    id: "service_public",
    displayName: "Service-Public",
    publisherName: "Direction de l'information legale et administrative",
    description:
      "Practical administrative news and public-service updates from official DILA XML open data.",
    country: "FR",
    language: "fr-FR",
    ingestionMethod: "xml_dataset",
    discoveryUrl: "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/",
    discoveryUrls: [
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/part/",
      "https://lecomarquage.service-public.gouv.fr/actu/3.5/pro/",
    ],
    canonicalUrlOrigins: [
      "https://www.service-public.fr",
      "https://www.service-public.gouv.fr",
      "https://lecomarquage.service-public.gouv.fr",
    ],
    fetchOrigins: ["https://lecomarquage.service-public.gouv.fr"],
    contentFormats: ["html", "text"],
    averageCharsPerItem: 7651,
  },
  {
    id: "bofip_impots",
    displayName: "BOFiP / impots.gouv.fr",
    publisherName: "Direction generale des Finances publiques",
    description: "French tax doctrine updates and official tax guidance news.",
    country: "FR",
    language: "fr-FR",
    ingestionMethod: "json_dataset",
    discoveryUrl:
      "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/bofip-vigueur/records",
    contentUrl:
      "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/bofip-vigueur/records",
    canonicalUrlOrigins: ["https://bofip.impots.gouv.fr"],
    fetchOrigins: ["https://data.economie.gouv.fr"],
    contentFormats: ["html", "text"],
    averageCharsPerItem: 1859,
  },
  {
    id: "assemblee_nationale",
    displayName: "Assemblee nationale",
    publisherName: "Assemblee nationale",
    description: "Parliamentary communications and documents.",
    country: "FR",
    language: "fr-FR",
    ingestionMethod: "official_document",
    discoveryUrl: "https://www2.assemblee-nationale.fr/feeds/detail/documents-parlementaires",
    canonicalUrlOrigins: [
      "https://www.assemblee-nationale.fr",
      "https://www2.assemblee-nationale.fr",
    ],
    fetchOrigins: ["https://www.assemblee-nationale.fr", "https://www2.assemblee-nationale.fr"],
    contentFormats: ["html", "pdf", "text"],
    averageCharsPerItem: 4981,
  },
] as const satisfies readonly PublicSourceDefinition[];
