/*
 * French professional-publishing seed content. Editorial material is authored
 * to read like real copy from a press house — no lorem ipsum anywhere.
 * UI chrome is translated via i18n; editorial content stays French in both
 * locales (as real French titles would in an English interface).
 */

export const HOUSE = "Bref.";

export const SOURCES: { id: string; name: string; type: "invitation" | "public"; days: number; subs: number; sub: 0 | 1 }[] = [
  { id: "src-1", name: "Lettre Juridique Sociale", type: "invitation", days: 2, subs: 4218, sub: 1 },
  { id: "src-2", name: "La Correspondance Fiscale", type: "invitation", days: 5, subs: 3876, sub: 1 },
  { id: "src-3", name: "Registre des Sociétés Cotées", type: "public", days: 1, subs: 11290, sub: 1 },
  { id: "src-4", name: "Alertes AMF — Fil Presse", type: "public", days: 0, subs: 5210, sub: 0 },
  { id: "src-5", name: "L'Éclairage Réglementaire UE", type: "invitation", days: 9, subs: 2044, sub: 1 },
  { id: "src-6", name: "Revue Contentieux & Arbitrage", type: "invitation", days: 21, subs: 1567, sub: 0 },
  { id: "src-7", name: "Bulletin Officiel des Marchés", type: "public", days: 3, subs: 8301, sub: 1 },
  { id: "src-8", name: "Mémento Paie & RémoNég", type: "invitation", days: 13, subs: 976, sub: 0 },
];

