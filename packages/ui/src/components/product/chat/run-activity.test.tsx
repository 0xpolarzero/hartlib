import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunActivity } from "./run-activity";

describe("run activity", () => {
  it("shows the current stage and keeps prior stages selectable", () => {
    const html = renderToStaticMarkup(
      <RunActivity
        status="running"
        title="Searching"
        meta="1 query"
        current="Searching the Commission site"
        stages={{ understanding: "complete", evidence: "running" }}
        events={[
          {
            stage: "understanding",
            label: "Plan ready",
            detail: "Check official sources.",
            tone: "done",
          },
          {
            stage: "evidence",
            label: "Query",
            detail: "Sent to the search provider.",
            tone: "active",
            queries: ["site:ec.europa.eu AI Act timeline"],
            sources: [
              {
                title: "European Commission · AI Act",
                meta: "Official guidance",
                status: "Reading",
              },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain("Searching the Commission site");
    expect(html).toContain("site:ec.europa.eu AI Act timeline");
    expect(html).toContain("European Commission · AI Act");
    expect(html).toContain('aria-expanded="true"');
    expect((html.match(/<button/g) ?? []).length).toBe(5);
    expect((html.match(/disabled=\"\"/g) ?? []).length).toBe(3);
  });

  it("keeps the production fallback compact when no activity detail exists", () => {
    const html = renderToStaticMarkup(<RunActivity status="queued" />);

    expect(html).toContain("Queued");
    expect(html).not.toContain("<button");
  });
});
