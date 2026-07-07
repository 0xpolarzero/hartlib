import { publicSourceDefinitions } from "@brief/source-ingestion";

import type { DemoIssue, DemoSubscriptionSource } from "./index";

export type DemoFilSourceType = "publisher_invite" | "public";

export type DemoFil = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourceType: DemoFilSourceType;
  readonly subscribed: boolean;
  readonly lastPublicationDate: string | null;
  readonly publisherName: string;
  readonly expectedCadence: string | undefined;
  readonly branding: DemoSubscriptionSource["branding"] | undefined;
};

export const publicSourceDemoIssues: readonly DemoIssue[] = [
  {
    id: "public_issue_service_public_2026_06_28",
    sourceId: "service_public_rss",
    title: "Nouveaux services en ligne pour les entreprises",
    publicationDate: "2026-06-28T06:00:00.000Z",
    status: "published",
    summary:
      "Mise à jour des démarches administratives en ligne pour les entreprises sur service-public.fr.",
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
    documents: [
      {
        id: "public_doc_service_public_2026_06_28",
        issueId: "public_issue_service_public_2026_06_28",
        title: "Service-Public.fr - 28 juin 2026",
        fileName: "",
        pageCount: 1,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "",
        extractedTextPreview:
          "Les entreprises peuvent désormais déclarer leurs salariés via la nouvelle interface TESEO simplifiée.",
        metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
      },
    ],
  },
  {
    id: "public_issue_service_public_2026_06_27",
    sourceId: "service_public_rss",
    title: "Simulateur de revenus net après impôt",
    publicationDate: "2026-06-27T06:00:00.000Z",
    status: "published",
    summary:
      "Un nouveau simulateur en ligne permet d'estimer le revenu net après impôt sur le revenu.",
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
    documents: [
      {
        id: "public_doc_service_public_2026_06_27",
        issueId: "public_issue_service_public_2026_06_27",
        title: "Service-Public.fr - 27 juin 2026",
        fileName: "",
        pageCount: 1,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "",
        extractedTextPreview:
          "Le simulateur prend en compte le barème 2026, la décote, le quotient familial et les réductions fiscales.",
        metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
      },
    ],
  },
  {
    id: "public_issue_info_gouv_2026_06_27",
    sourceId: "info_gouv",
    title: "Présentation du projet de loi de finances 2027",
    publicationDate: "2026-06-27T08:00:00.000Z",
    status: "published",
    summary:
      "Le gouvernement présente les grandes orientations du projet de loi de finances pour 2027.",
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
    documents: [
      {
        id: "public_doc_info_gouv_2026_06_27",
        issueId: "public_issue_info_gouv_2026_06_27",
        title: "Info.gouv.fr - 27 juin 2026",
        fileName: "",
        pageCount: 1,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "",
        extractedTextPreview:
          "Le projet de budget pour 2027 prioritise la transition écologique, la souveraineté technologique et le pouvoir d'achat.",
        metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
      },
    ],
  },
  {
    id: "public_issue_bofip_2026_06_26",
    sourceId: "bofip_impots",
    title: "Mise à jour de la doctrine fiscale - TVA et services numériques",
    publicationDate: "2026-06-26T10:00:00.000Z",
    status: "published",
    summary:
      "Nouvelle doctrine BOFiP sur l'application de la TVA aux services numériques transfrontaliers.",
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
    documents: [
      {
        id: "public_doc_bofip_2026_06_26",
        issueId: "public_issue_bofip_2026_06_26",
        title: "BOFiP - 26 juin 2026",
        fileName: "",
        pageCount: 1,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "",
        extractedTextPreview:
          "La doctrine précise les règles de localisation et les obligations déclaratives pour les prestataires de services numériques établis hors UE.",
        metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
      },
    ],
  },
  {
    id: "public_issue_tresor_2026_06_25",
    sourceId: "tresor",
    title: "Analyse des risques systémiques dans le secteur bancaire européen",
    publicationDate: "2026-06-25T09:00:00.000Z",
    status: "published",
    summary:
      "La Direction générale du Trésor publie une analyse des risques systémiques et des recommandations de supervision.",
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
    documents: [
      {
        id: "public_doc_tresor_2026_06_25",
        issueId: "public_issue_tresor_2026_06_25",
        title: "Trésor - 25 juin 2026",
        fileName: "",
        pageCount: 1,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "",
        extractedTextPreview:
          "L'analyse identifie une concentration accrue des risques de liquidité sur les portefeuilles de titres souverains et appelle à un renforcement des coussins de capital contracycliques.",
        metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
      },
    ],
  },
  {
    id: "public_issue_tresor_2026_06_20",
    sourceId: "tresor",
    title: "Point de conjoncture - Croissance et inflation au T2 2026",
    publicationDate: "2026-06-20T09:00:00.000Z",
    status: "published",
    summary:
      "Note de conjoncture trimestrielle sur les perspectives de croissance et d'inflation en zone euro.",
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
    documents: [
      {
        id: "public_doc_tresor_2026_06_20",
        issueId: "public_issue_tresor_2026_06_20",
        title: "Trésor - 20 juin 2026",
        fileName: "",
        pageCount: 1,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "",
        extractedTextPreview:
          "La croissance française est révisée à la hausse à 0,3% au T2 2026, portée par la consommation des ménages et l'investissement des entreprises.",
        metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
      },
    ],
  },
  {
    id: "public_issue_assemblee_2026_06_24",
    sourceId: "assemblee_nationale",
    title: "Rapport sur la transposition de la directive CSRD",
    publicationDate: "2026-06-24T15:00:00.000Z",
    status: "published",
    summary:
      "Rapport parlementaire détaillant la transposition de la directive sur le reporting de durabilité des entreprises.",
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
    documents: [
      {
        id: "public_doc_assemblee_2026_06_24",
        issueId: "public_issue_assemblee_2026_06_24",
        title: "Assemblée nationale - 24 juin 2026",
        fileName: "",
        pageCount: 1,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "",
        extractedTextPreview:
          "Le rapport propose d'étendre les obligations de reporting de durabilité aux entreprises de plus de 250 salariés et d'harmoniser les standards européens.",
        metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
      },
    ],
  },
  {
    id: "public_issue_senat_2026_06_26",
    sourceId: "senat_press",
    title: "Le Sénat adopte la proposition de loi sur la protection des lanceurs d'alerte",
    publicationDate: "2026-06-26T17:30:00.000Z",
    status: "published",
    summary:
      "Communiqué de presse du Sénat sur l'adoption de la proposition de loi renforçant la protection des lanceurs d'alerte.",
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
    documents: [
      {
        id: "public_doc_senat_2026_06_26",
        issueId: "public_issue_senat_2026_06_26",
        title: "Sénat - 26 juin 2026",
        fileName: "",
        pageCount: 1,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "",
        extractedTextPreview:
          "La proposition de loi élargit le périmètre des signalements protégés, renforce les garanties de confidentialité et crée une autorité indépendante de traitement des alertes.",
        metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
      },
    ],
  },
  {
    id: "public_issue_conseil_etat_2026_06_23",
    sourceId: "conseil_etat_actualites",
    title: "Jurisprudence - Recours abusifs et frais de procédure",
    publicationDate: "2026-06-23T10:00:00.000Z",
    status: "published",
    summary:
      "Le Conseil d'État précise les conditions de condamnation pour recours abusif et la notion de mauvaise foi du requérant.",
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
    documents: [
      {
        id: "public_doc_conseil_etat_2026_06_23",
        issueId: "public_issue_conseil_etat_2026_06_23",
        title: "Conseil d'État - 23 juin 2026",
        fileName: "",
        pageCount: 1,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "",
        extractedTextPreview:
          "Le Conseil d'État rappelle que la condamnation pour recours abusif nécessite de démontrer la mauvaise foi ou l'intention de nuire, et non la simple erreur juridique.",
        metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
      },
    ],
  },
] as const satisfies readonly DemoIssue[];