export const PUBLICATIONS: {
  id: string;
  title: string;
  sourceId: string;
  status: "published" | "scheduled" | "draft";
  publishedDaysAgo: number | null;
  scheduledInDays: number | null;
  autoDeleteInDays: number | null;
  subs: number;
  open: number;
  summary: string;
}[] = [
  {
    id: "pub-1",
    title: "N° 214 — Télétravail : la jurisprudence tranche sur le remboursement des frais",
    sourceId: "src-1",
    status: "published",
    publishedDaysAgo: 2,
    scheduledInDays: null,
    autoDeleteInDays: null,
    subs: 4188,
    open: 0.612,
    summary:
      "Trois arrêts d'appel convergent : l'employeur doit prendre en charge les frais professionnels engagés sur instruction, même hors contrat de télétravail écrit. Analyse des motifs et risques contentieux.",
  },
  {
    id: "pub-2",
    title: "N° 118 — Plus-values de cession : le régime faveur des titres de jeunes entreprises maintenu",
    sourceId: "src-2",
    status: "published",
    publishedDaysAgo: 5,
    scheduledInDays: null,
    autoDeleteInDays: null,
    subs: 3804,
    open: 0.544,
    summary:
      "Le dispositif d'exonération partielle est prorogé jusqu'en 2029 sous conditions d'effectif. Point complet sur les engagements de réinvestissement et les pièges de récipiscience.",
  },
  {
    id: "pub-3",
    title: "Revue hebdomadaire — Semaine 34 : cinq annonces à surveiller",
    sourceId: "src-3",
    status: "published",
    publishedDaysAgo: 1,
    scheduledInDays: null,
    autoDeleteInDays: null,
    subs: 11021,
    open: 0.471,
    summary:
      "Déclarations de franchissement, rachats programmés et nominations : la sélection des opérations structurantes de la semaine, avec notre lecture des intentions.",
  },
  {
    id: "pub-4",
    title: "Éclair n° 42 — CSRD : le reporting allégé entre en vigueur pour les PME cotées",
    sourceId: "src-5",
    status: "published",
    publishedDaysAgo: 9,
    scheduledInDays: null,
    autoDeleteInDays: null,
    subs: 2011,
    open: 0.589,
    summary:
      "Grille de 12 indicateurs, calendrier de dépôt et sanctions encourues. Ce que les directions financières doivent préparer avant le premier exercice couvert.",
  },
  {
    id: "pub-5",
    title: "N° 215 — Litiges collectifs : la classe à la française trouve son rythme",
    sourceId: "src-6",
    status: "published",
    publishedDaysAgo: 21,
    scheduledInDays: null,
    autoDeleteInDays: 26,
    subs: 1521,
    open: 0.497,
    summary:
      "Première année d'application complète de l'action de groupe étendue au climat : bilan chiffré, tactiques de défense, et ce que révèlent les décisions rendues.",
  },
  {
    id: "pub-6",
    title: "N° 216 — Restructurations : la consultation CSE à distance validée",
    sourceId: "src-1",
    status: "scheduled",
    publishedDaysAgo: null,
    scheduledInDays: 3,
    autoDeleteInDays: null,
    subs: 4218,
    open: 0,
    summary:
      "La Cour de cassation admet la visioconférence pour les réunions extraordinaires, sous réserve de garanties d'accès. Modalités pratiques et modèles de convocation.",
  },
  {
    id: "pub-7",
    title: "N° 119 — Défis de la dette convertible : clauses à renégocier avant 2027",
    sourceId: "src-2",
    status: "scheduled",
    publishedDaysAgo: null,
    scheduledInDays: 10,
    autoDeleteInDays: null,
    subs: 3876,
    open: 0,
    summary:
      "Taux de conversion, ratchets et clauses de sortie anticipée : l'état du marché et les stipulations que les émetteurs mal préparés regrettent déjà.",
  },
  {
    id: "pub-8",
    title: "Éclair n° 43 — Sanctions UE : le régime de compliance « preuve vivante »",
    sourceId: "src-5",
    status: "draft",
    publishedDaysAgo: null,
    scheduledInDays: null,
    autoDeleteInDays: null,
    subs: 0,
    open: 0,
    summary:
      "Brouillon en relecture. La charge probatoire bascule vers des dispositifs documentés en continu ; premières recommandations opérationnelles.",
  },
  {
    id: "pub-9",
    title: "Revue hebdomadaire — Semaine 35 : portée et limites du nouveau contrôle étranger",
    sourceId: "src-3",
    status: "draft",
    publishedDaysAgo: null,
    scheduledInDays: null,
    autoDeleteInDays: null,
    subs: 0,
    open: 0,
    summary:
      "Brouillon. Cartographie des secteurs couverts, seuils de notification et délais d'instruction pour les acquéreurs extra-européens.",
  },
  {
    id: "pub-10",
    title: "Hors-série — L'arbitrage du télétravail, mode d'emploi (dossier long)",
    sourceId: "src-6",
    status: "published",
    publishedDaysAgo: 34,
    scheduledInDays: null,
    autoDeleteInDays: null,
    subs: 1498,
    open: 0.655,
    summary:
      "Dossier de 24 pages : clause type de télétravail, forfait jours et droit à la déconnexion, jurisprudence sociale annotée, arbitrage des litiges transfrontaliers.",
  },
  {
    id: "pub-11",
    title: "N° 120 — Retraite supplémentaire : les PER d'entreprise sous la loupe",
    sourceId: "src-2",
    status: "published",
    publishedDaysAgo: 12,
    scheduledInDays: null,
    autoDeleteInDays: null,
    subs: 3733,
    open: 0.418,
    summary:
      "Frais réels, options d'investissement et sortie en rente : comparatif des dispositifs collectifs et points de vigilance fiscale pour 2027.",
  },
  {
    id: "pub-12",
    title: "N° 217 — Salaires & grilles : l'index égalité recalculé",
    sourceId: "src-1",
    status: "published",
    publishedDaysAgo: 16,
    scheduledInDays: null,
    autoDeleteInDays: 89,
    subs: 4102,
    open: 0.523,
    summary:
      "Nouvelle méthode de calcul des écarts de rémunération : ce qui change pour les entreprises de 50 à 250 salariés, avec simulateur commenté.",
  },
];

