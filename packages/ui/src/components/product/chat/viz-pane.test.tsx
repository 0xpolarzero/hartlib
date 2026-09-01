import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VizPane } from "./viz-pane";
import { TooltipProvider } from "../../ui/overlays";

const version = {
  id: "v1",
  specId: "spec",
  label: "Trend",
  html: "<h1>Chart</h1>",
  createdAt: "2026-01-01T00:00:00.000Z",
};
describe("visualization presentation", () => {
  it("keeps reachable empty state honest", () => {
    expect(renderToStaticMarkup(<VizPane versions={[]} activeVersionId={null} />)).toContain(
      "No visualization yet",
    );
  });
  it("renders an explicit loading state before a first version", () => {
    expect(
      renderToStaticMarkup(<VizPane versions={[]} activeVersionId={null} state="loading" />),
    ).toContain("Loading visualization");
  });
  it("uses a sandboxed srcDoc iframe and renders association", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <VizPane versions={[version]} activeVersionId="v1" association={{ messageId: "m1" }} />
      </TooltipProvider>,
    );
    expect(html).toContain('sandbox=""');
    expect(html).toContain('srcDoc="&lt;h1&gt;Chart&lt;/h1&gt;"');
    expect(html).toContain("Associated with message m1");
  });
});
