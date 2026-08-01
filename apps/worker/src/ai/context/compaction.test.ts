import { describe, expect, it } from "vitest";

import {
  CandidateLedgerSchema,
  candidateLocalId,
  isRunLocalId,
  toProviderCandidateView,
  type CandidateLedger,
  type CandidateLedgerEntry,
} from "../workflow/types";
import {
  buildCandidatePassageIndex,
  createCompactionGroups,
  createFallbackCompactionGroups,
  mergeGroupCompactionResults,
  validateFallbackGroupCompactionResult,
  validateFallbackContextManifest,
  validateGroupCompactionResult,
  validateInitialContextManifest,
  validateTightenedGroupCompactionResult,
} from "./compaction";
import { buildPassageIndex, mapPassageIdsToRanges } from "./passages";

const hash = "a".repeat(64);
const passageOptions = {
  maxTokens: 6,
  maxUtf8Bytes: 64,
  countTokens: (text: string) => Array.from(text).length,
};
const ledger: CandidateLedger = {
  candidates: [
    {
      candidateId: "c1",
      kind: "document",
      identity: {
        kind: "public_document",
        sourceId: "s",
        documentId: "d1",
        snapshotId: "v1",
        contentHash: hash,
      },
      provenance: { label: "Document", purpose: "answer", date: null },
      text: "Alpha. Beta.",
      baseRanges: [{ charStart: 0, charEnd: 12 }],
      previewRanges: [{ charStart: 0, charEnd: 6 }],
      preview: "Alpha.",
      renderedTokenCount: 30,
    },
    {
      candidateId: "c2",
      kind: "document",
      identity: {
        kind: "public_document",
        sourceId: "s",
        documentId: "d2",
        snapshotId: "v1",
        contentHash: hash,
      },
      provenance: { label: "Document 2", purpose: "answer", date: null },
      text: "Keep me.",
      baseRanges: [{ charStart: 0, charEnd: 8 }],
      previewRanges: [{ charStart: 0, charEnd: 8 }],
      preview: "Keep me.",
      renderedTokenCount: 10,
    },
    {
      candidateId: "c3",
      kind: "web",
      identity: {
        kind: "web",
        canonicalUrl: "https://example.com/a",
        quoteHash: "A".repeat(43),
        capturedAt: "2026-01-01T00:00:00Z",
      },
      provenance: { label: "Web", purpose: "answer", date: null },
      text: "Web.",
      baseRanges: [{ charStart: 0, charEnd: 4 }],
      previewRanges: [{ charStart: 0, charEnd: 4 }],
      preview: "Web.",
      renderedTokenCount: 3,
    },
  ],
};

const initialValue = {
  decisions: [
    { candidateId: "c1", action: "compact" as const, groupId: "g1", reason: "long" },
    { candidateId: "c2", action: "compact" as const, groupId: "g1", reason: "related" },
    { candidateId: "c3", action: "omit" as const, reason: "not needed" },
  ],
  groups: [{ groupId: "g1", renderedTokenBudget: 20 }],
};

