import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VisualizationFixture } from "./visualization.fixture";

describe("visualization fixture", () => {
  it("covers the honest empty pane and populated sandbox states", () => {
    const html = renderToStaticMarkup(<VisualizationFixture />);
    expect(html).toContain("No visualization yet");
    expect(html).toContain('sandbox=""');
    expect(html).toContain("Associated with message message-42");
    expect(html).toContain("Regenerating");
  });
  it("localizes fixture labels and generated document labels", () => {
    const html = renderToStaticMarkup(<VisualizationFixture locale="fr-FR" />);
    expect(html).toContain("Évolution du prix de l’énergie");
    expect(html).toContain("Graphique en courbes");
    expect(html).toContain("Régénération");
  });
});
