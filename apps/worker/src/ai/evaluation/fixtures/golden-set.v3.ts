import { GoldenEvaluationSetSchema } from "../schema";

const firstMessageDocument =
  "In 2024, France connected 4.6 GW of new solar capacity. Grid queues remained concentrated in southern regions.";
const followUpDocument =
  "The 2025 outlook projects 5.1 GW of additional solar connections, subject to transformer availability.";
const oldChatEvidence =
  "The earlier comparison found that storage reduced the evening solar ramp by 18 percent in the cited pilot.";
const memoryEvidence = "Prefer concise answers in French and report energy quantities in GWh.";
const oversizedEvidenceDocuments = Array.from({ length: 6 }, (_, regionIndex) => {
  const region = regionIndex + 1;
  const bindingResult =
    `Region ${region} binding conclusion: coordinated storage dispatch reduced curtailment ` +
    `by ${12 + regionIndex} percent.`;
  const searchableHeader =
    `Regional storage-dispatch trial ${region}: audit rules cover curtailment results across ` +
    `the six regional storage-dispatch trials. ${bindingResult}`;
  const auditRows = Array.from(
    { length: 500 },
    (_, rowIndex) =>
      `Region ${region} signed audit row ${rowIndex + 1}: dispatch telemetry confirmed reserve ` +
      "activation, transformer loading, the curtailment baseline, settlement interval integrity, " +
      `and independent checksum R${region}-${rowIndex + 1}. `,
  );
  const firstHalf = auditRows.slice(0, 190).join("");
  const content = `${searchableHeader} ${firstHalf}${auditRows.slice(190).join("")}`;
  const bindingStart = searchableHeader.length - bindingResult.length;
  const acceptableRange = {
    charStart: Math.max(0, bindingStart - 1_050),
    charEnd: bindingStart + 1_150,
  };
  return {
    sourceId: `doc:oversized-grid-study-region-${region}`,
    content,
    bindingResult,
    acceptableRange,
  };
});
const oversizedMemoryEvidence = [
  "ascending regional ordering",
  "percentage-first result fields",
  "concise exception notes",
  "explicit document-versus-memory provenance",
].map((preference, setIndex) => ({
  sourceId: `memory:oversized-audit-${setIndex + 1}:r1`,
  content:
    `Saved preference audit-rule set ${setIndex + 1}: apply ${preference} to every regional trial summary. ` +
    Array.from(
      { length: 4 },
      (_, ruleIndex) =>
        `Saved audit rule ${setIndex + 1}.${ruleIndex + 1}: when presenting regional storage ` +
        `trials, enforce ${preference}, retain the signed percentage, keep source classes ` +
        "separate, and preserve a concise verification note. ",
    ).join(""),
}));
const oversizedRequestPadding = Array.from(
  { length: 450 },
  (_, index) => `Deterministic audit constraint ${index + 1}: retain the binding conclusion.`,
).join(" ");
const solarEvidence =
  "Solar additions reached 4.6 GW, while connection queues grew by 9 percent year over year.";
const storageEvidence =
  "Storage projects supplied 1.2 GW during the evening peak and reduced local congestion.";
const marketWebEvidence =
  "This graph shows the 1/4 hourly prices and volumes on the Epex Spot hub and Nord Pool in France.";

const longConversation = Array.from({ length: 13 }, (_, index) => ({
  turnId: index === 0 ? "turn-old-storage" : `turn-${index + 1}`,
  userContent:
    index === 0
      ? "What did the regional storage pilot show?"
      : `Unrelated newsroom question ${index + 1}`,
  assistantContent:
    index === 0 ? oldChatEvidence : `Unrelated answer about publication workflow ${index + 1}.`,
}));

