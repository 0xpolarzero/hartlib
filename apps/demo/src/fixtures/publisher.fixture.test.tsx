import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublisherFixture } from "./publisher.fixture";

describe("dormant publisher fixture", () => {
  it("renders realistic fixture rows without a route contract", () => {
    const html = renderToStaticMarkup(<PublisherFixture />);
    expect(html).toContain("Atlas Energy Commission");
    expect(html).toContain("Northstar Research");
    expect(html).toContain('data-app-shell="true"');
    expect(html).toContain('aria-label="Publisher navigation"');
    expect(html).toContain("May 2026 market review");
  });
});
