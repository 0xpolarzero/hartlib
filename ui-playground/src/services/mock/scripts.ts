import type { CitedSource, RunStageId, VisualSpec } from "@/services/types";
import {
  QUOTES,
  SCRIPT_ARBITRATION_A,
  SCRIPT_ARBITRATION_Q,
  SCRIPT_CHURN_A,
  SCRIPT_CHURN_Q,
  SCRIPT_GROWTH_A,
  SCRIPT_GROWTH_FOLLOWUP_A,
  SCRIPT_GROWTH_FOLLOWUP_Q,
  SCRIPT_GROWTH_Q,
  SCRIPT_RENEWAL_A,
  SCRIPT_RENEWAL_Q,
} from "./content";

export const VISUALS: Record<string, VisualSpec> = {
  growth: {
    kind: "bar",
    id: "viz-growth",
    title: "Abonnés par lettre — T2 vs T3 2026",
    subtitle: "Portefeuille invitations",
    categories: ["Lettre Juridique", "Correspondance Fiscale", "Revue Contentieux"],
    series: [
      { name: "T2 2026", values: [4004, 3731, 1561] },
      { name: "T3 2026", values: [4218, 3876, 1567] },
    ],
    unit: "abonnés",
  },
  growthFollowup: {
    kind: "line",
    id: "viz-growth-followup",
    title: "Lettre Juridique Sociale — solde net mensuel",
    subtitle: "Ventilation T3 2026",
    xLabels: ["Juillet", "Août", "Septembre"],
    series: [{ name: "Solde net", values: [55, 39, 120] }],
    unit: "abonnés",
  },
  arbitration: {
    kind: "kpi",
    id: "viz-arbitration",
    title: "L'arbitrage du télétravail — chiffres clés",
    subtitle: "Hors-série septembre",
    items: [
      { label: "Clauses muettes", value: "63 %", delta: "des clauses de télétravail", direction: "flat" },
      { label: "Durée arbitrée", value: "14 mois", delta: "contre 29 en contentieux", direction: "down" },
      { label: "Stipulations type", value: "11", delta: "clause complète, forfait jours", direction: "flat" },
      { label: "Frais forfaitaires", value: "12 €/mois", delta: "hors instruction écrite", direction: "flat" },
    ],
  },
  renewal: {
    kind: "table",
    id: "viz-renewal",
    title: "Cohorte à risque — 60 jours",
    subtitle: "4 218 abonnés actifs",
    columns: ["Profil", "Abonnés", "Risque", "CA couvert"],
    rows: [
      ["Portefeuilles institutionnels", "61", "critique", "9,4 %"],
      ["Abonnements parrainés 2025", "128", "élevé", "6,1 %"],
      ["Forfait lettre seule", "153", "élevé", "11,8 %"],
    ],
  },
  churn: {
    kind: "bar",
    id: "viz-churn",
    title: "Churn par segment — N vs N-1",
    subtitle: "Annuel glissant, fin septembre",
    categories: ["Grands comptes", "PME directes", "Parrainés"],
    series: [
      { name: "N-1", values: [4.0, 9.6, 13.8] },
      { name: "N", values: [3.1, 7.9, 11.2] },
    ],
    unit: "%",
  },
};

export interface Script {
  id: string;
  /** Accent-insensitive keywords; ≥ 2 distinct hits (or exact question) selects the script. */
  keywords: string[];
  answer: string;
  sources: CitedSource[];
  visual?: VisualSpec;
  referencesVisual?: boolean;
  /** Scripted failure for the first attempt. */
  failure?: { code: string; retryable: boolean; stage: RunStageId };
}