const canonicalGoldenEvaluationSet = {
  version: 3,
  cases: [
    {
      id: "first-message-document-fr",
      dimensions: ["first_message", "document_retrieval", "web_disabled"],
      locale: "fr-FR",
      market: "FR",
      currentMessage: "Quelle capacité solaire la France a-t-elle raccordée en 2024 ?",
      conversation: [],
      evidence: [
        {
          sourceId: "doc:fr-solar-2024",
          selector: "A",
          kind: "document",
          content: firstMessageDocument,
          ranges: [{ charStart: 0, charEnd: firstMessageDocument.length }],
        },
      ],
      webRequested: false,
      webPolicyEnabled: false,
      labels: {
        relevantTurnIds: [],
        planTurn: {
          mode: "single",
          question: "Capacité solaire raccordée en France en 2024",
          relevantTurnIds: [],
          requiredTermGroups: [["solaire"], ["France"], ["2024"], ["raccordée", "raccordement"]],
        },
        retrievalSelectors: ["A"],
        requiredSourceIds: ["doc:fr-solar-2024"],
        relevantSourceIds: ["doc:fr-solar-2024"],
        acceptableOmissionSourceIds: [],
        acceptableRanges: {
          "doc:fr-solar-2024": [{ charStart: 0, charEnd: firstMessageDocument.length }],
        },
        supportedClaims: [
          { claimId: "fr-solar-added-2024", supportingSourceIds: ["doc:fr-solar-2024"] },
        ],
        expectedGaps: [],
        expectedMemoryProposals: [],
      },
    },
    {
      id: "follow-up-with-irrelevant-recent-turn",
      dimensions: ["follow_up", "irrelevant_recent_history", "document_retrieval"],
      locale: "fr-FR",
      market: "FR",
      currentMessage: "Et quelle est la projection pour 2025 ?",
      conversation: [
        {
          turnId: "turn-solar-2024",
          userContent: "Combien de solaire a été raccordé en 2024 ?",
          assistantContent: "La source indique 4,6 GW.",
        },
        {
          turnId: "turn-editorial",
          userContent: "Résume notre calendrier éditorial.",
          assistantContent: "Trois publications sont prévues mardi.",
        },
      ],
      evidence: [
        {
          sourceId: "doc:fr-solar-2025",
          selector: "A",
          kind: "document",
          content: followUpDocument,
          ranges: [{ charStart: 0, charEnd: followUpDocument.length }],
        },
      ],
      webRequested: false,
      webPolicyEnabled: false,
      labels: {
        relevantTurnIds: ["turn-solar-2024"],
        planTurn: {
          mode: "single",
          question: "Projection des raccordements solaires en France pour 2025",
          relevantTurnIds: ["turn-solar-2024"],
          requiredTermGroups: [["projection", "prévision"], ["solaire"], ["France"], ["2025"]],
        },
        retrievalSelectors: ["A"],
        requiredSourceIds: ["doc:fr-solar-2025"],
        relevantSourceIds: ["doc:fr-solar-2025"],
        acceptableOmissionSourceIds: [],
        acceptableRanges: {
          "doc:fr-solar-2025": [{ charStart: 0, charEnd: followUpDocument.length }],
        },
        supportedClaims: [
          { claimId: "fr-solar-outlook-2025", supportingSourceIds: ["doc:fr-solar-2025"] },
        ],
        expectedGaps: [],
        expectedMemoryProposals: [],
      },
    },
    {
      id: "ambiguous-reference-needs-clarification",
      dimensions: ["follow_up", "ambiguous_reference"],
      locale: "en-US",
      market: "US",
      currentMessage: "Compare it with the previous result.",
      conversation: [
        {
          turnId: "turn-wind",
          userContent: "What was the wind result?",
          assistantContent: "Wind output rose 7 percent.",
        },
        {
          turnId: "turn-solar",
          userContent: "What was the solar result?",
          assistantContent: "Solar output rose 11 percent.",
        },
      ],
      evidence: [],
      webRequested: false,
      webPolicyEnabled: false,
      labels: {
        relevantTurnIds: [],
        planTurn: {
          mode: "clarify",
          question: "wind solar which clarify",
          relevantTurnIds: [],
          requiredQuestionTermGroups: [["wind"], ["solar"], ["which", "clarify"]],
        },
        retrievalSelectors: [],
        requiredSourceIds: [],
        relevantSourceIds: [],
        acceptableOmissionSourceIds: [],
        acceptableRanges: {},
        supportedClaims: [],
        expectedGaps: [],
        expectedMemoryProposals: [],
      },
    },
    {
      id: "long-history-older-chat-evidence",
      dimensions: ["long_history", "older_chat_retrieval", "follow_up"],
      locale: "en-US",
      market: "US",
      currentMessage: "What reduction did that old storage pilot achieve?",
      conversation: longConversation,
      evidence: [
        {
          sourceId: "chat:turn-old-storage",
          selector: "A",
          kind: "chat_message",
          content: oldChatEvidence,
          ranges: [],
        },
      ],
      webRequested: false,
      webPolicyEnabled: false,
      labels: {
        relevantTurnIds: [],
        planTurn: {
          mode: "single",
          question: "Reduction achieved by the earlier regional storage pilot",
          relevantTurnIds: [],
          requiredTermGroups: [
            ["reduction", "reduced"],
            ["storage"],
            ["pilot"],
            ["earlier", "old"],
          ],
        },
        retrievalSelectors: ["A"],
        requiredSourceIds: ["chat:turn-old-storage"],
        relevantSourceIds: ["chat:turn-old-storage"],
        acceptableOmissionSourceIds: [],
        acceptableRanges: {},
        supportedClaims: [
          { claimId: "old-storage-reduction", supportingSourceIds: ["chat:turn-old-storage"] },
        ],
        expectedGaps: [],
        expectedMemoryProposals: [],
      },
    },
    {
      id: "memory-preference-selection-and-update",
      dimensions: ["memory_relevance", "follow_up"],
      locale: "fr-FR",
      market: "FR",
      currentMessage:
        "Applique ma préférence enregistrée, puis mémorise que je veux désormais les quantités en MWh.",
      conversation: [
        {
          turnId: "turn-format",
          userContent: "Peux-tu respecter mon format préféré ?",
          assistantContent: "Oui, je consulterai la préférence enregistrée.",
        },
      ],
      evidence: [
        {
          sourceId: "memory:pref-1:r1",
          selector: "B",
          kind: "memory",
          content: memoryEvidence,
          ranges: [],
        },
      ],
      webRequested: false,
      webPolicyEnabled: false,
      labels: {
        relevantTurnIds: ["turn-format"],
        planTurn: {
          mode: "single",
          question: "Préférence enregistrée de format et nouvelle unité MWh",
          relevantTurnIds: ["turn-format"],
          requiredTermGroups: [["préférence"], ["format", "quantités"], ["MWh"]],
        },
        retrievalSelectors: ["B"],
        requiredSourceIds: ["memory:pref-1:r1"],
        relevantSourceIds: ["memory:pref-1:r1"],
        acceptableOmissionSourceIds: [],
        acceptableRanges: {},
        supportedClaims: [
          { claimId: "saved-format-preference", supportingSourceIds: ["memory:pref-1:r1"] },
        ],
        expectedGaps: [],
        expectedMemoryProposals: [
          {
            action: "update",
            kind: "preference",
            content: "Prefer concise answers in French and report energy quantities in MWh.",
            targetMemoryId: "pref-1",
            expectedHeadRevisionId: "r1",
          },
        ],
      },
    },
    {
      id: "multilingual-live-web-update",
      dimensions: ["web_enabled", "multilingual", "first_message"],
      locale: "en-US",
      market: "FR",
      currentMessage:
        "Give me the latest official interconnector status, mais réponds avec la date exacte.",
      conversation: [],
      evidence: [
        {
          sourceId: "web:operator-interconnector-2026-03-14",
          selector: "W",
          kind: "web",
          content: "The project’s commissioning date is expected for Q4 2028.",
          ranges: [],
          url: "https://www.eirgrid.ie/celticinterconnector",
          title: "Celtic Interconnector | Projects",
          domain: "www.eirgrid.ie",
        },
      ],
      webRequested: true,
      webPolicyEnabled: true,
      labels: {
        relevantTurnIds: [],
        planTurn: {
          mode: "single",
          question: "Latest official interconnector status and exact date",
          relevantTurnIds: [],
          requiredTermGroups: [["latest"], ["official"], ["interconnector"], ["date"]],
        },
        retrievalSelectors: ["W"],
        requiredSourceIds: ["web:operator-interconnector-2026-03-14"],
        relevantSourceIds: ["web:operator-interconnector-2026-03-14"],
        acceptableOmissionSourceIds: [],
        acceptableRanges: {},
        supportedClaims: [
          {
            claimId: "interconnector-return-date",
            supportingSourceIds: ["web:operator-interconnector-2026-03-14"],
          },
        ],
        expectedGaps: [],
        expectedMemoryProposals: [],
      },
    },
    {
      id: "new-memory-instruction-creation",
      dimensions: ["memory_relevance", "first_message"],
      locale: "en-US",
      market: "US",
      currentMessage:
        "Remember that every comparison should state both the absolute and percentage change.",
      conversation: [],
      evidence: [],
      webRequested: false,
      webPolicyEnabled: false,
      labels: {
        relevantTurnIds: [],
        planTurn: {
          mode: "single",
          question: "Remember comparison instruction for absolute and percentage change",
          relevantTurnIds: [],
          requiredTermGroups: [["remember"], ["comparison"], ["absolute"], ["percentage"]],
        },
        retrievalSelectors: [],
        requiredSourceIds: [],
        relevantSourceIds: [],
        acceptableOmissionSourceIds: [],
        acceptableRanges: {},
        supportedClaims: [],
        expectedGaps: [],
        expectedMemoryProposals: [
          {
            action: "create",
            kind: "instruction",
            content: "Every comparison should state both the absolute and percentage change.",
            targetMemoryId: null,
            expectedHeadRevisionId: null,
          },
        ],
      },
    },
    {
      id: "oversized-document-requires-reduction",
      dimensions: [
        "oversized_evidence",
        "document_retrieval",
        "memory_relevance",
        "first_message",
        "web_disabled",
      ],
      locale: "en-US",
      market: "US",
      currentMessage:
        "Using all four saved audit-rule sets, compare the curtailment results across the six regional storage-dispatch trials.",
      conversation: [],
      evidence: [
        ...oversizedEvidenceDocuments.map((document) => ({
          sourceId: document.sourceId,
          selector: "A" as const,
          kind: "document" as const,
          content: document.content,
          ranges: [{ charStart: 0, charEnd: document.content.length }],
        })),
        ...oversizedMemoryEvidence.map((memory) => ({
          sourceId: memory.sourceId,
          selector: "B",
          kind: "memory",
          content: memory.content,
          ranges: [],
        })),
      ],
      webRequested: false,
      webPolicyEnabled: false,
      labels: {
        relevantTurnIds: [],
        planTurn: {
          mode: "single",
          question: `Curtailment reductions across six regional storage-dispatch trials using all four saved audit-rule sets ${oversizedRequestPadding}`,
          relevantTurnIds: [],
          requiredTermGroups: [
            ["curtailment"],
            ["storage"],
            ["dispatch"],
            ["regional", "region"],
            ["six", "6"],
            ["audit"],
            ["rules"],
          ],
        },
        retrievalSelectors: ["A", "B"],
        requiredSourceIds: [
          ...oversizedEvidenceDocuments.map((document) => document.sourceId),
          ...oversizedMemoryEvidence.map((memory) => memory.sourceId),
        ],
        relevantSourceIds: [
          ...oversizedEvidenceDocuments.map((document) => document.sourceId),
          ...oversizedMemoryEvidence.map((memory) => memory.sourceId),
        ],
        acceptableOmissionSourceIds: [],
        acceptableRanges: Object.fromEntries(
          oversizedEvidenceDocuments.map((document) => [
            document.sourceId,
            [document.acceptableRange],
          ]),
        ),
        supportedClaims: oversizedEvidenceDocuments
          .map((document, regionIndex) => ({
            claimId: `coordinated-storage-curtailment-region-${regionIndex + 1}`,
            supportingSourceIds: [document.sourceId],
          }))
          .concat(
            oversizedMemoryEvidence.map((memory, setIndex) => ({
              claimId: `saved-regional-audit-rule-set-${setIndex + 1}`,
              supportingSourceIds: [memory.sourceId],
            })),
          ),
        expectedGaps: [],
        expectedMemoryProposals: [],
      },
    },
    {
      id: "cross-cutting-separable-energy-question",
      dimensions: ["cross_cutting", "separable_multi_topic", "web_enabled"],
      locale: "en-US",
      market: "FR",
      currentMessage:
        "Compare solar connections and storage operations, then explain the current market-price signal from the official France Spot Electricity Exchange.",
      conversation: [],
      evidence: [
        {
          sourceId: "doc:solar-connections",
          selector: "A",
          kind: "document",
          content: solarEvidence,
          ranges: [{ charStart: 0, charEnd: solarEvidence.length }],
        },
        {
          sourceId: "doc:storage-operations",
          selector: "A",
          kind: "document",
          content: storageEvidence,
          ranges: [{ charStart: 0, charEnd: storageEvidence.length }],
        },
        {
          sourceId: "web:market-price-signal",
          selector: "W",
          kind: "web",
          content: marketWebEvidence,
          ranges: [],
          url: "https://www.services-rte.com/en/view-data-published-by-rte/france-spot-electricity-exchange.html",
          title: "France Spot Electricity Exchange - RTE Services Portal",
          domain: "www.services-rte.com",
        },
        {
          sourceId: "doc:optional-grid-background",
          selector: "A",
          kind: "document",
          content: "Background definitions for congestion management and balancing reserves.",
          ranges: [{ charStart: 0, charEnd: 70 }],
        },
      ],
      webRequested: true,
      webPolicyEnabled: true,
      labels: {
        relevantTurnIds: [],
        planTurn: {
          mode: "fanout",
          question: "Solar connections, storage operations, and current market-price signal",
          topics: [
            {
              topicId: "t1",
              question: "What do the solar connection sources report?",
              relevantTurnIds: [],
            },
            {
              topicId: "t2",
              question: "What do the storage operation sources report?",
              relevantTurnIds: [],
            },
            {
              topicId: "t3",
              question: "What is the current official market-price signal?",
              relevantTurnIds: [],
            },
          ],
        },
        retrievalSelectors: ["A", "W"],
        requiredSourceIds: [
          "doc:solar-connections",
          "doc:storage-operations",
          "web:market-price-signal",
        ],
        relevantSourceIds: [
          "doc:solar-connections",
          "doc:storage-operations",
          "web:market-price-signal",
          "doc:optional-grid-background",
        ],
        acceptableOmissionSourceIds: ["doc:optional-grid-background"],
        acceptableRanges: {
          "doc:solar-connections": [{ charStart: 0, charEnd: solarEvidence.length }],
          "doc:storage-operations": [{ charStart: 0, charEnd: storageEvidence.length }],
          "doc:optional-grid-background": [{ charStart: 0, charEnd: 70 }],
        },
        supportedClaims: [
          { claimId: "solar-connection-result", supportingSourceIds: ["doc:solar-connections"] },
          { claimId: "storage-operation-result", supportingSourceIds: ["doc:storage-operations"] },
          { claimId: "market-price-result", supportingSourceIds: ["web:market-price-signal"] },
        ],
        expectedGaps: [],
        expectedMemoryProposals: [],
      },
    },
    {
      id: "out-of-corpus-with-web-off",
      dimensions: ["out_of_corpus", "web_disabled", "first_message"],
      locale: "en-US",
      market: "US",
      currentMessage: "What was the verified 2027 lunar-grid capacity award?",
      conversation: [],
      evidence: [],
      webRequested: false,
      webPolicyEnabled: false,
      labels: {
        relevantTurnIds: [],
        planTurn: {
          mode: "single",
          question: "Verified 2027 lunar-grid capacity award",
          relevantTurnIds: [],
          requiredTermGroups: [["2027"], ["lunar"], ["grid"], ["capacity"], ["award"]],
        },
        retrievalSelectors: [],
        requiredSourceIds: [],
        relevantSourceIds: [],
        acceptableOmissionSourceIds: [],
        acceptableRanges: {},
        supportedClaims: [],
        expectedGaps: [
          {
            gapId: "no-verifiable-source",
            description: "No authorized source supports the claim.",
          },
        ],
        expectedMemoryProposals: [],
      },
    },
  ],
} as const;

export const CanonicalGoldenEvaluationSet = GoldenEvaluationSetSchema.parse({
  version: 3,
  cases: canonicalGoldenEvaluationSet.cases,
});