export const DOCUMENTS: {
  id: string;
  title: string;
  description: string;
  kb: number;
  missing: boolean;
  pub: string | null;
}[] = [
  { id: "doc-1", title: "N214_teletravail_frais.pdf", description: "Lettre complète — 12 pages, version diffuseur.", kb: 842, missing: false, pub: "pub-1" },
  { id: "doc-2", title: "Annexe_Jurisprudence_2026.pdf", description: "Tableau des trois arrêts motifs par motifs.", kb: 218, missing: false, pub: "pub-1" },
  { id: "doc-3", title: "N118_plus_values.pdf", description: "Lettre complète — 9 pages.", kb: 601, missing: false, pub: "pub-2" },
  { id: "doc-4", title: "Grille_CSBRD_PME.xlsx.export.pdf", description: "Export PDF de la grille des 12 indicateurs.", kb: 96, missing: false, pub: "pub-4" },
  { id: "doc-5", title: "HorsSerie_Arbitrage_Teletravail.pdf", description: "Dossier long 24 pages, reliure numérique.", kb: 2410, missing: false, pub: "pub-10" },
  { id: "doc-6", title: "Semaine34_Revue.pdf", description: "Revue hebdomadaire — mise en page diffuseur.", kb: 388, missing: false, pub: "pub-3" },
  { id: "doc-7", title: "N215_Litiges_collectifs.pdf", description: "Lettre complète — fichier non répliqué sur le stockage.", kb: 780, missing: true, pub: "pub-5" },
  { id: "doc-8", title: "Index_Egalite_Simulateur.pdf", description: "Notice du simulateur commenté, N° 217.", kb: 154, missing: false, pub: "pub-12" },
];

export const COMPANIES: { id: string; name: string; city: string }[] = [
  { id: "co-1", name: "Dupont & Cie", city: "Lyon" },
  { id: "co-2", name: "Groupe Vallée", city: "Nantes" },
  { id: "co-3", name: "SARL Meunier Frères", city: "Reims" },
  { id: "co-4", name: "Cabinet Aubert & Lenoir", city: "Paris" },
  { id: "co-5", name: "Holdings Marceau", city: "Lille" },
  { id: "co-6", name: "Technoforge Sud-Ouest", city: "Toulouse" },
  { id: "co-7", name: "Éditions du Phare", city: "Marseille" },
  { id: "co-8", name: "Assurances Berthelot", city: "Rennes" },
  { id: "co-9", name: "Cabinet Nakache", city: "Strasbourg" },
  { id: "co-10", name: "Société des Carrières Unies", city: "Amiens" },
  { id: "co-11", name: "Ateliers Réunis de Saumur", city: "Saumur" },
  { id: "co-12", name: "Filatures du Nord", city: "Roubaix" },
  { id: "co-13", name: "Transports Oliveira", city: "Bordeaux" },
  { id: "co-14", name: "Laboratoires Sereno", city: "Nice" },
  { id: "co-15", name: "Bureaux d'études Vasseur", city: "Orléans" },
];

/* ── Scripted assistant answers ──────────────────────────────────────────
 * Citation markers: [[1]] bare chip · [[1,2|claim text]] chip + tinted claim span.
 */

export const SCRIPT_GROWTH_Q = "Compare la croissance des abonnés de nos trois lettres sur le troisième trimestre.";

export const SCRIPT_GROWTH_A = `## Croissance des abonnés — T3 2026

Sur le trimestre, [[1|les trois lettres à invitation gagnent ensemble 512 abonnés nets]], soit une progression de 5,9 % par rapport au T2. La lecture reste contrastée : [[2|la Lettre Juridique Sociale concentre à elle seule 42 % de la croissance]], tandis que la Revue Contentieux marque le pas.

| Lettre | T2 2026 | T3 2026 | Variation |
| --- | --- | --- | --- |
| Lettre Juridique Sociale | 4 004 | 4 218 | +214 |
| La Correspondance Fiscale | 3 731 | 3 876 | +145 |
| Revue Contentieux & Arbitrage | 1 561 | 1 567 | +6 |

Trois facteurs ressortent de l'analyse :

- [[3|la campagne de parrainage « un pair, une lettre » a converti à 18 %]], contre 11 % pour la précédente édition ;
- la Correspondance Fiscale bénéficie d'un effet d'annonce réglementaire, sans révision durable des prix ;
- la Revue Contentieux subit le non-renouvellement de deux portefeuilles institutionnels.

> La croissance du T3 est saine mais concentrée : une seule lettre porte près de la moitié du gain net. Diversifier les relances de fin d'année limiterait la dépendance.

Le prochain juge de paix sera le T4 : [[4|les taux de renouvellement observés en octobre dépassent déjà 91 %]] sur les cohortes parrainées.`;

export const SCRIPT_GROWTH_FOLLOWUP_Q = "Décompose la Lettre Juridique mois par mois.";

