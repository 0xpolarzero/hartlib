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
    expect(chatProgressStages([complete])).toEqual([
      { stage: "understanding", status: "waiting" },
      { stage: "evidence", status: "complete" },
      { stage: "preparing", status: "waiting" },
      { stage: "writing", status: "waiting" },
      { stage: "finishing", status: "waiting" },
    ]);
    expect(chatProgressStages([{ ...running, status: "retrying" }])).toEqual([
      { stage: "understanding", status: "waiting" },
      { stage: "evidence", status: "retrying" },
      { stage: "preparing", status: "waiting" },
      { stage: "writing", status: "waiting" },
      { stage: "finishing", status: "waiting" },
    ]);
    expect(chatProgressStages([{ ...running, stage: "preparing", status: "skipped" }])).toEqual([
      { stage: "understanding", status: "waiting" },
      { stage: "evidence", status: "waiting" },
      { stage: "preparing", status: "skipped" },
      { stage: "writing", status: "waiting" },
      { stage: "finishing", status: "waiting" },
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

  it("places the fixed five-slot rail before streamed prose with a quiet filled connector", () => {
    const message: ChatTranscriptMessage = {
      id: "assistant-streaming",
      author: "assistant",
      content: "The answer is still growing.",
      citations: [],
      sourcesRead: [],
      activities: [
        {
          type: "activity",
          stage: "understanding",
          code: "request_understanding",
          status: "complete",
        },
        {
          type: "activity",
          stage: "evidence",
          code: "internal_sources",
          status: "complete",
        },
        {
          type: "activity",
          stage: "preparing",
          code: "context_preparation",
          status: "running",
        },
        {
          type: "activity",
          stage: "writing",
          code: "answer_generation",
          status: "retrying",
        },
        {
          type: "activity",
          stage: "finishing",
          code: "finalization",
          status: "skipped",
        },
      ],
      streaming: true,
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

    const railIndex = markup.indexOf('data-testid="chat-progress-stage-rail"');
    const contentIndex = markup.indexOf('data-testid="chat-message-content"');
    expect(railIndex).toBeGreaterThanOrEqual(0);
    expect(railIndex).toBeLessThan(contentIndex);
    expect(markup).toMatch(/data-testid="chat-progress-stage-rail"[^>]*data-completed-stages="2"/u);
    expect(markup).toMatch(
      /class="[^"]*h-px bg-rule[^"]*"[^>]*data-testid="chat-progress-connector"/u,
    );
    expect(markup).toMatch(
      /class="[^"]*h-px bg-accent[^"]*"[^>]*data-testid="chat-progress-connector-fill"/u,
    );
    expect(markup).toContain('data-fill-percent="25"');
    expect(markup).toContain("grid-cols-5");
    expect(markup).toMatch(/data-stage="understanding"[^>]*data-status="complete"/u);
    expect(markup).toMatch(/data-stage="evidence"[^>]*data-status="complete"/u);
    expect(markup).toMatch(/data-stage="preparing"[^>]*data-status="running"/u);
    expect(markup).toMatch(/data-stage="writing"[^>]*data-status="retrying"/u);
    expect(markup).toMatch(/data-stage="finishing"[^>]*data-status="skipped"/u);
    expect(markup).not.toContain("bg-gradient");
  });
});

describe("assistant Markdown and citations", () => {
  it("renders Markdown while keeping inline citations compact and source details separate", () => {
    const message: ChatTranscriptMessage = {
      id: "assistant-1",
      author: "assistant",
      content:
        "**Material gaps:** The practical rollout details are not in the available evidence. [[cite:k_source_1,k_source_3]]\n\n| Date | Status |\n| --- | --- |\n| 2026-09-01 | Starts |\n\n![Untrusted image](https://tracker.example/pixel.png)",
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
        {
          sourceKey: "k_source_3",
          label: "Implementation note",
          kind: "web",
          title: "Implementation note",
          domain: "example.net",
          url: "https://example.net/implementation",
          capturedAt: "2026-08-16T12:00:00.000Z",
          quote: "Implementation details remain subject to guidance.",
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
        {
          sourceKey: "k_source_2",
          label: "A read source without a citation",
          tokenCount: 12,
          topicIds: [],
          kind: "web",
          title: "A read source without a citation",
          domain: "example.org",
          url: "https://example.org/uncited",
          capturedAt: "2026-08-16T12:00:00.000Z",
          quote: "This source was read but not cited.",
          ranges: [],
        },
        {
          sourceKey: "k_source_3",
          label: "Implementation note",
          tokenCount: 8,
          topicIds: [],
          kind: "web",
          title: "Implementation note",
          domain: "example.net",
          url: "https://example.net/implementation",
          capturedAt: "2026-08-16T12:00:00.000Z",
          quote: "Implementation details remain subject to guidance.",
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
    expect(markup).toMatch(/data-testid="citation-marker"[^>]*>\[2\]<\/a>/u);
    expect(markup).toContain('data-testid="sources-read-disclosure"');
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|>)/u);
    expect(markup).toContain('data-testid="chat-answer-completion"');
    expect(markup).toContain("Answer ready");
    expect(markup).toContain("3 sources read");
    expect(markup).toContain("2 sources cited");
    expect(markup).not.toContain('data-testid="chat-progress-stage-rail"');
    expect(markup).not.toContain('data-testid="chat-progress-diagnostics"');
    expect(markup.indexOf('data-testid="chat-answer-completion"')).toBeGreaterThan(
      markup.indexOf('data-testid="chat-message-content"'),
    );
    expect(markup.indexOf('data-testid="sources-read-disclosure"')).toBeGreaterThan(
      markup.indexOf('data-testid="chat-answer-completion"'),
    );
    expect(markup).toContain('data-cited="true"');
    expect(markup).toContain('data-cited="false">not cited</span>');
    expect(markup).toContain("Untrusted image");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("tracker.example");
    expect(markup).toMatch(
      /class="[^"]*w-full max-w-\[72ch\] px-0 py-1[^"]*"[^>]*data-testid="chat-assistant-answer-column"/u,
    );
    expect(markup).not.toMatch(
      /class="[^"]*(?:border|bg-paper|rounded)[^"]*"[^>]*data-testid="chat-assistant-answer-column"/u,
    );
  });

  it("keeps user ownership in a compact right bubble without using the assistant icon", () => {
    const message: ChatTranscriptMessage = {
      id: "user-1",
      author: "user",
      content: "What changed?",
      run: { id: "run-1", status: "succeeded", finishedAt: "2026-08-16T12:00:00.000Z" },
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

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-labelledby="chat-message-user-1-author"');
    expect(markup).toMatch(
      /class="[^"]*max-w-\[86%\] rounded-sm border border-accent\/25 bg-accent\/10[^"]*"[^>]*data-testid="chat-user-bubble"/u,
    );
    expect(markup).toContain("Client");
  });

  it("renders bounded failed-attempt identity and cause details in French diagnostics", () => {
    const message: ChatTranscriptMessage = {
      id: "assistant-failed",
      author: "assistant",
      content: "",
      citations: [],
      sourcesRead: [],
      activities: [
        {
          type: "activity",
          stage: "understanding",
          code: "request_understanding",
          status: "retrying",
          runId: "run-safe-123",
          occurredAt: "2026-08-21T19:05:56.810Z",
          attempt: 1,
          errorCode: "plan_turn_failed",
          errorCategory: "provider_transport",
          errorMessage: "The model provider did not return a response.",
        },
      ],
      diagnostics: {
        activityHistory: [
          {
            type: "activity",
            stage: "understanding",
            code: "request_understanding",
            status: "retrying",
            runId: "run-safe-123",
            occurredAt: "2026-08-21T19:05:56.810Z",
            attempt: 1,
            errorCode: "plan_turn_failed",
            errorCategory: "provider_transport",
            errorMessage: "The model provider did not return a response.",
          },
        ],
        terminalFailure: {
          code: "plan_turn_failed",
          retryable: true,
          runId: "run-safe-123",
          stage: "understanding",
          occurredAt: "2026-08-21T19:05:58.509Z",
          errorCategory: "provider_transport",
          errorMessage: "The model provider did not return a response.",
        },
        sequence: 10,
      },
      activityFailure: { code: "plan_turn_failed", retryable: true },
      streaming: true,
    };
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, {
        locale: "fr-FR",
        market: "FR",
        children: createElement(ChatBubble, {
          message,
          authorLabels: { assistant: "Assistant", client: "Client" },
        }),
      }),
    );

    expect(markup).toContain("run-safe-123");
    expect(markup).toContain("2026-08-21T19:05:56.810Z");
    expect(markup).toContain("transport du fournisseur");
    expect(markup).toContain("The model provider did not return a response.");
    expect(markup).toContain("data-testid=" + '"chat-progress-failure-details"');
    expect(markup).not.toContain("provider body");
  });
});
