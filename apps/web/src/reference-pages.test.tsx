import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GalleryReferencePage, PublisherReferencePage } from "./reference-pages";

describe("reference page adapters", () => {
  it("renders the copied component gallery inside the shared shell", () => {
    const html = renderToStaticMarkup(<GalleryReferencePage locale="fr-FR" />);
    expect(html).toContain("Galerie de composants");
    expect(html).toContain("App shell &amp; navigation");
  });

  it("renders publisher source rows through the copied table tree", () => {
    const html = renderToStaticMarkup(<PublisherReferencePage locale="fr-FR" />);
    expect(html).toContain("Lettre Juridique Sociale");
    expect(html).toContain("Galerie de composants");
  });
});
