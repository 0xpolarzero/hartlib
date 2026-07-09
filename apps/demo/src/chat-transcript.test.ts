import { describe, expect, it } from "vitest";

import { buildTranscriptMessages } from "./chat-transcript";

const labels = {
  memoryBlockLabel: "Localized memories",
  memoryCitation: "Localized memory",
};

describe("buildTranscriptMessages", () => {
  it("attaches streaming references only for cited context blocks", () => {
    const messages = buildTranscriptMessages(
      [],
      "run-1",
      "answering",
      {
        assistantText: "Answer [[cite:b2]] and [[cite:b1,b2]]",
        contextBlocks: [
          { blockId: "b1", kind: "document", label: "Source A", tokenEstimate: 10 },
          { blockId: "b2", kind: "document", label: "Source B", tokenEstimate: 20 },
          { blockId: "b3", kind: "document", label: "Source C", tokenEstimate: 30 },
        ],
      },
      labels,
    );

    expect(messages[0]?.citations?.map((citation) => citation.id)).toEqual(["b2", "b1"]);
    expect(messages[0]?.contextBlocks?.map((block) => block.blockId)).toEqual(["b1", "b2", "b3"]);
  });

  it("localizes streaming memory context blocks before rendering references", () => {
    const messages = buildTranscriptMessages(
      [],
      "run-1",
      "answering",
      {
        assistantText: "Answer [[cite:b1]]",
        contextBlocks: [{ blockId: "b1", kind: "memory", label: null, tokenEstimate: 5 }],
      },
      labels,
    );

    expect(messages[0]?.citations?.[0]).toEqual({
      id: "b1",
      label: "Localized memory",
      url: null,
      publishedAt: null,
      title: "Localized memory",
      sourceDisplayName: null,
    });
    expect(messages[0]?.contextBlocks?.[0]?.label).toBe("Localized memories");
  });
});
