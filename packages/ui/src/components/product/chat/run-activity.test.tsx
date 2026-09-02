import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunActivity } from "./run-activity";

describe("run activity", () => {
  it("shows exact queries and named sources behind one disclosure", () => {
    const html = renderToStaticMarkup(
      <RunActivity
        status="running"
        title="Searching"
        meta="1 query"
        current="Searching the Commission site"
        defaultExpanded
        events={[
          {
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
    expect(html).toMatch(/<details[^>]* open=\"\"/);
    expect((html.match(/<summary/g) ?? []).length).toBe(1);
  });

  it("keeps the production fallback compact when no activity detail exists", () => {
    const html = renderToStaticMarkup(<RunActivity status="queued" />);

    expect(html).toContain("Queued");
    expect(html).not.toContain("<details");
  });
});
