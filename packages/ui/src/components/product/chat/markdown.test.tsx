import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerBody } from "./markdown";
import type { PublicCitationRecord } from "./types";

const webCitation: PublicCitationRecord = {
  sourceKey: "source-1",
  label: "Official source",
  kind: "web",
  title: "Official source",
  domain: "example.com",
  url: "https://example.com/source",
  capturedAt: "2026-01-01T00:00:00.000Z",
  ranges: [],
  quote: { text: "Quoted evidence" },
};

describe("answer markdown", () => {
  it("renders references and code without raw HTML", () => {
    const html = renderToStaticMarkup(
      <AnswerBody
        content={"# Title\n\nSafe <script>alert(1)</script>\n\n```ts\nconst value = 1\n```"}
      />,
    );
    expect(html).toContain("Title");
    expect(html).toContain("Copy code");
    expect(html).not.toContain("<script>");
  });
  it("holds an incomplete citation marker while streaming", () => {
    const html = renderToStaticMarkup(<AnswerBody content="Evidence [[cite:source" streaming />);
    expect(html).not.toContain("[[cite:source");
    expect(html).toContain("Evidence");
  });
  it("associates claims with strict citations and keeps the source gutter on the right", () => {
    const html = renderToStaticMarkup(
      <AnswerBody
        content="The claim [[cite:source-1]] and again [[cite:source-1]]."
        sources={[webCitation]}
      />,
    );
    expect(html).toContain("bg-accent/8");
    expect(html).toContain("lg:grid-cols-[minmax(0,1fr)_13rem]");
    expect(html).toContain("Quoted evidence");
    expect((html.match(/data-testid="citation-chip"/gu) ?? []).length).toBe(1);
    expect((html.match(/data-testid="citation-chip-repeat"/gu) ?? []).length).toBe(1);
  });
  it("keeps long margin quotes bounded and claims keyboard-focusable", () => {
    const html = renderToStaticMarkup(
      <AnswerBody
        content="A detailed claim remains associated [[cite:source-1]]."
        sources={[{ ...webCitation, quote: { text: "Long evidence. ".repeat(100) } }]}
      />,
    );
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("line-clamp-6");
  });
});