describe("complete compaction contracts", () => {
  it("validates sequential IDs, canonical uniqueness, exact previews, and normalized ranges", () => {
    expect(CandidateLedgerSchema.parse(ledger)).toBeDefined();
    expect(candidateLocalId(12)).toBe("c12");
    expect(isRunLocalId("q1", "q")).toBe(true);
    expect(isRunLocalId("c01")).toBe(false);
    expect(isRunLocalId("c9007199254740992")).toBe(false);

    const duplicate = {
      candidates: ledger.candidates.map((candidate, index) =>
        index === 1
          ? {
              ...candidate,
              identity: {
                ...ledger.candidates[0]!.identity,
                contentHash: "b".repeat(64),
              },
            }
          : candidate,
      ),
    };
    expect(() => CandidateLedgerSchema.parse(duplicate)).toThrow(/canonical identities/u);
    expect(() =>
      CandidateLedgerSchema.parse({
        candidates: [{ ...ledger.candidates[0], candidateId: "c2" }],
      }),
    ).toThrow(/sequential/u);
    expect(() =>
      CandidateLedgerSchema.parse({
        candidates: [{ ...ledger.candidates[0], preview: "fabricated" }],
      }),
    ).toThrow(/reconstruct/u);
    expect(() =>
      CandidateLedgerSchema.parse({
        candidates: [
          {
            ...ledger.candidates[0],
            text: "A😀B",
            baseRanges: [
              { charStart: 0, charEnd: 3 },
              { charStart: 2, charEnd: 4 },
            ],
            previewRanges: [{ charStart: 0, charEnd: 1 }],
            preview: "A",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      CandidateLedgerSchema.parse({
        candidates: [
          {
            ...ledger.candidates[0],
            previewRanges: [
              { charStart: 7, charEnd: 12 },
              { charStart: 0, charEnd: 6 },
            ],
            preview: "Beta.\n…\nAlpha.",
          },
        ],
      }),
    ).toThrow(/sorted/u);
    expect(() =>
      CandidateLedgerSchema.parse({
        candidates: [
          {
            ...ledger.candidates[0],
            previewRanges: [
              { charStart: 0, charEnd: 6 },
              { charStart: 6, charEnd: 12 },
            ],
            preview: "Alpha.\n…\n Beta.",
          },
        ],
      }),
    ).toThrow(/non-adjacent/u);
    const withPreviewRanges = (
      baseRanges: CandidateLedger["candidates"][number]["baseRanges"],
      previewRanges: CandidateLedger["candidates"][number]["previewRanges"],
      preview: string,
    ) =>
      CandidateLedgerSchema.parse({
        candidates: [
          {
            ...ledger.candidates[0]!,
            baseRanges,
            previewRanges,
            preview,
          },
        ],
      });
    expect(() =>
      withPreviewRanges([{ charStart: 0, charEnd: 6 }], [{ charStart: 7, charEnd: 12 }], "Beta."),
    ).toThrow(/subsets/u);
    expect(() =>
      withPreviewRanges([{ charStart: 0, charEnd: 6 }], [{ charStart: 5, charEnd: 8 }], "a. Be"),
    ).toThrow(/subsets/u);
    expect(() =>
      withPreviewRanges(
        [
          { charStart: 0, charEnd: 2 },
          { charStart: 4, charEnd: 6 },
        ],
        [{ charStart: 0, charEnd: 6 }],
        "Al\n…\nha",
      ),
    ).toThrow(/subsets/u);
    expect(
      withPreviewRanges(
        [
          { charStart: 0, charEnd: 6 },
          { charStart: 7, charEnd: 12 },
        ],
        [{ charStart: 0, charEnd: 6 }],
        "Alpha.",
      ),
    ).toBeDefined();
  });

  it("caps initial compaction manifests before task generation", () => {
    const ledgerFor = (count: number): CandidateLedger => ({
      candidates: Array.from({ length: count }, (_, index) => {
        const candidateId = candidateLocalId(index + 1);
        return {
          candidateId,
          kind: "document" as const,
          identity: {
            kind: "public_document" as const,
            sourceId: `source-${index + 1}`,
            documentId: `document-${index + 1}`,
            snapshotId: "snapshot-1",
            contentHash: hash,
          },
          provenance: { label: `Document ${index + 1}`, purpose: "answer", date: null },
          text: "Long text",
          baseRanges: [{ charStart: 0, charEnd: 9 }],
          previewRanges: [{ charStart: 0, charEnd: 9 }],
          preview: "Long text",
          renderedTokenCount: 10,
        };
      }),
    });
    const manifestFor = (count: number) => ({
      decisions: Array.from({ length: count }, (_, index) => ({
        candidateId: candidateLocalId(index + 1),
        action: "compact" as const,
        groupId: `g${index + 1}`,
        reason: "long",
      })),
      groups: Array.from({ length: count }, (_, index) => ({
        groupId: `g${index + 1}`,
        renderedTokenBudget: 1,
      })),
    });
    const valid = validateInitialContextManifest(manifestFor(999), ledgerFor(999));
    expect(valid.groups).toHaveLength(999);
    expect(() => validateInitialContextManifest(manifestFor(1000), ledgerFor(1000))).toThrow(
      /more than 999 groups/u,
    );
  });

  it("projects candidate views without any private proof fields", () => {
    const view = toProviderCandidateView(ledger.candidates[0]!);
    expect(view).toEqual({
      candidateId: "c1",
      kind: "document",
      label: "Document",
      purpose: "answer",
      date: null,
      renderedTokenCount: 30,
      preview: "Alpha.",
    });
    for (const field of ["identity", "baseRanges", "previewRanges", "text", "contentHash"]) {
      expect(field in view).toBe(false);
    }
  });

  it("strips citations only from assistant chat candidates and preserves user ranges", () => {
    const chatCandidate = (chatRole: "assistant" | "user"): CandidateLedgerEntry => {
      const text = "Literal [[cite:old]] text";
      const sanitizedText = "Literal  text";
      return {
        ...ledger.candidates[0]!,
        kind: "chat_message",
        identity: {
          kind: "chat_message",
          messageId: `${chatRole}-message`,
          sanitizedContentHash: hash,
        },
        text,
        baseRanges: [
          {
            charStart: 0,
            charEnd: chatRole === "assistant" ? sanitizedText.length : text.length,
          },
        ],
        previewRanges: [
          {
            charStart: 0,
            charEnd: chatRole === "assistant" ? sanitizedText.length : text.length,
          },
        ],
        preview: chatRole === "assistant" ? sanitizedText : text,
        chatRole,
      };
    };
    const assistantCandidate = CandidateLedgerSchema.parse({
      candidates: [chatCandidate("assistant")],
    }).candidates[0]! as CandidateLedgerEntry;
    expect(assistantCandidate.text).toBe("Literal  text");
    expect(assistantCandidate.baseRanges).toEqual([{ charStart: 0, charEnd: 13 }]);
    const assistant = buildCandidatePassageIndex(assistantCandidate, passageOptions);
    expect(assistant.text).toBe("Literal  text");
    const assistantRanges = mapPassageIdsToRanges(assistant, [assistant.passages[0]!.passageId]);
    const assistantReconstruction = assistantRanges
      .map((range) => assistant.text.slice(range.charStart, range.charEnd))
      .join("");
    expect(new TextEncoder().encode(assistantReconstruction)).toEqual(
      new TextEncoder().encode(assistant.passages[0]!.text),
    );
    expect(() =>
      buildCandidatePassageIndex(assistantCandidate, {
        ...passageOptions,
        stripCitations: true,
      }),
    ).toThrow(/ledger-sanitized/u);
    const user = buildCandidatePassageIndex(chatCandidate("user"), passageOptions);
    expect(user.text).toBe("Literal [[cite:old]] text");
    expect(user.passages[0]?.range.charStart).toBe(0);
    expect(user.passages.at(-1)?.range.charEnd).toBe(user.text.length);
  });

  it("restricts candidate passages to authorized base ranges", () => {
    const restricted = CandidateLedgerSchema.parse({
      candidates: [
        {
          ...ledger.candidates[0]!,
          baseRanges: [{ charStart: 0, charEnd: 6 }],
          previewRanges: [{ charStart: 0, charEnd: 6 }],
          preview: "Alpha.",
        },
      ],
    }).candidates[0]! as CandidateLedgerEntry;
    const index = buildCandidatePassageIndex(restricted, passageOptions);
    expect(index.passages.map((passage) => passage.text)).toEqual(["Alpha."]);
    expect(index.passages.every((passage) => passage.range.charEnd <= 6)).toBe(true);
  });

  it("treats empty base ranges as no authorization", () => {
    const candidate = CandidateLedgerSchema.parse({
      candidates: [
        {
          ...ledger.candidates[0]!,
          baseRanges: [],
          previewRanges: [],
          preview: "",
        },
      ],
    }).candidates[0]! as CandidateLedgerEntry;
    const emptyLedger = { candidates: [candidate] };
    expect(buildCandidatePassageIndex(candidate, passageOptions).passages).toEqual([]);
    expect(() =>
      validateInitialContextManifest(
        {
          decisions: [{ candidateId: "c1", action: "compact", groupId: "g1", reason: "long" }],
          groups: [{ groupId: "g1", renderedTokenBudget: 10 }],
        },
        emptyLedger,
      ),
    ).toThrow(/no authorized passages/u);
    expect(() =>
      validateGroupCompactionResult(
        {
          decisions: [
            {
              candidateId: "c1",
              action: "select",
              passageIds: ["p1"],
              reason: "forged",
            },
          ],
        },
        {
          groupId: "g1",
          candidateIds: ["c1"],
          renderedTokenBudget: 10,
          mode: "normal",
        },
        emptyLedger,
        passageOptions,
      ),
    ).toThrow(/not in this index/u);
  });

  it("rejects a budget below the smallest selectable passage", () => {
    expect(() =>
      validateInitialContextManifest(
        {
          decisions: [
            { candidateId: "c1", action: "compact", groupId: "g1", reason: "long" },
            { candidateId: "c2", action: "keep", reason: "keep" },
            { candidateId: "c3", action: "omit", reason: "omit" },
          ],
          groups: [{ groupId: "g1", renderedTokenBudget: 4 }],
        },
        ledger,
        passageOptions,
      ),
    ).toThrow(/smallest selectable passage/u);
  });

  it("short-circuits exact passage cost proof at the first fitting witness", () => {
    const calls: string[] = [];
    const costOptions = {
      countRenderedTokens: (sources: readonly { readonly text: string }[]) => {
        calls.push(sources[0]!.text);
        return 4;
      },
    };
    const manifest = {
      ...initialValue,
      groups: [{ groupId: "g1", renderedTokenBudget: 20 }],
    };
    expect(validateInitialContextManifest(manifest, ledger, passageOptions, costOptions)).toEqual(
      manifest,
    );
    expect(calls).toEqual(["Alpha."]);

    calls.length = 0;
    expect(() =>
      validateInitialContextManifest(
        { ...manifest, groups: [{ groupId: "g1", renderedTokenBudget: 3 }] },
        ledger,
        passageOptions,
        costOptions,
      ),
    ).toThrow(/smallest selectable passage/u);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("rejects an oversized multi-source normal group from measured input", () => {
    expect(() =>
      createCompactionGroups(initialValue, ledger, {
        sourceToolEligibleCandidateIds: [],
        groupMeasurements: {
          g1: {
            inputTokens: 101,
            usableInputTokens: 100,
            selectablePassageCost: 2,
          },
        },
      }),
    ).toThrow(/normal group g1 request does not fit/u);
    const single = validateInitialContextManifest(
      {
        decisions: [
          { candidateId: "c1", action: "compact", groupId: "g1", reason: "long" },
          { candidateId: "c2", action: "keep", reason: "keep" },
          { candidateId: "c3", action: "omit", reason: "omit" },
        ],
        groups: [{ groupId: "g1", renderedTokenBudget: 12 }],
      },
      ledger,
    );
    expect(
      createCompactionGroups(single, ledger, {
        sourceToolEligibleCandidateIds: ["c1"],
        groupMeasurements: {
          g1: {
            inputTokens: 101,
            usableInputTokens: 100,
            selectablePassageCost: 5,
          },
        },
      }),
    ).toEqual([
      { groupId: "g1", candidateIds: ["c1"], renderedTokenBudget: 12, mode: "source_tool" },
    ]);
  });
  it("orders independent groups by earliest ledger member", () => {
    const manifest = validateInitialContextManifest(
      {
        decisions: [
          { candidateId: "c1", action: "compact", groupId: "g2", reason: "first" },
          { candidateId: "c2", action: "compact", groupId: "g1", reason: "second" },
          { candidateId: "c3", action: "omit", reason: "omit" },
        ],
        groups: [
          { groupId: "g1", renderedTokenBudget: 9 },
          { groupId: "g2", renderedTokenBudget: 20 },
        ],
      },
      ledger,
    );
    expect(
      createCompactionGroups(manifest, ledger, { sourceToolEligibleCandidateIds: [] }),
    ).toEqual([
      { groupId: "g2", candidateIds: ["c1"], renderedTokenBudget: 20, mode: "normal" },
      { groupId: "g1", candidateIds: ["c2"], renderedTokenBudget: 9, mode: "normal" },
    ]);
  });

  it("rejects undeclared groups and requires measured source-tool eligibility", () => {
    const initial = validateInitialContextManifest(initialValue, ledger);
    expect(createCompactionGroups(initial, ledger, { sourceToolEligibleCandidateIds: [] })).toEqual(
      [
        {
          groupId: "g1",
          candidateIds: ["c1", "c2"],
          renderedTokenBudget: 20,
          mode: "normal",
        },
      ],
    );
    const single = validateInitialContextManifest(
      {
        decisions: [
          { candidateId: "c1", action: "compact", groupId: "g1", reason: "long" },
          { candidateId: "c2", action: "keep", reason: "keep" },
          { candidateId: "c3", action: "omit", reason: "omit" },
        ],
        groups: [{ groupId: "g1", renderedTokenBudget: 12 }],
      },
      ledger,
    );
    expect(
      createCompactionGroups(single, ledger, { sourceToolEligibleCandidateIds: [] })[0]?.mode,
    ).toBe("normal");
    expect(
      createCompactionGroups(single, ledger, {
        sourceToolEligibleCandidateIds: ["c1"],
      })[0]?.mode,
    ).toBe("source_tool");
    expect(() =>
      createCompactionGroups(initial, ledger, {
        sourceToolEligibleCandidateIds: ["c1"],
      }),
    ).toThrow(/eligibility/u);
    expect(() =>
      validateInitialContextManifest(
        {
          ...initialValue,
          decisions: [
            { candidateId: "c1", action: "compact", groupId: "g2", reason: "unknown" },
            ...initialValue.decisions.slice(1),
          ],
        },
        ledger,
      ),
    ).toThrow(/not declared/u);
  });

  it("rejects malformed expected group modes", () => {
    const initial = validateInitialContextManifest(initialValue, ledger);
    const group = createCompactionGroups(initial, ledger, {
      sourceToolEligibleCandidateIds: [],
    })[0]!;
    const firstResult = {
      decisions: [
        { candidateId: "c1", action: "omit" as const, reason: "omit" },
        { candidateId: "c2", action: "omit" as const, reason: "omit" },
      ],
    };
    const envelope = { groupId: group.groupId, result: firstResult, renderedTokenCount: 0 };
    expect(() =>
      mergeGroupCompactionResults(
        ledger,
        [{ ...group, mode: "source_tool", candidateIds: ["c1", "c2"] }],
        [envelope],
        passageOptions,
      ),
    ).toThrow(/expected compaction groups are invalid/u);
  });

  it("requires complete group envelopes and fails partial merges", () => {
    const initial = validateInitialContextManifest(initialValue, ledger);
    const group = createCompactionGroups(initial, ledger, {
      sourceToolEligibleCandidateIds: [],
    })[0]!;
    const c1Passages = buildPassageIndex(ledger.candidates[0]!.text, passageOptions).passages;
    const c2Passage = buildPassageIndex(ledger.candidates[1]!.text, passageOptions).passages[0]!;
    const result = validateGroupCompactionResult(
      {
        decisions: [
          {
            candidateId: "c1",
            action: "select",
            passageIds: c1Passages.map((passage) => passage.passageId),
            reason: "both",
          },
          {
            candidateId: "c2",
            action: "select",
            passageIds: [c2Passage.passageId],
            reason: "whole",
          },
        ],
      },
      group,
      ledger,
      passageOptions,
    );
    const envelope = { groupId: "g1", result, renderedTokenCount: 20 };
    expect(mergeGroupCompactionResults(ledger, [group], [envelope], passageOptions)).toHaveLength(
      2,
    );
    expect(() =>
      mergeGroupCompactionResults(
        ledger,
        [group],
        [{ ...envelope, renderedTokenCount: 21 }],
        passageOptions,
      ),
    ).toThrow(/budget|exact reconstruction/u);
    expect(() => mergeGroupCompactionResults(ledger, [group], [], passageOptions)).toThrow(
      /every expected group/u,
    );
    expect(() =>
      mergeGroupCompactionResults(
        ledger,
        [group],
        [
          {
            ...envelope,
            result: { decisions: result.decisions.slice(0, 1) },
          },
        ],
        passageOptions,
      ),
    ).toThrow(/membership/u);
    expect(() =>
      mergeGroupCompactionResults(
        ledger,
        [group],
        [
          {
            ...envelope,
            result: {
              decisions: [
                {
                  candidateId: "c1",
                  action: "select",
                  passageIds: ["p999"],
                  reason: "unknown passage",
                },
                result.decisions[1]!,
              ],
            },
          },
        ],
        passageOptions,
      ),
    ).toThrow(/not in this index/u);
  });

  it("proves fallback envelopes, omissions, frozen groups, and strict passage subsets", () => {
    const initial = validateInitialContextManifest(initialValue, ledger);
    const group = createCompactionGroups(initial, ledger, {
      sourceToolEligibleCandidateIds: [],
    })[0]!;
    const c1Passages = buildPassageIndex(ledger.candidates[0]!.text, passageOptions).passages;
    const firstResult = {
      decisions: [
        {
          candidateId: "c1",
          action: "select" as const,
          passageIds: c1Passages.map((passage) => passage.passageId),
          reason: "first",
        },
        { candidateId: "c2", action: "omit" as const, reason: "omit first" },
      ],
    };
    const envelope = { groupId: "g1", result: firstResult, renderedTokenCount: 12 };
    const fallback = validateFallbackContextManifest(
      {
        decisions: [
          { candidateId: "c1", action: "tighten", groupId: "g1", reason: "smaller" },
          { candidateId: "c2", action: "omit", reason: "stays omitted" },
          { candidateId: "c3", action: "omit", reason: "stays omitted" },
        ],
        groups: [{ groupId: "g1", renderedTokenBudget: 7 }],
      },
      initial,
      ledger,
      [envelope],
    );
    expect(fallback.groups[0]?.groupId).toBe("g1");
    expect(createFallbackCompactionGroups(fallback, initial, ledger, [envelope])).toEqual([
      { groupId: "g1", candidateIds: ["c1"], renderedTokenBudget: 7, mode: "normal" },
    ]);
    expect(() =>
      createFallbackCompactionGroups(fallback, initial, ledger, [envelope], {
        sourceToolEligibleCandidateIds: ["c1", "c1"],
      }),
    ).toThrow(/eligibility IDs must be unique/u);
    expect(() =>
      createFallbackCompactionGroups(fallback, initial, ledger, [envelope], {
        sourceToolEligibleCandidateIds: ["c3"],
      }),
    ).toThrow(/invalid source-tool eligibility/u);
    expect(() =>
      validateFallbackContextManifest(
        {
          decisions: [
            { candidateId: "c1", action: "tighten", groupId: "g2", reason: "moved" },
            { candidateId: "c2", action: "retain", reason: "restore first omission" },
            { candidateId: "c3", action: "omit", reason: "omit" },
          ],
          groups: [{ groupId: "g2", renderedTokenBudget: 7 }],
        },
        initial,
        ledger,
        [envelope],
      ),
    ).toThrow();
    expect(() =>
      validateFallbackContextManifest(
        {
          decisions: [
            { candidateId: "c1", action: "tighten", groupId: "g1", reason: "valid group" },
            { candidateId: "c2", action: "retain", reason: "restore first omission" },
            { candidateId: "c3", action: "omit", reason: "omit" },
          ],
          groups: [{ groupId: "g1", renderedTokenBudget: 7 }],
        },
        initial,
        ledger,
        [envelope],
      ),
    ).toThrow(/first-pass omission/u);
    expect(() =>
      validateFallbackContextManifest(fallback, initial, ledger, [envelope, envelope]),
    ).toThrow(/exactly once/u);
    expect(() =>
      validateFallbackContextManifest(fallback, initial, ledger, [{ ...envelope, groupId: "g2" }]),
    ).toThrow(/exactly once/u);

    const tightenGroup = { ...group, candidateIds: ["c1"], renderedTokenBudget: 7 };
    expect(
      validateTightenedGroupCompactionResult(
        {
          decisions: [
            {
              candidateId: "c1",
              action: "select",
              passageIds: [c1Passages[0]!.passageId],
              reason: "strict subset",
            },
          ],
        },
        tightenGroup,
        ledger,
        firstResult,
        passageOptions,
      ),
    ).toBeDefined();
    expect(() =>
      validateTightenedGroupCompactionResult(
        {
          decisions: [
            {
              candidateId: "c1",
              action: "select",
              passageIds: c1Passages.map((passage) => passage.passageId),
              reason: "not tighter",
            },
          ],
        },
        tightenGroup,
        ledger,
        firstResult,
        passageOptions,
      ),
    ).toThrow(/strict prior subset/u);
    expect(() =>
      validateTightenedGroupCompactionResult(
        {
          decisions: [{ candidateId: "c1", action: "omit", reason: "omit" }],
        },
        tightenGroup,
        ledger,
        firstResult,
        passageOptions,
      ),
    ).toThrow(/must retain a selected prior result/u);
  });

  it("allows retained members beside strictly tightened members", () => {
    const group = {
      groupId: "g1" as const,
      candidateIds: ["c1", "c2"] as const,
      renderedTokenBudget: 20,
      mode: "normal" as const,
    };
    const c1Passages = buildPassageIndex(ledger.candidates[0]!.text, passageOptions).passages;
    const c2Passages = buildPassageIndex(ledger.candidates[1]!.text, passageOptions).passages;
    const priorResult = {
      decisions: [
        {
          candidateId: "c1" as const,
          action: "select" as const,
          passageIds: c1Passages.map((passage) => passage.passageId),
          reason: "first",
        },
        {
          candidateId: "c2" as const,
          action: "select" as const,
          passageIds: c2Passages.map((passage) => passage.passageId),
          reason: "first",
        },
      ],
    };
    expect(
      validateFallbackGroupCompactionResult(
        {
          decisions: [
            {
              candidateId: "c1",
              action: "select",
              passageIds: [c1Passages[0]!.passageId],
              reason: "tighten",
            },
            {
              candidateId: "c2",
              action: "select",
              passageIds: c2Passages.map((passage) => passage.passageId),
              reason: "new rationale",
            },
          ],
        },
        group,
        ledger,
        priorResult,
        ["c1"],
        passageOptions,
      ),
    ).toBeDefined();
  });
});
