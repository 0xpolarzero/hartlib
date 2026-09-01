import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunRail } from "./run-rail";

describe("run rail", () => {
  it("shows exactly five stable decorative stages", () => {
    const html = renderToStaticMarkup(
      <RunRail
        stages={{
          understanding: "complete",
          evidence: "running",
          preparing: "waiting",
          writing: "waiting",
          finishing: "waiting",
        }}
      />,
    );
    expect((html.match(/<li/g) ?? []).length).toBe(5);
    expect(html).toContain("gathering evidence");
  });
});