export const SCRIPT_GROWTH_FOLLOWUP_A = `## Lettre Juridique Sociale — détail mensuel

Comme je le notais dans ma première réponse, [[1|le gain net du trimestre s'établit à 214 abonnés]]. Voici la ventilation mensuelle :

| Mois | Entrées | Sorties | Solde net |
| --- | --- | --- | --- |
| Juillet | 96 | 41 | +55 |
| Août | 61 | 22 | +39 |
| Septembre | 148 | 28 | +120 |

[[2|Septembre porte l'essentiel du trimestre : le solde net y double par rapport à juillet]], porté par la rentrée et la diffusion de l'arrêt sur le télétravail. [[3|Le taux d'attrition reste maîtrisé sous 1 % par mois]] — aucun épisode de résiliation groupée n'est signalé par le service abonnements.

> Point de vigilance : la base de juillet contient un nombre anormalement élevé d'abonnements offerts ; leur conversion en payant au 31 décembre conditionnera le vrai gain de l'année.`;

export const SCRIPT_ARBITRATION_Q = "Que concluait le dossier de septembre sur l'arbitrage des litiges de télétravail ?";

export const SCRIPT_ARBITRATION_A = `## Ce que retenait le dossier de septembre

Le hors-série part d'un constat : [[1|en 2026, 63 % des clauses de télétravail restent muettes sur le règlement des différends]]. Le dossier recommande de stipuler d'emblée la médiation préalable, puis l'arbitrage ad hoc, avant toute saisine prud'homale.

> « Une clause d'arbitrage bien rédigée ne supprime pas le litige ; elle lui donne un calendrier. » — Hors-série, p. 14

Trois apports concrets :

- [[2|une clause type en onze stipulations]], compatible forfait jours et droit à la déconnexion, reproduite en annexe ;
- [[3|une grille de répartition des frais de télétravail opposable en médiation]], alignée sur la jurisprudence la plus récente ;
- la suggestion d'inscrire ces règles dans la mémoire du service — [[4|que le télétravail en visioconférence des CSE est désormais validé]] sous conditions d'accès, point que nous avions déjà archivé ensemble.

Le dossier conclut que [[1|la voie arbitrale divisait par deux la durée moyenne des différends]] dans l'échantillon étudié (14 mois contre 29 en contentieux classique).`;

export const SCRIPT_RENEWAL_Q = "Montre-moi la cohorte à risque du point de renouvellement.";

export const SCRIPT_RENEWAL_A = `## Cohorte à risque — renouvellements à 60 jours

[[1|Sur 4 218 abonnés actifs, 342 présentent un indicateur de risque élevé ou critique]], soit 8,1 % du portefeuille. Le risque se concentre sur trois profils :

| Profil | Abonnés | Risque | Motif dominant |
| --- | --- | --- | --- |
| Portefeuilles institutionnels | 61 | critique | non-renouvellement budgétaire |
| Abonnements parrainés 2025 | 128 | élevé | conversion offert → payant |
| Titulaires du forfait lettre seule | 153 | élevé | concurrence presse en ligne |

[[2|Les 61 portefeuilles institutionnels couvrent 9,4 % du chiffre d'affaires récurrent]] : leur départ simultané serait le scénario le plus coûteux. À l'inverse, [[3|les cohortes parrainées affichent un taux d'ouverture supérieur de 12 points à la moyenne]], signe d'un attachement réel à convertir.

> Recommandation du service : déclencher les relances à J-45, en commençant par les portefeuilles dont l'exercice budgétaire clôture au 31 décembre.`;

export const SCRIPT_CHURN_Q = "Lance l'analyse confidentielle du churn.";

export const SCRIPT_CHURN_A = `## Analyse du churn — synthèse confidentielle

Après réexécution complète : [[1|le churn annuel ressort à 6,8 %, contre 8,4 % l'an dernier]], soit 1,6 point gagné sur douze mois.

| Segment | Churn N | Churn N-1 | Tendance |
| --- | --- | --- | --- |
| Grands comptes | 3,1 % | 4,0 % | ▼ 0,9 pt |
| PME directes | 7,9 % | 9,6 % | ▼ 1,7 pt |
| Abonnés parrainés | 11,2 % | 13,8 % | ▼ 2,6 pt |

[[2|La baisse est la plus nette chez les abonnés parrainés — précisément le segment le plus volatil en N-1]]. Le déploiement des synthèses hebdomadaires y est corrélé à une réduction des résiliations immédiates. [[3|Le churn des grands comptes n'a jamais été aussi bas depuis quatre exercices]].

> Lecture du service : la stabilisation tient à deux leviers — la régularité du rythme d'envoi et la personnalisation des synthèses. Maintenir les deux coûte moins que reconquérir un abonné perdu (coût estimé ×3,2).`;