function latestIssueDate(issues: readonly DemoIssue[]): string | null {
  let latest: string | null = null;
  for (const issue of issues) {
    if (latest === null || issue.publicationDate > latest) {
      latest = issue.publicationDate;
    }
  }
  return latest;
}

export function buildDemoFils(
  sources: readonly DemoSubscriptionSource[],
  publisherIssues: readonly DemoIssue[],
): readonly DemoFil[] {
  const publisherFils: DemoFil[] = sources.map((source) => {
    const sourceIssues = publisherIssues.filter((issue) => issue.sourceId === source.id);
    return {
      id: source.id,
      name: source.name,
      description: source.description,
      sourceType: "publisher_invite" as const,
      subscribed: true,
      lastPublicationDate: latestIssueDate(sourceIssues),
      publisherName: source.branding.publisherName,
      expectedCadence: undefined,
      branding: source.branding,
    };
  });

  const publicFils: DemoFil[] = publicSourceDefinitions.map((def) => {
    const sourceIssues = publicSourceDemoIssues.filter((issue) => issue.sourceId === def.id);
    return {
      id: def.id,
      name: def.displayName,
      description: def.description,
      sourceType: "public" as const,
      subscribed: true,
      lastPublicationDate: latestIssueDate(sourceIssues),
      publisherName: def.publisherName,
      expectedCadence: def.expectedCadence,
      branding: undefined,
    };
  });

  return [...publisherFils, ...publicFils];
}
