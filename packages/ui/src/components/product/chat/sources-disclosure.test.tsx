import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourcesDisclosure } from "./sources-disclosure";

describe("sources disclosure", () => {
  it("renders an honest empty state without an expandable control", () => {
    const html = renderToStaticMarkup(<SourcesDisclosure sources={[]} answerId="answer-1" />);
    expect(html).toContain("Sources read (0)");
    expect(html).toContain("No sources were read.");
    expect(html).not.toContain("aria-expanded=");
  });

  it("keeps a stable answer-scoped disclosure id and marks uncited reads", () => {
    const html = renderToStaticMarkup(
      <SourcesDisclosure
        answerId="answer-42"
        defaultOpen
        sources={[
          {
            sourceKey: "source-a",
            label: "Source A",
            kind: "web",
            tokenCount: 3,
            topicIds: [],
            title: "A",
            domain: "a.example",
            url: "https://a.example",
            capturedAt: "2026-01-01T00:00:00.000Z",
            ranges: [],
            quote: "Evidence",
          },
        ]}
        citations={[]}
      />,
    );
    expect(html).toContain('aria-controls="sources-answer-42"');
    expect(html).toContain("not cited");
  });
});
