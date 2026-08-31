import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubscriberSubscriptions } from "./subscriber-subscriptions";

describe("subscriber subscriptions", () => {
  it("shows disabled authorized rows and nested publication breadcrumbs", () => {
    const html = renderToStaticMarkup(
      <SubscriberSubscriptions
        sources={[{ id: "source-1", name: "Atlas", kind: "public", country: "US", enabled: false }]}
        publications={[
          {
            id: "issue-1",
            sourceId: "source-1",
            title: "June issue",
            status: "published",
            documents: [],
          },
        ]}
      />,
    );
    expect(html).toContain("Disabled rows stay visible");
    expect(html).toContain("Atlas");
    expect(html).toContain("disabled");
    const detail = renderToStaticMarkup(
      <SubscriberSubscriptions
        sourceId="source-1"
        issueId="issue-1"
        sources={[{ id: "source-1", name: "Atlas", kind: "public", country: "US", enabled: true }]}
        publications={[
          {
            id: "issue-1",
            sourceId: "source-1",
            title: "June issue",
            status: "published",
            documents: [{ id: "doc-1", title: "Official PDF", state: "missing" }],
          },
        ]}
      />,
    );
    expect(detail).toContain("Official PDF");
    expect(detail).toContain("Unavailable");
  });
});
