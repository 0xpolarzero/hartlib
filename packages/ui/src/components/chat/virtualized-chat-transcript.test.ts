import { I18nProvider } from "@hartlib/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ChatBubble,
  chatFailureMessageId,
  chatProgressStages,
  isChatTranscriptNearBottom,
  type ChatTranscriptMessage,
} from "./virtualized-chat-transcript";

describe("chat failure localization", () => {
  it.each([
    "workflow_resume_incompatible",
    "context_compaction_failed",
    "context_assembly_failed",
    "context_plan_unfit",
    "memory_conflict",
  ])("maps canonical code %s to its exact catalog key", (code) =>
    expect(chatFailureMessageId(code)).toBe(`chat.failure.${code}`),
  );

  it.each(["workflow_incompatible"])(
    "uses the generic fallback for unknown historical code %s",
    (code) => expect(chatFailureMessageId(code)).toBe("chat.failure.generic"),
  );
});

describe("chat progress and transcript anchoring", () => {
  it("keeps the compact rail separate from the full diagnostic history", () => {
    const running = {
      type: "activity" as const,
      stage: "evidence" as const,
      code: "internal_sources" as const,
      status: "running" as const,
    };
    const complete = { ...running, status: "complete" as const };
    expect(chatProgressStages([complete])).toEqual([{ stage: "evidence", status: "complete" }]);
    expect(chatProgressStages([{ ...running, status: "retrying" }])).toEqual([
      { stage: "evidence", status: "retrying" },
    ]);
    expect([running, complete]).toHaveLength(2);
  });

  it("sticks only near the bottom, so growth does not yank a scrolled-up viewer", () => {
    expect(
      isChatTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 752, clientHeight: 200 }),
    ).toBe(true);
    expect(
      isChatTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 }),
    ).toBe(false);
  });
});

describe("assistant Markdown and citations", () => {
  it("renders Markdown while keeping inline citations compact and source details separate", () => {
    const message: ChatTranscriptMessage = {
      id: "assistant-1",
      author: "assistant",
      content:
        "**Material gaps:** The practical rollout details are not in the available evidence. [[cite:k_source_1]]\n\n| Date | Status |\n| --- | --- |\n| 2026-09-01 | Starts |\n\n![Untrusted image](https://tracker.example/pixel.png)",
      citations: [
        {
          sourceKey: "k_source_1",
          label: "Electronic invoicing: prepare for 1 September 2026",
          kind: "web",
          title: "Electronic invoicing",
          domain: "example.com",
          url: "https://example.com/e-invoicing",
          capturedAt: "2026-08-16T12:00:00.000Z",
          quote: "The reform begins on 1 September 2026.",
          ranges: [],
        },
      ],
      sourcesRead: [
        {
          sourceKey: "k_source_1",
          label: "Electronic invoicing: prepare for 1 September 2026",
          tokenCount: 20,
          topicIds: [],
          kind: "web",
          title: "Electronic invoicing",
          domain: "example.com",
          url: "https://example.com/e-invoicing",
          capturedAt: "2026-08-16T12:00:00.000Z",
          quote: "The reform begins on 1 September 2026.",
          ranges: [],
        },
      ],
    };

    const markup = renderToStaticMarkup(
      createElement(I18nProvider, {
        locale: "en-US",
        market: "US",
        children: createElement(ChatBubble, {
          message,
          authorLabels: { assistant: "Assistant", client: "Client" },
        }),
      }),
    );

    expect(markup).toContain("<strong>Material gaps:</strong>");
    expect(markup).toContain("<table");
    expect(markup).not.toContain("[[cite:");
    expect(markup).toMatch(/data-testid="citation-marker"[^>]*>\[1\]<\/a>/u);
    expect(markup).not.toContain('data-testid="chat-citations"');
    expect(markup).toContain("Untrusted image");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("tracker.example");
  });
});
