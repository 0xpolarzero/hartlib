import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DocumentsTable,
  PublicationsTable,
  SourcesTable,
  SubscribersTable,
  type PublisherDocument,
  type PublisherPublicationRow,
  type PublisherSourceRow,
  type PublisherSubscriberRow,
} from "./tables";

const source: PublisherSourceRow = {
  id: "source-1",
  name: "Source one",
  kind: "public",
  country: "US",
  enabled: true,
};
const publication: PublisherPublicationRow = {
  id: "publication-1",
  sourceId: source.id,
  title: "Publication one",
  status: "published",
};
const document: PublisherDocument = {
  id: "document-1",
  issueId: publication.id,
  name: "document.pdf",
  status: "ready",
};
const subscriber: PublisherSubscriberRow = {
  id: "subscriber-1",
  email: "reader@example.com",
  company: "Example",
  status: "active",
};

describe("publisher tables", () => {
  it("keeps subscriber add and validation actions prop-driven", () => {
    const html = renderToStaticMarkup(
      <SubscribersTable
        rows={[{ id: "s1", email: "bad", company: "Example", status: "invalid" }]}
        onAdd={() => undefined}
        onValidate={() => undefined}
        state="data"
      />,
    );
    expect(html).toContain("Add subscriber");
    expect(html).toContain("Validate");
    expect(html).toContain("bad");
  });

  it("wires loading, empty, error, filled, and retry states for every publisher table", () => {
    const cases = [
      {
        label: "Sources",
        render: (state: "loading" | "empty" | "error" | "data", onRetry?: () => void) => (
          <SourcesTable
            rows={state === "data" ? [source] : []}
            state={state}
            {...(onRetry === undefined ? {} : { onRetry })}
          />
        ),
        filled: "Source one",
      },
      {
        label: "Publications",
        render: (state: "loading" | "empty" | "error" | "data", onRetry?: () => void) => (
          <PublicationsTable
            rows={state === "data" ? [publication] : []}
            state={state}
            {...(onRetry === undefined ? {} : { onRetry })}
          />
        ),
        filled: "Publication one",
      },
      {
        label: "Documents",
        render: (state: "loading" | "empty" | "error" | "data", onRetry?: () => void) => (
          <DocumentsTable
            rows={state === "data" ? [document] : []}
            state={state}
            {...(onRetry === undefined ? {} : { onRetry })}
          />
        ),
        filled: "document.pdf",
      },
      {
        label: "Subscribers",
        render: (state: "loading" | "empty" | "error" | "data", onRetry?: () => void) => (
          <SubscribersTable
            rows={state === "data" ? [subscriber] : []}
            state={state}
            {...(onRetry === undefined ? {} : { onRetry })}
          />
        ),
        filled: "reader@example.com",
      },
    ] as const;

    for (const entry of cases) {
      const retry = () => undefined;
      const loading = renderToStaticMarkup(entry.render("loading", retry));
      expect(loading, `${entry.label} loading`).toContain('aria-label="');
      expect(loading, `${entry.label} loading`).toContain("animate-pulse");

      const empty = renderToStaticMarkup(entry.render("empty", retry));
      expect(empty, `${entry.label} empty`).toContain("No ");

      const error = renderToStaticMarkup(entry.render("error", retry));
      expect(error, `${entry.label} error`).toContain('role="alert"');
      expect(error, `${entry.label} error`).toMatch(/<button[^>]*>Retry<\/button>/u);

      const filled = renderToStaticMarkup(entry.render("data", retry));
      expect(filled, `${entry.label} filled`).toContain(entry.filled);
    }
  });
});
