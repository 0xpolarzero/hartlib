import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublisherComposition } from "./publisher-composition";

describe("dormant publisher composition", () => {
  it("defaults to empty honest state without enabled writes", () => {
    const html = renderToStaticMarkup(<PublisherComposition />);
    expect(html).toContain('data-publisher-dormant="true"');
    expect(html).toContain('data-app-shell="true"');
    expect(html).toContain('aria-label="Publisher navigation"');
    expect(html).toContain("0 records");
    expect(html).toContain("No sources");
    expect(html).not.toContain("Add subscriber");
  });
});
