import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunActivity } from "./run-activity";

describe("run activity", () => {
  it("renders exact activity details and source records without free-form captions", () => {
    const html = renderToStaticMarkup(
      <RunActivity
        status="running"
        stages={{ understanding: "complete", evidence: "running" }}
        activities={[
          {
            type: "activity",
            stage: "understanding",
            code: "request_understanding",
            status: "complete",
            occurredAt: "2026-05-12T10:00:00.000Z",
          },
          {
            type: "activity",
            stage: "evidence",
            code: "web_research",
            status: "running",
            occurredAt: "2026-05-12T10:00:00.100Z",
            detail: {
              kind: "web_search",
              ordinal: 1,
              query: "site:ec.europa.eu AI Act timeline",
            },
          },
        ]}
        sourcesRead={[
          {
            kind: "web",
            sourceKey: "web:commission",
            label: "Commission",
            tokenCount: 100,
            topicIds: ["t1"],
            title: "European Commission · AI Act",
            domain: "ec.europa.eu",
            url: "https://ec.europa.eu/ai-act",
            capturedAt: "2026-05-12T10:00:00.200Z",
            quote: "Recorded source text.",
            ranges: [],
          },
        ]}
      />,
    );

    expect(html).toContain("Web research");
    expect(html).toContain("site:ec.europa.eu AI Act timeline");
    expect(html).toContain("European Commission · AI Act");
    expect(html).toContain("2026-05-12T10:00:00.100Z");
    expect(html).not.toContain("Searching the Commission site");
    expect(html).toContain('aria-expanded="true"');
    expect((html.match(/<button/g) ?? []).length).toBe(5);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3);
  });

  it("keeps the production fallback compact when no activity detail exists", () => {
    const html = renderToStaticMarkup(<RunActivity status="queued" />);

    expect(html).toContain("Queued");
    expect(html).not.toContain("<button");
  });
});