export const SCRIPTS: Script[] = [
  {
    id: "growth",
    keywords: ["compare", "croissance", "abonnes", "trois", "lettres", "trimestre"],
    answer: SCRIPT_GROWTH_A,
    visual: VISUALS.growth,
    referencesVisual: true,
    sources: [
      { ordinal: 1, kind: "document", label: "Synthèse trimestrielle diffusion — T3 2026", quote: QUOTES.growth[0], meta: "p. 2" },
      { ordinal: 2, kind: "document", label: "Synthèse trimestrielle diffusion — T3 2026", quote: QUOTES.growth[1], meta: "p. 5" },
      { ordinal: 3, kind: "document", label: "Rapport campagne « un pair, une lettre »", quote: QUOTES.growth[2], meta: "annexe A" },
      { ordinal: 4, kind: "web", label: "observatoire-presse.pro — baromètre T3", quote: QUOTES.growth[3], meta: "baromètre, §4" },
      { ordinal: 0, kind: "document", label: "Note de conjoncture presse spécialisée", quote: null, meta: "§2" },
      { ordinal: 0, kind: "web", label: "afp.com — dépêche rentrée", quote: "La rentrée 2026 confirme la reprise des abonnements aux lettres professionnelles, avec un net frémissement des sociétés de conseil." },
    ],
  },
  {
    id: "growth-followup",
    keywords: ["decompose", "juridique", "mois", "par", "mois"],
    answer: SCRIPT_GROWTH_FOLLOWUP_A,
    visual: VISUALS.growthFollowup,
    referencesVisual: true,
    sources: [
      { ordinal: 1, kind: "document", label: "Synthèse trimestrielle diffusion — T3 2026", quote: QUOTES.growthFollowup[0], meta: "p. 2" },
      { ordinal: 2, kind: "document", label: "Ventilation mensuelle Lettre Juridique", quote: QUOTES.growthFollowup[1], meta: "extraction" },
      { ordinal: 3, kind: "document", label: "Suivi attrition — lettres à invitation", quote: QUOTES.growthFollowup[2], meta: "p. 9" },
    ],
  },
  {
    id: "arbitration",
    keywords: ["concluait", "dossier", "septembre", "arbitrage", "litiges", "teletravail"],
    answer: SCRIPT_ARBITRATION_A,
    visual: VISUALS.arbitration,
    referencesVisual: true,
    sources: [
      { ordinal: 1, kind: "document", label: "Hors-série — L'arbitrage du télétravail", quote: QUOTES.arbitration[0], meta: "p. 8" },
      { ordinal: 2, kind: "document", label: "Hors-série — annexe clause type", quote: QUOTES.arbitration[1], meta: "annexe 2" },
      { ordinal: 3, kind: "document", label: "N° 214 — Annexe jurisprudence", quote: QUOTES.arbitration[2], meta: "p. 4" },
      { ordinal: 4, kind: "memory", label: "Clause CSE à distance validée", quote: QUOTES.arbitration[3], meta: "rév. 1", memoryId: "mem-3", memoryRevision: 1 },
      { ordinal: 0, kind: "document", label: "Guide pratique CNB — modes alternatifs", quote: null, meta: "ch. 3" },
    ],
  },
  {
    id: "renewal",
    keywords: ["montre", "cohortes", "risque", "renouvellement"],
    answer: SCRIPT_RENEWAL_A,
    visual: VISUALS.renewal,
    referencesVisual: true,
    sources: [
      { ordinal: 1, kind: "document", label: "Fichier cohortes renouvellement — extraction 60 j", quote: QUOTES.renewal[0], meta: "onglet « risque »" },
      { ordinal: 2, kind: "document", label: "Synthèse chiffre d'affaires récurrent", quote: QUOTES.renewal[1], meta: "p. 3" },
      { ordinal: 3, kind: "document", label: "Rapport campagne « un pair, une lettre »", quote: QUOTES.renewal[2], meta: "annexe B" },
      { ordinal: 0, kind: "web", label: "presse-pro.fr — étude fidélisation B2B", quote: "Le taux d'ouverture reste le meilleur prédicteur de renouvellement en presse professionnelle (R² = 0,71 sur 140 titres)." },
    ],
  },
  {
    id: "churn",
    keywords: ["lance", "analyse", "confidentielle", "churn"],
    answer: SCRIPT_CHURN_A,
    visual: VISUALS.churn,
    referencesVisual: true,
    failure: { code: "RUN-429", retryable: true, stage: "evidence" },
    sources: [
      { ordinal: 1, kind: "document", label: "Extraction churn glissant — 12 mois", quote: QUOTES.churn[0], meta: "p. 1" },
      { ordinal: 2, kind: "document", label: "Extraction churn glissant — 12 mois", quote: QUOTES.churn[1], meta: "p. 7" },
      { ordinal: 3, kind: "chat", label: "Croissance des abonnés — T3 (réponse précédente)", quote: "Le prochain juge de paix sera le T4 : les taux de renouvellement observés en octobre dépassent déjà 91 % sur les cohortes parrainées." },
    ],
  },
  {
    id: "fatal",
    keywords: ["compile", "cartographie", "sourcesnon", "publiques"],
    answer: "",
    failure: { code: "RUN-X500", retryable: false, stage: "preparing" },
    sources: [],
  },
];

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");

export function matchScript(text: string): Script | null {
  const n = " " + normalize(text) + " ";
  let best: Script | null = null;
  let bestScore = 0;
  for (const script of SCRIPTS) {
    const hits = script.keywords.filter((k) => n.includes(" " + k) || n.includes(k + " ")).length;
    if (hits > bestScore) {
      best = script;
      bestScore = hits;
    }
  }
  return bestScore >= 2 ? best : null;
}

/** Generic fallback answer for unscripted questions (still cites, no visual). */
export function genericScript(text: string): Script {
  const topic = text.replace(/\s+/g, " ").trim().replace(/^[a-zàâçéèêëîïôûùüÿñæœ]+/, (c) => c.toUpperCase());
  return {
    id: "generic",
    keywords: [],
    answer: `## Réponse au sujet : « ${topic.slice(0, 120)} »

J'ai interrogé l'archive des publications livrées [[1|sur les douze derniers mois, 41 numéros correspondent au sujet]] posé. Voici l'essentiel à retenir.

- [[2|Le sujet est couvert en profondeur par la Lettre Juridique Sociale]], avec trois dossiers longs et un hors-série ;
- la Correspondance Fiscale y consacre une veille régulière, sans dossier de fond sur la période ;
- aucun contentieux en cours n'est identifié à ce propos dans l'archive.

> Si vous souhaitez une analyse plus fine, précisez le périmètre (lettre, période, type de sources) et je relancerai la recherche documentaire.

*Réponse établie hors mémoire conversationnelle — aucune préférence enregistrée ne s'applique ici.*`,
    sources: [
      { ordinal: 1, kind: "document", label: "Index de l'archive livrée — extraction thématique", quote: "41 numéros identifiés sur la fenêtre de douze mois, dont 12 hors-série." },
      { ordinal: 2, kind: "document", label: "Lettre Juridique Sociale — plans de numéro 2026", quote: "Trois dossiers longs et un hors-série couvrent le sujet sur l'exercice." },
      { ordinal: 0, kind: "web", label: "presse-pro.fr — veille réglementaire", quote: null },
    ],
  };
}

export { SCRIPT_GROWTH_Q, SCRIPT_ARBITRATION_Q, SCRIPT_RENEWAL_Q, SCRIPT_CHURN_Q, SCRIPT_GROWTH_FOLLOWUP_Q };