export const SCRIPT_FATAL_Q = "Compile la cartographie confidentielle des sourcesnon publiques.";

export const SCRIPT_MEMORIES: {
  id: string;
  label: string;
  content: string;
  origin: string;
  daysAgo: number;
  updatedDaysAgo: number;
  deletedDaysAgo: number | null;
  revisions: { daysAgo: number; origin: string; content: string }[];
}[] = [
  {
    id: "mem-1",
    label: "Préférence de synthèse — Dupont & Cie",
    content: "Dupont & Cie préfère recevoir une synthèse hebdomadaire le jeudi matin, avant 9 h, plutôt que les envois au fil de l'eau.",
    origin: "« Peux-tu me tout regrouper en une seule note le jeudi ? » — Croissance des abonnés — T3",
    daysAgo: 41,
    updatedDaysAgo: 3,
    deletedDaysAgo: null,
    revisions: [
      { daysAgo: 41, origin: "Créée depuis la conversation", content: "Dupont & Cie veut une synthèse hebdomadaire." },
      { daysAgo: 17, origin: "Complétée sur précision de l'abonné", content: "Dupont & Cie préfère une synthèse hebdomadaire, envoyée le jeudi." },
      { daysAgo: 3, origin: "Horaires précisés par le lecteur", content: "Dupont & Cie préfère recevoir une synthèse hebdomadaire le jeudi matin, avant 9 h, plutôt que les envois au fil de l'eau." },
    ],
  },
  {
    id: "mem-2",
    label: "Renouvellement — Groupe Vallée",
    content: "Le renouvellement du Groupe Vallée est arbitré au comité du 15 octobre ; budget validé sauf contre-ordre du directeur financier.",
    origin: "« On saura au comité d'octobre pour Vallée » — Risques de renouvellement",
    daysAgo: 23,
    updatedDaysAgo: 23,
    deletedDaysAgo: null,
    revisions: [{ daysAgo: 23, origin: "Créée depuis la conversation", content: "Le renouvellement du Groupe Vallée est arbitré au comité du 15 octobre ; budget validé sauf contre-ordre du directeur financier." }],
  },
  {
    id: "mem-3",
    label: "Clause CSE à distance validée",
    content: "La consultation CSE entièrement à distance est validée par la Cour de cassation sous réserve de garanties d'accès (arrêt commenté dans le N° 216, à paraître).",
    origin: "« Retiens que la visio pour les CSE extraordinaires est validée » — Arbitrage du télétravail",
    daysAgo: 12,
    updatedDaysAgo: 12,
    deletedDaysAgo: null,
    revisions: [{ daysAgo: 12, origin: "Créée depuis la conversation", content: "La consultation CSE entièrement à distance est validée par la Cour de cassation sous réserve de garanties d'accès (arrêt commenté dans le N° 216, à paraître)." }],
  },
  {
    id: "mem-4",
    label: "Index égalité — simulateur N° 217",
    content: "L'index égalité est recalculé avec la nouvelle méthode pour les 50–250 salariés ; le simulateur commenté du N° 217 sert de référence aux abonnés RH.",
    origin: "« Garde le simulateur du 217 sous la main » — Lettre Juridique Sociale",
    daysAgo: 16,
    updatedDaysAgo: 8,
    deletedDaysAgo: null,
    revisions: [
      { daysAgo: 16, origin: "Créée depuis la conversation", content: "L'index égalité est recalculé pour les 50–250 salariés." },
      { daysAgo: 8, origin: "Référence au simulateur ajoutée", content: "L'index égalité est recalculé avec la nouvelle méthode pour les 50–250 salariés ; le simulateur commenté du N° 217 sert de référence aux abonnés RH." },
    ],
  },
  {
    id: "mem-5",
    label: "Relances à J-45",
    content: "Les relances de renouvellement se déclenchent à J-45, en commençant par les portefeuilles à clôture budgétaire au 31 décembre.",
    origin: "« On relance toujours 45 jours avant » — Risques de renouvellement",
    daysAgo: 6,
    updatedDaysAgo: 6,
    deletedDaysAgo: null,
    revisions: [{ daysAgo: 6, origin: "Créée depuis la conversation", content: "Les relances de renouvellement se déclenchent à J-45, en commençant par les portefeuilles à clôture budgétaire au 31 décembre." }],
  },
  {
    id: "mem-6",
    label: "Interlocutrice — Cabinet Aubert & Lenoir",
    content: "Chez Aubert & Lenoir, la lectrice de référence pour le contentieux est Me Lenoir ; ne pas envoyer de sollicitations commerciales.",
    origin: "« C'est Me Lenoir qui suit le contentieux chez eux » — Revue Contentieux",
    daysAgo: 55,
    updatedDaysAgo: 55,
    deletedDaysAgo: 5,
    revisions: [{ daysAgo: 55, origin: "Créée depuis la conversation", content: "Chez Aubert & Lenoir, la lectrice de référence pour le contentieux est Me Lenoir ; ne pas envoyer de sollicitations commerciales." }],
  },
  {
    id: "mem-7",
    label: "Seuil d'alerte churn",
    content: "Au-delà de 8 % de churn annuel glissant, une cellule de rétention est activée avec revue hebdomadaire.",
    origin: "« Alerte si on passe 8 % de churn » — Analyse du churn",
    daysAgo: 2,
    updatedDaysAgo: 2,
    deletedDaysAgo: null,
    revisions: [{ daysAgo: 2, origin: "Créée depuis la conversation", content: "Au-delà de 8 % de churn annuel glissant, une cellule de rétention est activée avec revue hebdomadaire." }],
  },
];

