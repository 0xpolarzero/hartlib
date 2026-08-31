import { describe, expect, it } from "vitest";

import enUS from "./locales/en-US.json";
import frFR from "./locales/fr-FR.json";
import { messageForLocale } from "./context";

describe("localization catalogs", () => {
  it("keeps the two canonical catalogs key-identical and non-empty", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(frFR).sort());
    for (const [id, value] of Object.entries(enUS)) {
      expect(value.trim(), `${id} must be translated in en-US`).not.toBe("");
      expect(frFR[id as keyof typeof frFR].trim(), `${id} must be translated in fr-FR`).not.toBe(
        "",
      );
    }
  });

  it("resolves error-boundary chrome from the active catalog", () => {
    expect(messageForLocale("en-US", "web.error.reload")).toBe("Reload");
    expect(messageForLocale("fr-FR", "web.error.reload")).toBe("Recharger");
  });

  it("keeps reset copy focused on the destructive demo reset", () => {
    expect(enUS["action.reset"]).toBe("Reset demo");
    expect(frFR["action.reset"]).toBe("Réinitialiser la démo");
    expect(enUS["action.reset.tooltip"]).toContain("Revoke");
    expect(frFR["action.reset.tooltip"]).toContain("Révoquez");
    expect(enUS["chat.resetFailed"]).toContain("reset");
    expect(frFR["chat.resetFailed"]).toContain("réinitialiser");
  });

  it("contains labels for the language picker", () => {
    expect(enUS["ui.languageEnglish"]).toBe("English");
    expect(enUS["ui.languageFrench"]).toBe("French");
    expect(frFR["ui.languageEnglish"]).toBe("Anglais");
    expect(frFR["ui.languageFrench"]).toBe("Français");
  });

  it("contains the dormant publisher fixture labels", () => {
    expect(enUS["fixture.publisherTitle"]).toBe("Publisher fixture");
    expect(frFR["fixture.publisherTitle"]).toBe("Aperçu éditeur");
    expect(enUS["fixture.publicationDeliveryDescription"]).toContain("subscribers");
    expect(frFR["fixture.validationErrorsDescription"]).toContain("adresse");
  });

  it("contains localized breadcrumb and retry labels", () => {
    expect(enUS["ui.breadcrumb"]).toBe("Breadcrumb");
    expect(frFR["ui.breadcrumb"]).toBe("Fil d’Ariane");
    expect(frFR["ui.retry"]).toBe("Réessayer");
  });
});