/** Quotes backing citations, by script. */
export const QUOTES = {
  growth: [
    "Les trois lettres à invitation affichent un solde net de +512 abonnés sur le trimestre, à comparer aux +431 du T2.",
    "La Lettre Juridique Sociale revendique 214 abonnés nets sur le T3, soit 42 % du gain consolidé des lettres à invitation.",
    "Campagne « un pair, une lettre » : 1 240 invitations émises, 223 conversions, taux de 18,0 % (11,3 % pour l'édition précédente).",
    "Cohortes parrainées T2 : taux de renouvellement constaté à fin septembre — 91,4 %.",
  ],
  growthFollowup: [
    "Solde net T3 pour la Lettre Juridique Sociale : +214 (96/41 en juillet, 61/22 en août, 148/28 en septembre).",
    "Le mois de septembre concentre 56 % du solde net trimestriel ; la rentrée et l'arrêt télétravail expliquent le pic d'entrées.",
    "Attrition mensuelle de la Lettre Juridique : 0,8 % en moyenne sur le trimestre, sans épisode de résiliation groupée.",
  ],
  arbitration: [
    "Étude des 241 clauses recensées : 63 % ne comportent aucune stipulation de règlement des différends liés au télétravail.",
    "Clause type du hors-série : onze stipulations, dont médiation préalable de 30 jours et arbitrage ad hoc à siège de Paris.",
    "Grille de répartition des frais : prise en charge forfaitaire de 12 €/mois hors instruction écrite, indemnisation au réel sinon.",
    "Arrêt du 12 juin 2026 : la visioconférence est admise pour les réunions extraordinaires du CSE sous garanties d'accès.",
  ],
  renewal: [
    "342 abonnés sur 4 218 (8,1 %) présentent un indicateur de risque élevé ou critique à 60 jours du terme.",
    "Les 61 portefeuilles institutionnels représentent 9,4 % du chiffre d'affaires récurrent de la lettre.",
    "Cohortes parrainées 2025 : taux d'ouverture moyen de 71 %, contre 59 % pour la base directe.",
  ],
  churn: [
    "Churn annuel glissant : 6,8 % (N-1 : 8,4 %). Mesure à fin septembre, portefeuille toutes lettres.",
    "Segment parrainé : 11,2 % contre 13,8 % en N-1 ; la corrélation avec les synthèses hebdomadaires est la plus forte.",
    "Grands comptes : churn à 3,1 %, plus bas niveau depuis quatre exercices.",
  ],
};
